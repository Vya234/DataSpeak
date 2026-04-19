const { parseNumber, groupByTime } = require("../utils/datasetAnalysis");

function groupBySum(data, groupBy, metricColumn) {
  const map = new Map();
  for (const row of data || []) {
    const k = String(row?.[groupBy] ?? "").trim() || "(blank)";
    const n = parseNumber(row?.[metricColumn]);
    if (n === null) continue;
    map.set(k, (map.get(k) || 0) + n);
  }
  return [...map.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
}

function timeSeries(data, dateColumn, metricColumn, aggregation = "sum") {
  const agg = aggregation === "avg" ? "avg" : "sum";
  const buckets = groupByTime(data || [], dateColumn, [metricColumn], agg);
  return (buckets || []).map((b) => ({
    label: b.label,
    value: Number(b[metricColumn]) || 0,
  }));
}

function computeChange(current, previous) {
  const c = Number(current);
  const p = Number(previous);
  if (!Number.isFinite(c) || !Number.isFinite(p)) {
    return { absolute: null, percent: null };
  }
  const absolute = c - p;
  const percent = p === 0 ? (c === 0 ? 0 : null) : ((c - p) / Math.abs(p)) * 100;
  return { absolute, percent };
}

function getTopContributors(data, groupByCol, metricCol, n = 5) {
  return groupBySum(data, groupByCol, metricCol).slice(0, Math.max(0, n));
}

function seriesMeanStd(values) {
  const v = (values || []).map(Number).filter(Number.isFinite);
  if (!v.length) return { mean: 0, std: 0 };
  const mean = v.reduce((a, x) => a + x, 0) / v.length;
  const variance = v.reduce((a, x) => a + (x - mean) ** 2, 0) / v.length;
  return { mean, std: Math.sqrt(variance) };
}

function markAnomalies(points, { kSigma = 2 } = {}) {
  const vals = points.map((p) => p.value);
  const { mean, std } = seriesMeanStd(vals);
  const hi = mean + kSigma * std;
  return points.map((p) => ({
    ...p,
    anomaly: std > 0 && p.value > hi,
  }));
}

module.exports = {
  groupBySum,
  timeSeries,
  computeChange,
  getTopContributors,
  markAnomalies,
  seriesMeanStd,
};
