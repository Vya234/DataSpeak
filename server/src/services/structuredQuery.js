const { detectIntent } = require("./intentClassifier");
const { findColumnForAliases } = require("./metricResolver");
const { getNumericColumns } = require("../utils/datasetAnalysis");

function normalizeWord(w) {
  return String(w || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function isLikelyTimeColumnName(name) {
  return /\b(date|time|day|week|month|year|period|timestamp)\b/i.test(String(name));
}

const FUZZY_STOP = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "what",
  "which",
  "who",
  "how",
  "why",
  "when",
  "where",
  "does",
  "did",
  "do",
  "has",
  "have",
  "had",
  "for",
  "with",
  "from",
  "into",
  "that",
  "this",
  "than",
  "then",
  "there",
  "here",
  "best",
  "worst",
  "most",
  "least",
  "highest",
  "lowest",
  "top",
  "bottom",
  "give",
  "show",
  "tell",
  "get",
  "me",
  "my",
  "our",
  "your",
  "all",
  "any",
  "each",
  "some",
]);

/**
 * FIRST: match question words / two-word phrases to categorical column headers (partial, case-insensitive).
 * Requires rows so numeric columns can be excluded from "categorical" candidates.
 */
function inferGroupByFromCategoricalFuzzyMatch(question, columns, rows) {
  if (!question || !columns?.length || !Array.isArray(rows) || rows.length === 0) return null;

  const numericSet = new Set(getNumericColumns(rows, columns));
  const cats = columns.filter((c) => c && !numericSet.has(c) && !isLikelyTimeColumnName(c));
  if (!cats.length) return null;

  const lower = String(question).toLowerCase();

  const whichM = lower.match(/\bwhich\s+([a-z][a-z0-9_]*)\b/i);
  if (whichM) {
    const token = normalizeWord(whichM[1]);
    if (token.length >= 2) {
      for (const c of cats) {
        const cn = String(c).toLowerCase().replace(/_/g, "");
        const cspaced = String(c).toLowerCase();
        if (token.length >= 2 && (cspaced.includes(whichM[1].toLowerCase()) || cn.includes(token))) {
          return c;
        }
      }
    }
  }

  const rawWords = lower.split(/\s+/);
  const words = rawWords.map((w) => normalizeWord(w)).filter((w) => w.length >= 2 && !FUZZY_STOP.has(w));

  const bigrams = [];
  for (let i = 0; i < rawWords.length - 1; i++) {
    const a = normalizeWord(rawWords[i]);
    const b = normalizeWord(rawWords[i + 1]);
    if (a.length >= 2 && b.length >= 2) bigrams.push(a + b);
    if (a.length >= 2 && b.length >= 2) bigrams.push(`${a} ${b}`);
  }

  function scoreColumn(col) {
    const spaced = String(col).toLowerCase().replace(/[_]+/g, " ");
    const compact = spaced.replace(/\s/g, "");
    let score = 0;
    for (const w of words) {
      if (w.length < 3) continue;
      if (spaced.includes(w) || compact.includes(w)) score += w.length * 2;
    }
    for (const bg of bigrams) {
      if (bg.length < 6) continue;
      const bgCompact = bg.replace(/\s/g, "");
      if (spaced.includes(bg) || compact.includes(bgCompact)) score += 12;
    }
    return score;
  }

  let best = null;
  let bestScore = 0;
  for (const c of cats) {
    const s = scoreColumn(c);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }

  return bestScore >= 4 ? best : null;
}

/**
 * If the user names a dimension after by/per/each/for each (e.g. "by agent"),
 * prefer any column whose header contains that word — before default region/product picks.
 */
function inferGroupByFromExplicitDimensionWord(question, columns) {
  const q = String(question || "").toLowerCase();
  const patterns = [
    /\b(?:by|per)\s+([a-z][a-z0-9_]*)\b/i,
    /\bfor\s+each\s+([a-z][a-z0-9_]*)\b/i,
    /\beach\s+([a-z][a-z0-9_]*)\b/i,
  ];
  let dim = null;
  for (const p of patterns) {
    const m = q.match(p);
    if (m && m[1]) {
      dim = m[1].toLowerCase();
      break;
    }
  }
  if (!dim || dim.length < 2) return null;
  const stop = new Set([
    "the",
    "a",
    "an",
    "all",
    "total",
    "sum",
    "avg",
    "average",
    "row",
    "rows",
    "day",
    "week",
    "month",
    "year",
    "revenue",
    "sales",
    "profit",
    "cost",
    "amount",
    "price",
    "count",
    "rate",
    "order",
    "orders",
  ]);
  if (stop.has(dim)) return null;

  const hits = (columns || []).filter((c) => String(c).toLowerCase().includes(dim));
  if (hits.length === 0) return null;
  if (hits.length === 1) return hits[0];
  const exact = hits.find((c) => String(c).toLowerCase() === dim);
  if (exact) return exact;
  return [...hits].sort((a, b) => String(a).length - String(b).length)[0];
}

function inferGroupByColumn(question, columns, rows) {
  const fuzzy = rows?.length ? inferGroupByFromCategoricalFuzzyMatch(question, columns, rows) : null;
  if (fuzzy) return fuzzy;

  const explicit = inferGroupByFromExplicitDimensionWord(question, columns);
  if (explicit) return explicit;

  const q = String(question || "").toLowerCase();
  if (/\bregion\b/i.test(q)) return findColumnForAliases(columns, ["region", "area", "territory", "geo"]);
  if (/\bproduct\b/i.test(q)) return findColumnForAliases(columns, ["product", "sku", "item", "plan"]);
  if (/\bchannel\b/i.test(q)) return findColumnForAliases(columns, ["channel", "source", "medium"]);
  if (/\bcategor\b/i.test(q)) return findColumnForAliases(columns, ["category", "categories"]);
  if (/\bsegment\b/i.test(q)) return findColumnForAliases(columns, ["segment", "customer segment"]);
  return (
    findColumnForAliases(columns, ["region", "area", "territory"]) ||
    findColumnForAliases(columns, ["product", "sku", "item"]) ||
    findColumnForAliases(columns, ["channel", "segment", "department"])
  );
}

function buildStructuredQuery({ question, columns, metrics, dateCol, rows }) {
  const intent = detectIntent(question);
  const metricId = metrics.primaryMetricId;
  const metricColumn = metrics.primaryColumn;
  const aggregation =
    metricId && metrics.aggregationHints?.[metricId] ? metrics.aggregationHints[metricId] : "sum";

  return {
    intent,
    metric: metricId ? String(metricId) : null,
    metricColumn,
    groupBy: inferGroupByColumn(question, columns, rows),
    aggregation,
    dateColumn: dateCol || null,
    rawQuestion: String(question || "").trim(),
  };
}

module.exports = {
  buildStructuredQuery,
  inferGroupByColumn,
  inferGroupByFromExplicitDimensionWord,
  inferGroupByFromCategoricalFuzzyMatch,
};
