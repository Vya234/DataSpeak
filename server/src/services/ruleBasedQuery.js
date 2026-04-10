const {
  getNumericColumns,
  sumColumn,
  avgColumn,
  countNumericInColumn,
  columnMentionedInQuestion,
  inferColumnsFromRows,
  getDefaultLabelColumn,
  extremesByValue,
  formatNumber,
  parseNumber,
} = require("../utils/datasetAnalysis");

const SOURCE_RULE = "rule-based";

/** User wants a visual comparison (chart) or explicit compare wording */
function wantsVisualization(lower) {
  return (
    /\bcompare\b/i.test(lower) ||
    /\bchart\b/i.test(lower) ||
    /\bplot\b/i.test(lower) ||
    /\bgraph\b/i.test(lower)
  );
}

function wantsTotal(lower) {
  return lower.includes("total");
}

function wantsAverage(lower) {
  return /\b(average|mean)\b/i.test(lower) || lower.includes("avg");
}

function wantsHighest(lower) {
  return (
    /\bhighest\b/i.test(lower) ||
    /\bmaximum\b/i.test(lower) ||
    /\blargest\b/i.test(lower) ||
    /\bmax\b/i.test(lower) ||
    /\btop\b/i.test(lower)
  );
}

function wantsLowest(lower) {
  return (
    /\blowest\b/i.test(lower) ||
    /\bminimum\b/i.test(lower) ||
    /\bsmallest\b/i.test(lower) ||
    /\bmin\b/i.test(lower)
  );
}

function wantsRange(lower) {
  if (/\b(range|spread)\b/i.test(lower)) return true;
  if (wantsHighest(lower) && wantsLowest(lower)) return true;
  return false;
}

function pickNumericColumn(question, numericCols) {
  if (numericCols.length === 0) return null;
  const mentioned = columnMentionedInQuestion(question, numericCols);
  if (mentioned) return mentioned;
  if (numericCols.length === 1) return numericCols[0];
  return null;
}

function tryChartRule(q, data, cols) {
  const lower = q.toLowerCase();
  if (!wantsVisualization(lower)) return null;

  const numericCols = getNumericColumns(data, cols);
  const valueCol = pickNumericColumn(q, numericCols);
  if (!valueCol) return null;

  const labelCol = getDefaultLabelColumn(data, cols, numericCols);
  if (!labelCol) return null;

  const labels = [];
  const values = [];
  for (const row of data) {
    const v = parseNumber(row?.[valueCol]);
    if (v === null) continue;
    labels.push(String(row?.[labelCol] ?? "").trim() || "—");
    values.push(v);
  }
  if (labels.length === 0) return null;

  const ex = extremesByValue(data, valueCol, labelCol);
  let answer;
  if (ex) {
    answer = `**${valueCol}** ranges from **${formatNumber(ex.min.value)}** to **${formatNumber(ex.max.value)}**, with **${ex.max.label}** highest and **${ex.min.label}** lowest.`;
  } else {
    answer = `Comparison of **${valueCol}** across **${labelCol}** (${labels.length} categories).`;
  }

  return {
    answer,
    chartData: { labels, values },
    source: SOURCE_RULE,
  };
}

function tryTotalRule(q, data, cols) {
  if (!wantsTotal(q.toLowerCase())) return null;
  const numericCols = getNumericColumns(data, cols);
  const targetCol = pickNumericColumn(q, numericCols);
  if (!targetCol) return null;

  const total = sumColumn(data, targetCol);
  const n = countNumericInColumn(data, targetCol);
  const formatted = formatNumber(total);
  return {
    answer: `Total **${targetCol}** is **${formatted}** (computed from **${n}** rows with numeric values).`,
    source: SOURCE_RULE,
  };
}

function tryAverageRule(q, data, cols) {
  if (!wantsAverage(q.toLowerCase())) return null;
  const numericCols = getNumericColumns(data, cols);
  const targetCol = pickNumericColumn(q, numericCols);
  if (!targetCol) return null;

  const avg = avgColumn(data, targetCol);
  if (avg === null) return null;
  const formatted = formatNumber(avg);
  return {
    answer: `Average **${targetCol}** is **${formatted}**, based on all numeric entries in that column.`,
    source: SOURCE_RULE,
  };
}

function tryHighestRule(q, data, cols) {
  if (!wantsHighest(q.toLowerCase()) || wantsRange(q.toLowerCase())) return null;
  const numericCols = getNumericColumns(data, cols);
  const valueCol = pickNumericColumn(q, numericCols);
  if (!valueCol) return null;

  const labelCol = getDefaultLabelColumn(data, cols, numericCols);
  const ex = extremesByValue(data, valueCol, labelCol);
  if (!ex) return null;

  return {
    answer: `**${ex.max.label}** has the highest **${valueCol}** (**${formatNumber(ex.max.value)}**).`,
    source: SOURCE_RULE,
  };
}

function tryLowestRule(q, data, cols) {
  if (!wantsLowest(q.toLowerCase()) || wantsRange(q.toLowerCase())) return null;
  const numericCols = getNumericColumns(data, cols);
  const valueCol = pickNumericColumn(q, numericCols);
  if (!valueCol) return null;

  const labelCol = getDefaultLabelColumn(data, cols, numericCols);
  const ex = extremesByValue(data, valueCol, labelCol);
  if (!ex) return null;

  return {
    answer: `**${ex.min.label}** has the lowest **${valueCol}** (**${formatNumber(ex.min.value)}**).`,
    source: SOURCE_RULE,
  };
}

function tryRangeRule(q, data, cols) {
  if (!wantsRange(q.toLowerCase())) return null;
  const numericCols = getNumericColumns(data, cols);
  const valueCol = pickNumericColumn(q, numericCols);
  if (!valueCol) return null;

  const labelCol = getDefaultLabelColumn(data, cols, numericCols);
  const ex = extremesByValue(data, valueCol, labelCol);
  if (!ex) return null;

  return {
    answer: `**${valueCol}** ranges from **${formatNumber(ex.min.value)}** to **${formatNumber(ex.max.value)}**, with **${ex.max.label}** highest and **${ex.min.label}** lowest.`,
    source: SOURCE_RULE,
  };
}

/**
 * Deterministic answers (no LLM). Order: chart → total → average → range → highest → lowest.
 * @returns {{ answer: string, source: string, chartData?: object } | null}
 */
function tryRuleBasedAnswer({ question, rows, columns }) {
  const q = String(question || "").trim();
  if (!q) return null;

  const data = Array.isArray(rows) ? rows : [];
  const cols = Array.isArray(columns) && columns.length > 0 ? columns : inferColumnsFromRows(data);
  if (cols.length === 0 || data.length === 0) return null;

  return (
    tryChartRule(q, data, cols) ||
    tryTotalRule(q, data, cols) ||
    tryAverageRule(q, data, cols) ||
    tryRangeRule(q, data, cols) ||
    tryHighestRule(q, data, cols) ||
    tryLowestRule(q, data, cols)
  );
}

module.exports = { tryRuleBasedAnswer, SOURCE_RULE };
