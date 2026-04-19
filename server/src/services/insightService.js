/**
 * insightService.js — Deterministic-first orchestrator + explain-only LLM.
 */

const crypto = require("crypto");
const { tryRuleBasedAnswer } = require("./ruleBasedQuery");
const { askGroqForInsight } = require("./groqService");
const { runDeterministicPipeline } = require("./deterministicAnalytics");
const { parseIntent } = require("./intentParser");
const { detectIntent: detectIntentLabel } = require("./intentClassifier");
const { buildStructuredQuery } = require("./structuredQuery");
const { resolveMetrics } = require("./metricResolver");
const { findBestDateColumn, resolveComparisonWindows, filterRowsBySortKeyRange } = require("./timeResolver");
const {
  inferColumnsFromRows,
  getNumericColumns,
  detectTemporalColumn,
  parseNumber,
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
const {
  buildMissingReferencedMetricMessage,
  buildUnmatchedQuestionMessage,
} = require("../lib/insightFallbackMessages");
const { applyNumericGuardrails } = require("./verifier");
const { datasetStore } = require("../utils/datasetStore");
const {
  comparisonAnalysis,
  trendAnalysis,
  breakdownAnalysis,
  summaryAnalysis,
  driverAnalysis,
  looksLikePairwiseComparisonQuestion,
} = require("./queryAnalysis");

const insightCache = new Map();
const CACHE_MAX = 200;
const CACHE_TTL_MS = 120_000;

function datasetFingerprint(columns, rowCount) {
  return crypto.createHash("sha256").update(`${(columns || []).join("|")}#${rowCount}`).digest("hex").slice(0, 24);
}

function cacheGet(key) {
  const e = insightCache.get(key);
  if (!e) return null;
  if (Date.now() > e.exp) {
    insightCache.delete(key);
    return null;
  }
  return e.value;
}

function cacheSet(key, value) {
  if (insightCache.size > CACHE_MAX) {
    insightCache.delete(insightCache.keys().next().value);
  }
  insightCache.set(key, { value, exp: Date.now() + CACHE_TTL_MS });
}

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

function mapSource(rawSource) {
  if (rawSource === "AI") return "AI";
  /* "rule-based" keeps ChatPanel SourceBadge working (computed path). */
  return "rule-based";
}

function pickConfidence(raw, mappedSource) {
  if (raw?.confidence === "high" || raw?.confidence === "medium" || raw?.confidence === "low") {
    return raw.confidence;
  }
  if (mappedSource === "AI") return "medium";
  return "high";
}

function shapeApiResponse(raw, extras = {}) {
  const answer0 = typeof raw?.answer === "string" ? raw.answer : "";
  const source = mapSource(raw?.source);
  const confidence = pickConfidence(raw, source);
  const chartData = sanitizeChartData(raw?.chartData);
  const out = { answer: answer0, source, confidence };
  if (chartData) out.chartData = chartData;
  if (extras.dataUsed) out.dataUsed = extras.dataUsed;
  if (Array.isArray(extras.suggestedQuestions) && extras.suggestedQuestions.length) {
    out.suggestedQuestions = extras.suggestedQuestions;
  }
  if (extras.clarifying) out.clarifying = true;
  return out;
}

function attachFinalAnswer(base, meta, verificationNote) {
  let answer = appendDataUsedIfMissing(base.answer, meta);
  if (verificationNote) {
    answer += `\n\n${verificationNote}`;
  }
  return { ...base, answer, verificationNote: verificationNote || undefined };
}

function computedSummaryForGuardrails(metrics, pipelineRows) {
  const col = metrics?.primaryColumn;
  if (!col) return null;
  let sum = 0;
  for (const r of pipelineRows || []) {
    const n = parseNumber(r?.[col]);
    if (n !== null) sum += n;
  }
  const looksCurrency = /revenue|sales|cost|spend|price|amount|profit|income/i.test(col);
  const bulletFacts = looksCurrency
    ? `**Computed total (${col}):** $${sum.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `**Computed total (${col}):** ${sum.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
  return {
    bulletFacts,
    currencyTargets: looksCurrency ? [sum] : [],
    percentTargets: [],
  };
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
  const fp = datasetFingerprint(columns, allRows.length);
  const cacheKey = `${fp}::${trimmed.toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  if (isSourceTransparencyQuestion(trimmed)) {
    const prev = datasetStore.getLastQueryMeta();
    if (!prev) {
      const out = {
        answer:
          "No prior answer metadata is stored yet. Ask a data question first, then request **which columns and rows** were used.",
        source: "rule-based",
        confidence: "high",
      };
      cacheSet(cacheKey, out);
      return out;
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
    const out = { answer: text, source: "rule-based", confidence: "high" };
    cacheSet(cacheKey, out);
    return out;
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
  const intentLabel = detectIntentLabel(trimmed);
  const metrics = resolveMetrics({ question: trimmed, columns, rows });

  if (metrics.missingRequestedMetricId) {
    const answer = buildMissingReferencedMetricMessage(metrics.numericColumns);
    const dataUsed = buildDataUsedMeta({
      columnsUsed: columns.slice(0, 12),
      filterDescription: wasFiltered ? filterDescription : null,
      timeBundle: {},
      rowCount: rows.length,
      totalRows: allRows.length,
    });
    dataUsed.structuredQuery = buildStructuredQuery({
      question: trimmed,
      columns,
      metrics,
      dateCol: null,
      rows,
    });
    const shaped = shapeApiResponse(
      { answer, source: "rule-based", confidence: "low" },
      {
        dataUsed,
        suggestedQuestions: suggestFollowUps({ columns, question: trimmed, dateCol: null, rows }),
      }
    );
    const out = attachFinalAnswer(shaped, dataUsed, "");
    persistQueryMeta(dataUsed, {});
    cacheSet(cacheKey, out);
    return out;
  }

  const numericSet = new Set(getNumericColumns(rows, columns));
  const { column: resolvedDateCol } = findBestDateColumn(rows, columns, numericSet);
  const dateCol = resolvedDateCol || detectTemporalColumn(columns);
  const structuredQuery = buildStructuredQuery({ question: trimmed, columns, metrics, dateCol, rows });

  const ambiguous = detectAmbiguousRelativeTime(trimmed, rows, dateCol);
  if (ambiguous?.message) {
    const dataUsed = buildDataUsedMeta({
      columnsUsed: columns.slice(0, 12),
      filterDescription: wasFiltered ? filterDescription : null,
      timeBundle: {},
      rowCount: rows.length,
      totalRows: allRows.length,
    });
    dataUsed.structuredQuery = structuredQuery;
    const shaped = shapeApiResponse(
      { answer: ambiguous.message, source: "rule-based", confidence: "high" },
      {
        dataUsed,
        suggestedQuestions: suggestFollowUps({ columns, question: trimmed, dateCol, rows }),
        clarifying: true,
      }
    );
    const out = attachFinalAnswer(shaped, dataUsed, "");
    persistQueryMeta(dataUsed, {});
    cacheSet(cacheKey, out);
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
    dataUsed.structuredQuery = structuredQuery;
    const shaped = shapeApiResponse(
      { ...merged, source: merged.source || "rule-based", confidence: merged.confidence || "high" },
      {
        dataUsed,
        suggestedQuestions: suggestFollowUps({ columns, question: trimmed, dateCol, rows: pipelineRows }),
      }
    );
    const out = attachFinalAnswer(shaped, dataUsed, "✓ Verified (computed from your CSV)");
    persistQueryMeta(dataUsed, {
      groupBy: (merged.resolvedDimensions && merged.resolvedDimensions.join(", ")) || null,
    });
    cacheSet(cacheKey, out);
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
    dataUsed.structuredQuery = structuredQuery;
    const shaped = shapeApiResponse(
      { ...withChart, source: withChart.source || "rule-based", confidence: "high" },
      {
        dataUsed,
        suggestedQuestions: suggestFollowUps({ columns, question: trimmed, dateCol, rows: pipelineRows }),
      }
    );
    const outR = attachFinalAnswer(shaped, dataUsed, "✓ Verified (computed from your CSV)");
    persistQueryMeta(dataUsed, {});
    cacheSet(cacheKey, outR);
    return outR;
  }

  const qaCtx = {
    question: trimmed,
    rows: pipelineRows,
    columns,
    metrics,
    dateCol,
    timeBundle,
    intent,
  };

  let qa =
    (intentLabel === "why" && driverAnalysis(qaCtx)) ||
    (looksLikePairwiseComparisonQuestion(trimmed) && comparisonAnalysis(qaCtx)) ||
    ((intentLabel === "trend" || questionWantsTrend(trimmed)) && trendAnalysis(qaCtx)) ||
    (intentLabel === "breakdown" && breakdownAnalysis(qaCtx)) ||
    (intentLabel === "summary" &&
      summaryAnalysis({ rows: pipelineRows, columns, metrics, dateCol, question: trimmed }));

  if (qa && typeof qa.answer === "string" && qa.answer.trim()) {
    if (wasFiltered && !/\*\([^)]*Filter/i.test(qa.answer)) {
      qa = {
        ...qa,
        answer: `*(Filtered: ${filterDescription} — ${pipelineRows.length} of ${allRows.length} rows)*\n\n${qa.answer}`,
      };
    }
    const colsUsed = columnsUsedFromContext(metrics, dateCol, qa);
    const dataUsed = buildDataUsedMeta({
      columnsUsed: colsUsed.length ? colsUsed : columns.slice(0, 8),
      filterDescription: wasFiltered ? filterDescription : null,
      timeBundle,
      rowCount: pipelineRows.length,
      totalRows: allRows.length,
    });
    dataUsed.structuredQuery = structuredQuery;
    const shaped = shapeApiResponse(
      { ...qa, source: qa.source === "computed" ? "rule-based" : qa.source, confidence: qa.confidence || "high" },
      {
        dataUsed,
        suggestedQuestions: suggestFollowUps({ columns, question: trimmed, dateCol, rows: pipelineRows }),
      }
    );
    const outQa = attachFinalAnswer(shaped, dataUsed, "✓ Verified (computed from your CSV)");
    persistQueryMeta(dataUsed, {});
    cacheSet(cacheKey, outQa);
    return outQa;
  }

  if (intentLabel === "summary" || intentLabel === "unknown") {
    const answer = buildUnmatchedQuestionMessage(columns);
    const colsUsed = columns.slice(0, 12);
    const dataUsed = buildDataUsedMeta({
      columnsUsed: colsUsed.length ? colsUsed : columns,
      filterDescription: wasFiltered ? filterDescription : null,
      timeBundle,
      rowCount: pipelineRows.length,
      totalRows: allRows.length,
    });
    dataUsed.structuredQuery = structuredQuery;
    const shaped = shapeApiResponse(
      { answer, source: "rule-based", confidence: "low" },
      {
        dataUsed,
        suggestedQuestions: suggestFollowUps({ columns, question: trimmed, dateCol, rows: pipelineRows }),
      }
    );
    const outFb = attachFinalAnswer(shaped, dataUsed, "");
    persistQueryMeta(dataUsed, {});
    cacheSet(cacheKey, outFb);
    return outFb;
  }

  let ai = await askGroqForInsight({
    question: trimmed,
    rows: pipelineRows,
    columns,
    metrics,
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

  const guardCtx = computedSummaryForGuardrails(metrics, pipelineRows);
  if (guardCtx && ai?.source === "AI") {
    const g = applyNumericGuardrails(ai.answer, guardCtx);
    ai = { ...ai, answer: g.text };
  }

  if (!ai.chartData) {
    const inferred = tryInferChartFromRows(trimmed, pipelineRows, columns, getNumericColumns(pipelineRows, columns));
    if (inferred) ai = { ...ai, chartData: inferred };
  }

  const colsUsed = columns.slice(0, 12);
  const dataUsed = buildDataUsedMeta({
    columnsUsed: colsUsed,
    filterDescription: wasFiltered ? filterDescription : null,
    timeBundle,
    rowCount: pipelineRows.length,
    totalRows: allRows.length,
  });
  dataUsed.structuredQuery = structuredQuery;

  const shaped = shapeApiResponse(ai, {
    dataUsed,
    suggestedQuestions: suggestFollowUps({ columns, question: trimmed, dateCol, rows: pipelineRows }),
  });

  const outAi = attachFinalAnswer(shaped, dataUsed, verificationNote);
  persistQueryMeta(dataUsed, {});
  cacheSet(cacheKey, outAi);
  return outAi;
}

module.exports = { getInsight };
