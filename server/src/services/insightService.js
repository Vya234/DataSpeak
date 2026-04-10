const { tryRuleBasedAnswer } = require("./ruleBasedQuery");
const { askGroqForInsight } = require("./groqService");
const { inferColumnsFromRows } = require("../utils/datasetAnalysis");

/**
 * Hybrid insight: rule-based first, then Groq. Response always includes `source`.
 *
 * @param {{ question: string, dataset: { rows?: object[], columns?: string[] } }} params
 * @returns {Promise<{ answer: string, source: 'rule-based' | 'AI', chartData?: object }>}
 */
async function getInsight({ question, dataset }) {
  const rows = Array.isArray(dataset?.rows) ? dataset.rows : [];
  const columns =
    Array.isArray(dataset?.columns) && dataset.columns.length > 0
      ? dataset.columns
      : inferColumnsFromRows(rows);

  const trimmed = String(question || "").trim();

  const ruled = tryRuleBasedAnswer({ question: trimmed, rows, columns });
  if (ruled) return ruled;

  return askGroqForInsight({
    question: trimmed,
    rows,
    columns,
  });
}

module.exports = { getInsight };
