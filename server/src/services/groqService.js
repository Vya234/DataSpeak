const Groq = require("groq-sdk");
const { safeJsonParse } = require("../utils/safeJson");
const { inferColumnsFromRows } = require("../utils/datasetAnalysis");
const { buildGroqSystemPrompt, buildGroqUserContentPrefix } = require("../lib/promptBuilder");
const { buildMetricDefinitionsForColumns } = require("../lib/metricDictionary");

/** Stable Groq chat model — verify on console.groq.com if this id changes */
const GROQ_CHAT_MODEL = "llama-3.1-8b-instant";

const SOURCE_AI = "AI";
const PLACEHOLDER_KEYS = new Set(["your_groq_key_here", "your_key_here"]);

function getGroqApiKey() {
  const raw = process.env.GROQ_API_KEY;
  return typeof raw === "string" ? raw.trim() : "";
}

function normalizeQuestion(question) {
  return String(question || "").trim().toLowerCase();
}

function normalizeToken(value) {
  return String(value || "")
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

function titleCase(value) {
  return String(value || "")
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isComparisonQuestion(question) {
  const q = normalizeQuestion(question);
  return /\b(compare|comparison|vs|versus)\b/i.test(q);
}

function isBreakdownQuestion(question) {
  const q = normalizeQuestion(question);
  return /\b(breakdown|split|distribution|composition|share|by)\b/i.test(q);
}

function isWeeklySummaryQuestion(question) {
  const q = normalizeQuestion(question);
  return /\bweekly summary|summary of this week|this week summary|give me a weekly summary|weekly summary for customer metrics\b/i.test(q);
}

function isMonthlySummaryQuestion(question) {
  const q = normalizeQuestion(question);
  return /\bmonthly summary|summary of this month|this month summary|give me a monthly summary|monthly summary for customer metrics\b/i.test(q);
}

function isDailySummaryQuestion(question) {
  const q = normalizeQuestion(question);
  return /\bdaily summary|summary for today|today summary|give me a daily summary|daily summary for customer metrics\b/i.test(q);
}

function isTotalSalesCompositionQuestion(question) {
  const q = normalizeQuestion(question);
  return (
    (q.includes("total sales") || q.includes("sales")) &&
    (q.includes("makes up") ||
      q.includes("what makes up") ||
      q.includes("components of") ||
      q.includes("made up of") ||
      q.includes("what contributes to") ||
      q.includes("contributes to"))
  );
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round((toNumber(value) + Number.EPSILON) * factor) / factor;
}

function average(values, decimals = 4) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const total = values.reduce((sum, v) => sum + toNumber(v), 0);
  return round(total / values.length, decimals);
}

function percentChange(current, previous, decimals = 1) {
  const prev = toNumber(previous);
  const curr = toNumber(current);
  if (prev === 0) return 0;
  return round(((curr - prev) / prev) * 100, decimals);
}

function formatSignedCurrencyDiff(value) {
  const n = round(value, 2);
  return `${n >= 0 ? "+" : "-"}$${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatSignedNumberDiff(value) {
  const n = round(value, 2);
  return `${n >= 0 ? "+" : ""}${n}`;
}

function getAllColumns(rows, columns) {
  if (Array.isArray(columns) && columns.length > 0) return columns;
  return inferColumnsFromRows(Array.isArray(rows) ? rows : []);
}

function buildColumnIndex(columns) {
  return (columns || []).map((col) => ({
    original: col,
    normalized: normalizeToken(col),
    singular: singularize(col),
  }));
}

function exactColumnMatch(queryToken, columns) {
  const target = normalizeToken(queryToken);
  const singularTarget = singularize(queryToken);
  const indexed = buildColumnIndex(columns);

  return (
    indexed.find((c) => c.normalized === target)?.original ||
    indexed.find((c) => c.singular === singularTarget)?.original ||
    null
  );
}

function looseColumnMatch(queryToken, columns) {
  const target = normalizeToken(queryToken);
  const singularTarget = singularize(queryToken);
  const indexed = buildColumnIndex(columns);

  return (
    indexed.find((c) => c.normalized.includes(target) || target.includes(c.normalized))?.original ||
    indexed.find((c) => c.singular.includes(singularTarget) || singularTarget.includes(c.singular))?.original ||
    null
  );
}

function findColumnByAliases(columns, aliases = []) {
  for (const alias of aliases) {
    const exact = exactColumnMatch(alias, columns);
    if (exact) return exact;
  }
  for (const alias of aliases) {
    const loose = looseColumnMatch(alias, columns);
    if (loose) return loose;
  }
  return null;
}

function getTimeColumns(columns) {
  const dateCol = findColumnByAliases(columns, ["date", "day"]);
  const weekCol = findColumnByAliases(columns, ["week", "week number", "weeknum", "week_no"]);
  const monthCol = findColumnByAliases(columns, ["month", "month name", "month_year", "year month"]);
  return { dateCol, weekCol, monthCol };
}

function getMetricColumnCandidates() {
  return {
    Revenue: ["revenue", "sales", "sale", "gross sales", "net sales", "income"],
    Orders: ["orders", "order count", "order", "transactions", "transaction count", "units sold", "units"],
    Signups: ["signups", "sign ups", "signup", "registrations", "registration", "new users", "users"],
    Customers: ["customers", "customer", "customer count", "num customers", "n customers"],
    AdSpend: ["adspend", "ad spend", "spend", "marketing spend", "cost", "costs", "expense", "expenses", "budget"],
    ReturnRate: ["returnrate", "return rate", "returns", "refund rate"],
    ChurnRate: ["churnrate", "churn rate", "churn"],
    AvgHandleTimeSec: [
      "avghandletimesec",
      "avg handle time sec",
      "average handle time",
      "handle time",
      "aht",
      "avg handle time",
      "support time",
    ],
  };
}

function getResolvedMetricMap(columns) {
  const candidates = getMetricColumnCandidates();
  const resolved = {};

  for (const [metric, aliases] of Object.entries(candidates)) {
    const match = findColumnByAliases(columns, aliases);
    if (match) resolved[metric] = match;
  }

  return resolved;
}

function getDimensionAliasMap() {
  return {
    Region: ["region", "area", "zone", "territory", "geo", "geography", "location"],
    Product: ["product", "item", "sku", "offering", "service", "plan"],
    Segment: ["segment", "customer segment", "user segment", "market segment"],
    Channel: ["channel", "source", "platform", "medium", "sales channel"],
    Department: ["department", "dept", "function", "division", "team", "section", "business unit", "cost center"],
  };
}

function getRequestedDimension(question, columns) {
  const q = normalizeQuestion(question);
  const aliasMap = getDimensionAliasMap();

  for (const aliases of Object.values(aliasMap)) {
    for (const alias of aliases) {
      if (q.includes(alias)) {
        const match = findColumnByAliases(columns, aliases);
        if (match) return { requested: alias, column: match };
        return { requested: alias, column: null };
      }
    }
  }

  const genericGroupingWords = [
    "department",
    "section",
    "team",
    "division",
    "category",
    "group",
    "region",
    "product",
    "channel",
    "segment",
    "cost center",
    "business unit",
  ];

  for (const word of genericGroupingWords) {
    if (q.includes(word)) {
      const match = findColumnByAliases(columns, [word]);
      if (match) return { requested: word, column: match };
      return { requested: word, column: null };
    }
  }

  return { requested: null, column: null };
}

function getRequestedMetric(question, columns, resolvedMetrics) {
  const q = normalizeQuestion(question);
  const metrics = resolvedMetrics || getResolvedMetricMap(columns);

  const patterns = [
    { aliases: ["revenue", "sales", "sale"], metric: "Revenue" },
    { aliases: ["orders", "order"], metric: "Orders" },
    { aliases: ["signups", "signup", "registrations"], metric: "Signups" },
    { aliases: ["customers", "customer"], metric: "Customers" },
    { aliases: ["complaints", "complaint", "tickets", "support tickets"], metric: "Customers" },
    { aliases: ["adspend", "ad spend", "marketing spend", "spend", "cost", "costs", "expense", "expenses", "budget"], metric: "AdSpend" },
    { aliases: ["return rate", "returns", "returnrate"], metric: "ReturnRate" },
    { aliases: ["churn", "churn rate", "churnrate"], metric: "ChurnRate" },
    { aliases: ["handle time", "avg handle time", "average handle time", "aht"], metric: "AvgHandleTimeSec" },
  ];

  for (const item of patterns) {
    if (item.aliases.some((alias) => q.includes(alias)) && metrics[item.metric]) {
      return item.metric;
    }
  }

  if ((q.includes("cost") || q.includes("spend") || q.includes("expense")) && metrics.AdSpend) {
    return "AdSpend";
  }

  if ((q.includes("sales") || q.includes("revenue")) && metrics.Revenue) {
    return "Revenue";
  }

  return metrics.Revenue ? "Revenue" : Object.keys(metrics)[0] || null;
}

function listLikelyGroupingColumns(columns, metricMap, timeCols) {
  const metricCols = new Set(Object.values(metricMap || {}));
  const timeColSet = new Set(Object.values(timeCols || {}).filter(Boolean));

  return (columns || []).filter((col) => {
    if (metricCols.has(col)) return false;
    if (timeColSet.has(col)) return false;
    return true;
  });
}

function sortPeriodKeys(keys, timeType) {
  const arr = [...keys];

  if (timeType === "date") {
    return arr.sort((a, b) => new Date(a) - new Date(b));
  }

  if (timeType === "month") {
    return arr.sort((a, b) => String(a).localeCompare(String(b)));
  }

  if (timeType === "week") {
    return arr.sort((a, b) => String(a).localeCompare(String(b)));
  }

  return arr.sort((a, b) => String(a).localeCompare(String(b)));
}

function parseDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function getWeekdayFromDateString(dateStr) {
  const d = parseDate(dateStr);
  if (!d) return null;
  return d.getUTCDay();
}

function isoWeekdayFromDateString(dateStr) {
  const day = getWeekdayFromDateString(dateStr);
  if (day === null) return null;
  return day === 0 ? 7 : day;
}

function getDayOfMonth(dateStr) {
  const d = parseDate(dateStr);
  if (!d) return null;
  return d.getUTCDate();
}

function getMetricValueFromRow(row, logicalMetric, metricMap) {
  const col = metricMap?.[logicalMetric];
  if (!col) return undefined;
  return row[col];
}

const AVG_METRICS = new Set(["ReturnRate", "ChurnRate", "AvgHandleTimeSec"]);

function aggregateRows(rows, metricMap) {
  const ids = Object.keys(metricMap || {}).filter((id) => metricMap[id]);
  const empty = { ARPO: 0 };
  for (const id of ids) {
    empty[id] = AVG_METRICS.has(id) ? 0 : 0;
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return empty;
  }

  const out = { ...empty };
  for (const id of ids) {
    if (AVG_METRICS.has(id)) continue;
    const dec = id === "Revenue" || id === "AdSpend" || id === "Profit" ? 2 : 0;
    out[id] = round(
      rows.reduce((s, r) => s + toNumber(getMetricValueFromRow(r, id, metricMap)), 0),
      dec
    );
  }
  for (const id of ids) {
    if (!AVG_METRICS.has(id)) continue;
    out[id] = average(
      rows
        .map((r) => getMetricValueFromRow(r, id, metricMap))
        .filter((v) => v !== undefined && v !== null && v !== ""),
      id === "AvgHandleTimeSec" ? 2 : 4
    );
  }

  const revenue = toNumber(out.Revenue);
  const orders = toNumber(out.Orders);
  out.ARPO = orders === 0 ? 0 : round(revenue / orders, 2);
  return out;
}

function aggregateByTime(rows, timeType, timeCols, metricMap) {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const keyColumn =
    timeType === "date" ? timeCols?.dateCol : timeType === "week" ? timeCols?.weekCol : timeCols?.monthCol;

  if (!keyColumn) return [];

  const grouped = {};

  for (const row of rows) {
    const key = row[keyColumn];
    if (!key) continue;

    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(row);
  }

  const sortedKeys = sortPeriodKeys(Object.keys(grouped), timeType);

  return sortedKeys.map((key) => ({
    period: key,
    ...aggregateRows(grouped[key], metricMap),
    _rows: grouped[key],
  }));
}

function aggregateByDimension(rows, dimensionColumn, metricMap) {
  if (!Array.isArray(rows) || rows.length === 0 || !dimensionColumn) return [];

  const grouped = {};

  for (const row of rows) {
    const key = row[dimensionColumn];
    if (key === undefined || key === null || key === "") continue;

    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(row);
  }

  const sortKey = metricMap.Revenue ? "Revenue" : sumMetricIds(metricMap)[0];
  return Object.entries(grouped)
    .map(([label, groupRows]) => ({
      label,
      ...aggregateRows(groupRows, metricMap),
    }))
    .sort((a, b) => toNumber(b[sortKey]) - toNumber(a[sortKey]));
}

function detectTimeIntent(question) {
  const q = normalizeQuestion(question);

  if (
    q.includes("last month") ||
    q.includes("this month") ||
    q.includes("month over month") ||
    q.includes("mom") ||
    q.includes("monthly")
  ) {
    return "month";
  }

  if (
    q.includes("last week") ||
    q.includes("this week") ||
    q.includes("week over week") ||
    q.includes("wow") ||
    q.includes("weekly")
  ) {
    return "week";
  }

  if (q.includes("today") || q.includes("yesterday") || q.includes("daily") || q.includes("by date")) {
    return "date";
  }

  return null;
}

function getLastTwoPeriods(aggregatedRows) {
  if (!Array.isArray(aggregatedRows) || aggregatedRows.length < 2) return null;
  return {
    previous: aggregatedRows[aggregatedRows.length - 2],
    current: aggregatedRows[aggregatedRows.length - 1],
  };
}

function buildTwoPeriodMetricComparison(metricName, currentValue, previousValue) {
  const diff = round(currentValue - previousValue, 2);
  const pct = percentChange(currentValue, previousValue, 1);

  return {
    metric: metricName,
    current: round(currentValue, 2),
    previous: round(previousValue, 2),
    diff,
    pct,
  };
}

function sumMetricIds(metricMap) {
  return Object.keys(metricMap || {}).filter((id) => metricMap[id] && !AVG_METRICS.has(id));
}

function buildSnapshotMetricClause(current, metricMap) {
  const sums = sumMetricIds(metricMap);
  if (!sums.length) return "";
  const parts = sums.map((id) => {
    const lbl = physicalColumnName(id, metricMap);
    return `${lbl} is ${formatMetricValue(id, current[id])}`;
  });
  const avgs = Object.keys(metricMap || {}).filter((id) => AVG_METRICS.has(id) && metricMap[id]);
  for (const id of avgs) {
    const lbl = physicalColumnName(id, metricMap);
    parts.push(`${lbl} is ${formatMetricValue(id, current[id])}`);
  }
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function buildMultiMetricPeriodNarrative(previous, current, metricMap, leadMetric) {
  const lead = leadMetric && metricMap[leadMetric] ? leadMetric : sumMetricIds(metricMap)[0];
  if (!lead) return "";

  const leadCmp = buildTwoPeriodMetricComparison(lead, toNumber(current[lead]), toNumber(previous[lead]));
  const leadLabel = physicalColumnName(lead, metricMap);
  let answer =
    `Comparing ${current.period} to ${previous.period}, ${leadLabel} ` +
    `${leadCmp.diff >= 0 ? "increased" : "decreased"} by ${Math.abs(leadCmp.pct)}% ` +
    (lead === "Revenue" || lead === "AdSpend" || lead === "Profit"
      ? `(${formatSignedCurrencyDiff(leadCmp.diff)}), from ${formatMetricValue(lead, previous[lead])} to ${formatMetricValue(lead, current[lead])}. `
      : `(${formatSignedNumberDiff(leadCmp.diff)}), from ${formatMetricValue(lead, previous[lead])} to ${formatMetricValue(lead, current[lead])}. `);

  const rest = sumMetricIds(metricMap).filter((id) => id !== lead);
  const moveParts = [];
  for (const id of rest) {
    const cmp = buildTwoPeriodMetricComparison(id, toNumber(current[id]), toNumber(previous[id]));
    if (cmp.diff === 0 && cmp.pct === 0) continue;
    const lbl = physicalColumnName(id, metricMap);
    moveParts.push(
      `${lbl} ${cmp.diff >= 0 ? "increased" : "decreased"} by ${Math.abs(cmp.pct)}% (${formatSignedNumberDiff(cmp.diff)})`
    );
  }
  if (moveParts.length) answer += moveParts.join(", ") + ". ";

  const avgParts = [];
  for (const id of Object.keys(metricMap || {})) {
    if (!AVG_METRICS.has(id) || !metricMap[id]) continue;
    avgParts.push(
      `${physicalColumnName(id, metricMap)} moved from ${formatMetricValue(id, previous[id])} to ${formatMetricValue(id, current[id])}`
    );
  }
  if (avgParts.length) answer += avgParts.join(", ") + ".";
  return answer.trim();
}

function chooseChartMetric(question, metricMap, columns) {
  const chosen = getRequestedMetric(question, columns, metricMap);
  return chosen || "Revenue";
}

function buildChartDataForTwoPeriods(question, previousPeriod, currentPeriod, metricMap, columns) {
  const metric = chooseChartMetric(question, metricMap, columns);
  return {
    labels: [previousPeriod.period, currentPeriod.period],
    values: [toNumber(previousPeriod[metric]), toNumber(currentPeriod[metric])],
    type: "bar",
  };
}

function buildChartDataForBreakdown(question, rows, metricMap, columns) {
  const metric = chooseChartMetric(question, metricMap, columns);
  return {
    labels: rows.map((r) => String(r.label)),
    values: rows.map((r) => toNumber(r[metric])),
    type: "bar",
  };
}

function getWeekCoverageInfo(periodObj, timeCols) {
  const dateCol = timeCols?.dateCol;
  if (!periodObj || !Array.isArray(periodObj._rows) || periodObj._rows.length === 0 || !dateCol) {
    return {
      uniqueDates: [],
      daysCovered: 0,
      latestIsoWeekday: null,
      isCompleteWeek: false,
    };
  }

  const uniqueDates = [...new Set(periodObj._rows.map((r) => r[dateCol]).filter(Boolean))].sort();
  const lastDate = uniqueDates[uniqueDates.length - 1];
  const latestIsoWeekday = isoWeekdayFromDateString(lastDate);
  const daysCovered = uniqueDates.length;

  return {
    uniqueDates,
    daysCovered,
    latestIsoWeekday,
    isCompleteWeek: daysCovered >= 7,
  };
}

function getMonthCoverageInfo(periodObj, timeCols) {
  const dateCol = timeCols?.dateCol;
  if (!periodObj || !Array.isArray(periodObj._rows) || periodObj._rows.length === 0 || !dateCol) {
    return {
      uniqueDates: [],
      daysCovered: 0,
      latestDayOfMonth: null,
      isCompleteMonth: false,
    };
  }

  const uniqueDates = [...new Set(periodObj._rows.map((r) => r[dateCol]).filter(Boolean))].sort();
  const lastDate = uniqueDates[uniqueDates.length - 1];
  const latestDayOfMonth = getDayOfMonth(lastDate);

  const expectedDaysInMonth = (() => {
    const d = parseDate(lastDate);
    if (!d) return null;
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth();
    return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  })();

  const daysCovered = uniqueDates.length;

  return {
    uniqueDates,
    daysCovered,
    latestDayOfMonth,
    isCompleteMonth: expectedDaysInMonth !== null ? daysCovered >= expectedDaysInMonth : false,
  };
}

function buildFairWeekComparison(rows, timeCols, metricMap) {
  const weekly = aggregateByTime(rows, "week", timeCols, metricMap);
  const pair = getLastTwoPeriods(weekly);
  if (!pair) return null;

  const { previous, current } = pair;
  const currentCoverage = getWeekCoverageInfo(current, timeCols);
  const dateCol = timeCols?.dateCol;

  if (currentCoverage.isCompleteWeek || !dateCol) {
    return {
      previousPeriod: { period: previous.period, ...aggregateRows(previous._rows, metricMap) },
      currentPeriod: { period: current.period, ...aggregateRows(current._rows, metricMap) },
      isPartialComparison: false,
      note: null,
    };
  }

  const currentDayCount = currentCoverage.uniqueDates.length;
  const currentLastIsoWeekday = currentCoverage.latestIsoWeekday;

  let previousComparableRows = previous._rows;

  if (currentLastIsoWeekday !== null) {
    previousComparableRows = previous._rows.filter((r) => {
      const isoDay = isoWeekdayFromDateString(r[dateCol]);
      return isoDay !== null && isoDay <= currentLastIsoWeekday;
    });
  }

  const previousComparableDates = [
    ...new Set(previousComparableRows.map((r) => r[dateCol]).filter(Boolean)),
  ].sort();

  if (previousComparableDates.length === 0 && currentDayCount > 0) {
    const previousDates = [...new Set(previous._rows.map((r) => r[dateCol]).filter(Boolean))].sort();
    const chosenDates = previousDates.slice(0, currentDayCount);
    previousComparableRows = previous._rows.filter((r) => chosenDates.includes(r[dateCol]));
  }

  return {
    previousPeriod: {
      period: `${previous.period} (same days)`,
      ...aggregateRows(previousComparableRows, metricMap),
    },
    currentPeriod: {
      period: `${current.period} (so far)`,
      ...aggregateRows(current._rows, metricMap),
    },
    isPartialComparison: true,
    note: `The current week is incomplete, so this compares ${current.period} so far against the same weekdays from ${previous.period}.`,
  };
}

function buildFairMonthComparison(rows, timeCols, metricMap) {
  const monthly = aggregateByTime(rows, "month", timeCols, metricMap);
  const pair = getLastTwoPeriods(monthly);
  if (!pair) return null;

  const { previous, current } = pair;
  const currentCoverage = getMonthCoverageInfo(current, timeCols);
  const dateCol = timeCols?.dateCol;

  if (currentCoverage.isCompleteMonth || !dateCol) {
    return {
      previousPeriod: { period: previous.period, ...aggregateRows(previous._rows, metricMap) },
      currentPeriod: { period: current.period, ...aggregateRows(current._rows, metricMap) },
      isPartialComparison: false,
      note: null,
    };
  }

  const latestDayOfMonth = currentCoverage.latestDayOfMonth;

  let previousComparableRows = previous._rows;
  if (latestDayOfMonth !== null) {
    previousComparableRows = previous._rows.filter((r) => {
      const day = getDayOfMonth(r[dateCol]);
      return day !== null && day <= latestDayOfMonth;
    });
  }

  return {
    previousPeriod: {
      period: `${previous.period} (same dates)`,
      ...aggregateRows(previousComparableRows, metricMap),
    },
    currentPeriod: {
      period: `${current.period} (so far)`,
      ...aggregateRows(current._rows, metricMap),
    },
    isPartialComparison: true,
    note: `The current month is incomplete, so this compares ${current.period} so far against the same dates from ${previous.period}.`,
  };
}

/** CSV header for a logical metric slot (never show logical id as the column name to users). */
function physicalColumnName(metric, metricMap) {
  const c = metricMap?.[metric];
  return c || metric;
}

function formatMetricValue(metric, value) {
  const n = toNumber(value);

  if (metric === "Revenue" || metric === "AdSpend" || metric === "ARPO") {
    return `$${n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }

  if (metric === "ReturnRate" || metric === "ChurnRate") {
    return `${round(n, 4)}`;
  }

  if (metric === "AvgHandleTimeSec") {
    return `${round(n, 2)} seconds`;
  }

  return `${round(n, 0).toLocaleString("en-US")}`;
}

function answerWeeklyOrMonthlyComparison(question, rows, timeCols, metricMap, columns) {
  const timeIntent = detectTimeIntent(question);
  if (!timeIntent) return null;

  if (timeIntent === "week") {
    const fair = buildFairWeekComparison(rows, timeCols, metricMap);
    if (!fair) return null;

    const previous = fair.previousPeriod;
    const current = fair.currentPeriod;

    let answer = buildMultiMetricPeriodNarrative(previous, current, metricMap, chooseChartMetric(question, metricMap, columns));

    if (fair.note) answer = `${fair.note} ${answer}`;

    return {
      answer,
      source: SOURCE_AI,
      chartData: buildChartDataForTwoPeriods(question, previous, current, metricMap, columns),
    };
  }

  if (timeIntent === "month") {
    const fair = buildFairMonthComparison(rows, timeCols, metricMap);
    if (!fair) return null;

    const previous = fair.previousPeriod;
    const current = fair.currentPeriod;

    let answer = buildMultiMetricPeriodNarrative(previous, current, metricMap, chooseChartMetric(question, metricMap, columns));

    if (fair.note) answer = `${fair.note} ${answer}`;

    return {
      answer,
      source: SOURCE_AI,
      chartData: buildChartDataForTwoPeriods(question, previous, current, metricMap, columns),
    };
  }

  return null;
}

function answerRateDecreaseQuestion(question, rows, timeCols, metricMap, columns) {
  const q = normalizeQuestion(question);
  if (!/\bdecrease|decreased|drop|dropped|increase|increased|rate\b/i.test(q)) return null;

  const timeIntent = detectTimeIntent(question);
  if (!timeIntent) return null;

  const metric = chooseChartMetric(question, metricMap, columns);

  if (timeIntent === "week") {
    const fair = buildFairWeekComparison(rows, timeCols, metricMap);
    if (!fair) return null;

    const previous = fair.previousPeriod;
    const current = fair.currentPeriod;
    const prevVal = toNumber(previous[metric]);
    const currVal = toNumber(current[metric]);
    const pct = percentChange(currVal, prevVal, 1);
    const direction = pct >= 0 ? "increased" : "decreased";

    const colLabel = physicalColumnName(metric, metricMap);
    let answer =
      `Column **${colLabel}** ${direction} by ${Math.abs(pct)}% from ${previous.period} to ${current.period}, moving from ${formatMetricValue(metric, prevVal)} to ${formatMetricValue(metric, currVal)}.`;

    if (fair.note) answer = `${fair.note} ${answer}`;

    return {
      answer,
      source: SOURCE_AI,
      chartData: buildChartDataForTwoPeriods(question, previous, current, metricMap, columns),
    };
  }

  if (timeIntent === "month") {
    const fair = buildFairMonthComparison(rows, timeCols, metricMap);
    if (!fair) return null;

    const previous = fair.previousPeriod;
    const current = fair.currentPeriod;
    const prevVal = toNumber(previous[metric]);
    const currVal = toNumber(current[metric]);
    const pct = percentChange(currVal, prevVal, 1);
    const direction = pct >= 0 ? "increased" : "decreased";

    const colLabel = physicalColumnName(metric, metricMap);
    let answer =
      `Column **${colLabel}** ${direction} by ${Math.abs(pct)}% from ${previous.period} to ${current.period}, moving from ${formatMetricValue(metric, prevVal)} to ${formatMetricValue(metric, currVal)}.`;

    if (fair.note) answer = `${fair.note} ${answer}`;

    return {
      answer,
      source: SOURCE_AI,
      chartData: buildChartDataForTwoPeriods(question, previous, current, metricMap, columns),
    };
  }

  const aggregated = aggregateByTime(rows, timeIntent, timeCols, metricMap);
  const pair = getLastTwoPeriods(aggregated);
  if (!pair) return null;

  const previous = pair.previous;
  const current = pair.current;
  const prevVal = toNumber(previous[metric]);
  const currVal = toNumber(current[metric]);
  const pct = percentChange(currVal, prevVal, 1);
  const direction = pct >= 0 ? "increased" : "decreased";

  const colLabel = physicalColumnName(metric, metricMap);
  return {
    answer: `Column **${colLabel}** ${direction} by ${Math.abs(pct)}% from ${previous.period} to ${current.period}, moving from ${formatMetricValue(metric, prevVal)} to ${formatMetricValue(metric, currVal)}.`,
    source: SOURCE_AI,
    chartData: buildChartDataForTwoPeriods(question, previous, current, metricMap, columns),
  };
}

function answerBreakdown(question, rows, columns, timeCols, metricMap) {
  const dimensionRequest = getRequestedDimension(question, columns);
  const requestedMetric = getRequestedMetric(question, columns, metricMap);

  if (!isBreakdownQuestion(question) && !dimensionRequest.requested) return null;
  if (!requestedMetric) return null;

  if (dimensionRequest.requested && !dimensionRequest.column) {
    const available = listLikelyGroupingColumns(columns, metricMap, timeCols);
    return {
      answer:
        `I could not find a "${titleCase(dimensionRequest.requested)}" column in this dataset. ` +
        `Available grouping columns are: ${available.length ? available.join(", ") : "none detected"}.`,
      source: SOURCE_AI,
    };
  }

  const chosenDimension =
    dimensionRequest.column ||
    findColumnByAliases(columns, ["region", "product", "channel", "segment", "department", "team", "category"]) ||
    null;

  if (!chosenDimension) return null;

  const aggregated = aggregateByDimension(rows, chosenDimension, metricMap);
  if (!aggregated.length) return null;

  const metric = requestedMetric;
  const total = aggregated.reduce((sum, row) => sum + toNumber(row[metric]), 0);
  const top = aggregated[0];

  const parts = aggregated.map((row) => {
    const share = total === 0 ? 0 : round((toNumber(row[metric]) / total) * 100, 1);
    return `${row.label}: ${formatMetricValue(metric, row[metric])} (${share}%)`;
  });

  const mcol = physicalColumnName(metric, metricMap);
  let answer =
    `**${mcol}** (by **${chosenDimension}**): ${parts.join("; ")}. ` +
    `The largest contributor is ${top.label} with ${formatMetricValue(metric, top[metric])}.`;

  if (dimensionRequest.requested && normalizeToken(dimensionRequest.requested) !== normalizeToken(chosenDimension)) {
    answer =
      `I did not find an exact "${titleCase(dimensionRequest.requested)}" column, but I found "${chosenDimension}". ` +
      answer;
  }

  if ((normalizeQuestion(question).includes("cost") || normalizeQuestion(question).includes("expense")) && metric !== "AdSpend") {
    answer =
      `I did not find a dedicated cost-like column such as Cost, Expense, or Spend, so I used ${metric}. ` +
      answer;
  }

  return {
    answer,
    source: SOURCE_AI,
    chartData: buildChartDataForBreakdown(question, aggregated, metricMap, columns),
  };
}

function answerTotalSalesComposition(question, rows, columns, metricMap, timeCols) {
  if (!isTotalSalesCompositionQuestion(question)) return null;
  if (!metricMap.Revenue) return null;

  const overall = aggregateRows(rows, metricMap);

  const pieces = [];
  const likelyDims = ["Product", "Region", "Channel", "Segment", "Department"]
    .map((alias) => findColumnByAliases(columns, [alias]))
    .filter(Boolean);

  const seen = new Set();
  let compChart;
  for (const dim of likelyDims) {
    if (seen.has(dim)) continue;
    seen.add(dim);

    const grouped = aggregateByDimension(rows, dim, metricMap);
    if (!grouped.length) continue;

    if (!compChart && grouped.length >= 2) {
      const revCol = physicalColumnName("Revenue", metricMap);
      compChart = {
        labels: grouped.slice(0, 10).map((r) => String(r.label)),
        values: grouped.slice(0, 10).map((r) => toNumber(r.Revenue)),
        type: "pie",
        categoryAxisLabel: dim,
        valueAxisLabel: revCol,
      };
    }

    const totalRevenue = grouped.reduce((sum, r) => sum + toNumber(r.Revenue), 0);
    const topEntries = grouped.slice(0, 3).map((r) => {
      const share = totalRevenue === 0 ? 0 : round((toNumber(r.Revenue) / totalRevenue) * 100, 1);
      return `${r.label} (${formatMetricValue("Revenue", r.Revenue)}, ${share}%)`;
    });

    if (topEntries.length) {
      pieces.push(`By **${dim}**, the main contributors for **${physicalColumnName("Revenue", metricMap)}** are ${topEntries.join(", ")}`);
    }
  }

  const revCol = physicalColumnName("Revenue", metricMap);
  return {
    answer:
      `In this dataset, total **${revCol}** is ${formatMetricValue("Revenue", overall.Revenue)} from **${physicalColumnName("Orders", metricMap)}** ${formatMetricValue("Orders", overall.Orders)} (ARPO ${formatMetricValue("ARPO", overall.ARPO)}). ` +
      `${pieces.length ? pieces.join(". ") + "." : ""}`,
    source: SOURCE_AI,
    chartData: compChart,
  };
}

function answerWeeklySummary(question, rows, timeCols, metricMap) {
  if (!isWeeklySummaryQuestion(question) || !timeCols.weekCol) return null;

  const weekly = aggregateByTime(rows, "week", timeCols, metricMap);
  if (!weekly.length) return null;

  const current = weekly[weekly.length - 1];
  const coverage = getWeekCoverageInfo(current, timeCols);

  let answer =
    `For ${current.period}${coverage.isCompleteWeek ? "" : " so far"}, ${buildSnapshotMetricClause(current, metricMap)}.`;

  if (!coverage.isCompleteWeek) answer = `This week is incomplete. ${answer}`;

  if (weekly.length > 1) {
    const fair = buildFairWeekComparison(rows, timeCols, metricMap);
    if (fair) {
      const revenuePct = percentChange(fair.currentPeriod.Revenue, fair.previousPeriod.Revenue, 1);
      const ordersPct = percentChange(fair.currentPeriod.Orders, fair.previousPeriod.Orders, 1);
      answer +=
        ` Compared with ${fair.previousPeriod.period}, Revenue ${revenuePct >= 0 ? "increased" : "decreased"} by ${Math.abs(revenuePct)}% and Orders ${ordersPct >= 0 ? "increased" : "decreased"} by ${Math.abs(ordersPct)}%.`;
    }
  }

  return {
    answer,
    source: SOURCE_AI,
    chartData: {
      labels: weekly.map((r) => r.period),
      values: weekly.map((r) => r.Revenue),
      type: "line",
    },
  };
}

function answerMonthlySummary(question, rows, timeCols, metricMap) {
  if (!isMonthlySummaryQuestion(question) || !timeCols.monthCol) return null;

  const monthly = aggregateByTime(rows, "month", timeCols, metricMap);
  if (!monthly.length) return null;

  const current = monthly[monthly.length - 1];
  const coverage = getMonthCoverageInfo(current, timeCols);

  let answer =
    `For ${current.period}${coverage.isCompleteMonth ? "" : " so far"}, ${buildSnapshotMetricClause(current, metricMap)}.`;

  if (!coverage.isCompleteMonth) answer = `This month is incomplete. ${answer}`;

  if (monthly.length > 1) {
    const fair = buildFairMonthComparison(rows, timeCols, metricMap);
    if (fair) {
      const revenuePct = percentChange(fair.currentPeriod.Revenue, fair.previousPeriod.Revenue, 1);
      const ordersPct = percentChange(fair.currentPeriod.Orders, fair.previousPeriod.Orders, 1);
      const signupsPct = percentChange(fair.currentPeriod.Signups, fair.previousPeriod.Signups, 1);

      answer +=
        ` Compared with ${fair.previousPeriod.period}, Revenue ${revenuePct >= 0 ? "increased" : "decreased"} by ${Math.abs(revenuePct)}%, Orders ${ordersPct >= 0 ? "increased" : "decreased"} by ${Math.abs(ordersPct)}%, and Signups ${signupsPct >= 0 ? "increased" : "decreased"} by ${Math.abs(signupsPct)}%.`;
    }
  }

  return {
    answer,
    source: SOURCE_AI,
    chartData: {
      labels: monthly.map((r) => r.period),
      values: monthly.map((r) => r.Revenue),
      type: "line",
    },
  };
}

function answerDailySummary(question, rows, timeCols, metricMap) {
  if (!isDailySummaryQuestion(question) || !timeCols.dateCol) return null;

  const daily = aggregateByTime(rows, "date", timeCols, metricMap);
  if (!daily.length) return null;

  const current = daily[daily.length - 1];
  const previous = daily.length > 1 ? daily[daily.length - 2] : null;

  let answer = `For ${current.period}, ${buildSnapshotMetricClause(current, metricMap)}.`;

  if (previous) {
    const revenuePct = percentChange(current.Revenue, previous.Revenue, 1);
    const ordersPct = percentChange(current.Orders, previous.Orders, 1);
    const signupsPct = percentChange(current.Signups, previous.Signups, 1);

    answer +=
      ` Compared with ${previous.period}, Revenue ${revenuePct >= 0 ? "increased" : "decreased"} by ${Math.abs(revenuePct)}%, Orders ${ordersPct >= 0 ? "increased" : "decreased"} by ${Math.abs(ordersPct)}%, and Signups ${signupsPct >= 0 ? "increased" : "decreased"} by ${Math.abs(signupsPct)}%.`;
  }

  return {
    answer,
    source: SOURCE_AI,
    chartData: {
      labels: daily.slice(-7).map((r) => r.period),
      values: daily.slice(-7).map((r) => r.Revenue),
      type: "line",
    },
  };
}

function buildStructuredUserPrompt({ question, rows, columns, timeCols, metricMap }) {
  const data = Array.isArray(rows) ? rows : [];
  const cols = getAllColumns(data, columns);
  const timeIntent = detectTimeIntent(question);

  let preparedData = data;
  let contextNote = "Row-level rows below.";

  if (timeIntent) {
    preparedData = aggregateByTime(data, timeIntent, timeCols, metricMap).map(({ _rows, ...rest }) => rest);
    contextNote = `Rows aggregated by ${timeIntent} for the time column.`;
  } else {
    const dimReq = getRequestedDimension(question, cols);
    if (dimReq.column) {
      preparedData = aggregateByDimension(data, dimReq.column, metricMap);
      contextNote = `Rows aggregated by exact column **${dimReq.column}**.`;
    }
  }

  const sample = preparedData.slice(0, 50);
  const numericExact = Object.entries(metricMap || {})
    .map(([logical, physical]) => `${logical} → read values from column "${physical}"`)
    .join("; ");

  return (
    buildGroqUserContentPrefix(cols) +
    [
      `Time columns (exact headers): ${Object.values(timeCols || {}).filter(Boolean).join(", ") || "(none)"}.`,
      numericExact ? `Metric mapping (use physical names in the answer): ${numericExact}` : "",
      `Context: ${contextNote}`,
      "",
      "Data (JSON):",
      JSON.stringify(sample),
      "",
      "Answer using only the data above. Refer to columns by exact CSV header names.",
      `Question: ${question}`,
    ]
      .filter(Boolean)
      .join("\n")
  );
}

function normalizeGroqResponse(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    return { answer: "No response from the model. Please try again.", source: SOURCE_AI };
  }

  const parsed = safeJsonParse(raw.trim());
  if (parsed.ok && typeof parsed.value.answer === "string") {
    const answer = parsed.value.answer;
    const chartData = parsed.value.chartData;

    if (chartData && typeof chartData === "object" && chartData !== null) {
      const labels = Array.isArray(chartData.labels) ? chartData.labels.map(String) : [];
      const values = Array.isArray(chartData.values) ? chartData.values.map((v) => Number(v)) : [];
      if (!values.every((n) => Number.isFinite(n))) {
        return { answer, source: SOURCE_AI };
      }
      const type = ["bar", "line", "pie", "doughnut"].includes(chartData.type) ? chartData.type : "bar";

      if (labels.length > 0 && values.length === labels.length) {
        return { answer, chartData: { labels, values, type }, source: SOURCE_AI };
      }
    }

    return { answer, source: SOURCE_AI };
  }

  return { answer: raw.trim(), source: SOURCE_AI };
}

async function askGroqNarrative({ question, rows, columns, timeCols, metricMap }) {
  const apiKey = getGroqApiKey();
  if (!apiKey || PLACEHOLDER_KEYS.has(apiKey.toLowerCase())) {
    return {
      answer: "AI is not configured: set a valid GROQ_API_KEY in dataspeak/.env (copy from .env.example).",
      source: SOURCE_AI,
    };
  }

  const cols = getAllColumns(rows, columns);
  const metricDefinitions = buildMetricDefinitionsForColumns(cols);
  const userContent = buildStructuredUserPrompt({ question, rows, columns, timeCols, metricMap });
  const system = buildGroqSystemPrompt({ columns: cols, metricDefinitions });

  try {
    const groq = new Groq({ apiKey });
    const response = await groq.chat.completions.create({
      model: GROQ_CHAT_MODEL,
      temperature: 0.1,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
    });

    const raw = response.choices?.[0]?.message?.content ?? "";
    return normalizeGroqResponse(raw);
  } catch (err) {
    const status = err.status || err.statusCode;

    if (status === 401) {
      return {
        answer: "The AI service rejected the API key. Check GROQ_API_KEY in dataspeak/.env (Groq console).",
        source: SOURCE_AI,
      };
    }

    if (status === 429) {
      return {
        answer: "The AI service is busy (rate limit). Please wait a moment and try again.",
        source: SOURCE_AI,
      };
    }

    return {
      answer: "We could not get an AI answer right now. Please try again shortly.",
      source: SOURCE_AI,
    };
  }
}

/**
 * Groq-backed insight. Uses deterministic backend logic first.
 * Falls back to Groq only for free-form narrative questions.
 *
 * @param {{ question: string, rows: object[], columns?: string[] }} params
 * @returns {Promise<{ answer: string, source: string, chartData?: object }>}
 */
async function askGroqForInsight({ question, rows, columns }) {
  const data = Array.isArray(rows) ? rows : [];
  const cols = getAllColumns(data, columns);

  if (!data.length) {
    return {
      answer: "No dataset rows are available to analyze.",
      source: SOURCE_AI,
    };
  }

  const timeCols = getTimeColumns(cols);
  const metricMap = getResolvedMetricMap(cols);
  const q = normalizeQuestion(question);

  const totalSalesAnswer = answerTotalSalesComposition(question, data, cols, metricMap, timeCols);
  if (totalSalesAnswer) return totalSalesAnswer;

  const dailySummary = answerDailySummary(question, data, timeCols, metricMap);
  if (dailySummary) return dailySummary;

  const weeklySummary = answerWeeklySummary(question, data, timeCols, metricMap);
  if (weeklySummary) return weeklySummary;

  const monthlySummary = answerMonthlySummary(question, data, timeCols, metricMap);
  if (monthlySummary) return monthlySummary;

  const rateAnswer = answerRateDecreaseQuestion(question, data, timeCols, metricMap, cols);
  if (rateAnswer) return rateAnswer;

  if (
    q.includes("this week") ||
    q.includes("last week") ||
    q.includes("this month") ||
    q.includes("last month") ||
    q.includes("week over week") ||
    q.includes("month over month") ||
    q.includes("wow") ||
    q.includes("mom")
  ) {
    const compareAnswer = answerWeeklyOrMonthlyComparison(question, data, timeCols, metricMap, cols);
    if (compareAnswer) return compareAnswer;
  }

  const breakdownAnswer = answerBreakdown(question, data, cols, timeCols, metricMap);
  if (breakdownAnswer) return breakdownAnswer;

  if (isComparisonQuestion(question)) {
    const dimReq = getRequestedDimension(question, cols);
    const dimensionColumn =
      dimReq.column ||
      findColumnByAliases(cols, ["product", "region", "channel", "segment", "department", "team", "category"]);

    if (!dimensionColumn) {
      const available = listLikelyGroupingColumns(cols, metricMap, timeCols);
      return {
        answer:
          `I could not find a suitable grouping column for comparison. ` +
          `Available grouping columns are: ${available.length ? available.join(", ") : "none detected"}.`,
        source: SOURCE_AI,
      };
    }

    const aggregated = aggregateByDimension(data, dimensionColumn, metricMap);
    if (aggregated.length >= 2) {
      const metric = chooseChartMetric(question, metricMap, cols);
      const topTwo = aggregated.slice(0, 2);

      const mcol = physicalColumnName(metric, metricMap);
      return {
        answer:
          `Comparing **${dimensionColumn}** values **${topTwo[0].label}** vs **${topTwo[1].label}** on column **${mcol}**: ` +
          `${formatMetricValue(metric, topTwo[0][metric])} vs ${formatMetricValue(metric, topTwo[1][metric])}.`,
        source: SOURCE_AI,
        chartData: buildChartDataForBreakdown(question, topTwo, metricMap, cols),
      };
    }
  }

  return askGroqNarrative({
    question,
    rows: data,
    columns: cols,
    timeCols,
    metricMap,
  });
}

module.exports = {
  askGroqForInsight,
  GROQ_CHAT_MODEL,
  SOURCE_AI,
};