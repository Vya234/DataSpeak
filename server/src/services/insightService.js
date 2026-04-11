/**
 * insightService.js — Hybrid insight orchestrator.
 *
 * Routing flow:
 *   1. Validate + normalise dataset
 *   2. *** Extract + apply categorical filters from the question ***
 *   3. Try rule-based engine on the FILTERED dataset
 *   4. If no rule matched → enrich context and send FILTERED data to Groq
 *
 * Filtering happens exactly once, here, so neither the rule engine nor
 * the LLM ever sees rows that don't match the user's intent.
 */

const { tryRuleBasedAnswer } = require("./ruleBasedQuery");
const { askGroqForInsight } = require("./groqService");
const {
  inferColumnsFromRows,
  getNumericColumns,
  groupBy,
  groupByTime,
  detectTrend,
  summaryStats,
  detectTemporalColumn,
  detectGroupColumn,
  representativeSample,
} = require("../utils/datasetAnalysis");
const { filterDataset } = require("../utils/filterDataset");

const LARGE_DATASET_THRESHOLD = 200;

// ─── INTENT HELPERS ───────────────────────────────────────────────────────────

function questionWantsTrend(q) {
  return /\b(trend|over time|progress|growth|decline|change|month.over|year.over|increase|decrease|fluctuat)\b/i.test(q);
}

function questionWantsGroupBy(q) {
  return /\b(by |per |each |breakdown|group|segment|categor)\b/i.test(q);
}

// ─── LARGE-DATASET / TIME-SERIES ENRICHMENT ──────────────────────────────────

/**
 * Builds the optimal payload for Groq:
 *
 * - Time-series query + temporal column present:
 *     → convert to monthly aggregated rows (clean, 8–15 points)
 *     → Groq receives tidy time-series instead of 31 noisy raw rows
 *
 * - Large dataset (>200 rows), non-time-series:
 *     → summary stats + grouped aggregations + representative sample
 *
 * - Small dataset: pass full rows unchanged.
 *
 * Always operates on the already-filtered rows.
 */
function buildLLMPayload({ question, rows, columns }) {
  const numericCols = getNumericColumns(rows, columns);
  const temporalCol = detectTemporalColumn(columns);
  const isTrendQuery = questionWantsTrend(question);

  // ── Time-series path ──────────────────────────────────────────────────────
  if (isTrendQuery && temporalCol && numericCols.length > 0) {
    const avgKeywords = /\b(price|rate|ratio|score|rating|index|temperature|avg|average|mean|percent|%)\b/i;
    const agg = avgKeywords.test(question) ? "avg" : "sum";

    // Aggregate ALL numeric cols into monthly buckets — gives Groq clean data
    const timeBuckets = groupByTime(rows, temporalCol, numericCols.slice(0, 5), agg);

    if (timeBuckets.length >= 2) {
      // Convert bucket objects to plain rows Groq can read
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

  // ── Small dataset: full data ──────────────────────────────────────────────
  if (rows.length <= LARGE_DATASET_THRESHOLD) {
    return { rows, columns };
  }

  // ── Large dataset: stats + grouped + sample ───────────────────────────────
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

// ─── MAIN ORCHESTRATOR ────────────────────────────────────────────────────────

/**
 * Hybrid insight: filter → rule-based → Groq.
 * Response always includes `source`.
 *
 * @param {{ question: string, dataset: { rows?: object[], columns?: string[] } }} params
 * @returns {Promise<{ answer: string, source: 'rule-based' | 'AI', chartData?: object }>}
 */
async function getInsight({ question, dataset }) {
  // ── 1. Normalise dataset ────────────────────────────────────────────────────
  const allRows = Array.isArray(dataset?.rows) ? dataset.rows : [];
  const columns =
    Array.isArray(dataset?.columns) && dataset.columns.length > 0
      ? dataset.columns
      : inferColumnsFromRows(allRows);

  const trimmed = String(question || "").trim();

  // ── 2. Extract + apply categorical filters ──────────────────────────────────
  const numericColumns = getNumericColumns(allRows, columns);
  const { filteredRows, filters, filterDescription } = filterDataset({
    question: trimmed,
    rows: allRows,
    columns,
    numericColumns,
  });

  // If filtering wiped out all rows (bad match), fall back to full dataset
  const rows = filteredRows.length > 0 ? filteredRows : allRows;
  const wasFiltered = filters.length > 0 && filteredRows.length > 0;

  // ── 3. Rule-based engine on filtered data ───────────────────────────────────
  const ruled = tryRuleBasedAnswer({ question: trimmed, rows, columns });
  if (ruled) {
    // Annotate the answer so the user knows filtering was applied
    if (wasFiltered && ruled.answer) {
      ruled.answer =
        `*(Filtered: ${filterDescription} — ${rows.length} of ${allRows.length} rows)*\n\n` +
        ruled.answer;
    }
    return ruled;
  }

  // ── 4. Groq with enriched, filtered context ─────────────────────────────────
  const payload = buildLLMPayload({ question: trimmed, rows, columns });

  // Inject filter + aggregation context so the LLM is fully aware of what it's seeing
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

  return askGroqForInsight({
    question: questionWithContext,
    rows: payload.rows,
    columns: payload.columns,
  });
}

module.exports = { getInsight };