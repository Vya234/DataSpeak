/**
 * explanationFormatter.js — Turn computed evidence into NL; optional LLM is formatter-only.
 */

const {
  summaryStats,
  groupBy,
  groupByTime,
  representativeSample,
  detectTemporalColumn,
  inferColumnsFromRows,
} = require("../utils/datasetAnalysis");

const LARGE_ROW_THRESHOLD = 200;

/**
 * Compact JSON-safe evidence for LLM formatting (never raw huge row dumps).
 */
function buildStructuredEvidence({ question, rows, columns, dateCol, metrics }) {
  const cols =
    Array.isArray(columns) && columns.length > 0 ? columns : inferColumnsFromRows(rows);
  const stats = summaryStats(rows, cols);
  const temporal = dateCol || detectTemporalColumn(cols);
  const numericCols = metrics.numericColumns.slice(0, 6);

  const evidence = {
    rowCount: rows.length,
    columns: cols,
    summaryStats: stats,
    primaryMetric: metrics.primaryMetricId,
    primaryColumn: metrics.primaryColumn,
    metricColumnMap: metrics.columnMap,
  };

  if (temporal && numericCols.length) {
    evidence.timeAggregatesMonthly = groupByTime(
      rows,
      temporal,
      numericCols.slice(0, 4),
      "sum"
    ).slice(-18);
  }

  const catCols = cols.filter((c) => !numericCols.includes(c)).slice(0, 4);
  for (const c of catCols) {
    const g = groupBy(rows, c, numericCols.slice(0, 2));
    if (g.length && g.length <= 80) {
      evidence[`topGroups_${c}`] = g.slice(0, 15);
    }
  }

  if (rows.length <= LARGE_ROW_THRESHOLD) {
    evidence.sampleRows = rows;
  } else {
    evidence.sampleRows = representativeSample(rows, 35);
    evidence.note = `Sample of ${evidence.sampleRows.length} evenly spaced rows from ${rows.length} total — do not treat sample totals as full-dataset totals.`;
  }

  return evidence;
}

function factsToFallbackAnswer(evidence) {
  const lines = [];
  lines.push(`Analyzed **${evidence.rowCount}** rows.`);
  if (evidence.primaryMetric && evidence.primaryColumn) {
    const s = evidence.summaryStats?.[evidence.primaryColumn];
    if (s) {
      lines.push(
        `**${evidence.primaryColumn}**: sum **${s.sum}**, avg **${s.avg}**, min **${s.min}**, max **${s.max}**.`
      );
    }
  }
  if (evidence.timeAggregatesMonthly?.length) {
    const last = evidence.timeAggregatesMonthly[evidence.timeAggregatesMonthly.length - 1];
    lines.push(`The latest month in the series is **${last.label}**.`);
  }
  lines.push(
    "I could not match a specific deterministic question pattern; the figures above are computed directly from your filtered data."
  );
  return lines.join(" ");
}

module.exports = {
  buildStructuredEvidence,
  factsToFallbackAnswer,
  LARGE_ROW_THRESHOLD,
};
