/**
 * ruleBasedQuery.js — Enhanced deterministic query engine.
 * Additions: trend detection, groupBy aggregation, top/bottom N, smarter answer text.
 */

const {
  getNumericColumns,
  sumColumn,
  avgColumn,
  minColumn,
  maxColumn,
  countNumericInColumn,
  columnMentionedInQuestion,
  inferColumnsFromRows,
  getDefaultLabelColumn,
  extremesByValue,
  formatNumber,
  parseNumber,
  groupBy,
  groupByTime,
  detectTrend,
  linearRegression,
  summaryStats,
  detectTemporalColumn,
  detectGroupColumn,
} = require("../utils/datasetAnalysis");

const SOURCE_RULE = "rule-based";

// ─── INTENT DETECTION ─────────────────────────────────────────────────────────

function wantsVisualization(lower) {
  return /\b(compare|chart|plot|graph|visuali[sz]e)\b/i.test(lower);
}
function wantsTotal(lower) {
  return /\b(total|sum|overall|cumulative|combined)\b/i.test(lower);
}
function wantsAverage(lower) {
  return /\b(average|mean|avg)\b/i.test(lower);
}
function wantsHighest(lower) {
  return /\b(highest|maximum|largest|max|top|best|most)\b/i.test(lower);
}
function wantsLowest(lower) {
  return /\b(lowest|minimum|smallest|min|bottom|worst|least)\b/i.test(lower);
}
function wantsRange(lower) {
  if (/\b(range|spread|difference between high|diff)\b/i.test(lower)) return true;
  if (wantsHighest(lower) && wantsLowest(lower)) return true;
  return false;
}
function wantsTrend(lower) {
  return /\b(trend|over time|over the|across|progress|growth|decline|change|increase|decrease|month[ -]over|year[ -]over|week[ -]over|fluctuat)\b/i.test(lower);
}
function wantsGroupBy(lower) {
  return /\b(by |per |each |breakdown|group|segment|categor|split)\b/i.test(lower);
}
function wantsCount(lower) {
  return /\b(count|how many|number of|total number|tally)\b/i.test(lower);
}
function wantsTopN(lower) {
  const m = lower.match(/\btop[\s-]?(\d+)\b/);
  return m ? parseInt(m[1], 10) : null;
}
function wantsBottomN(lower) {
  const m = lower.match(/\bbottom[\s-]?(\d+)\b/);
  return m ? parseInt(m[1], 10) : null;
}

// ─── COLUMN SELECTION ─────────────────────────────────────────────────────────

function pickNumericColumn(question, numericCols) {
  if (numericCols.length === 0) return null;
  const mentioned = columnMentionedInQuestion(question, numericCols);
  if (mentioned) return mentioned;
  if (numericCols.length === 1) return numericCols[0];
  return null;
}

// ─── RULES ────────────────────────────────────────────────────────────────────

/** TREND RULE — aggregates into time buckets before analysis */
function tryTrendRule(q, data, cols) {
  const lower = q.toLowerCase();
  if (!wantsTrend(lower)) return null;

  const numericCols = getNumericColumns(data, cols);
  const valueCol = pickNumericColumn(q, numericCols);
  if (!valueCol) return null;

  const temporalCol = detectTemporalColumn(cols);
  const labelCol = temporalCol || getDefaultLabelColumn(data, cols, numericCols);

  // ── Determine aggregation method ──────────────────────────────────────────
  // Flow metrics (sales, revenue, profit, cost, quantity) → sum per period
  // Stock/rate metrics (price, rating, score, %) → average per period
  const avgKeywords = /\b(price|rate|ratio|score|rating|index|temperature|avg|average|mean|percent|%)\b/i;
  const agg = avgKeywords.test(valueCol) ? "avg" : "sum";

  // ── Detect trend (aggregates into monthly buckets internally) ─────────────
  const trend = detectTrend(data, valueCol, labelCol, agg);
  if (!trend) return null;

  const { direction, from, to, min, max, labels, values, aggregated } = trend;

  // ── Compute overall change ────────────────────────────────────────────────
  const change = to - from;
  const changePct = from !== 0 ? ((change / Math.abs(from)) * 100).toFixed(1) : null;
  const changePctStr =
    changePct !== null ? ` (${change >= 0 ? "+" : ""}${changePct}%)` : "";

  const firstLabel = labels[0] || "the start";
  const lastLabel = labels[labels.length - 1] || "the end";
  const periodLabel = aggregated ? "month" : "period";

  // ── Compose human-readable sentence ──────────────────────────────────────
  const directionSentences = {
    "upward":
      `**${valueCol}** shows a clear **upward trend**, rising from **${formatNumber(from)}** (${firstLabel}) to **${formatNumber(to)}** (${lastLabel})${changePctStr}. This consistent growth suggests a positive trajectory worth sustaining.`,
    "downward":
      `**${valueCol}** shows a **downward trend**, falling from **${formatNumber(from)}** (${firstLabel}) to **${formatNumber(to)}** (${lastLabel})${changePctStr}. This consistent decline may warrant investigation.`,
    "stable":
      `**${valueCol}** remains **stable** over the observed period, hovering between **${formatNumber(min)}** and **${formatNumber(max)}** with no significant directional movement.`,
    "overall upward with fluctuations":
      `**${valueCol}** shows an **overall upward trend** with minor fluctuations, growing from **${formatNumber(from)}** (${firstLabel}) to **${formatNumber(to)}** (${lastLabel})${changePctStr}. Despite some month-to-month variation, the general direction is positive.`,
    "overall downward with fluctuations":
      `**${valueCol}** shows an **overall downward trend** with fluctuations, declining from **${formatNumber(from)}** (${firstLabel}) to **${formatNumber(to)}** (${lastLabel})${changePctStr}. The general direction is negative despite some recovery periods.`,
  };

  const answer =
    (directionSentences[direction] ||
      `**${valueCol}** moved from **${formatNumber(from)}** to **${formatNumber(to)}**${changePctStr} — classified as **${direction}**.`) +
    ` Range: **${formatNumber(min)}** – **${formatNumber(max)}** across **${labels.length}** ${periodLabel}s.`;

  // ── Build chart data (cap at 15 points for readability) ──────────────────
  const MAX_CHART_POINTS = 15;
  let chartLabels = labels;
  let chartValues = values;
  if (values.length > MAX_CHART_POINTS) {
    // Even downsampling that always includes first and last
    const step = (values.length - 1) / (MAX_CHART_POINTS - 1);
    const indices = Array.from({ length: MAX_CHART_POINTS }, (_, i) =>
      Math.min(Math.round(i * step), values.length - 1)
    );
    chartLabels = indices.map((i) => labels[i]);
    chartValues = indices.map((i) => parseFloat(values[i].toFixed(2)));
  } else {
    chartValues = values.map((v) => parseFloat(v.toFixed(2)));
  }

  return {
    answer,
    chartData: { labels: chartLabels, values: chartValues, type: "line" },
    source: SOURCE_RULE,
  };
}

/** GROUP BY RULE */
function tryGroupByRule(q, data, cols) {
  const lower = q.toLowerCase();
  if (!wantsGroupBy(lower)) return null;

  const numericCols = getNumericColumns(data, cols);
  if (numericCols.length === 0) return null;

  const valueCol = pickNumericColumn(q, numericCols);
  if (!valueCol) return null;

  // Find group column: mentioned in question, or auto-detect
  const nonNumeric = cols.filter((c) => !numericCols.includes(c));
  const groupCol =
    columnMentionedInQuestion(q, nonNumeric) ||
    detectGroupColumn(data, cols, numericCols);
  if (!groupCol) return null;

  const grouped = groupBy(data, groupCol, [valueCol]);
  if (grouped.length === 0) return null;

  // Top 10 for chart readability
  const top10 = grouped.slice(0, 10);
  const labels = top10.map((g) => g.group);
  const values = top10.map((g) => parseFloat((g[`${valueCol}_sum`] || 0).toFixed(2)));

  const total = values.reduce((a, b) => a + b, 0);
  const topGroup = top10[0];
  const topContrib = total > 0 ? ((topGroup[`${valueCol}_sum`] / total) * 100).toFixed(1) : null;

  const answer =
    `**${valueCol}** by **${groupCol}**: ` +
    `**${topGroup.group}** leads with **${formatNumber(topGroup[`${valueCol}_sum`])}** ` +
    (topContrib ? `(${topContrib}% of total **${formatNumber(total)}**). ` : ". ") +
    `${grouped.length > 10 ? `Showing top 10 of ${grouped.length} groups. ` : ""}` +
    `Breakdown: ${top10.slice(0, 5).map((g) => `${g.group}: ${formatNumber(g[`${valueCol}_sum`])}`).join(", ")}.`;

  return {
    answer,
    chartData: { labels, values, type: "bar" },
    source: SOURCE_RULE,
  };
}

/** CHART RULE */
function tryChartRule(q, data, cols) {
  const lower = q.toLowerCase();
  if (!wantsVisualization(lower)) return null;

  const numericCols = getNumericColumns(data, cols);
  const valueCol = pickNumericColumn(q, numericCols);
  if (!valueCol) return null;

  const labelCol = getDefaultLabelColumn(data, cols, numericCols);
  if (!labelCol) return null;

  // Group and take top 10
  const grouped = groupBy(data, labelCol, [valueCol]);
  const top10 = grouped.slice(0, 10);
  const labels = top10.map((g) => g.group);
  const values = top10.map((g) => parseFloat((g[`${valueCol}_sum`] || 0).toFixed(2)));

  if (labels.length === 0) return null;

  const ex = extremesByValue(data, valueCol, labelCol);
  let answer;
  if (ex) {
    const total = values.reduce((a, b) => a + b, 0);
    const topContrib = total > 0 ? ((ex.max.value / total) * 100).toFixed(1) : null;
    answer =
      `**${valueCol}** comparison across **${labelCol}**: ` +
      `**${ex.max.label}** is highest at **${formatNumber(ex.max.value)}** ` +
      (topContrib ? `(${topContrib}% of total), ` : "") +
      `while **${ex.min.label}** is lowest at **${formatNumber(ex.min.value)}**. ` +
      `Spread: **${formatNumber(ex.max.value - ex.min.value)}**.`;
  } else {
    answer = `Comparison of **${valueCol}** across **${labelCol}** (${labels.length} categories).`;
  }

  return {
    answer,
    chartData: { labels, values, type: "bar" },
    source: SOURCE_RULE,
  };
}

/** COUNT RULE */
function tryCountRule(q, data, cols) {
  const lower = q.toLowerCase();
  if (!wantsCount(lower)) return null;

  // Count by group if grouping intent
  const numericCols = getNumericColumns(data, cols);
  const nonNumeric = cols.filter((c) => !numericCols.includes(c));
  const groupCol =
    wantsGroupBy(lower)
      ? columnMentionedInQuestion(q, nonNumeric) || detectGroupColumn(data, cols, numericCols)
      : null;

  if (groupCol) {
    const grouped = groupBy(data, groupCol, numericCols.length ? [numericCols[0]] : []);
    const counts = {};
    for (const row of data) {
      const key = String(row?.[groupCol] ?? "").trim() || "(blank)";
      counts[key] = (counts[key] || 0) + 1;
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const top5 = sorted.slice(0, 5).map(([k, v]) => `${k}: ${v}`).join(", ");
    return {
      answer: `Total **${data.length}** rows. Count by **${groupCol}**: ${top5}${sorted.length > 5 ? " (and more)" : "."} The most frequent is **${sorted[0][0]}** with **${sorted[0][1]}** entries.`,
      source: SOURCE_RULE,
    };
  }

  return {
    answer: `The dataset contains **${data.length}** rows and **${cols.length}** columns (${cols.join(", ")}).`,
    source: SOURCE_RULE,
  };
}

/** TOP N RULE */
function tryTopNRule(q, data, cols) {
  const n = wantsTopN(q.toLowerCase());
  if (!n) return null;

  const numericCols = getNumericColumns(data, cols);
  const valueCol = pickNumericColumn(q, numericCols);
  if (!valueCol) return null;

  const labelCol = getDefaultLabelColumn(data, cols, numericCols);

  // Group first to handle duplicate categories
  const grouped = labelCol ? groupBy(data, labelCol, [valueCol]) : null;
  if (grouped && grouped.length > 0) {
    const topN = grouped.slice(0, n);
    const total = grouped.reduce((a, g) => a + (g[`${valueCol}_sum`] || 0), 0);
    const topNTotal = topN.reduce((a, g) => a + (g[`${valueCol}_sum`] || 0), 0);
    const pct = total > 0 ? ((topNTotal / total) * 100).toFixed(1) : null;

    const list = topN.map((g, i) => `${i + 1}. **${g.group}** — ${formatNumber(g[`${valueCol}_sum`])}`).join(", ");
    return {
      answer:
        `Top ${n} by **${valueCol}**: ${list}. ` +
        (pct ? `Together they account for **${pct}%** of total **${formatNumber(total)}**.` : ""),
      chartData: {
        labels: topN.map((g) => g.group),
        values: topN.map((g) => parseFloat((g[`${valueCol}_sum`] || 0).toFixed(2))),
        type: "bar",
      },
      source: SOURCE_RULE,
    };
  }

  // Fallback: raw rows
  const sorted = [...data]
    .filter((r) => parseNumber(r?.[valueCol]) !== null)
    .sort((a, b) => (parseNumber(b[valueCol]) || 0) - (parseNumber(a[valueCol]) || 0));
  const topN = sorted.slice(0, n);
  const list = topN.map((r, i) => `${i + 1}. **${formatNumber(parseNumber(r[valueCol]))}`).join(", ");
  return {
    answer: `Top ${n} values in **${valueCol}**: ${list}.`,
    source: SOURCE_RULE,
  };
}

/** BOTTOM N RULE */
function tryBottomNRule(q, data, cols) {
  const n = wantsBottomN(q.toLowerCase());
  if (!n) return null;

  const numericCols = getNumericColumns(data, cols);
  const valueCol = pickNumericColumn(q, numericCols);
  if (!valueCol) return null;

  const labelCol = getDefaultLabelColumn(data, cols, numericCols);
  const grouped = labelCol ? groupBy(data, labelCol, [valueCol]) : null;

  if (grouped && grouped.length > 0) {
    const bottomN = grouped.slice(-n).reverse();
    const list = bottomN.map((g, i) => `${i + 1}. **${g.group}** — ${formatNumber(g[`${valueCol}_sum`])}`).join(", ");
    return {
      answer: `Bottom ${n} by **${valueCol}**: ${list}.`,
      chartData: {
        labels: bottomN.map((g) => g.group),
        values: bottomN.map((g) => parseFloat((g[`${valueCol}_sum`] || 0).toFixed(2))),
        type: "bar",
      },
      source: SOURCE_RULE,
    };
  }
  return null;
}

/** TOTAL RULE */
function tryTotalRule(q, data, cols) {
  if (!wantsTotal(q.toLowerCase())) return null;
  const numericCols = getNumericColumns(data, cols);
  const targetCol = pickNumericColumn(q, numericCols);
  if (!targetCol) return null;

  const total = sumColumn(data, targetCol);
  const n = countNumericInColumn(data, targetCol);
  const avg = avgColumn(data, targetCol);
  const formatted = formatNumber(total);

  // Find top contributor group
  const labelCol = getDefaultLabelColumn(data, cols, numericCols);
  const grouped = labelCol ? groupBy(data, labelCol, [targetCol]) : [];
  const topGroup = grouped[0];
  const topContrib = topGroup && total > 0
    ? ((topGroup[`${targetCol}_sum`] / total) * 100).toFixed(1)
    : null;

  return {
    answer:
      `Total **${targetCol}** is **${formatted}** across **${n}** rows (avg: **${formatNumber(avg)}**). ` +
      (topGroup && topContrib
        ? `**${topGroup.group}** contributes the most at **${formatNumber(topGroup[`${targetCol}_sum`])}** (${topContrib}% of total).`
        : ""),
    source: SOURCE_RULE,
  };
}

/** AVERAGE RULE */
function tryAverageRule(q, data, cols) {
  if (!wantsAverage(q.toLowerCase())) return null;
  const numericCols = getNumericColumns(data, cols);
  const targetCol = pickNumericColumn(q, numericCols);
  if (!targetCol) return null;

  const avg = avgColumn(data, targetCol);
  if (avg === null) return null;

  const minVal = minColumn(data, targetCol);
  const maxVal = maxColumn(data, targetCol);
  const n = countNumericInColumn(data, targetCol);

  return {
    answer:
      `Average **${targetCol}** is **${formatNumber(avg)}** across **${n}** numeric entries. ` +
      `Values range from **${formatNumber(minVal)}** to **${formatNumber(maxVal)}**, ` +
      `a spread of **${formatNumber(maxVal - minVal)}**.`,
    source: SOURCE_RULE,
  };
}

/** HIGHEST RULE */
function tryHighestRule(q, data, cols) {
  if (!wantsHighest(q.toLowerCase()) || wantsRange(q.toLowerCase())) return null;
  const numericCols = getNumericColumns(data, cols);
  const valueCol = pickNumericColumn(q, numericCols);
  if (!valueCol) return null;

  const labelCol = getDefaultLabelColumn(data, cols, numericCols);
  const ex = extremesByValue(data, valueCol, labelCol);
  if (!ex) return null;

  const total = sumColumn(data, valueCol);
  const pct = total > 0 ? ((ex.max.value / total) * 100).toFixed(1) : null;

  return {
    answer:
      `**${ex.max.label}** has the highest **${valueCol}** at **${formatNumber(ex.max.value)}**` +
      (pct ? ` — contributing **${pct}%** of the total **${formatNumber(total)}**.` : "."),
    source: SOURCE_RULE,
  };
}

/** LOWEST RULE */
function tryLowestRule(q, data, cols) {
  if (!wantsLowest(q.toLowerCase()) || wantsRange(q.toLowerCase())) return null;
  const numericCols = getNumericColumns(data, cols);
  const valueCol = pickNumericColumn(q, numericCols);
  if (!valueCol) return null;

  const labelCol = getDefaultLabelColumn(data, cols, numericCols);
  const ex = extremesByValue(data, valueCol, labelCol);
  if (!ex) return null;

  return {
    answer: `**${ex.min.label}** has the lowest **${valueCol}** at **${formatNumber(ex.min.value)}** — the furthest from the maximum of **${formatNumber(ex.max.value)}** (**${formatNumber(ex.max.label)}**).`,
    source: SOURCE_RULE,
  };
}

/** RANGE RULE */
function tryRangeRule(q, data, cols) {
  if (!wantsRange(q.toLowerCase())) return null;
  const numericCols = getNumericColumns(data, cols);
  const valueCol = pickNumericColumn(q, numericCols);
  if (!valueCol) return null;

  const labelCol = getDefaultLabelColumn(data, cols, numericCols);
  const ex = extremesByValue(data, valueCol, labelCol);
  if (!ex) return null;

  const spread = ex.max.value - ex.min.value;
  const avg = avgColumn(data, valueCol);

  return {
    answer:
      `**${valueCol}** ranges from **${formatNumber(ex.min.value)}** (**${ex.min.label}**) ` +
      `to **${formatNumber(ex.max.value)}** (**${ex.max.label}**), ` +
      `a spread of **${formatNumber(spread)}** with an average of **${formatNumber(avg)}**.`,
    source: SOURCE_RULE,
  };
}

// ─── MAIN ENTRY POINT ────────────────────────────────────────────────────────

/**
 * Deterministic rule-based answers.
 * Order: topN → bottomN → trend → groupBy → chart → count → total → average → range → highest → lowest.
 * @returns {{ answer: string, source: string, chartData?: object } | null}
 */
function questionSeeksCausalExplanation(q) {
  const lower = String(q || "").toLowerCase();
  return (
    /\b(why|what caused|what drove|reason|reasons|how come)\b/i.test(lower) ||
    /\bcauses?\b|\bcause\b/i.test(lower) ||
    (/\b(why|what|reason|cause|explain)\b/i.test(lower) &&
      /\b(drop|drops|dropped|increase|increased|decrease|decreased)\b/i.test(lower))
  );
}

function tryRuleBasedAnswer({ question, rows, columns }) {
  const q = String(question || "").trim();
  if (!q) return null;
  if (questionSeeksCausalExplanation(q)) return null;

  const data = Array.isArray(rows) ? rows : [];
  const cols = Array.isArray(columns) && columns.length > 0 ? columns : inferColumnsFromRows(data);
  if (cols.length === 0 || data.length === 0) return null;

  return (
    tryTopNRule(q, data, cols) ||
    tryBottomNRule(q, data, cols) ||
    tryTrendRule(q, data, cols) ||
    tryGroupByRule(q, data, cols) ||
    tryChartRule(q, data, cols) ||
    tryCountRule(q, data, cols) ||
    tryTotalRule(q, data, cols) ||
    tryAverageRule(q, data, cols) ||
    tryRangeRule(q, data, cols) ||
    tryHighestRule(q, data, cols) ||
    tryLowestRule(q, data, cols)
  );
}

module.exports = { tryRuleBasedAnswer, SOURCE_RULE };