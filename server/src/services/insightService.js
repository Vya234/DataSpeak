/**
 * insightService.js — Hybrid insight orchestrator.
 *
 * Routing flow:
 *   1. Validate + normalise dataset
 *   2. Ambiguous relative time → clarifying question (no silent pick)
 *   3. Categorical filters from the question
 *   4. Deterministic → rules → Groq
 *   5. Data-used metadata, optional numeric verification (AI), follow-up chips
 */

const { tryRuleBasedAnswer } = require("./ruleBasedQuery");
const { askGroqForInsight } = require("./groqService");
const { runDeterministicPipeline } = require("./deterministicAnalytics");
const { parseIntent } = require("./intentParser");
const { resolveMetrics } = require("./metricResolver");
const { findBestDateColumn, resolveComparisonWindows, filterRowsBySortKeyRange } = require("./timeResolver");
const {
  inferColumnsFromRows,
  getNumericColumns,
  groupBy,
  groupByTime,
  summaryStats,
  detectTemporalColumn,
  detectGroupColumn,
  representativeSample,
} = require("../utils/datasetAnalysis");
const { filterDataset } = require("../utils/filterDataset");
const { detectAmbiguousRelativeTime } = require("../lib/ambiguousTime");
const {
  buildDataUsedMeta,
  appendDataUsedIfMissing,
  suggestFollowUps,
  tryInferChartFromRows,
} = require("../lib/responseExtras");
const { verifyAnswerAgainstRows, applyVerifiedCurrency } = require("../lib/answerVerifier");
const { datasetStore } = require("../utils/datasetStore");

const LARGE_DATASET_THRESHOLD = 200;

function isSourceTransparencyQuestion(q) {
  const s = String(q || "").toLowerCase();
  if (
    /\b(last|previous)\s+answer\b/.test(s) &&
    /\b(data|rows?|columns?|source|used)\b/.test(s)
  ) {
    return true;
  }
  return (
    ((/\bwhich\b/.test(s) || /\bwhat\b/.test(s)) &&
      /\b(data|rows?|columns?|fields?)\b/.test(s) &&
      /\b(use|used|source|based)\b/.test(s)) ||
    /\bhow\s+did\s+you\s+compute\b/.test(s)
  );
}

function persistQueryMeta(dataUsed, extra = {}) {
  if (!dataUsed) return;
  datasetStore.setLastQueryMeta({
    columnsUsed: dataUsed.columnsUsed,
    filterApplied: dataUsed.filter || null,
    rowCount: dataUsed.rowCount,
    totalRows: dataUsed.totalRows,
    timeWindow: dataUsed.timeWindow,
    groupBy: extra.groupBy || null,
  });
}

function questionWantsTrend(q) {
  return /\b(trend|over time|progress|growth|decline|change|month.over|year.over|increase|decrease|fluctuat)\b/i.test(q);
}

function questionWantsGroupBy(q) {
  return /\b(by |per |each |breakdown|group|segment|categor)\b/i.test(q);
}

function sanitizeChartData(chartData) {
  if (!chartData || typeof chartData !== "object") return undefined;
  const labels = Array.isArray(chartData.labels) ? chartData.labels.map(String) : [];
  const rawVals = Array.isArray(chartData.values) ? chartData.values : [];
  if (labels.length === 0 || rawVals.length !== labels.length) return undefined;
  const values = rawVals.map((v) => Number(v));
  if (!values.every((n) => Number.isFinite(n))) return undefined;
  const t = chartData.type;
  const type = ["bar", "line", "pie", "doughnut"].includes(t) ? t : "bar";
  const out = { labels, values, type };
  if (typeof chartData.valueAxisLabel === "string") out.valueAxisLabel = chartData.valueAxisLabel;
  if (typeof chartData.categoryAxisLabel === "string") out.categoryAxisLabel = chartData.categoryAxisLabel;
  return out;
}

function columnsUsedFromContext(metrics, dateCol, deterministic) {
  const set = new Set();
  if (metrics?.primaryColumn) set.add(metrics.primaryColumn);
  if (dateCol) set.add(dateCol);
  for (const d of deterministic?.resolvedDimensions || []) {
    if (d) set.add(d);
  }
  return [...set];
}

function shapeApiResponse(raw, extras = {}) {
  const answer0 = typeof raw?.answer === "string" ? raw.answer : "";
  const source = raw?.source === "AI" ? "AI" : "rule-based";
  const chartData = sanitizeChartData(raw?.chartData);
  const out = { answer: answer0, source };
  if (chartData) out.chartData = chartData;
  if (extras.dataUsed) out.dataUsed = extras.dataUsed;
  if (Array.isArray(extras.suggestedQuestions) && extras.suggestedQuestions.length) {
    out.suggestedQuestions = extras.suggestedQuestions;
  }
  if (extras.clarifying) out.clarifying = true;
  return out;
}

function buildLLMPayload({ question, rows, columns }) {
  const numericCols = getNumericColumns(rows, columns);
  const temporalCol = detectTemporalColumn(columns);
  const isTrendQuery = questionWantsTrend(question);

  if (isTrendQuery && temporalCol && numericCols.length > 0) {
    const avgKeywords = /\b(price|rate|ratio|score|rating|index|temperature|avg|average|mean|percent|%)\b/i;
    const agg = avgKeywords.test(question) ? "avg" : "sum";

    const timeBuckets = groupByTime(rows, temporalCol, numericCols.slice(0, 5), agg);

    if (timeBuckets.length >= 2) {
      const aggregatedRows = timeBuckets.map((b) => {
        const r = { [temporalCol]: b.label };
        for (const col of numericCols.slice(0, 5)) {
          if (b[col] !== undefined) r[col] = parseFloat((b[col] || 0).toFixed(4));
        }
        return r;
      });

      return {
        rows: aggregatedRows,
        columns: [temporalCol, ...numericCols.slice(0, 5)],
        _meta: { aggregated: true, agg, buckets: timeBuckets.length, originalRows: rows.length },
      };
    }
  }

  if (rows.length <= LARGE_DATASET_THRESHOLD) {
    return { rows, columns };
  }

  const categoricalCol = detectGroupColumn(rows, columns, numericCols);
  const stats = summaryStats(rows, columns);
  const groupedResults = [];

  if (numericCols.length > 0) {
    const primaryGroupCol = isTrendQuery && temporalCol
      ? temporalCol
      : categoricalCol || temporalCol;

    if (primaryGroupCol) {
      const grouped = groupBy(rows, primaryGroupCol, numericCols.slice(0, 4));
      if (grouped.length > 0) groupedResults.push({ groupCol: primaryGroupCol, groups: grouped });
    }

    if (questionWantsGroupBy(question) && temporalCol && categoricalCol && temporalCol !== categoricalCol) {
      const grouped2 = groupBy(rows, categoricalCol, numericCols.slice(0, 4));
      if (grouped2.length > 0) groupedResults.push({ groupCol: categoricalCol, groups: grouped2 });
    }
  }

  return {
    rows,
    columns,
    _meta: { stats, groupedResults, sampleRows: representativeSample(rows, 40), totalRows: rows.length },
  };
}

function attachFinalAnswer(base, meta, verificationNote) {
  let answer = appendDataUsedIfMissing(base.answer, meta);
  if (verificationNote) {
    answer += `\n\n${verificationNote}`;
  }
  return { ...base, answer, verificationNote: verificationNote || undefined };
}

/**
 * @param {{ question: string, dataset: { rows?: object[], columns?: string[] } }} params
 */
async function getInsight({ question, dataset }) {
  const allRows = Array.isArray(dataset?.rows) ? dataset.rows : [];
  const columns =
    Array.isArray(dataset?.columns) && dataset.columns.length > 0
      ? dataset.columns
      : inferColumnsFromRows(allRows);

  const trimmed = String(question || "").trim();

  if (isSourceTransparencyQuestion(trimmed)) {
    const prev = datasetStore.getLastQueryMeta();
    if (!prev) {
      return {
        answer:
          "No prior answer metadata is stored yet. Ask a data question first, then request **which columns and rows** were used.",
        source: "rule-based",
      };
    }
    const text = [
      "Here is the **stored computation metadata** from the last answer (no new query was run):",
      "",
      `• **Columns used:** ${(prev.columnsUsed || []).join(", ") || "n/a"}`,
      `• **Filter applied:** ${prev.filterApplied || "none"}`,
      `• **Time window:** ${prev.timeWindow || "none"}`,
      `• **Group by:** ${prev.groupBy || "none"}`,
      `• **Rows used:** ${prev.rowCount ?? "?"} of ${prev.totalRows ?? "?"} total rows in the upload`,
    ].join("\n");
    return { answer: text, source: "rule-based" };
  }

  const numericColumns = getNumericColumns(allRows, columns);
  const { filteredRows, filters, filterDescription } = filterDataset({
    question: trimmed,
    rows: allRows,
    columns,
    numericColumns,
  });

  const rows = filteredRows.length > 0 ? filteredRows : allRows;
  const wasFiltered = filters.length > 0 && filteredRows.length > 0;

  const intent = parseIntent(trimmed);
  const metrics = resolveMetrics({ question: trimmed, columns, rows });
  const numericSet = new Set(getNumericColumns(rows, columns));
  const { column: resolvedDateCol } = findBestDateColumn(rows, columns, numericSet);
  const dateCol = resolvedDateCol || detectTemporalColumn(columns);

  const ambiguous = detectAmbiguousRelativeTime(trimmed, rows, dateCol);
  if (ambiguous?.message) {
    const dataUsed = buildDataUsedMeta({
      columnsUsed: columns.slice(0, 12),
      filterDescription: wasFiltered ? filterDescription : null,
      timeBundle: {},
      rowCount: rows.length,
      totalRows: allRows.length,
    });
    const shaped = shapeApiResponse(
      { answer: ambiguous.message, source: "rule-based" },
      {
        dataUsed,
        suggestedQuestions: suggestFollowUps({ columns, question: trimmed, dateCol }),
        clarifying: true,
      }
    );
    const out = attachFinalAnswer(shaped, dataUsed, "");
    persistQueryMeta(dataUsed, {});
    return out;
  }

  const timeBundle = dateCol ? resolveComparisonWindows(trimmed, rows, dateCol, intent) : {};

  let pipelineRows = rows;
  const tr = timeBundle.resolvedTimeRange;
  const cmp = timeBundle.comparison;
  const hasPairWindow =
    cmp &&
    Number.isFinite(cmp.start) &&
    Number.isFinite(cmp.end) &&
    tr &&
    Number.isFinite(tr.start) &&
    Number.isFinite(tr.end);
  if (dateCol && tr && Number.isFinite(tr.start) && Number.isFinite(tr.end) && !hasPairWindow) {
    const scoped = filterRowsBySortKeyRange(rows, dateCol, tr.start, tr.end);
    if (scoped.length > 0) pipelineRows = scoped;
  }

  const deterministic = runDeterministicPipeline({
    question: trimmed,
    rows: pipelineRows,
    columns,
    intent,
    metrics,
    dateCol,
    timeBundle,
    filterDescription: wasFiltered ? filterDescription : "",
  });

  if (deterministic && typeof deterministic.answer === "string" && deterministic.answer.trim()) {
    let merged = deterministic;
    if (wasFiltered && !/\*\([^)]*Filter/i.test(merged.answer)) {
      merged = {
        ...merged,
        answer: `*(Filtered: ${filterDescription} — ${pipelineRows.length} of ${allRows.length} rows)*\n\n${merged.answer}`,
      };
    }
    const colsUsed = columnsUsedFromContext(metrics, dateCol, merged);
    const dataUsed = buildDataUsedMeta({
      columnsUsed: colsUsed.length ? colsUsed : [metrics.primaryColumn].filter(Boolean),
      filterDescription: wasFiltered ? filterDescription : null,
      timeBundle,
      rowCount: pipelineRows.length,
      totalRows: allRows.length,
    });
    const shaped = shapeApiResponse(merged, {
      dataUsed,
      suggestedQuestions: suggestFollowUps({ columns, question: trimmed, dateCol }),
    });
    const out = attachFinalAnswer(shaped, dataUsed, "✓ Verified (computed from your CSV)");
    persistQueryMeta(dataUsed, {
      groupBy: (merged.resolvedDimensions && merged.resolvedDimensions.join(", ")) || null,
    });
    return out;
  }

  const ruled = tryRuleBasedAnswer({ question: trimmed, rows: pipelineRows, columns });
  if (ruled) {
    if (wasFiltered && ruled.answer) {
      ruled.answer =
        `*(Filtered: ${filterDescription} — ${pipelineRows.length} of ${allRows.length} rows)*\n\n` +
        ruled.answer;
    }
    let chartData = ruled.chartData;
    if (!chartData) {
      chartData = tryInferChartFromRows(trimmed, pipelineRows, columns, getNumericColumns(pipelineRows, columns));
    }
    const withChart = chartData ? { ...ruled, chartData } : ruled;
    const colsUsed = columnsUsedFromContext(metrics, dateCol, null);
    const dataUsed = buildDataUsedMeta({
      columnsUsed: colsUsed.length ? colsUsed : columns.slice(0, 6),
      filterDescription: wasFiltered ? filterDescription : null,
      timeBundle,
      rowCount: pipelineRows.length,
      totalRows: allRows.length,
    });
    const shaped = shapeApiResponse(withChart, {
      dataUsed,
      suggestedQuestions: suggestFollowUps({ columns, question: trimmed, dateCol }),
    });
    const outR = attachFinalAnswer(shaped, dataUsed, "✓ Verified (computed from your CSV)");
    persistQueryMeta(dataUsed, {});
    return outR;
  }

  const payload = buildLLMPayload({ question: trimmed, rows: pipelineRows, columns });

  const filterNote = wasFiltered
    ? `[Dataset pre-filtered: ${filterDescription} — ${pipelineRows.length} of ${allRows.length} rows.]`
    : "";
  const aggNote = payload._meta?.aggregated
    ? `[Data has been pre-aggregated into ${payload._meta.buckets} monthly buckets (${payload._meta.agg} per period) from ${payload._meta.originalRows} original rows. Use these aggregated values directly — do NOT re-aggregate.]`
    : "";
  const contextNote = [filterNote, aggNote].filter(Boolean).join(" ");

  const questionWithContext = contextNote
    ? `${trimmed}\n\n${contextNote}`
    : trimmed;

  let ai = await askGroqForInsight({
    question: questionWithContext,
    rows: payload.rows,
    columns: payload.columns,
  });

  let verificationNote = "";
  if (metrics.primaryColumn) {
    const v = verifyAnswerAgainstRows(ai.answer, pipelineRows, metrics.primaryColumn);
    if (v.status === "mismatch" && v.correctedTotal != null) {
      ai = {
        ...ai,
        answer: applyVerifiedCurrency(ai.answer, v.correctedTotal),
      };
      verificationNote = v.note;
    } else if (v.status === "match") {
      verificationNote = v.note;
    }
  }

  if (!ai.chartData) {
    const inferred = tryInferChartFromRows(trimmed, pipelineRows, columns, getNumericColumns(pipelineRows, columns));
    if (inferred) ai = { ...ai, chartData: inferred };
  }

  const colsUsed = Array.isArray(payload.columns) ? payload.columns : columns.slice(0, 10);
  const dataUsed = buildDataUsedMeta({
    columnsUsed: colsUsed,
    filterDescription: wasFiltered ? filterDescription : null,
    timeBundle,
    rowCount: pipelineRows.length,
    totalRows: allRows.length,
  });

  const shaped = shapeApiResponse(ai, {
    dataUsed,
    suggestedQuestions: suggestFollowUps({ columns, question: trimmed, dateCol }),
  });

  const outAi = attachFinalAnswer(shaped, dataUsed, verificationNote);
  persistQueryMeta(dataUsed, {});
  return outAi;
}

module.exports = { getInsight };
