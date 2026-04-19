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

const FUZZY_MATCH_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "what",
  "how",
  "give",
  "me",
  "show",
  "tell",
  "please",
  "total",
  "sum",
  "overall",
  "combined",
  "of",
  "for",
  "in",
  "on",
  "to",
  "by",
  "from",
  "with",
  "this",
  "that",
  "my",
  "our",
  "dataset",
  "data",
  "column",
  "value",
  "values",
  "number",
  "numbers",
  "all",
  "across",
  "and",
  "or",
  "vs",
  "per",
  "each",
]);

/** Lowercase, split camelCase, collapse punctuation — for fuzzy column ↔ question matching. */
function normalizeForFuzzyMatch(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[_\-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeForFuzzyMatch(normalized) {
  return normalized
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !FUZZY_MATCH_STOPWORDS.has(t));
}

/**
 * Pick the numeric column whose name best matches the question (or a short phrase).
 * Returns null when scores are low or ambiguous.
 * @param {string} questionOrPhrase
 * @param {string[]} numericColumns
 * @param {{ minScore?: number, minDelta?: number }} [options]
 */
function bestFuzzyNumericColumnMatch(questionOrPhrase, numericColumns, options = {}) {
  const minScore = options.minScore ?? 4;
  const minDelta = options.minDelta ?? 1;
  if (!questionOrPhrase || !Array.isArray(numericColumns) || numericColumns.length === 0) return null;

  const qNorm = normalizeForFuzzyMatch(questionOrPhrase);
  if (!qNorm) return null;
  const qTokens = tokenizeForFuzzyMatch(qNorm);

  let best = { col: null, score: -Infinity };
  let second = -Infinity;

  for (const col of numericColumns) {
    if (!col) continue;
    const cNorm = normalizeForFuzzyMatch(col);
    if (!cNorm) continue;

    let score = 0;
    if (cNorm.length >= 4 && qNorm.includes(cNorm)) score += 45;
    if (qNorm.length >= 5 && cNorm.includes(qNorm)) score += 28;

    const cTokens = tokenizeForFuzzyMatch(cNorm);
    const qset = new Set(qTokens.filter((t) => t.length >= 3));
    let inter = 0;
    for (const t of cTokens) {
      if (t.length < 3) continue;
      if (qset.has(t)) {
        inter++;
        score += 12;
        continue;
      }
      for (const qt of qTokens) {
        if (qt.length < 3) continue;
        if (t === qt) {
          score += 12;
          break;
        }
        if (t.length >= 4 && qt.length >= 4 && (t.includes(qt) || qt.includes(t))) {
          score += 6;
        }
      }
    }
    if (cTokens.length) score += (inter / Math.max(1, cTokens.length)) * 14;

    if (score > best.score) {
      second = best.score;
      best = { col, score };
    } else if (score > second) {
      second = score;
    }
  }

  if (!best.col || best.score < minScore) return null;
  if (best.score - second < minDelta) return null;
  return best.col;
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
 * ISO 8601 week sort key + label (YYYY-Www), aligned with parseDateToken week keys (year*10000 + week*100).
 * @param {number} y
 * @param {number} mo 1–12
 * @param {number} d 1–31
 */
function isoWeekBucketFromCalendarDate(y, mo, d) {
  const date = new Date(Date.UTC(y, mo - 1, d));
  const dayNr = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNr + 3);
  const isoYear = date.getUTCFullYear();
  const week1 = new Date(Date.UTC(isoYear, 0, 4));
  const week =
    1 +
    Math.round(
      ((date.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getUTCDay() + 6) % 7)) / 7
    );
  const w = Math.min(Math.max(week, 1), 53);
  const label = `${isoYear}-W${String(w).padStart(2, "0")}`;
  return { sortKey: isoYear * 10000 + w * 100, label };
}

function formatDayLabelFromSortKey(sortKey) {
  const y = Math.floor(sortKey / 10000);
  const mo = Math.floor((sortKey % 10000) / 100);
  const d = sortKey % 100;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
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
 * @param {"month"|"week"|"day"} [timeGrain="month"] — how to bucket the timeline before aggregating values.
 * @returns {{ label: string, sortKey: number, [col]: number }[]}
 *   Sorted chronologically by sortKey.
 */
function groupByTime(rows, timeCol, valueCols, agg = "sum", timeGrain = "month") {
  if (!timeCol || !Array.isArray(valueCols) || valueCols.length === 0) return [];

  const buckets = new Map(); // bucketKey → { label, sortKey, sums:{}, counts:{} }

  for (const row of rows) {
    const raw = String(row?.[timeCol] ?? "").trim();
    if (!raw) continue;

    const { sortKey, label } = parseDateToken(raw);

    let bucketKey;
    let canonicalLabel = label;

    if (timeGrain === "day") {
      if (sortKey > 0) {
        const dpart = sortKey % 100;
        const mpart = Math.floor((sortKey % 10000) / 100);
        const ypart = Math.floor(sortKey / 10000);
        if (dpart >= 1 && dpart <= 31 && mpart >= 1 && mpart <= 12) {
          bucketKey = sortKey;
          canonicalLabel = formatDayLabelFromSortKey(sortKey);
        } else {
          bucketKey = Math.floor(sortKey / 100) * 100;
          const y = Math.floor(bucketKey / 10000);
          const m = Math.floor((bucketKey % 10000) / 100);
          if (m >= 1 && m <= 12) canonicalLabel = `${monthName(m)} ${y}`;
          else canonicalLabel = label;
        }
      } else {
        bucketKey = label || raw;
        canonicalLabel = String(label || raw);
      }
    } else if (timeGrain === "week") {
      const labStr = String(label ?? "");
      const looksLikeWeek =
        /\bW\d{1,2}\b/i.test(labStr) || /\bweek\b/i.test(labStr.toLowerCase());
      if (sortKey > 0 && looksLikeWeek) {
        bucketKey = sortKey;
        canonicalLabel = labStr;
      } else if (sortKey > 0) {
        const dpart = sortKey % 100;
        const mpart = Math.floor((sortKey % 10000) / 100);
        const ypart = Math.floor(sortKey / 10000);
        if (dpart >= 1 && dpart <= 31 && mpart >= 1 && mpart <= 12) {
          const iw = isoWeekBucketFromCalendarDate(ypart, mpart, dpart);
          bucketKey = iw.sortKey;
          canonicalLabel = iw.label;
        } else if (dpart === 0 && mpart >= 1 && mpart <= 12) {
          const iw = isoWeekBucketFromCalendarDate(ypart, mpart, 1);
          bucketKey = iw.sortKey;
          canonicalLabel = iw.label;
        } else {
          bucketKey = Math.floor(sortKey / 100) * 100;
          const y = Math.floor(bucketKey / 10000);
          const m = Math.floor((bucketKey % 10000) / 100);
          if (m >= 1 && m <= 12) canonicalLabel = `${monthName(m)} ${y}`;
          else canonicalLabel = label;
        }
      } else {
        bucketKey = label || raw;
        canonicalLabel = String(label || raw);
      }
    } else {
      // month (default): collapse to calendar month
      if (sortKey > 0) {
        bucketKey = Math.floor(sortKey / 100) * 100;
      } else {
        bucketKey = label || raw;
      }

      if (typeof bucketKey === "number" && bucketKey > 0) {
        const y = Math.floor(bucketKey / 10000);
        const m = Math.floor((bucketKey % 10000) / 100);
        const labStr = String(label ?? "");
        const isWeekBucket = labStr.toLowerCase().includes("w") || labStr.toLowerCase().includes("week");
        if (!isWeekBucket && m >= 1 && m <= 12) {
          canonicalLabel = `${monthName(m)} ${y}`;
        }
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

/** 0–1: share of non-empty cells that parse to a positive sortKey (date-like). */
function dateColumnScore(rows, col) {
  if (!Array.isArray(rows) || !col) return 0;
  let nonempty = 0;
  let good = 0;
  for (const row of rows) {
    const raw = String(row?.[col] ?? "").trim();
    if (!raw) continue;
    nonempty++;
    if (parseDateToken(raw).sortKey > 0) good++;
  }
  if (nonempty === 0) return 0;
  return good / nonempty;
}

/**
 * Coarse grain of a date column: used to refuse WoW on monthly-only files.
 * Heuristic: few distinct calendar days per month-bucket → "month"; many → "day".
 */
function inferDatasetTemporalGranularity(rows, dateCol) {
  if (!Array.isArray(rows) || !dateCol) return { grain: "unknown" };
  const sks = rows
    .map((r) => parseDateToken(String(r?.[dateCol] ?? "").trim()).sortKey)
    .filter((k) => k > 0);
  if (sks.length < 2) return { grain: "unknown" };
  const monthBuckets = new Set(sks.map((sk) => Math.floor(sk / 100) * 100));
  const uniqueDays = new Set(sks).size;
  const ratio = uniqueDays / Math.max(1, monthBuckets.size);
  if (ratio < 3) return { grain: "month" };
  if (ratio < 12) return { grain: "week" };
  return { grain: "day" };
}

/**
 * Per-row month bucket sort key (YYYYMM00), aligned with `rows` indices.
 * Used by timeResolver for calendar windows; null when the cell is not parseable.
 */
function computeOrderedMonthBucketKeys(rows, dateCol) {
  if (!Array.isArray(rows) || !dateCol) return [];
  return rows.map((row) => {
    const raw = String(row?.[dateCol] ?? "").trim();
    if (!raw) return null;
    const { sortKey } = parseDateToken(raw);
    if (sortKey > 0) return Math.floor(sortKey / 100) * 100;
    return null;
  });
}

/**
 * Categorical pairs where each value of A maps to exactly one value of B (and vice versa) — structural redundancy.
 */
function findPerfectCategoricalCorrelations(rows, columns, numericSet) {
  const cats = (columns || []).filter((c) => c && !numericSet.has(c));
  const out = [];
  for (let i = 0; i < cats.length; i++) {
    for (let j = i + 1; j < cats.length; j++) {
      const ca = cats[i];
      const cb = cats[j];
      const aToB = new Map();
      const bToA = new Map();
      let ok = true;
      for (const row of rows || []) {
        const a = String(row?.[ca] ?? "").trim();
        const b = String(row?.[cb] ?? "").trim();
        if (!a || !b) {
          ok = false;
          break;
        }
        if (aToB.has(a) && aToB.get(a) !== b) {
          ok = false;
          break;
        }
        if (bToA.has(b) && bToA.get(b) !== a) {
          ok = false;
          break;
        }
        aToB.set(a, b);
        bToA.set(b, a);
      }
      if (ok && aToB.size >= 2) {
        out.push({ colA: ca, colB: cb, mappingSize: aToB.size });
      }
    }
  }
  return out;
}

/** Pearson r on paired numeric values; deterministic correlation path. */
function pearsonCorrelation(rows, colX, colY) {
  const pairs = [];
  for (const row of rows || []) {
    const x = parseNumber(row?.[colX]);
    const y = parseNumber(row?.[colY]);
    if (x !== null && y !== null) pairs.push({ x, y });
  }
  const n = pairs.length;
  if (n < 3) return { r: null, n, sufficient: false, reason: "n_lt_3" };
  const meanX = pairs.reduce((a, p) => a + p.x, 0) / n;
  const meanY = pairs.reduce((a, p) => a + p.y, 0) / n;
  let num = 0;
  let sxx = 0;
  let syy = 0;
  for (const p of pairs) {
    const dx = p.x - meanX;
    const dy = p.y - meanY;
    num += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return { r: null, n, sufficient: false, reason: "zero_variance" };
  const r = num / Math.sqrt(sxx * syy);
  return { r, n, sufficient: true, reason: null };
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
  bestFuzzyNumericColumnMatch,
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
  dateColumnScore,
  inferDatasetTemporalGranularity,
  computeOrderedMonthBucketKeys,
  pearsonCorrelation,
  findPerfectCategoricalCorrelations,
};