/**
 * intentParser.js — Structured intent from natural language.
 * Pure heuristics + regex; all numbers come from downstream analytics.
 */

function normalizeQ(q) {
  return String(q || "")
    .trim()
    .replace(/\s+/g, " ");
}

function parseIntent(question) {
  const raw = normalizeQ(question);
  const lower = raw.toLowerCase();

  /** @type {Set<string>} */
  const tasks = new Set();

  const whyLike =
    /\b(why|what caused|what drove|reason|reasons|explain|because|due to|driver|drivers|root cause)\b/i.test(
      lower
    );
  const compareTime =
    /\b(last month|this month|next month|last week|this week|next week|today|yesterday|mom|wow|yoy|qoq|dod|month over month|week over week|year over year|quarter over quarter|q[1-4]\b|quarter\b)/i.test(
      lower
    ) ||
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(
      lower
    );

  const compareEntities =
    /\b(vs\.?|versus|compared to|compare|between)\b/i.test(lower) ||
    /\b(region|product|channel|segment|department)\s+[a-z0-9].*\b(vs\.?|versus|and)\b/i.test(lower);

  const breakdown =
    /\b(break ?down|decomposition|split|distribution|composition|share|make up|makes up|what makes up|by\s+\w+)/i.test(
      lower
    );

  const summary =
    /\b(summary|summarize|overview|recap|snapshot)\b/i.test(lower) ||
    /\b(daily|weekly|monthly)\s+summary\b/i.test(lower) ||
    /\b(monthly|weekly|daily)\s+(analysis|review|report)\b/i.test(lower) ||
    /\bgive me (a )?monthly analysis\b/i.test(lower) ||
    /\banalyze (this month|the latest month)\b/i.test(lower) ||
    /\b(latest|this) month analysis\b/i.test(lower);

  const topBottom =
    /\b(top|bottom|best|worst|highest|lowest|leading|lagging)\b/i.test(lower) ||
    /\btop\s*\d+|\bbottom\s*\d+\b/i.test(lower);

  const anomaly =
    /\b(anomal|outlier|spike|drop|unusual|abnormal|sudden)\b/i.test(lower);

  const correlation =
    /\b(correlat|relationship|associated|association|lead to|linked to|move together)\b/i.test(lower) ||
    /\bdoes\b.+\b(higher|lower|more|less)\b.+\b(higher|lower|more|less)\b/i.test(lower);

  const trend =
    /\b(trend|over time|over the|across time|growth|decline|trajectory|moving)\b/i.test(lower);

  const metricLookup =
    /\b(total|sum|average|avg|mean|minimum|min|maximum|max|count|how many)\b/i.test(lower);

  if (whyLike) tasks.add("driver_analysis");
  if (compareTime) tasks.add("compare_time");
  if (compareEntities) tasks.add("compare_entities");
  if (breakdown) tasks.add("breakdown");
  if (summary) tasks.add("summary");
  if (topBottom) tasks.add("top_bottom");
  if (anomaly) tasks.add("anomaly");
  if (correlation) tasks.add("correlation");
  if (trend) tasks.add("trend");
  if (metricLookup) tasks.add("metric_lookup");

  // Default when nothing matched: still allow metric / exploration
  if (tasks.size === 0) tasks.add("open");

  const grainHint = (() => {
    if (/\b(daily|by day|each day|per day|today|yesterday)\b/i.test(lower)) return "day";
    if (/\b(weekly|by week|each week|per week|last week|this week)\b/i.test(lower)) return "week";
    if (/\b(monthly|by month|each month|per month|last month|this month|mom)\b/i.test(lower)) return "month";
    if (/\b(quarter|quarterly|q[1-4]\b|yoy|qoq)\b/i.test(lower)) return "quarter";
    if (/\b(yearly|annual|year over|yoy)\b/i.test(lower)) return "year";
    return null;
  })();

  const explicitFullCurrent =
    /\b(full|entire|complete|whole)\b.*\b(month|week)\b/i.test(lower) ||
    /\b(month|week)\b.*\b(full|entire|complete)\b/i.test(lower);

  return {
    rawQuestion: raw,
    lower,
    tasks: [...tasks],
    wantsWhy: whyLike,
    grainHint,
    explicitFullCurrentPeriod: explicitFullCurrent,
    isComparisonQuestion: /\b(compare|comparison|vs\.?|versus)\b/i.test(lower),
    isBreakdownQuestion: breakdown,
    isWeeklySummary: /\bweekly\s+summary\b/i.test(lower) || /\bgive me a weekly summary\b/i.test(lower),
    isMonthlySummary:
      /\bmonthly\s+summary\b/i.test(lower) ||
      /\bgive me a monthly summary\b/i.test(lower) ||
      /\bmonthly\s+(analysis|review|report)\b/i.test(lower) ||
      /\bgive me (a )?monthly analysis\b/i.test(lower) ||
      /\banalyze (this month|the latest month)\b/i.test(lower) ||
      /\b(latest|this) month analysis\b/i.test(lower),
    isDailySummary: /\bdaily\s+summary\b/i.test(lower) || /\bsummary for today\b/i.test(lower),
    wantsChart: /\b(chart|plot|graph|visuali[sz]e)\b/i.test(lower),
  };
}

/**
 * Pull "A vs B" style entity names from the question (best-effort).
 */
function extractEntityPair(question) {
  const raw = normalizeQ(question);
  // Quoted names
  const quoted = [...raw.matchAll(/["']([^"']{2,80})["']/g)].map((m) => m[1].trim());
  if (quoted.length >= 2) return { a: quoted[0], b: quoted[1] };

  const vs = raw.split(/\bvs\.?\b|\bversus\b/i);
  if (vs.length >= 2) {
    const left = vs[0].replace(/^.*\b(region|product|channel|segment|department|for|in)\s+/i, "").trim();
    const right = vs[1].replace(/\?.*$/, "").trim();
    const clean = (s) => s.replace(/^(the|a|an)\s+/i, "").trim();
    const a = clean(left.split(/[,.;]/)[0] || "");
    const b = clean(right.split(/[,.;]/)[0] || "");
    if (a.length >= 2 && b.length >= 2) return { a, b };
  }
  return null;
}

/**
 * True when an extracted "A vs B" pair is really relative calendar phrasing (defer to dataset time resolver).
 */
function isRelativeTimeEntityPair(pair) {
  if (!pair?.a || !pair?.b) return false;
  const blob = `${pair.a} ${pair.b}`.toLowerCase().replace(/\s+/g, " ");
  if (/\b(this|last|next|prior|previous|current)\s+(month|week|quarter|year|day)\b/.test(blob)) return true;
  if (/\b(latest|most\s+recent)\s+month\b/.test(blob)) return true;
  if (/\b(previous|prior)\s+month\b/.test(blob)) return true;
  return false;
}

module.exports = { parseIntent, extractEntityPair, normalizeQ, isRelativeTimeEntityPair };
