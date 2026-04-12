/**
 * insightService.js — Hybrid insight orchestrator.
 *
 * Routing flow:
 *   1. Validate + normalise dataset
 *   2. Extract + apply categorical filters from the question
 *   3. Deterministic analytics pipeline (filtered rows)
 *   4. Rule-based engine → Groq
 */

const { tryRuleBasedAnswer } = require("./ruleBasedQuery");
const { askGroqForInsight } = require("./groqService");
const { runDeterministicPipeline } = require("./deterministicAnalytics");
const { parseIntent } = require("./intentParser");
const { resolveMetrics } = require("./metricResolver");
const { findBestDateColumn, resolveComparisonWindows } = require("./timeResolver");
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

const LARGE_DATASET_THRESHOLD = 200;

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
  const type = ["bar", "line", "pie"].includes(chartData.type) ? chartData.type : "bar";
  return { labels, values, type };
}

function shapeApiResponse(raw) {
  const answer = typeof raw?.answer === "string" ? raw.answer : "";
  const source = raw?.source === "AI" ? "AI" : "rule-based";
  const chartData = sanitizeChartData(raw?.chartData);
  const out = { answer, source };
  if (chartData) out.chartData = chartData;
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

/**
 * @param {{ question: string, dataset: { rows?: object[], columns?: string[] } }} params
 * @returns {Promise<{ answer: string, source: 'rule-based' | 'AI', chartData?: object }>}
 */
async function getInsight({ question, dataset }) {
  const allRows = Array.isArray(dataset?.rows) ? dataset.rows : [];
  const columns =
    Array.isArray(dataset?.columns) && dataset.columns.length > 0
      ? dataset.columns
      : inferColumnsFromRows(allRows);

  const trimmed = String(question || "").trim();

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
  const timeBundle = dateCol ? resolveComparisonWindows(trimmed, rows, dateCol, intent) : {};

  const deterministic = runDeterministicPipeline({
    question: trimmed,
    rows,
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
        answer: `*(Filtered: ${filterDescription} — ${rows.length} of ${allRows.length} rows)*\n\n${merged.answer}`,
      };
    }
    return shapeApiResponse(merged);
  }

  const ruled = tryRuleBasedAnswer({ question: trimmed, rows, columns });
  if (ruled) {
    if (wasFiltered && ruled.answer) {
      ruled.answer =
        `*(Filtered: ${filterDescription} — ${rows.length} of ${allRows.length} rows)*\n\n` +
        ruled.answer;
    }
    return shapeApiResponse(ruled);
  }

  const payload = buildLLMPayload({ question: trimmed, rows, columns });

  const filterNote = wasFiltered
    ? `[Dataset pre-filtered: ${filterDescription} — ${rows.length} of ${allRows.length} rows.]`
    : "";
  const aggNote = payload._meta?.aggregated
    ? `[Data has been pre-aggregated into ${payload._meta.buckets} monthly buckets (${payload._meta.agg} per period) from ${payload._meta.originalRows} original rows. Use these aggregated values directly — do NOT re-aggregate.]`
    : "";
  const contextNote = [filterNote, aggNote].filter(Boolean).join(" ");

  const questionWithContext = contextNote
    ? `${trimmed}\n\n${contextNote}`
    : trimmed;

  const ai = await askGroqForInsight({
    question: questionWithContext,
    rows: payload.rows,
    columns: payload.columns,
  });
  return shapeApiResponse(ai);
}

module.exports = { getInsight };
