/**
 * filterDataset.js — Dynamic filter extraction and application
 * FIX: supports multi-value filters (Electronics + Furniture)
 */

const STOP_WORDS = new Set([
  "what","which","who","where","when","why","how",
  "is","are","was","were","be","been","being",
  "do","does","did","have","has","had",
  "can","could","will","would","shall","should","may","might","must",
  "show","give","find","get","tell","list","display","calculate",
  "compute","compare","plot","graph","chart","visualize",
  "total","sum","average","avg","mean","max","min","count",
  "trend","growth","decline","change","increase","decrease",
  "highest","lowest","best","worst","top","bottom","most","least",
  "the","a","an","in","on","at","for","of","by","to","from",
  "with","without","about","over","under","between","across",
  "and","or","but","not","no",
  "time","month","year","week","day","quarter",
  "data","dataset","rows","columns","column","row",
]);

function buildValueIndex(rows, col) {
  const map = new Map();
  for (const r of rows) {
    const v = r?.[col];
    if (!v) continue;
    const s = String(v).trim();
    if (s) map.set(s.toLowerCase(), s);
  }
  return map;
}

function getCategoricalColumns(rows, columns, numericSet) {
  return columns.filter((c) => {
    if (numericSet.has(c)) return false;
    const unique = new Set(rows.map(r => String(r?.[c] ?? "").toLowerCase())).size;
    return unique > 1 && unique / rows.length < 0.6;
  });
}

function extractFilters(question, rows, columns, numericColumns) {
  const numericSet = new Set(numericColumns);
  const categoricalCols = getCategoricalColumns(rows, columns, numericSet);

  const indices = new Map();
  for (const col of categoricalCols) {
    indices.set(col, buildValueIndex(rows, col));
  }

  const words = question.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/);

  const filters = [];

  for (const word of words) {
    if (STOP_WORDS.has(word)) continue;

    for (const col of categoricalCols) {
      const index = indices.get(col);
      if (index.has(word)) {
        filters.push({
          col,
          value: index.get(word),
        });
      }
    }
  }

  return filters;
}

// 🔥 FIXED FUNCTION
function applyFilters(rows, filters) {
  if (!filters.length) return rows;

  // group filters by column
  const grouped = {};
  for (const f of filters) {
    if (!grouped[f.col]) grouped[f.col] = [];
    grouped[f.col].push(f.value.toLowerCase());
  }

  return rows.filter((row) => {
    return Object.entries(grouped).every(([col, values]) => {
      const cell = String(row?.[col] ?? "").toLowerCase();
      return values.includes(cell); // OR logic
    });
  });
}

function filterDataset({ question, rows, columns, numericColumns }) {
  const filters = extractFilters(question, rows, columns, numericColumns);
  const filteredRows = applyFilters(rows, filters);

  return {
    filteredRows,
    filters,
    filterDescription: filters.map(f => `${f.col}=${f.value}`).join(", ")
  };
}

module.exports = { filterDataset };