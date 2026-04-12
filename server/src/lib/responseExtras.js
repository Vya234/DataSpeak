const { groupByTime, detectTemporalColumn } = require("../utils/datasetAnalysis");

function buildDataUsedMeta({
  columnsUsed,
  filterDescription,
  timeBundle,
  rowCount,
  totalRows,
}) {
  const timeWindow =
    timeBundle?.resolvedTimeRange?.label && timeBundle?.comparison?.label
      ? `${timeBundle.comparison.label} → ${timeBundle.resolvedTimeRange.label}`
      : timeBundle?.resolvedTimeRange?.label || null;

  return {
    columnsUsed: Array.isArray(columnsUsed) ? columnsUsed : columns || [],
    filter: filterDescription || null,
    timeWindow,
    rowCount: typeof rowCount === "number" ? rowCount : 0,
    totalRows: typeof totalRows === "number" ? totalRows : 0,
  };
}

function formatDataUsedBlock(meta) {
  const cols =
    meta.columnsUsed && meta.columnsUsed.length ? meta.columnsUsed.join(", ") : "(see dataset)";
  const filter = meta.filter || "none";
  const time = meta.timeWindow || "none";
  return (
    `\n\n─────────────────────\n` +
    `Data used\n` +
    `Columns: ${cols}\n` +
    `Filter: ${filter}\n` +
    `Time: ${time}\n` +
    `Rows: ${meta.rowCount} of ${meta.totalRows}\n` +
    `─────────────────────`
  );
}

function appendDataUsedIfMissing(answer, meta) {
  const a = String(answer || "");
  if (/\bData used\b/i.test(a)) return a;
  return a + formatDataUsedBlock(meta);
}

function suggestFollowUps({ columns, question, dateCol }) {
  const lower = String(question || "").toLowerCase();
  const chips = [];
  const hasRegion = columns.some((c) => /region|territory|area/i.test(c));
  const hasProduct = columns.some((c) => /product|sku|item/i.test(c));
  const hasRev = columns.some((c) => /revenue|sales/i.test(c));

  if (hasRegion && !lower.includes("region")) {
    chips.push("Compare revenue by region");
  }
  if (hasProduct && !lower.includes("product")) {
    chips.push("Top 5 products by revenue");
  }
  if (dateCol && !/\b(mom|month|trend)\b/i.test(lower)) {
    chips.push("Show revenue trend over time");
  }
  if (hasRev && chips.length < 3) {
    chips.push("Why did revenue change month over month?");
  }
  if (chips.length < 2) {
    chips.push("Summarize the main numeric columns");
    chips.push("Chart revenue by category if available");
  }
  return [...new Set(chips)].slice(0, 3);
}

/**
 * When server did not attach chartData, infer a simple line chart from time + first numeric column.
 */
function tryInferChartFromRows(question, rows, columns, numericCols) {
  if (!rows?.length || !columns?.length || !numericCols?.length) return null;
  const q = String(question || "").toLowerCase();
  if (!/\b(chart|plot|graph|trend|over time|breakdown|compare|by |total|sum|average|top |highest|lowest)\b/i.test(q))
    return null;
  const temporal = detectTemporalColumn(columns);
  const valueCol = numericCols[0];
  if (!temporal || !valueCol) return null;
  const buckets = groupByTime(rows, temporal, [valueCol], "sum");
  if (buckets.length < 2) return null;
  return {
    labels: buckets.map((b) => b.label),
    values: buckets.map((b) => Number(b[valueCol]) || 0),
    type: "line",
    valueAxisLabel: valueCol,
    categoryAxisLabel: temporal,
  };
}

module.exports = {
  buildDataUsedMeta,
  formatDataUsedBlock,
  appendDataUsedIfMissing,
  suggestFollowUps,
  tryInferChartFromRows,
};
