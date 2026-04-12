/**
 * filterResolver.js — Categorical filters from NL: quoted values, multi-word matches,
 * OR within a column, AND across columns; avoids generic token matches.
 */

const { normalizeToken, findColumnForAliases } = require("./metricResolver");

const STOP_WORDS = new Set([
  "what",
  "which",
  "who",
  "where",
  "when",
  "why",
  "how",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "can",
  "could",
  "will",
  "would",
  "shall",
  "should",
  "may",
  "might",
  "must",
  "show",
  "give",
  "find",
  "get",
  "tell",
  "list",
  "display",
  "calculate",
  "compute",
  "compare",
  "plot",
  "graph",
  "chart",
  "visualize",
  "total",
  "sum",
  "average",
  "avg",
  "mean",
  "max",
  "min",
  "count",
  "trend",
  "growth",
  "decline",
  "change",
  "increase",
  "decrease",
  "highest",
  "lowest",
  "best",
  "worst",
  "top",
  "bottom",
  "most",
  "least",
  "the",
  "a",
  "an",
  "in",
  "on",
  "at",
  "for",
  "of",
  "by",
  "to",
  "from",
  "with",
  "without",
  "about",
  "over",
  "under",
  "between",
  "across",
  "and",
  "or",
  "but",
  "not",
  "no",
  "time",
  "month",
  "year",
  "week",
  "day",
  "quarter",
  "data",
  "dataset",
  "rows",
  "columns",
  "column",
  "row",
  "mom",
  "wow",
  "yoy",
  "qoq",
  "sales",
  "revenue",
  "cost",
  "costs",
  "region",
  "product",
  "channel",
  "segment",
  "department",
  "performance",
  "metrics",
  "customer",
  "customers",
]);

/** Phrases that look like time — do not treat as category values. */
const TIME_TOKENS = new Set([
  "q1",
  "q2",
  "q3",
  "q4",
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
  "january",
  "february",
  "march",
  "april",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "last",
  "this",
  "next",
  "today",
  "yesterday",
]);

function getCategoricalColumns(rows, columns, numericSet) {
  return (columns || []).filter((c) => {
    if (numericSet.has(c)) return false;
    const keys = new Set(rows.map((r) => String(r?.[c] ?? "").trim().toLowerCase()).filter(Boolean));
    const uniq = keys.size;
    return uniq > 1 && uniq / Math.max(1, rows.length) < 0.55;
  });
}

function uniqueValuesForColumn(rows, col) {
  const m = new Map();
  for (const r of rows) {
    const v = r?.[col];
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (!s) continue;
    const low = s.toLowerCase();
    if (!m.has(low)) m.set(low, s);
  }
  return m;
}

/**
 * Levenshtein ratio for short fuzzy match; only used when lengths are close.
 */
function fuzzyOk(a, b, maxDist = 1) {
  if (Math.abs(a.length - b.length) > maxDist) return false;
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n] <= maxDist;
}

/**
 * @typedef {{ column: string, values: string[], match: 'exact'|'substring'|'fuzzy', confidence: number }} ResolvedFilter
 */

/**
 * Extract quoted literals from the question.
 */
function extractQuoted(question) {
  const out = [];
  const re = /["']([^"']{2,120})["']/g;
  let m;
  while ((m = re.exec(question))) out.push(m[1].trim());
  return out;
}

/**
 * Match quoted string to a column's domain.
 */
function matchQuotedValue(qt, valueMap) {
  const low = qt.toLowerCase();
  if (valueMap.has(low)) return { value: valueMap.get(low), confidence: 1, match: "exact" };
  for (const [lowV, canon] of valueMap) {
    if (lowV.includes(low) || low.includes(lowV)) {
      const ratio = Math.min(low.length, lowV.length) / Math.max(low.length, lowV.length);
      if (ratio >= 0.65)
        return { value: canon, confidence: 0.85, match: "substring" };
    }
  }
  for (const [lowV, canon] of valueMap) {
    if (lowV.length <= 12 && low.length <= 12 && fuzzyOk(lowV, low)) {
      return { value: canon, confidence: 0.7, match: "fuzzy" };
    }
  }
  return null;
}

/**
 * Scan question for longest substring matches against known category values (multi-word).
 */
function scanSubstringMatches(questionLower, valueMap, minLen = 4) {
  /** @type {{ value: string, confidence: number, match: string }[]} */
  const hits = [];
  for (const [lowV, canon] of valueMap) {
    if (lowV.length < minLen) continue;
    if (STOP_WORDS.has(lowV) || TIME_TOKENS.has(lowV)) continue;
    if (questionLower.includes(lowV)) {
      const conf = 0.75 + Math.min(0.2, lowV.length / 80);
      hits.push({ value: canon, confidence: Math.min(0.95, conf), match: "substring" });
    }
  }
  // Dedupe by value keeping max confidence
  const best = new Map();
  for (const h of hits) {
    const k = h.value.toLowerCase();
    if (!best.has(k) || best.get(k).confidence < h.confidence) best.set(k, h);
  }
  return [...best.values()].filter((h) => h.confidence >= 0.72);
}

function resolveFilters({ question, rows, columns, numericColumns }) {
  const numericSet = new Set(numericColumns || []);
  const categoricalCols = getCategoricalColumns(rows, columns, numericSet);
  const questionLower = question.toLowerCase();

  /** @type {ResolvedFilter[]} */
  const resolved = [];
  const quoted = extractQuoted(question);

  // 1) Quoted literals → best column (highest confidence)
  for (const qt of quoted) {
    let best = null;
    for (const col of categoricalCols) {
      const vm = uniqueValuesForColumn(rows, col);
      const hit = matchQuotedValue(qt, vm);
      if (hit && (!best || hit.confidence > best.confidence)) {
        best = { column: col, ...hit };
      }
    }
    if (best && best.confidence >= 0.7) {
      resolved.push({
        column: best.column,
        values: [best.value],
        match: best.match,
        confidence: best.confidence,
      });
    }
  }

  // 2) Longest-value substring scan per column (skip if already covered)
  const coveredValues = new Set(resolved.flatMap((r) => r.values.map((v) => v.toLowerCase())));

  for (const col of categoricalCols) {
    const vm = uniqueValuesForColumn(rows, col);
    const hits = scanSubstringMatches(questionLower, vm).filter(
      (h) => !coveredValues.has(h.value.toLowerCase())
    );
    if (hits.length === 0) continue;

    // OR within column: keep hits that do not overlap trivially
    const mergedValues = [];
    for (const h of hits.sort((a, b) => b.confidence - a.confidence)) {
      if (h.confidence < 0.72) continue;
      mergedValues.push(h.value);
    }
    if (mergedValues.length) {
      resolved.push({
        column: col,
        values: [...new Set(mergedValues)],
        match: "substring",
        confidence: Math.max(...hits.map((h) => h.confidence)),
      });
      mergedValues.forEach((v) => coveredValues.add(v.toLowerCase()));
    }
  }

  // 3) Legacy single-token exact match — only for longer tokens to reduce noise
  const words = questionLower.replace(/[^\w\s]/g, " ").split(/\s+/);
  for (const word of words) {
    if (word.length < 4 || STOP_WORDS.has(word) || TIME_TOKENS.has(word)) continue;
    for (const col of categoricalCols) {
      const vm = uniqueValuesForColumn(rows, col);
      if (vm.has(word)) {
        const canon = vm.get(word);
        if (coveredValues.has(canon.toLowerCase())) continue;
        resolved.push({
          column: col,
          values: [canon],
          match: "exact",
          confidence: 0.8,
        });
        coveredValues.add(canon.toLowerCase());
      }
    }
  }

  // Merge multiple hits for the same column (e.g. two quoted values) → one filter with OR semantics
  const consolidated = consolidateResolvedFilters(resolved);
  const filteredRows = applyResolvedFilters(rows, consolidated);

  const filterDescription = consolidated
    .map((r) => `${r.column} in (${r.values.join(" | ")})`)
    .join(" AND ");

  return {
    resolvedFilters: consolidated,
    filteredRows,
    filterDescription,
    /** @deprecated use resolvedFilters */
    filters: consolidated.map((r) => ({ col: r.column, value: r.values[0] })),
  };
}

function consolidateResolvedFilters(resolved) {
  const map = new Map();
  for (const r of resolved) {
    if (!map.has(r.column)) {
      map.set(r.column, {
        column: r.column,
        values: [...r.values],
        match: r.match,
        confidence: r.confidence,
      });
    } else {
      const o = map.get(r.column);
      o.values = [...new Set([...o.values, ...r.values])];
      o.confidence = Math.max(o.confidence, r.confidence);
    }
  }
  return [...map.values()];
}

function applyResolvedFilters(rows, resolved) {
  if (!resolved.length) return rows;

  const byCol = new Map();
  for (const r of resolved) {
    if (!byCol.has(r.column)) byCol.set(r.column, []);
    byCol.get(r.column).push(...r.values.map((v) => v.toLowerCase()));
  }

  return rows.filter((row) => {
    for (const [col, vals] of byCol) {
      const cell = String(row?.[col] ?? "").toLowerCase();
      const ok = vals.some((v) => cell === v);
      if (!ok) return false;
    }
    return true;
  });
}

/** Backward-compatible entry matching old filterDataset API. */
function filterDataset({ question, rows, columns, numericColumns }) {
  const r = resolveFilters({ question, rows, columns, numericColumns });
  return {
    filteredRows: r.filteredRows,
    filters: r.filters,
    filterDescription: r.filterDescription,
    resolvedFilters: r.resolvedFilters,
  };
}

module.exports = { resolveFilters, applyResolvedFilters, filterDataset };
