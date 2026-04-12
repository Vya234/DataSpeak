/**
 * metricResolver.js — Semantic metric layer: canonical metrics map to dataset columns.
 * First column win per canonical id; synonyms resolve consistently by priority order.
 */

const {
  getNumericColumns,
  columnMentionedInQuestion,
  inferColumnsFromRows,
} = require("../utils/datasetAnalysis");

/**
 * Canonical business metrics. `aliases` are matched against column names (normalized) and question text.
 * `preferAggregation`: default when bucketing time — sum for flow, avg for rates.
 */
const METRIC_DICTIONARY = [
  {
    id: "Revenue",
    aliases: ["revenue", "sales", "sale", "gross sales", "net sales", "income", "turnover"],
    preferAggregation: "sum",
  },
  {
    id: "Profit",
    aliases: [
      "profit",
      "gross profit",
      "gross_profit",
      "net profit",
      "net_profit",
      "operating profit",
      "ebit",
      "ebitda",
      "pnl",
    ],
    preferAggregation: "sum",
  },
  {
    id: "GrossMarginPct",
    aliases: ["gross margin", "gross margin pct", "gross margin %", "margin pct", "gross_margin_pct"],
    preferAggregation: "avg",
  },
  {
    id: "Orders",
    aliases: ["orders", "order count", "order", "transactions", "transaction count", "units sold", "units"],
    preferAggregation: "sum",
  },
  {
    id: "Signups",
    aliases: ["signups", "sign ups", "signup", "registrations", "registration", "new users"],
    preferAggregation: "sum",
  },
  {
    id: "Complaints",
    aliases: [
      "complaints",
      "complaint",
      "customer complaints",
      "customer_complaints",
      "tickets",
      "support tickets",
      "issues",
    ],
    preferAggregation: "sum",
  },
  {
    id: "AdSpend",
    aliases: ["adspend", "ad spend", "ad_spend", "marketing spend", "spend", "advertising", "ads"],
    preferAggregation: "sum",
  },
  {
    id: "NPS",
    aliases: ["nps", "nps score", "nps_score", "net promoter"],
    preferAggregation: "avg",
  },
  {
    id: "CSAT",
    aliases: ["csat", "csat score", "csat_score", "customer satisfaction"],
    preferAggregation: "avg",
  },
  {
    id: "ActiveUsers",
    aliases: ["active users", "active_users", "activeusers", "mau", "dau"],
    preferAggregation: "sum",
  },
  {
    id: "Cost",
    aliases: ["cost", "costs", "expense", "expenses", "cogs", "opex", "budget"],
    preferAggregation: "sum",
  },
  {
    id: "ReturnRate",
    aliases: ["return rate", "returnrate", "returns rate", "refund rate"],
    preferAggregation: "avg",
  },
  {
    id: "Returns",
    aliases: ["returns", "refunds", "return count", "returned units"],
    preferAggregation: "sum",
  },
  {
    id: "ChurnRate",
    aliases: ["churn rate", "churnrate", "churn %", "churn percent"],
    preferAggregation: "avg",
  },
  {
    id: "Churn",
    aliases: ["churn", "churned", "churn count", "cancellations"],
    preferAggregation: "sum",
  },
  {
    id: "AvgHandleTimeSec",
    aliases: [
      "avg handle time",
      "average handle time",
      "handle time",
      "aht",
      "support time",
      "avghandletimesec",
    ],
    preferAggregation: "avg",
  },
];

function normalizeToken(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[_\-]+/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function singularize(word) {
  const w = normalizeToken(word);
  if (w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

function buildColumnIndex(columns) {
  return (columns || []).map((col) => ({
    original: col,
    normalized: normalizeToken(col),
    singular: singularize(col),
  }));
}

function findColumnForAliases(columns, aliases) {
  const indexed = buildColumnIndex(columns);
  for (const alias of aliases) {
    const target = normalizeToken(alias);
    const sing = singularize(alias);
    const exact =
      indexed.find((c) => c.normalized === target) ||
      indexed.find((c) => c.singular === sing);
    if (exact) return exact.original;
  }
  for (const alias of aliases) {
    const target = normalizeToken(alias);
    const sing = singularize(alias);
    const loose =
      indexed.find((c) => c.normalized.includes(target) || target.includes(c.normalized)) ||
      indexed.find((c) => c.singular.includes(sing) || sing.includes(c.singular));
    if (loose) return loose.original;
  }
  return null;
}

/**
 * Map canonical metric id → physical column name (only if column exists and is numeric in the data).
 */
function resolveMetricColumns(columns, rows) {
  const numericCols = new Set(getNumericColumns(rows || [], columns || []));
  const map = {};
  for (const def of METRIC_DICTIONARY) {
    const col = findColumnForAliases(columns, def.aliases);
    if (col && numericCols.has(col)) map[def.id] = { column: col, preferAggregation: def.preferAggregation };
  }
  return map;
}

/** Match alias as phrase (multi-word) or whole token in normalized question — avoids false positives on column names like order_date. */
function questionMentionsAlias(questionNorm, aliasNorm) {
  if (!aliasNorm) return false;
  if (aliasNorm.includes(" ")) return questionNorm.includes(aliasNorm);
  const esc = aliasNorm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^| )${esc}( |$)`).test(questionNorm);
}

/**
 * Pick primary metric for the question using dictionary order + question mentions.
 */
function resolvePrimaryMetric(question, columns, rows, metricColumns) {
  const q = normalizeToken(question);
  const numericCols = getNumericColumns(rows || [], columns);

  // Explicit column name in question
  const mentioned = columnMentionedInQuestion(question, columns);
  if (mentioned && numericCols.includes(mentioned)) {
    for (const def of METRIC_DICTIONARY) {
      if (metricColumns[def.id]?.column === mentioned) return def.id;
    }
    return null; /* ad-hoc numeric column */
  }

  for (const def of METRIC_DICTIONARY) {
    if (!metricColumns[def.id]) continue;
    if (def.aliases.some((a) => questionMentionsAlias(q, normalizeToken(a)))) return def.id;
  }

  // Loose: revenue before generic cost
  if (/\brevenue\b|\bsales\b/i.test(question) && metricColumns.Revenue) return "Revenue";
  if (/\bprofit\b|\bebit\b|\bebitda\b/i.test(question) && metricColumns.Profit) return "Profit";
  if (/\bchurn rate\b|\bchurn %/i.test(question) && metricColumns.ChurnRate) return "ChurnRate";
  if (/\bchurn\b/i.test(question) && metricColumns.Churn && !/\brate\b/i.test(question)) return "Churn";
  if (/\breturn rate\b|\brefund rate\b/i.test(question) && metricColumns.ReturnRate) return "ReturnRate";
  if (/\breturns\b/i.test(question) && metricColumns.Returns) return "Returns";
  if (/\b(cost|spend|expense|budget)\b/i.test(question)) {
    if (metricColumns.Cost) return "Cost";
    if (metricColumns.AdSpend) return "AdSpend";
  }
  if (/\bcomplaints\b|\btickets\b/i.test(question) && metricColumns.Complaints) return "Complaints";
  if (/\bnps\b|net promoter/i.test(question) && metricColumns.NPS) return "NPS";
  if (/\bcsat\b|customer satisfaction/i.test(question) && metricColumns.CSAT) return "CSAT";
  if (/\bactive users\b|\bmau\b|\bdau\b/i.test(question) && metricColumns.ActiveUsers) return "ActiveUsers";
  if (/\bgross margin\b|margin pct/i.test(question) && metricColumns.GrossMarginPct) return "GrossMarginPct";

  if (metricColumns.Revenue) return "Revenue";
  const keys = Object.keys(metricColumns);
  return keys[0] || null;
}

/**
 * User named a canonical metric (or synonym) that is not present as a column — do not substitute another metric.
 */
function findExplicitMissingMetric(question, metricColumns) {
  const q = normalizeToken(question);
  for (const def of METRIC_DICTIONARY) {
    if (!def.aliases.some((a) => questionMentionsAlias(q, normalizeToken(a)))) continue;
    if (!metricColumns[def.id]) return def.id;
  }
  return null;
}

/**
 * @param {{ question: string, columns: string[], rows: object[] }} ctx
 */
function resolveMetrics(ctx) {
  const { question, columns, rows } = ctx;
  const cols =
    Array.isArray(columns) && columns.length > 0 ? columns : inferColumnsFromRows(rows || []);
  const numericColumns = getNumericColumns(rows || [], cols);
  const metricColumns = resolveMetricColumns(cols, rows || []);

  const missingRequestedMetricId = findExplicitMissingMetric(question, metricColumns);
  if (missingRequestedMetricId) {
    return {
      columns: cols,
      numericColumns,
      metricColumns,
      primaryMetricId: null,
      primaryColumn: null,
      columnMap: Object.fromEntries(
        Object.entries(metricColumns).map(([id, v]) => [id, v.column])
      ),
      aggregationHints: Object.fromEntries(
        Object.entries(metricColumns).map(([id, v]) => [id, v.preferAggregation])
      ),
      missingRequestedMetricId,
    };
  }

  let primaryMetricId = resolvePrimaryMetric(question, cols, rows || [], metricColumns);

  let primaryColumn = primaryMetricId ? metricColumns[primaryMetricId]?.column : null;
  if (!primaryColumn) {
    const mentioned = columnMentionedInQuestion(question, cols);
    if (mentioned && numericColumns.includes(mentioned)) primaryColumn = mentioned;
  }
  if (!primaryColumn && numericColumns.length === 1) primaryColumn = numericColumns[0];

  // Ad-hoc numeric column not in dictionary — still expose a stable metric id for analytics
  if (primaryColumn && !primaryMetricId) {
    const id = primaryColumn.replace(/\s+/g, "_");
    metricColumns[id] = { column: primaryColumn, preferAggregation: "sum" };
    primaryMetricId = id;
  }

  return {
    columns: cols,
    numericColumns,
    metricColumns,
    primaryMetricId,
    primaryColumn,
    missingRequestedMetricId: null,
    /** Plain object for analytics: { Revenue: 'rev_col', ... } */
    columnMap: Object.fromEntries(
      Object.entries(metricColumns).map(([id, v]) => [id, v.column])
    ),
    aggregationHints: Object.fromEntries(
      Object.entries(metricColumns).map(([id, v]) => [id, v.preferAggregation])
    ),
  };
}

function getMetricColumn(metricColumns, id) {
  return metricColumns[id]?.column || null;
}

module.exports = {
  METRIC_DICTIONARY,
  resolveMetricColumns,
  resolvePrimaryMetric,
  resolveMetrics,
  getMetricColumn,
  normalizeToken,
  findColumnForAliases,
  findExplicitMissingMetric,
};
