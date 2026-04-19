const { contributionsByDimension } = require("./deterministicAnalytics");
const { computeChange } = require("./computationEngine");
const { parseNumber } = require("../utils/datasetAnalysis");

function sumMetric(rows, metricCol) {
  let s = 0;
  for (const r of rows || []) {
    const n = parseNumber(r?.[metricCol]);
    if (n !== null) s += n;
  }
  return s;
}

function analyzeWhyByCategory(curRows, prevRows, categoryCol, metricCol) {
  const currentTotal = sumMetric(curRows, metricCol);
  const previousTotal = sumMetric(prevRows, metricCol);
  const { percent: totalChangePercent } = computeChange(currentTotal, previousTotal);

  const cur = contributionsByDimension(curRows, categoryCol, metricCol);
  const prev = contributionsByDimension(prevRows, categoryCol, metricCol);
  const prevMap = new Map(prev.map((p) => [p.label, p.sum]));

  const drivers = cur
    .map((c) => {
      const p0 = prevMap.get(c.label) ?? 0;
      const { percent } = computeChange(c.sum, p0);
      return {
        category: c.label,
        delta: c.sum - p0,
        impactPercent: percent,
        current: c.sum,
        previous: p0,
      };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 20);

  return {
    totalChangePercent,
    currentTotal,
    previousTotal,
    drivers,
  };
}

module.exports = { analyzeWhyByCategory, sumMetric };
