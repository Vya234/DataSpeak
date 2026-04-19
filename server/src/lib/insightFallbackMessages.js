/**
 * Honest, non–data-dump fallbacks when we cannot answer confidently.
 * Never list arbitrary column sums here — only column names for guidance.
 */

function formatColumnList(names) {
  const list = (names || []).filter(Boolean).map(String);
  return list.length ? list.join(", ") : "(no columns detected)";
}

/** User asked for a named metric/synonym that is not present as a column. */
function buildMissingReferencedMetricMessage(numericColumnNames) {
  return `Your dataset doesn't appear to contain information about that. Available metrics are: ${formatColumnList(
    numericColumnNames
  )}`;
}

/** Broad no-match — list actual CSV headers so the user can rephrase. */
function buildUnmatchedQuestionMessage(columnNames) {
  return `I couldn't find relevant information in your dataset to answer that question. Try asking about: ${formatColumnList(
    columnNames
  )}`;
}

module.exports = {
  buildMissingReferencedMetricMessage,
  buildUnmatchedQuestionMessage,
  formatColumnList,
};
