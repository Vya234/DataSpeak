/**
 * Concise, deterministic footnotes so users see which columns and periods were used.
 */

function appendDataProvenance(answer, { metrics, timeBundle, resolvedDimensions = [], filterNote = null }) {
  if (!answer || typeof answer !== "string") return answer;
  const bits = [];
  if (metrics?.primaryColumn) bits.push(`metric **${metrics.primaryColumn}**`);
  if (resolvedDimensions?.length) bits.push(`grouped by **${resolvedDimensions.join("**, **")}**`);
  const tr = timeBundle?.resolvedTimeRange;
  const cmp = timeBundle?.comparison;
  if (cmp?.label && tr?.label && cmp.start && tr.start) {
    bits.push(`**${cmp.label}** vs **${tr.label}**`);
  } else if (tr?.label) {
    bits.push(`period **${tr.label}**`);
  }
  if (filterNote) bits.push(filterNote);
  if (!bits.length) return answer;
  return `${answer.trim()}\n\n— *Data basis: ${bits.join("; ")}.*`;
}

module.exports = { appendDataProvenance };
