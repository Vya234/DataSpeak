const { groupByTime, detectTemporalColumn, getNumericColumns, sumColumn } = require("../utils/datasetAnalysis");

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

function isRateLikeForSuggestion(col) {
  return /\b(rate|pct|percent|percentage|score|ratio|nps|csat|margin|index|satisfaction)\b/i.test(
    String(col)
  );
}

function pickMetricForSuggestions(rows, columns, numericCols) {
  if (!numericCols.length) return null;
  const pool = numericCols.filter((c) => !isRateLikeForSuggestion(c));
  const use = pool.length ? pool : numericCols;
  let best = use[0];
  let bestSum = -Infinity;
  for (const c of use) {
    const s = sumColumn(rows, c);
    if (s > bestSum) {
      bestSum = s;
      best = c;
    }
  }
  return best;
}

function pickDimensionForSuggestions(columns, numericCols, dateCol) {
  const numSet = new Set(numericCols);
  const cats = (columns || []).filter((c) => c && !numSet.has(c) && c !== dateCol);
  if (!cats.length) return null;
  const ranked = [...cats].sort((a, b) => {
    const score = (name) => {
      const low = String(name).toLowerCase();
      let s = 0;
      if (/department|region|agent|product|category|segment|channel|team|country|sku/i.test(low)) s += 3;
      return s;
    };
    return score(b) - score(a);
  });
  return ranked[0];
}

/** Follow-up chips use real CSV column names only (no hardcoded "revenue", etc.). */
function suggestFollowUps({ columns, question, dateCol, rows }) {
  const lower = String(question || "").toLowerCase();
  if (!columns?.length) return [];

  const data = Array.isArray(rows) ? rows : [];
  const numericCols = data.length ? getNumericColumns(data, columns) : [];

  const metric = pickMetricForSuggestions(data, columns, numericCols);
  const dim = pickDimensionForSuggestions(columns, numericCols, dateCol);

  const chips = [];
  if (metric && dim) {
    const dimLow = String(dim).toLowerCase();
    if (!lower.includes(dimLow)) {
      chips.push(`Compare ${metric} by ${dim}`);
    }
  }
  if (metric && dateCol && !/\b(trend|over time|mom|wow|month over)\b/i.test(lower)) {
    chips.push(`Show ${metric} trend over time`);
  }
  if (metric && dim) {
    chips.push(`Which ${dim} has the highest ${metric}?`);
  }

  const uniq = [...new Set(chips)].filter(Boolean);
  if (uniq.length >= 3) return uniq.slice(0, 3);

  if (metric && columns.length) {
    const other = columns.find((c) => c && c !== metric && c !== dateCol);
    if (other && !uniq.some((u) => u.includes(other))) {
      uniq.push(`Compare ${metric} by ${other}`);
    }
  }
  if (uniq.length < 2 && metric) {
    uniq.push(`Total ${metric} across the dataset`);
  }
  if (uniq.length < 2 && columns[0]) {
    uniq.push(`Summarize key columns including ${columns[0]}`);
  }

  return [...new Set(uniq)].slice(0, 3);
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
