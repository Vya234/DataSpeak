/**
 * datasetAnalysis.js — Enhanced helpers for CSV row analysis.
 * Additions: groupBy, trendDetection, summaryStats, representativeSampling.
 */

function parseNumber(val) {
  if (val === null || val === undefined) return null;
  const s = String(val).replace(/,/g, "").trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Fraction of non-empty cells in `col` that parse as finite numbers (0–1). */
function numericDensity(rows, col) {
  let filled = 0;
  let numeric = 0;
  for (const row of rows) {
    if (!row || !(col in row)) continue;
    const v = row[col];
    if (v === null || v === undefined || String(v).trim() === "") continue;
    filled++;
    if (parseNumber(v) !== null) numeric++;
  }
  if (filled === 0) return 0;
  return numeric / filled;
}

/**
 * Columns where at least `minRatio` of non-empty values are numeric.
 */
function getNumericColumns(rows, columns, minRatio = 0.7) {
  if (!Array.isArray(columns) || columns.length === 0) return [];
  return columns.filter((c) => numericDensity(rows, c) >= minRatio);
}

function sumColumn(rows, col) {
  let sum = 0;
  for (const row of rows) {
    const n = parseNumber(row?.[col]);
    if (n !== null) sum += n;
  }
  return sum;
}

function avgColumn(rows, col) {
  let sum = 0;
  let count = 0;
  for (const row of rows) {
    const n = parseNumber(row?.[col]);
    if (n !== null) { sum += n; count++; }
  }
  return count > 0 ? sum / count : null;
}

function countNumericInColumn(rows, col) {
  let n = 0;
  for (const row of rows) {
    if (parseNumber(row?.[col]) !== null) n++;
  }
  return n;
}

function minColumn(rows, col) {
  let min = null;
  for (const row of rows) {
    const n = parseNumber(row?.[col]);
    if (n !== null && (min === null || n < min)) min = n;
  }
  return min;
}

function maxColumn(rows, col) {
  let max = null;
  for (const row of rows) {
    const n = parseNumber(row?.[col]);
    if (n !== null && (max === null || n > max)) max = n;
  }
  return max;
}

function getDefaultLabelColumn(rows, columns, numericCols) {
  const set = new Set(numericCols);
  for (const c of columns) {
    if (!set.has(c) && numericDensity(rows, c) < 0.65) return c;
  }
  return columns[0] || null;
}

function extremesByValue(rows, valueCol, labelCol) {
  let minV = null, maxV = null, minL = "", maxL = "";
  for (const row of rows) {
    const n = parseNumber(row?.[valueCol]);
    if (n === null) continue;
    const lab = String(row?.[labelCol] ?? "").trim() || "(blank)";
    if (minV === null || n < minV) { minV = n; minL = lab; }
    if (maxV === null || n > maxV) { maxV = n; maxL = lab; }
  }
  if (minV === null) return null;
  return { min: { value: minV, label: minL }, max: { value: maxV, label: maxL } };
}

function formatNumber(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "";
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  return n.toFixed(2);
}

function columnMentionedInQuestion(question, columns) {
  const q = question.toLowerCase();
  for (const col of columns) {
    if (!col) continue;
    if (q.includes(String(col).toLowerCase())) return col;
  }
  return null;
}

function inferColumnsFromRows(rows) {
  if (!rows || rows.length === 0) return [];
  return Object.keys(rows[0]);
}

// ─── NEW: GROUP BY ────────────────────────────────────────────────────────────

/**
 * Groups rows by a label column, then computes sum/avg/count for each numeric column.
 * Returns an array of { group, [col_sum], [col_avg], [col_count] } sorted by first numeric sum desc.
 *
 * @param {object[]} rows
 * @param {string} groupCol  - the categorical column to group on
 * @param {string[]} valueCols - numeric columns to aggregate
 * @returns {{ group: string, [key: string]: number|string }[]}
 */
function groupBy(rows, groupCol, valueCols) {
  if (!groupCol || !Array.isArray(valueCols) || valueCols.length === 0) return [];

  const map = new Map();
  for (const row of rows) {
    const key = String(row?.[groupCol] ?? "").trim() || "(blank)";
    if (!map.has(key)) map.set(key, { group: key, _sums: {}, _counts: {} });
    const entry = map.get(key);
    for (const col of valueCols) {
      const n = parseNumber(row?.[col]);
      if (n !== null) {
        entry._sums[col] = (entry._sums[col] || 0) + n;
        entry._counts[col] = (entry._counts[col] || 0) + 1;
      }
    }
  }

  const result = [];
  for (const [, entry] of map) {
    const out = { group: entry.group };
    for (const col of valueCols) {
      const s = entry._sums[col] ?? 0;
      const c = entry._counts[col] ?? 0;
      out[`${col}_sum`] = s;
      out[`${col}_avg`] = c > 0 ? s / c : 0;
      out[`${col}_count`] = c;
    }
    result.push(out);
  }

  // Sort by first value col sum descending
  const firstCol = `${valueCols[0]}_sum`;
  result.sort((a, b) => (b[firstCol] || 0) - (a[firstCol] || 0));

  return result;
}

// ─── TREND DETECTION ─────────────────────────────────────────────────────────

/**
 * Parse a raw date/week string into a sortable { sortKey, label } pair.
 *
 * Handles common formats:
 *   "2024-01-15"  → { sortKey: 20240115,  label: "Jan 2024" }
 *   "Jan 2024"    → { sortKey: 20240100,  label: "Jan 2024" }
 *   "2024-W03"    → { sortKey: 20240300,  label: "2024-W03" }
 *   "Q1 2024"     → { sortKey: 20240100,  label: "Q1 2024"  }
 *   "Week 3 2024" → { sortKey: 20240300,  label: "Week 3 2024" }
 *   Anything else → { sortKey: 0,          label: raw string }
 *
 * @param {string} raw
 * @returns {{ sortKey: number, label: string }}
 */
const MONTH_MAP = {
  jan:1,feb:2,mar:3,apr:4,may:5,jun:6,
  jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,
};

function parseDateToken(raw) {
  const s = String(raw || "").trim();
  if (!s) return { sortKey: 0, label: s };

  // ISO date: 2024-01-15 or 2024/01/15
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) {
    const [, y, mo, d] = m.map(Number);
    return { sortKey: y * 10000 + mo * 100 + d, label: `${monthName(mo)} ${y}` };
  }

  // Year-Month only: 2024-01
  m = s.match(/^(\d{4})[-/](\d{1,2})$/);
  if (m) {
    const [, y, mo] = m.map(Number);
    return { sortKey: y * 10000 + mo * 100, label: `${monthName(mo)} ${y}` };
  }

  // ISO week: 2024-W03
  m = s.match(/^(\d{4})-W(\d{1,2})$/i);
  if (m) {
    const [, y, w] = m.map(Number);
    return { sortKey: y * 10000 + w * 100, label: `${y}-W${String(w).padStart(2,"0")}` };
  }

  // "Week N YYYY" or "Week N, YYYY"
  m = s.match(/week\s+(\d{1,2})[,\s]+(\d{4})/i);
  if (m) {
    const w = Number(m[1]), y = Number(m[2]);
    return { sortKey: y * 10000 + w * 100, label: `Week ${w} ${y}` };
  }

  // "Jan 2024" / "January 2024"
  m = s.match(/^([a-z]{3,9})\s+(\d{4})$/i);
  if (m) {
    const mo = MONTH_MAP[m[1].slice(0,3).toLowerCase()];
    const y = Number(m[2]);
    if (mo && y) return { sortKey: y * 10000 + mo * 100, label: `${m[1].slice(0,3)} ${y}` };
  }

  // "2024 Jan"
  m = s.match(/^(\d{4})\s+([a-z]{3,9})$/i);
  if (m) {
    const mo = MONTH_MAP[m[2].slice(0,3).toLowerCase()];
    const y = Number(m[1]);
    if (mo && y) return { sortKey: y * 10000 + mo * 100, label: `${m[2].slice(0,3)} ${y}` };
  }

  // "Q1 2024" / "2024 Q1"
  m = s.match(/Q([1-4])\s*(\d{4})|(\d{4})\s*Q([1-4])/i);
  if (m) {
    const q = Number(m[1] || m[4]), y = Number(m[2] || m[3]);
    return { sortKey: y * 10000 + q * 300, label: `Q${q} ${y}` };
  }

  // Plain year: 2024
  m = s.match(/^(\d{4})$/);
  if (m) return { sortKey: Number(m[1]) * 10000, label: s };

  // Fallback — try JS Date parse as last resort
  const d = new Date(s);
  if (!isNaN(d)) {
    const y = d.getFullYear(), mo = d.getMonth() + 1;
    return { sortKey: y * 10000 + mo * 100 + d.getDate(), label: `${monthName(mo)} ${y}` };
  }

  return { sortKey: 0, label: s };
}

function monthName(n) {
  return ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][n - 1] || String(n);
}

/**
 * Groups rows by a time column into monthly (or weekly) buckets,
 * aggregating numeric columns by SUM (for flow metrics like sales/revenue)
 * or AVERAGE (for stock metrics like price/rating).
 *
 * Key fix: the bucket key is always the MONTH-level sort key (YYYYMM00),
 * so daily rows like 2024-01-03 and 2024-01-27 collapse into one Jan 2024 bucket.
 *
 * @param {object[]} rows
 * @param {string}   timeCol   - the date/week/month column name
 * @param {string[]} valueCols - numeric columns to aggregate
 * @param {"sum"|"avg"} [agg="sum"]
 * @returns {{ label: string, sortKey: number, [col]: number }[]}
 *   Sorted chronologically by sortKey.
 */
function groupByTime(rows, timeCol, valueCols, agg = "sum") {
  if (!timeCol || !Array.isArray(valueCols) || valueCols.length === 0) return [];

  const buckets = new Map(); // bucketKey → { label, sortKey, sums:{}, counts:{} }

  for (const row of rows) {
    const raw = String(row?.[timeCol] ?? "").trim();
    if (!raw) continue;

    const { sortKey, label } = parseDateToken(raw);

    // Normalise to month-level bucket key:
    //   - Full date sortKey (e.g. 20240115) → strip day → 20240100
    //   - Week sortKey (e.g. 20240300) already has 00 day → keep as-is
    //   - Zero sortKey (unparseable) → fall back to the label string itself
    let bucketKey;
    if (sortKey > 0) {
      // YYYYMMDD → YYYYMM00  (zeros out the day component)
      bucketKey = Math.floor(sortKey / 100) * 100;
    } else {
      bucketKey = label || raw; // string fallback
    }

    // Canonical label for this bucket: derive from the truncated sortKey
    let canonicalLabel = label;
    if (typeof bucketKey === "number" && bucketKey > 0) {
      const y = Math.floor(bucketKey / 10000);
      const m = Math.floor((bucketKey % 10000) / 100);
      // Only convert to "Mon YYYY" for actual calendar months (1–12).
      // Week buckets already carry a meaningful label from parseDateToken — leave them.
      const isWeekBucket = label.toLowerCase().includes("w") || label.toLowerCase().includes("week");
      if (!isWeekBucket && m >= 1 && m <= 12) {
        canonicalLabel = `${monthName(m)} ${y}`;
      }
    }

    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, {
        label: canonicalLabel,
        sortKey: typeof bucketKey === "number" ? bucketKey : 0,
        _sums: {},
        _counts: {},
      });
    }

    const b = buckets.get(bucketKey);
    for (const col of valueCols) {
      const n = parseNumber(row?.[col]);
      if (n !== null) {
        b._sums[col] = (b._sums[col] || 0) + n;
        b._counts[col] = (b._counts[col] || 0) + 1;
      }
    }
  }

  // Sort chronologically
  const sorted = [...buckets.values()].sort((a, b) => a.sortKey - b.sortKey);

  // Build final output rows
  return sorted.map((b) => {
    const out = { label: b.label, sortKey: b.sortKey };
    for (const col of valueCols) {
      const s = b._sums[col] ?? 0;
      const c = b._counts[col] ?? 0;
      out[col] = agg === "avg" ? (c > 0 ? s / c : 0) : s;
    }
    return out;
  });
}

/**
 * Compute linear regression slope over an array of values.
 * Positive → upward, negative → downward.
 * Returns { slope, intercept, rSquared }
 */
function linearRegression(values) {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: values[0] ?? 0, rSquared: 0 };
  const xs = values.map((_, i) => i);
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let ssXY = 0, ssXX = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    ssXY += (xs[i] - meanX) * (values[i] - meanY);
    ssXX += (xs[i] - meanX) ** 2;
    ssTot += (values[i] - meanY) ** 2;
  }
  const slope = ssXX !== 0 ? ssXY / ssXX : 0;
  const intercept = meanY - slope * meanX;
  const ssRes = values.reduce((acc, v, i) => acc + (v - (slope * i + intercept)) ** 2, 0);
  const rSquared = ssTot !== 0 ? 1 - ssRes / ssTot : 0;
  return { slope, intercept, rSquared };
}

/**
 * Rich trend direction from aggregated, chronologically-ordered values.
 *
 * Uses linear regression slope as the primary signal, step-count ratios as
 * secondary signal, and relative variation (CV) to distinguish stable from
 * noisy series. This eliminates the false "fluctuating" result that raw
 * week-level rows produce.
 *
 * Returns one of:
 *   "upward"  |  "downward"  |  "stable"
 *   "overall upward with fluctuations"  |  "overall downward with fluctuations"
 *
 * @param {number[]} values  - chronologically ordered aggregated values
 * @returns {string}
 */
function detectTrendDirection(values) {
  if (!values || values.length < 2) return "stable";

  const { slope, rSquared } = linearRegression(values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return "stable";

  // Coefficient of variation — how noisy is the series?
  const stddev = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length);
  const cv = stddev / Math.abs(mean); // 0 = flat, >0.3 = noisy

  // Normalised slope: change per step relative to mean
  const normSlope = slope / Math.abs(mean);

  // Step-count ratios as tiebreaker
  let ups = 0, downs = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] > values[i - 1]) ups++;
    else if (values[i] < values[i - 1]) downs++;
  }
  const steps = values.length - 1;
  const upRatio = ups / steps;
  const downRatio = downs / steps;

  const isNoisy = cv > 0.25;
  const slopeUp = normSlope > 0.02;    // rising more than 2% of mean per step
  const slopeDown = normSlope < -0.02; // falling more than 2% of mean per step
  const isFlat = Math.abs(normSlope) <= 0.02;

  if (isFlat) return "stable";

  if (slopeUp) return isNoisy ? "overall upward with fluctuations" : "upward";
  if (slopeDown) return isNoisy ? "overall downward with fluctuations" : "downward";

  // Slope is borderline — fall back to step ratios
  if (upRatio >= 0.6) return isNoisy ? "overall upward with fluctuations" : "upward";
  if (downRatio >= 0.6) return isNoisy ? "overall downward with fluctuations" : "downward";

  return "stable";
}

/**
 * Detect trend for a numeric column.
 *
 * When a temporal column is provided, data is first aggregated into monthly
 * buckets via groupByTime() — this is the key fix that removes raw-row noise.
 *
 * @param {object[]} rows        - already-filtered rows
 * @param {string}   valueCol    - numeric column to analyse
 * @param {string}   [labelCol]  - temporal or label column
 * @param {"sum"|"avg"} [agg]    - aggregation method for time grouping
 * @returns {{ direction, from, to, min, max, labels, values, aggregated } | null}
 */
function detectTrend(rows, valueCol, labelCol, agg = "sum") {
  // If we have a temporal label column, aggregate first
  const temporalHint = labelCol && DATE_LIKE_PATTERNS.some((p) => p.test(labelCol));

  let labels = [];
  let values = [];

  if (temporalHint) {
    const timeBuckets = groupByTime(rows, labelCol, [valueCol], agg);
    if (timeBuckets.length < 2) return null;
    labels = timeBuckets.map((b) => b.label);
    values = timeBuckets.map((b) => parseFloat((b[valueCol] || 0).toFixed(4)));
  } else {
    // Non-temporal: read values in row order
    for (const row of rows) {
      const n = parseNumber(row?.[valueCol]);
      if (n !== null) {
        values.push(n);
        if (labelCol) labels.push(String(row?.[labelCol] ?? "").trim());
      }
    }
  }

  if (values.length < 2) return null;

  const direction = detectTrendDirection(values);
  const { slope } = linearRegression(values);

  return {
    direction,
    slope,
    from: values[0],
    to: values[values.length - 1],
    min: Math.min(...values),
    max: Math.max(...values),
    labels,
    values,
    aggregated: temporalHint, // true = monthly buckets, false = raw rows
  };
}

// ─── NEW: SUMMARY STATS ───────────────────────────────────────────────────────

/**
 * Returns a summary stats object for all numeric columns.
 * { col: { min, max, avg, sum, count, stddev } }
 */
function summaryStats(rows, columns) {
  const numericCols = getNumericColumns(rows, columns);
  const stats = {};
  for (const col of numericCols) {
    const nums = rows.map((r) => parseNumber(r?.[col])).filter((n) => n !== null);
    if (nums.length === 0) continue;
    const sum = nums.reduce((a, b) => a + b, 0);
    const avg = sum / nums.length;
    const variance = nums.reduce((a, n) => a + (n - avg) ** 2, 0) / nums.length;
    stats[col] = {
      min: Math.min(...nums),
      max: Math.max(...nums),
      avg: parseFloat(avg.toFixed(4)),
      sum: parseFloat(sum.toFixed(4)),
      count: nums.length,
      stddev: parseFloat(Math.sqrt(variance).toFixed(4)),
    };
  }
  return stats;
}

// ─── NEW: REPRESENTATIVE SAMPLING ────────────────────────────────────────────

/**
 * Returns a representative sample of rows for large datasets.
 * Picks rows evenly spread across the dataset (not just the first N).
 *
 * @param {object[]} rows
 * @param {number} [sampleSize=50]
 * @returns {object[]}
 */
function representativeSample(rows, sampleSize = 50) {
  if (!rows || rows.length <= sampleSize) return rows;
  const step = rows.length / sampleSize;
  const sample = [];
  for (let i = 0; i < sampleSize; i++) {
    const idx = Math.min(Math.round(i * step), rows.length - 1);
    sample.push(rows[idx]);
  }
  return sample;
}

// ─── NEW: DETECT TEMPORAL COLUMN ─────────────────────────────────────────────

const DATE_LIKE_PATTERNS = [/date/i, /month/i, /year/i, /week/i, /quarter/i, /time/i, /period/i, /day/i];

/**
 * Heuristically finds a date/time-like column for trend analysis.
 */
function detectTemporalColumn(columns) {
  for (const col of columns) {
    if (DATE_LIKE_PATTERNS.some((p) => p.test(col))) return col;
  }
  return null;
}

/**
 * Detects categorical column likely used for grouping.
 * Returns the first non-numeric column that has low cardinality (< 50% unique values).
 */
function detectGroupColumn(rows, columns, numericCols) {
  const numSet = new Set(numericCols);
  const candidates = columns.filter((c) => !numSet.has(c));
  for (const col of candidates) {
    const uniqueVals = new Set(rows.map((r) => String(r?.[col] ?? "").trim())).size;
    const ratio = uniqueVals / rows.length;
    if (uniqueVals > 1 && ratio < 0.5) return col;
  }
  return candidates[0] || null;
}

module.exports = {
  parseNumber,
  numericDensity,
  getNumericColumns,
  sumColumn,
  avgColumn,
  minColumn,
  maxColumn,
  countNumericInColumn,
  getDefaultLabelColumn,
  extremesByValue,
  formatNumber,
  columnMentionedInQuestion,
  inferColumnsFromRows,
  groupBy,
  detectTrend,
  detectTrendDirection,
  linearRegression,
  groupByTime,
  parseDateToken,
  summaryStats,
  representativeSample,
  detectTemporalColumn,
  detectGroupColumn,
};