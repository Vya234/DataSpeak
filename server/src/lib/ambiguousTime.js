const { getAvailableDatasetPeriods } = require("../services/timeResolver");

/**
 * Vague relative time ("recently", "latest") with multiple periods in the file —
 * ask the user to name a period instead of guessing.
 * Phrases like "this month" / "last month" are handled by the time resolver and are not ambiguous here.
 */
function detectAmbiguousRelativeTime(question, rows, dateCol) {
  if (!dateCol || !Array.isArray(rows) || rows.length === 0) return null;
  const lower = String(question || "").toLowerCase();
  const periods = getAvailableDatasetPeriods(rows, dateCol);
  if (periods.length < 2) return null;

  const anchoredToFile = /\b(in|from)\s+(the\s+)?(data|dataset|file|upload|csv)\b/i.test(lower);
  if (anchoredToFile) return null;

  const hasNamedMonth =
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(
      lower
    ) || /\b20\d{2}[-/](0?[1-9]|1[0-2])\b/.test(lower);

  if (hasNamedMonth) return null;

  const vague =
    /\brecently\b|\bmost recent\b|\bthe latest\b/i.test(lower) ||
    /\bprevious\b/i.test(lower) && !/\bprevious\s+month\b/i.test(lower);

  if (!vague) return null;

  const labels = periods.map((p) => p.label).join(", ");
  const latest = periods[periods.length - 1].label;
  return {
    message:
      `Your question uses a **vague time** phrase, but this file contains **multiple periods** (${labels}).\n\n` +
      `Which period did you mean? Reply with a specific label (e.g. **${latest}** for the latest in this file) or a calendar month/year.`,
  };
}

module.exports = { detectAmbiguousRelativeTime };
