/**
 * Helpers to infer column types from parsed CSV rows (string values from csv-parser).
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
 * @param {object[]} rows
 * @param {string[]} columns
 * @param {number} [minRatio=0.7]
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

/** Mean of numeric cells in column; null if none. */
function avgColumn(rows, col) {
  let sum = 0;
  let count = 0;
  for (const row of rows) {
    const n = parseNumber(row?.[col]);
    if (n !== null) {
      sum += n;
      count++;
    }
  }
  return count > 0 ? sum / count : null;
}

/** Count rows that have a numeric value in `col`. */
function countNumericInColumn(rows, col) {
  let n = 0;
  for (const row of rows) {
    if (parseNumber(row?.[col]) !== null) n++;
  }
  return n;
}

/**
 * Pick a label column for charts / extremes (prefer non-numeric text).
 * @param {string[]} numericCols
 */
function getDefaultLabelColumn(rows, columns, numericCols) {
  const set = new Set(numericCols);
  for (const c of columns) {
    if (!set.has(c) && numericDensity(rows, c) < 0.65) return c;
  }
  return columns[0] || null;
}

/** Min/max numeric in valueCol with corresponding labelCol cell. */
function extremesByValue(rows, valueCol, labelCol) {
  let minV = null;
  let maxV = null;
  let minL = "";
  let maxL = "";
  for (const row of rows) {
    const n = parseNumber(row?.[valueCol]);
    if (n === null) continue;
    const lab = String(row?.[labelCol] ?? "").trim() || "(blank)";
    if (minV === null || n < minV) {
      minV = n;
      minL = lab;
    }
    if (maxV === null || n > maxV) {
      maxV = n;
      maxL = lab;
    }
  }
  if (minV === null) return null;
  return {
    min: { value: minV, label: minL },
    max: { value: maxV, label: maxL },
  };
}

function formatNumber(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "";
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  return n.toFixed(2);
}

/** First column name that appears as a substring of `question` (case-insensitive). */
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

module.exports = {
  parseNumber,
  numericDensity,
  getNumericColumns,
  sumColumn,
  avgColumn,
  countNumericInColumn,
  getDefaultLabelColumn,
  extremesByValue,
  formatNumber,
  columnMentionedInQuestion,
  inferColumnsFromRows,
};
