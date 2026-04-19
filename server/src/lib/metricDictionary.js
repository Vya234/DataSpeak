/**
 * Human-readable metric definitions keyed by normalized column name tokens.
 * Answers and prompts must still refer to columns by their EXACT CSV header.
 */

const COLUMN_DEFINITION_HINTS = [
  { match: (n) => /revenue|sales|net_sales|gross_sales/i.test(n), text: "Total sales revenue (use exact column name in answers)" },
  { match: (n) => /^orders?$/i.test(n) || n.includes("order") && !n.includes("date"), text: "Count of orders (use exact column name in answers)" },
  { match: (n) => /^customers?$/i.test(n) || n.includes("customer") && !n.includes("complaint"), text: "Customer count or customer-related totals (use exact column name in answers)" },
  { match: (n) => /complaint|ticket|issue/i.test(n), text: "Support or complaint counts (use exact column name in answers)" },
  { match: (n) => /ad_spend|adspend|marketing/i.test(n), text: "Advertising spend (use exact column name in answers)" },
  { match: (n) => /profit|ebit|margin/i.test(n), text: "Profit or margin metric (use exact column name in answers)" },
  { match: (n) => /cost|expense|opex|cogs/i.test(n), text: "Cost or expense (use exact column name in answers)" },
  { match: (n) => /churn/i.test(n), text: "Churn-related metric (use exact column name in answers)" },
  { match: (n) => /return|refund/i.test(n), text: "Returns or refunds (use exact column name in answers)" },
  { match: (n) => /nps|csat|satisfaction/i.test(n), text: "Survey or satisfaction score (use exact column name in answers)" },
];

/**
 * @param {string[]} columns — exact headers from CSV
 * @returns {Record<string, string>}
 */
function buildMetricDefinitionsForColumns(columns) {
  const out = {};
  for (const col of columns || []) {
    const n = String(col || "");
    let def = `Values from the "${n}" column (exact CSV header).`;
    for (const h of COLUMN_DEFINITION_HINTS) {
      if (h.match(n)) {
        def = `${h.text}: column **${n}**.`;
        break;
      }
    }
    out[n] = def;
  }
  return out;
}

module.exports = { buildMetricDefinitionsForColumns, COLUMN_DEFINITION_HINTS };
