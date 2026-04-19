const { parseNumber } = require("../utils/datasetAnalysis");

/**
 * Sum a numeric column across rows (same as pipeline truth).
 */
function sumColumn(rows, col) {
  let s = 0;
  for (const r of rows || []) {
    const n = parseNumber(r?.[col]);
    if (n !== null) s += n;
  }
  return s;
}

/**
 * Extract first currency literal from text.
 */
function parseFirstCurrency(text) {
  const m = String(text || "").match(/\$\s*([\d,]+(?:\.\d+)?)/);
  if (!m) return null;
  return Number(m[1].replace(/,/g, ""));
}

/**
 * Extract first percentage from text.
 */
function parseFirstPercent(text) {
  const m = String(text || "").match(/([\d.]+)\s*%/);
  if (!m) return null;
  return Number(m[1]);
}

/**
 * If answer cites a total for one column and rows are a full slice, check within 1%.
 */
function verifyAnswerAgainstRows(answer, rows, primaryColumn) {
  if (!answer || !primaryColumn || !Array.isArray(rows) || rows.length === 0) {
    return { status: "skipped", note: "" };
  }
  const fromText = parseFirstCurrency(answer);
  if (fromText === null || !Number.isFinite(fromText)) {
    return { status: "skipped", note: "" };
  }
  const computed = sumColumn(rows, primaryColumn);
  if (!Number.isFinite(computed) || computed === 0) {
    return { status: "skipped", note: "" };
  }
  const rel = Math.abs(fromText - computed) / Math.max(Math.abs(computed), 1e-9);
  if (rel <= 0.01) {
    return { status: "match", note: "✓ Verified" };
  }
  const fixed = computed.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return {
    status: "mismatch",
    note: `✓ Verified against source data: **$${fixed}** in column **${primaryColumn}** (answer text adjusted).`,
    correctedTotal: computed,
  };
}

/**
 * Replace first $ amount in answer with corrected value when mismatch.
 */
function applyVerifiedCurrency(answer, correctedTotal) {
  if (correctedTotal === undefined || correctedTotal === null) return answer;
  const formatted = correctedTotal.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return String(answer || "").replace(/\$\s*[\d,]+(?:\.\d+)?/, `$${formatted}`);
}

module.exports = {
  verifyAnswerAgainstRows,
  applyVerifiedCurrency,
  sumColumn,
  parseFirstCurrency,
  parseFirstPercent,
};
