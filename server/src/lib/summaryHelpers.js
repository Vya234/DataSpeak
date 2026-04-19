const {
  getNumericColumns,
  columnMentionedInQuestion,
  bestFuzzyNumericColumnMatch,
  sumColumn,
  groupByTime,
} = require("../utils/datasetAnalysis");

function isRateLikeColumn(colName) {
  return /\b(rate|rates|pct|percent|percentage|ratio|score|nps|csat|satisfaction|margin|index)\b/i.test(
    String(colName)
  );
}

function userExplicitlyAskedRateOrScore(question) {
  return /\b(rate|rates|pct|percent|percentage|ratio|score|scores|nps|csat|satisfaction|margin|escalation\s+rate)\b/i.test(
    String(question || "")
  );
}

/**
 * Summary path metric: mentioned column → fuzzy phrase match → highest total sum among non-rate columns.
 * Rate/percentage-style columns are excluded unless the user explicitly asks for them.
 */
function pickSummaryMetricColumn(question, rows, columns) {
  const numericCols = getNumericColumns(rows, columns);
  if (!numericCols.length) return null;

  const mentioned = columnMentionedInQuestion(question, columns);
  if (mentioned && numericCols.includes(mentioned)) {
    if (!isRateLikeColumn(mentioned) || userExplicitlyAskedRateOrScore(question)) return mentioned;
  }

  const fz = bestFuzzyNumericColumnMatch(question, numericCols, { minScore: 4, minDelta: 0.75 });
  if (fz) {
    if (!isRateLikeColumn(fz) || userExplicitlyAskedRateOrScore(question)) return fz;
  }

  let best = null;
  let bestSum = -Infinity;
  for (const c of numericCols) {
    if (isRateLikeColumn(c) && !userExplicitlyAskedRateOrScore(question)) continue;
    const s = sumColumn(rows, c);
    if (s > bestSum) {
      bestSum = s;
      best = c;
    }
  }
  if (best) return best;

  if (mentioned && numericCols.includes(mentioned)) return mentioned;
  return numericCols[0];
}

function formatIdForValue(metrics, col) {
  if (!metrics?.columnMap) return col;
  const entry = Object.entries(metrics.columnMap).find(([, c]) => c === col);
  return entry ? entry[0] : col;
}

function coerceSummaryRequestedGrain(requested) {
  if (requested === "day") return "day";
  if (requested === "week") return "week";
  return "month";
}

function nextCoarserGrain(grain) {
  if (grain === "day") return "week";
  if (grain === "week") return "month";
  return null;
}

function grainAdjective(grain) {
  if (grain === "day") return "daily";
  if (grain === "week") return "weekly";
  return "monthly";
}

/**
 * Picks effective time grain and runs groupByTime until ≥2 buckets or grain cannot be coarsened.
 * Prefix is set only when the effective grain differs from the first attempted grain.
 */
function computeSummaryBucketsWithFallback(rows, temporal, valueCol, agg, requestedGrain) {
  let g = coerceSummaryRequestedGrain(requestedGrain);
  const initial = g;
  let prefix = "";

  while (true) {
    const buckets = groupByTime(rows, temporal, [valueCol], agg, g);
    if (buckets.length >= 2) {
      if (g !== initial) {
        prefix = `Showing **${grainAdjective(g)}** summary (finest granularity available in your data).\n\n`;
      }
      return { buckets, effectiveGrain: g, prefix };
    }
    const nextg = nextCoarserGrain(g);
    if (!nextg) {
      if (g !== initial && buckets.length > 0) {
        prefix = `Showing **${grainAdjective(g)}** summary (finest granularity available in your data).\n\n`;
      }
      return { buckets, effectiveGrain: g, prefix };
    }
    g = nextg;
  }
}

module.exports = {
  pickSummaryMetricColumn,
  formatIdForValue,
  isRateLikeColumn,
  userExplicitlyAskedRateOrScore,
  computeSummaryBucketsWithFallback,
  grainAdjective,
};
