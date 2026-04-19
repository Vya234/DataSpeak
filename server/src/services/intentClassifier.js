/**
 * Keyword / pattern intent classifier — no ML.
 * @returns {"comparison"|"trend"|"breakdown"|"why"|"summary"|"unknown"}
 */
function detectIntent(query) {
  const lower = String(query || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

  if (
    /\b(why|what caused|what drove|reason|reasons|how come|due to|driver|drivers|root cause)\b/i.test(lower) ||
    /\bcauses?\b/i.test(lower) ||
    (/\b(why|what|reason|cause|explain)\b/i.test(lower) &&
      /\b(drop|drops|dropped|increase|increased|decrease|decreased|declin|rose|fell|change|changed)\b/i.test(lower))
  ) {
    return "why";
  }

  if (
    /\b(compare|comparison|versus|vs\.?)\b/i.test(lower) ||
    /\bbetween\s+.+\s+and\s+/i.test(lower) ||
    /\bacross\b.*\b(regions?|products?|channels?|segments?|categor|departments?|countries?)\b/i.test(lower)
  ) {
    return "comparison";
  }

  if (
    /\b(trend|over time|over the period|trajectory|time series|growth|decline|progress)\b/i.test(lower) ||
    /\b(mom|wow|yoy|qoq|dod|month over month|week over week|year over year)\b/i.test(lower) ||
    (/\b(increase|decrease|change)\b/i.test(lower) && /\bover\b.*\b(time|months?|years?|weeks?|days?)\b/i.test(lower))
  ) {
    return "trend";
  }

  if (
    /\b(summary|overview|recap|snapshot)\b/i.test(lower) ||
    /\b(monthly|weekly|daily)\s+(analysis|review|report)\b/i.test(lower) ||
    /\bgive me (a )?monthly analysis\b/i.test(lower) ||
    /\banalyze (this month|the latest month)\b/i.test(lower) ||
    /\b(latest|this) month analysis\b/i.test(lower)
  ) {
    return "summary";
  }

  if (
    /\b(break ?down|decomposition|composition|split|distribution|share|make up|what makes up)\b/i.test(lower) ||
    /\b(group|segment)\s+by\b/i.test(lower)
  ) {
    return "breakdown";
  }

  if (
    /\b(by|per|for each|each)\s+\w+/i.test(lower) &&
    /\b(total|sum|avg|average|revenue|sales|orders?|count)\b/i.test(lower)
  ) {
    return "breakdown";
  }

  if (
    /\b(which|what)\s+\w+[^\n]{0,160}?\b(best|highest|most|lowest|least|worst|greatest|smallest|largest)\b/i.test(
      lower
    ) ||
    /\b(which|what)\s+\w+\s+(has|have)\s+the\s+(best|highest|most|lowest|least|worst)\b/i.test(lower)
  ) {
    return "breakdown";
  }

  return "unknown";
}

module.exports = { detectIntent };
