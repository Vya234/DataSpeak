// /**
//  * queryAnalysis.js — Validation, strict intent, and modular deterministic analytics.
//  * Never assumes columns exist; returns safe messages when data is missing or incomplete.
//  */

// const {
//   parseDateToken,
//   parseNumber,
//   getNumericColumns,
//   detectTemporalColumn,
//   inferDatasetTemporalGranularity,
//   detectTrend,
//   detectTrendDirection,
//   formatNumber,
//   groupBy,
//   groupByTime,
//   detectGroupColumn,
//   columnMentionedInQuestion,
//   summaryStats,
//   computeOrderedMonthBucketKeys,
//   parseMonthNameOnly,
// } = require("../utils/datasetAnalysis");
// const { METRIC_DICTIONARY, findColumnForAliases } = require("./metricResolver");
// const { extractEntityPair } = require("./intentParser");

// const MONTH_WORDS = {
//   january: 1,
//   jan: 1,
//   february: 2,
//   feb: 2,
//   march: 3,
//   mar: 3,
//   april: 4,
//   apr: 4,
//   may: 5,
//   june: 6,
//   jun: 6,
//   july: 7,
//   jul: 7,
//   august: 8,
//   aug: 8,
//   september: 9,
//   sep: 9,
//   sept: 9,
//   october: 10,
//   oct: 10,
//   november: 11,
//   nov: 11,
//   december: 12,
//   dec: 12,
// };

// function normMonthToken(t) {
//   const s = String(t || "")
//     .toLowerCase()
//     .replace(/\./g, "")
//     .trim();
//   if (!s) return null;
//   if (MONTH_WORDS[s] !== undefined) return MONTH_WORDS[s];
//   return MONTH_WORDS[s.slice(0, 3)] ?? null;
// }

// /**
//  * Single primary intent — strict priority (do not mix).
//  * Order: DRIVER → COMPARISON → TREND → TOP_N → BREAKDOWN → SUMMARY.
//  */
// function detectIntent(question) {
//   const lower = String(question || "").toLowerCase();

//   if (/\b(why|cause|causes|reason|reasons|what caused|what drove|due to|driver)\b/i.test(lower)) {
//     return { type: "driver", raw: question };
//   }
//   if (/\b(compare|comparison|versus|vs\.?)\b/i.test(lower) || /\bbetween\s+.+\s+and\s+/i.test(question)) {
//     return { type: "comparison", raw: question };
//   }
//   if (/\b(trend|over time|over the period|trajectory)\b/i.test(lower)) {
//     return { type: "trend", raw: question };
//   }
//   if (/\b(top\s*\d+|bottom\s*\d+|highest\s+\d+|best\s+\d+|worst\s+\d+)\b/i.test(lower) || /\b(top|highest|lowest)\b/i.test(lower)) {
//     return { type: "top_n", raw: question };
//   }
//   if (/\b(summary|overview|recap|snapshot)\b/i.test(lower)) {
//     return { type: "summary", raw: question };
//   }
//   if (/\b(breakdown|composition)\b/i.test(lower) || /\bby\b/i.test(lower)) {
//     return { type: "breakdown", raw: question };
//   }
//   return { type: "general", raw: question };
// }

// /** User-requested series grain from wording (null = no explicit constraint). */
// function inferRequestedSeriesGrain(question) {
//   const lower = String(question || "").toLowerCase();
//   if (/\bdaily\b|day[- ]by[- ]day|each\s+day|per\s+day\b/i.test(lower)) return "day";
//   if (/\bweekly\b|week[- ]level|wow\b|week\s+over\s+week/i.test(lower)) return "week";
//   if (/\bmonthly\b|month[- ]level|mom\b|month\s+over\s+month/i.test(lower)) return "month";
//   return null;
// }

// /**
//  * Validate that we can answer questions about the requested metric/dimension/time.
//  */
// function validateData({ question, columns, rows, metrics, dateCol, timeGrainRequired, strictIntentType, intent }) {
//   const warnings = [];
//   let status = "ok";

//   if (!Array.isArray(rows) || rows.length === 0) {
//     return { ok: false, message: "No data rows to analyze.", validation_status: "empty", warnings: [] };
//   }
//   if (!metrics.primaryColumn && metrics.numericColumns.length === 0) {
//     return {
//       ok: false,
//       message: "The dataset has no numeric columns to aggregate.",
//       validation_status: "missing_metric",
//       warnings: [],
//     };
//   }

//   const lower = question.toLowerCase();
//   const revenueDef = METRIC_DICTIONARY.find((d) => d.id === "Revenue");
//   if (revenueDef && /\b(revenue|sales|income|turnover)\b/i.test(lower)) {
//     const revCol = findColumnForAliases(columns, revenueDef.aliases);
//     if (!revCol) {
//       return {
//         ok: false,
//         message: "The dataset does not contain a revenue-related column.",
//         validation_status: "missing_metric",
//         warnings: [],
//       };
//     }
//   }

//   if (/\bregion\b/i.test(lower)) {
//     const rcol = findColumnForAliases(columns, ["region", "area", "territory"]);
//     if (!rcol) {
//       return {
//         ok: false,
//         message: "The dataset does not contain a region column.",
//         validation_status: "missing_dimension",
//         warnings: [],
//       };
//     }
//   }

//   const requestedGrain = inferRequestedSeriesGrain(question);
//   const dataGrain = dateCol ? inferDatasetTemporalGranularity(rows, dateCol).grain : "unknown";

//   const wantsDailySummary =
//     intent?.isDailySummary ||
//     /\bdaily\s+summary\b/i.test(lower) ||
//     /\b(summary|overview|recap)\b.*\bdaily\b/i.test(lower) ||
//     /\bdaily\b.*\b(summary|overview|recap)\b/i.test(lower);

//   if (wantsDailySummary && dataGrain !== "day") {
//     return {
//       ok: false,
//       message: "dataset does not support daily analysis",
//       validation_status: "unsupported_granularity",
//       warnings: ["no_daily_grain"],
//     };
//   }

//   if (timeGrainRequired === "week" || requestedGrain === "week") {
//     if (!dateCol) {
//       return {
//         ok: false,
//         message: "This dataset has monthly granularity, not weekly.",
//         validation_status: "unsupported_granularity",
//         warnings: ["dataset_not_weekly"],
//       };
//     }
//     if (dataGrain === "month" || dataGrain === "unknown") {
//       return {
//         ok: false,
//         message: "This dataset has monthly granularity, not weekly.",
//         validation_status: "unsupported_granularity",
//         warnings: ["dataset_not_weekly"],
//       };
//     }
//   }

//   if (
//     (strictIntentType === "trend" || /\btrend\b/i.test(lower)) &&
//     requestedGrain === "day" &&
//     (dataGrain === "month" || dataGrain === "week")
//   ) {
//     return {
//       ok: false,
//       message: "This dataset does not support daily analysis.",
//       validation_status: "unsupported_granularity",
//       warnings: ["no_daily_grain"],
//     };
//   }

//   if (
//     (strictIntentType === "trend" || /\btrend\b/i.test(lower)) &&
//     requestedGrain === "week" &&
//     dataGrain === "month"
//   ) {
//     return {
//       ok: false,
//       message: "This dataset has monthly granularity, not weekly.",
//       validation_status: "unsupported_granularity",
//       warnings: ["dataset_not_weekly"],
//     };
//   }

//   return { ok: true, validation_status: status, warnings };
// }

// function checkCompleteness({ timeBundle, question }) {
//   const warnings = [];
//   const lower = question.toLowerCase();
//   if (/\bthis week\b/i.test(lower) && /\blast week\b/i.test(lower) && timeBundle?.partialWeekIncomplete) {
//     warnings.push(
//       "This week's data is incomplete relative to a full calendar week; interpret week-over-week deltas cautiously."
//     );
//   }
//   if (timeBundle?.resolvedTimeRange?.partialNote) {
//     warnings.push(timeBundle.resolvedTimeRange.partialNote);
//   }
//   if (timeBundle?.comparison?.partialNote) {
//     warnings.push(timeBundle.comparison.partialNote);
//   }
//   return { warnings };
// }

// function logDebug(payload) {
//   if (process.env.DATASPEAK_DEBUG === "1" || process.env.DATASPEAK_DEBUG === "true") {
//     console.log("[DataSpeak]", JSON.stringify({ ts: new Date().toISOString(), ...payload }));
//   }
// }

// /** Latest calendar year present in the time column (uses bucket keys + parseable dates). */
// function latestDataYear(rows, dateCol) {
//   if (!dateCol || !rows.length) return null;
//   const orderedKeys = computeOrderedMonthBucketKeys(rows, dateCol);
//   let maxY = 0;
//   for (let i = 0; i < rows.length; i++) {
//     const sk = parseDateToken(rows[i]?.[dateCol]).sortKey;
//     if (sk > 0) maxY = Math.max(maxY, Math.floor(sk / 10000));
//     const b = orderedKeys[i];
//     if (b != null && typeof b === "number") maxY = Math.max(maxY, Math.floor(b / 10000));
//   }
//   return maxY > 0 ? maxY : null;
// }

// function rowCalendarYearMonthFromTimeCol(rows, dateCol, rowIndex, orderedKeys) {
//   const raw = String(rows[rowIndex]?.[dateCol] ?? "").trim();
//   if (!raw) return null;
//   const bucket = orderedKeys[rowIndex];
//   if (bucket != null && typeof bucket === "number") {
//     const y = Math.floor(bucket / 10000);
//     const mo = Math.floor((bucket % 10000) / 100);
//     if (mo >= 1 && mo <= 12) return { y, mo };
//   }
//   const sk = parseDateToken(raw).sortKey;
//   if (sk > 0) {
//     const y = Math.floor(sk / 10000);
//     const mo = Math.floor((sk % 10000) / 100);
//     if (mo >= 1 && mo <= 12) return { y, mo };
//   }
//   const moOnly = parseMonthNameOnly(raw);
//   if (moOnly !== null) {
//     const yFromBucket =
//       bucket != null && typeof bucket === "number" ? Math.floor(bucket / 10000) : null;
//     return { y: yFromBucket, mo: moOnly, monthNameOnly: yFromBucket == null };
//   }
//   return null;
// }

// /** Sum metric where calendar month index (1–12) matches — aggregates across years (month-name rows included). */
// function sumMetricForMonthIndex(rows, dateCol, valueCol, monthIndex) {
//   const orderedKeys = computeOrderedMonthBucketKeys(rows, dateCol);
//   let s = 0;
//   for (let i = 0; i < rows.length; i++) {
//     const ym = rowCalendarYearMonthFromTimeCol(rows, dateCol, i, orderedKeys);
//     if (!ym || ym.mo !== monthIndex) continue;
//     const n = parseNumber(rows[i]?.[valueCol]);
//     if (n !== null) s += n;
//   }
//   return s;
// }

// /** Sum for specific calendar year + month */
// function sumMetricForYearMonth(rows, dateCol, valueCol, year, monthIndex) {
//   const orderedKeys = computeOrderedMonthBucketKeys(rows, dateCol);
//   let s = 0;
//   for (let i = 0; i < rows.length; i++) {
//     const ym = rowCalendarYearMonthFromTimeCol(rows, dateCol, i, orderedKeys);
//     if (!ym || ym.mo !== monthIndex) continue;
//     if (ym.y === null || ym.y !== year) continue;
//     if (ym.monthNameOnly) continue;
//     const n = parseNumber(rows[i]?.[valueCol]);
//     if (n !== null) s += n;
//   }
//   return s;
// }

// function quarterFromMonth(m) {
//   return Math.floor((m - 1) / 3) + 1;
// }

// function sumMetricForQuarter(rows, dateCol, valueCol, year, quarter) {
//   const startM = (quarter - 1) * 3 + 1;
//   const endM = startM + 2;
//   const orderedKeys = computeOrderedMonthBucketKeys(rows, dateCol);
//   let s = 0;
//   for (let i = 0; i < rows.length; i++) {
//     const ym = rowCalendarYearMonthFromTimeCol(rows, dateCol, i, orderedKeys);
//     if (!ym || ym.y === null || ym.y !== year) continue;
//     if (ym.mo < startM || ym.mo > endM) continue;
//     const n = parseNumber(rows[i]?.[valueCol]);
//     if (n !== null) s += n;
//   }
//   return s;
// }

// function sumMetricForYear(rows, dateCol, valueCol, year) {
//   const orderedKeys = computeOrderedMonthBucketKeys(rows, dateCol);
//   let s = 0;
//   for (let i = 0; i < rows.length; i++) {
//     const ym = rowCalendarYearMonthFromTimeCol(rows, dateCol, i, orderedKeys);
//     if (!ym || ym.y === null || ym.y !== year) continue;
//     const n = parseNumber(rows[i]?.[valueCol]);
//     if (n !== null) s += n;
//   }
//   return s;
// }

// function extractTwoMonthsFromQuestion(q) {
//   const between = q.match(/\bbetween\s+([a-zA-Z]+)\s+and\s+([a-zA-Z]+)\b/i);
//   if (between) {
//     const a = normMonthToken(between[1]);
//     const b = normMonthToken(between[2]);
//     if (a && b) return { left: a, right: b, labels: [between[1], between[2]] };
//   }
//   const re =
//     /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/gi;
//   const found = [];
//   let m;
//   while ((m = re.exec(q)) !== null) {
//     const idx = normMonthToken(m[1]);
//     if (idx) found.push({ idx, label: m[1] });
//   }
//   if (found.length >= 2) {
//     return { left: found[0].idx, right: found[1].idx, labels: [found[0].label, found[1].label] };
//   }
//   return null;
// }

// function extractTwoQuarters(q) {
//   const m = q.match(/\bq([1-4])\b.*\bq([1-4])\b/i);
//   if (m) return { q1: Number(m[1]), q2: Number(m[2]) };
//   return null;
// }

// function extractTwoYears(q) {
//   const m = q.match(/\b(20[0-9]{2})\b.*\b(20[0-9]{2})\b/);
//   if (m) return { y1: Number(m[1]), y2: Number(m[2]) };
//   return null;
// }

// /** Two explicit month+year pairs in order (e.g. Jan 2023 vs Feb 2023, or Jan 2023 vs Jan 2024). */
// function extractTwoYearMonthSpecs(q) {
//   const re =
//     /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)\s+(20[0-9]{2})\b/gi;
//   const hits = [...q.matchAll(re)];
//   if (hits.length < 2) return null;
//   const mo1 = normMonthToken(hits[0][1]);
//   const mo2 = normMonthToken(hits[1][1]);
//   const y1 = Number(hits[0][2]);
//   const y2 = Number(hits[1][2]);
//   if (mo1 && mo2) return { mo1, y1, mo2, y2 };
//   return null;
// }

// function formatMoney(n) {
//   return `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// }

// function formatVal(n, colName) {
//   if (/revenue|sales|cost|spend|price|amount/i.test(colName)) return formatMoney(n);
//   return Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
// }

// /**
//  * Pairwise comparison: months, quarters, years, or two category values.
//  */
// function comparisonAnalysis(ctx) {
//   const { question, rows, columns, metrics, dateCol } = ctx;
//   const valueCol = metrics.primaryColumn || metrics.columnMap?.[metrics.primaryMetricId];
//   if (!valueCol) {
//     return {
//       answer: "Could not determine which numeric column to compare.",
//       source: "computed",
//       confidence: "low",
//       validation_status: "missing_metric",
//       warnings: [],
//     };
//   }

//   const metricLabel = metrics.primaryMetricId || valueCol;
//   const q = String(question);

//   const looksTimeCompare =
//     extractTwoMonthsFromQuestion(q) ||
//     extractTwoYearMonthSpecs(q) ||
//     (extractTwoYears(q) && /\b(compare|versus|vs|between)\b/i.test(q)) ||
//     (extractTwoQuarters(q) && /\b(compare|versus|vs|between|\bq[1-4]\b.*\bq[1-4]\b)/i.test(q));
//   if (looksTimeCompare && !dateCol) {
//     return {
//       answer:
//         "This comparison needs a parseable date column in the dataset. None was detected with enough confidence.",
//       source: "computed",
//       confidence: "high",
//       validation_status: "missing_time",
//       warnings: ["no_date_column"],
//     };
//   }

//   // --- Specific year-months: "Jan 2023 vs Feb 2023" / "January 2023 and January 2024"
//   const ym = extractTwoYearMonthSpecs(q);
//   if (ym && dateCol) {
//     const v1 = sumMetricForYearMonth(rows, dateCol, valueCol, ym.y1, ym.mo1);
//     const v2 = sumMetricForYearMonth(rows, dateCol, valueCol, ym.y2, ym.mo2);
//     return buildPairAnswer({
//       leftLabel: `${ym.mo1}/${ym.y1}`,
//       rightLabel: `${ym.mo2}/${ym.y2}`,
//       v1,
//       v2,
//       valueCol,
//       metricLabel,
//       dimension: "year-month",
//     });
//   }

//   // --- Two calendar years
//   const yy = extractTwoYears(q);
//   if (yy && dateCol && /\bcompare\b|\bcomparison\b|\bvs\b|\bversus\b|\bbetween\b/i.test(q)) {
//     const v1 = sumMetricForYear(rows, dateCol, valueCol, yy.y1);
//     const v2 = sumMetricForYear(rows, dateCol, valueCol, yy.y2);
//     return buildPairAnswer({
//       leftLabel: String(yy.y1),
//       rightLabel: String(yy.y2),
//       v1,
//       v2,
//       valueCol,
//       metricLabel,
//       dimension: "year",
//     });
//   }

//   // --- Two quarters (same year from latest data if not specified)
//   const qq = extractTwoQuarters(q);
//   if (qq && dateCol) {
//     const refSk = rows.map((r) => parseDateToken(r[dateCol]).sortKey).filter(Boolean);
//     const maxSk = refSk.length ? Math.max(...refSk) : 0;
//     const y = latestDataYear(rows, dateCol) || (maxSk ? Math.floor(maxSk / 10000) : null);
//     if (!y) return null;
//     const v1 = sumMetricForQuarter(rows, dateCol, valueCol, y, qq.q1);
//     const v2 = sumMetricForQuarter(rows, dateCol, valueCol, y, qq.q2);
//     const out = buildPairAnswer({
//       leftLabel: `Q${qq.q1} ${y}`,
//       rightLabel: `Q${qq.q2} ${y}`,
//       v1,
//       v2,
//       valueCol,
//       metricLabel,
//       dimension: "quarter",
//     });
//     out.warnings = [...(out.warnings || []), `Quarters use year **${y}** from your latest dated row unless you specified otherwise.`];
//     return out;
//   }

//   // --- Two month names, no year → compare within latest calendar year present in data
//   const mo = extractTwoMonthsFromQuestion(q);
//   if (mo && dateCol) {
//     const yLatest = latestDataYear(rows, dateCol);
//     const monthNames = [
//       "",
//       "January",
//       "February",
//       "March",
//       "April",
//       "May",
//       "June",
//       "July",
//       "August",
//       "September",
//       "October",
//       "November",
//       "December",
//     ];
//     let v1;
//     let v2;
//     let leftLabel;
//     let rightLabel;
//     if (yLatest) {
//       v1 = sumMetricForYearMonth(rows, dateCol, valueCol, yLatest, mo.left);
//       v2 = sumMetricForYearMonth(rows, dateCol, valueCol, yLatest, mo.right);
//       leftLabel = `${monthNames[mo.left]} ${yLatest}`;
//       rightLabel = `${monthNames[mo.right]} ${yLatest}`;
//     } else {
//       v1 = sumMetricForMonthIndex(rows, dateCol, valueCol, mo.left);
//       v2 = sumMetricForMonthIndex(rows, dateCol, valueCol, mo.right);
//       leftLabel = monthNames[mo.left];
//       rightLabel = monthNames[mo.right];
//     }
//     const out = buildPairAnswer({
//       leftLabel,
//       rightLabel,
//       v1,
//       v2,
//       valueCol,
//       metricLabel,
//       dimension: "calendar_month",
//     });
//     if (yLatest) {
//       out.warnings = [...(out.warnings || []), `Compared months within **${yLatest}** (latest year found in the date column).`];
//     }
//     return out;
//   }

//   // --- Category pair (North vs South)
//   const pair = extractEntityPair(q);
//   if (pair) {
//     const numericSet = new Set(getNumericColumns(rows, columns));
//     const dim =
//       findColumnForAliases(columns, ["region", "area", "territory"]) ||
//       findColumnForAliases(columns, ["product", "sku", "item"]) ||
//       findColumnForAliases(columns, ["channel", "segment", "department"]);
//     if (!dim) {
//       return {
//         answer: "I need a region/product/channel column to compare those values, but none was found.",
//         source: "computed",
//         confidence: "low",
//         validation_status: "missing_dimension",
//         warnings: [],
//       };
//     }
//     const norm = (s) => String(s || "").trim().toLowerCase();
//     const a = norm(pair.a);
//     const b = norm(pair.b);
//     let s1 = 0;
//     let s2 = 0;
//     for (const row of rows) {
//       const lab = norm(row[dim]);
//       const n = parseNumber(row?.[valueCol]);
//       if (n === null) continue;
//       if (lab.includes(a) || a.includes(lab)) s1 += n;
//       if (lab.includes(b) || b.includes(lab)) s2 += n;
//     }
//     return buildPairAnswer({
//       leftLabel: pair.a,
//       rightLabel: pair.b,
//       v1: s1,
//       v2: s2,
//       valueCol,
//       metricLabel,
//       dimension: dim,
//     });
//   }

//   return null;
// }

// /**
//  * True when the question is asking for a two-sided numeric comparison (not e.g. "highest month overall").
//  */
// function looksLikePairwiseComparisonQuestion(q) {
//   const s = String(q);
//   const lower = s.toLowerCase();
//   if (/\b(compare|comparison|versus|vs\.?)\b/i.test(lower)) return true;
//   if (/\bbetween\s+.+\s+and\s+/i.test(s)) return true;
//   if (extractTwoMonthsFromQuestion(s)) return true;
//   if (extractTwoYearMonthSpecs(s)) return true;
//   const yy = extractTwoYears(s);
//   if (yy && /\b(compare|versus|vs|between)\b/i.test(lower)) return true;
//   if (extractTwoQuarters(s) && /\b(compare|versus|vs|between|\bq[1-4]\b.*\bq[1-4]\b)/i.test(s)) return true;
//   if (extractEntityPair(s)) return true;
//   return false;
// }

// function buildPairAnswer({ leftLabel, rightLabel, v1, v2, valueCol, metricLabel, dimension }) {
//   const diff = v2 - v1;
//   const pct = v1 !== 0 ? ((diff / Math.abs(v1)) * 100).toFixed(1) : v2 === 0 ? "0" : "∞";
//   const winner = v1 > v2 ? leftLabel : v2 > v1 ? rightLabel : "tie";
//   const higher = v2 > v1 ? rightLabel : v1 > v2 ? leftLabel : null;

//   const fv1 = formatVal(v1, valueCol);
//   const fv2 = formatVal(v2, valueCol);
//   const fdiff = formatVal(Math.abs(diff), valueCol);

//   let answer = `**${metricLabel}** (${valueCol}) aggregated by **${dimension}**: **${leftLabel}** = **${fv1}**, **${rightLabel}** = **${fv2}**.`;
//   if (higher && v1 !== v2) {
//     answer += ` **${higher}** is higher by **${fdiff}** (${Math.abs(Number(pct))}% vs the other).`;
//   } else if (v1 === v2) {
//     answer += " Both totals are equal.";
//   }

//   return {
//     answer,
//     source: "computed",
//     confidence: "high",
//     reasoning_mode: "pairwise_comparison",
//     validation_status: "ok",
//     comparison: {
//       metric: metricLabel,
//       dimension,
//       left: { label: leftLabel, value: v1 },
//       right: { label: rightLabel, value: v2 },
//       diff,
//       pctDiff: pct,
//       winner: winner === "tie" ? null : winner,
//     },
//     chartData: {
//       labels: [leftLabel, rightLabel],
//       values: [v1, v2],
//       type: "bar",
//     },
//     warnings: [],
//   };
// }

// const { tryTimeComparisonAndDriver } = require("./deterministicAnalytics");

// /** MoM / WoW driver attribution — same core as deterministic pipeline (no anomaly detection). */
// function driverAnalysis(ctx) {
//   return tryTimeComparisonAndDriver(ctx);
// }

// /**
//  * @returns {object|null} Structured answer or null to defer to rules / LLM.
//  */
// function trendAnalysis({ question, rows, columns, metrics, dateCol }) {
//   const valueCol = metrics.primaryColumn;
//   if (!valueCol || !rows.length) return null;

//   const reqG = inferRequestedSeriesGrain(question);
//   const dataGrain = dateCol ? inferDatasetTemporalGranularity(rows, dateCol).grain : "unknown";
//   if (reqG === "day" && (dataGrain === "month" || dataGrain === "week")) {
//     return {
//       answer: "This dataset does not support daily analysis.",
//       source: "computed",
//       confidence: "high",
//       reasoning_mode: "safe_refusal",
//       validation_status: "unsupported_granularity",
//       warnings: ["no_daily_grain"],
//     };
//   }
//   if (reqG === "week" && dataGrain === "month") {
//     return {
//       answer: "This dataset has monthly granularity, not weekly.",
//       source: "computed",
//       confidence: "high",
//       reasoning_mode: "safe_refusal",
//       validation_status: "unsupported_granularity",
//       warnings: ["dataset_not_weekly"],
//     };
//   }

//   const labelCol = dateCol || detectTemporalColumn(columns);
//   if (!labelCol) {
//     return {
//       answer:
//         "A date or time column is required to describe how this metric changes over time; none was detected.",
//       source: "computed",
//       confidence: "high",
//       reasoning_mode: "safe_refusal",
//       validation_status: "missing_time",
//       warnings: ["no_date_column"],
//     };
//   }

//   const avgKeywords = /\b(price|rate|ratio|score|rating|index|temperature|avg|average|mean|percent|%)\b/i;
//   const agg = avgKeywords.test(valueCol) ? "avg" : "sum";
//   const trend = detectTrend(rows, valueCol, labelCol, agg);
//   if (!trend) return null;

//   const { direction, from, to, min, max, labels } = trend;
//   const firstLabel = labels[0] || "start";
//   const lastLabel = labels[labels.length - 1] || "end";
//   const change = to - from;
//   const changePct = from !== 0 ? ((change / Math.abs(from)) * 100).toFixed(1) : null;

//   let answer = `**${metrics.primaryMetricId || valueCol}** (${valueCol}) over **${labelCol}**: `;
//   answer += `from **${formatNumber(from)}** (${firstLabel}) to **${formatNumber(to)}** (${lastLabel})`;
//   if (changePct !== null) answer += ` — about **${change >= 0 ? "+" : ""}${changePct}%** vs the start of the series.`;
//   answer += ` Direction: **${direction}** (range **${formatNumber(min)}**–**${formatNumber(max)}** across **${labels.length}** time periods).`;

//   return {
//     answer,
//     source: "computed",
//     confidence: "high",
//     reasoning_mode: "trend",
//     validation_status: "ok",
//     warnings: [],
//     chartData: {
//       labels: labels.slice(-15),
//       values: trend.values.slice(-15).map((v) => parseFloat(Number(v).toFixed(2))),
//       type: "line",
//     },
//   };
// }

// function breakdownAnalysis({ question, rows, columns, metrics }) {
//   const valueCol = metrics.primaryColumn;
//   if (!valueCol) {
//     return {
//       answer: "Could not determine which numeric column to break down.",
//       source: "computed",
//       confidence: "low",
//       validation_status: "missing_metric",
//       warnings: [],
//     };
//   }

//   const numericCols = getNumericColumns(rows, columns);
//   const nonNumeric = columns.filter((c) => !numericCols.includes(c));
//   const dim =
//     columnMentionedInQuestion(question, nonNumeric) ||
//     findColumnForAliases(columns, ["region", "area", "territory", "country"]) ||
//     findColumnForAliases(columns, ["product", "sku", "item"]) ||
//     findColumnForAliases(columns, ["channel", "segment", "department"]) ||
//     detectGroupColumn(rows, columns, numericCols);

//   if (!dim) {
//     return {
//       answer:
//         "I could not find a categorical column (for example region or product) to split this metric by.",
//       source: "computed",
//       confidence: "medium",
//       validation_status: "missing_dimension",
//       warnings: [],
//     };
//   }

//   const grouped = groupBy(rows, dim, [valueCol]);
//   if (!grouped.length) return null;

//   const total = grouped.reduce((a, g) => a + (g[`${valueCol}_sum`] || 0), 0);
//   const top = grouped.slice(0, 8);
//   const parts = top.map((g) => {
//     const v = g[`${valueCol}_sum`] || 0;
//     const pct = total > 0 ? ((v / total) * 100).toFixed(1) : "0";
//     return `**${g.group}** ${pct}% (${formatNumber(v)})`;
//   });

//   const answer =
//     `**${metrics.primaryMetricId || valueCol}** by **${dim}** (share of total **${formatNumber(total)}**): ` +
//     `${parts.join(", ")}.`;

//   return {
//     answer,
//     source: "computed",
//     confidence: "high",
//     reasoning_mode: "breakdown",
//     validation_status: "ok",
//     warnings: [],
//     chartData: {
//       labels: top.map((g) => g.group),
//       values: top.map((g) => parseFloat((g[`${valueCol}_sum`] || 0).toFixed(2))),
//       type: "bar",
//     },
//   };
// }

// function summaryAnalysis({ rows, columns, metrics, dateCol }) {
//   const primary = metrics.primaryColumn;
//   if (!primary) return null;

//   const stats = summaryStats(rows, columns);
//   const s0 = stats[primary];
//   if (!s0) return null;

//   const temporal = dateCol || detectTemporalColumn(columns);
//   let latestChange = "";
//   let overallTrend = "";
//   let stability = "";

//   if (temporal) {
//     const buckets = groupByTime(rows, temporal, [primary], "sum");
//     if (buckets.length >= 2) {
//       const vals = buckets.map((b) => Number(b[primary]) || 0);
//       const last = vals[vals.length - 1];
//       const prev = vals[vals.length - 2];
//       const pct = prev !== 0 ? (((last - prev) / Math.abs(prev)) * 100).toFixed(1) : last === 0 ? "0" : "—";
//       latestChange = `Latest period vs prior: **${formatNumber(last)}** vs **${formatNumber(prev)}** (${pct}%). `;

//       const dir = detectTrendDirection(vals);
//       overallTrend = `Overall series trend: **${dir}** (from **${formatNumber(vals[0])}** to **${formatNumber(last)}**). `;

//       const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
//       const std = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length) || 0;
//       const cv = mean !== 0 ? std / Math.abs(mean) : 0;
//       stability =
//         cv < 0.15
//           ? "Period-to-period variation is **low** relative to the mean."
//           : cv < 0.35
//             ? "Period-to-period variation is **moderate**."
//             : "Period-to-period variation is **high**.";
//     }
//   }

//   const answer =
//     `**${metrics.primaryMetricId || primary}** — total **${formatNumber(s0.sum)}**, average **${formatNumber(s0.avg)}**, range **${formatNumber(s0.min)}**–**${formatNumber(s0.max)}**. ` +
//     (latestChange || "") +
//     (overallTrend || `Across all rows, values span **${formatNumber(s0.min)}** to **${formatNumber(s0.max)}**. `) +
//     (stability || "");

//   return {
//     answer,
//     source: "computed",
//     confidence: temporal ? "high" : "medium",
//     reasoning_mode: "summary",
//     validation_status: "ok",
//     warnings: [],
//   };
// }

// module.exports = {
//   detectIntent,
//   inferRequestedSeriesGrain,
//   validateData,
//   checkCompleteness,
//   comparisonAnalysis,
//   looksLikePairwiseComparisonQuestion,
//   driverAnalysis,
//   trendAnalysis,
//   breakdownAnalysis,
//   summaryAnalysis,
//   logDebug,
//   MONTH_WORDS,
// };
/**
 * queryAnalysis.js — Validation, strict intent, and modular deterministic analytics.
 * Never assumes columns exist; returns safe messages when data is missing or incomplete.
 */

const {
  parseDateToken,
  parseNumber,
  getNumericColumns,
  detectTemporalColumn,
  inferDatasetTemporalGranularity,
  detectTrend,
  detectTrendDirection,
  formatNumber,
  groupBy,
  groupByTime,
  detectGroupColumn,
  columnMentionedInQuestion,
  summaryStats,
  computeOrderedMonthBucketKeys,
  parseMonthNameOnly,
} = require("../utils/datasetAnalysis");
const { METRIC_DICTIONARY, findColumnForAliases } = require("./metricResolver");
const { extractEntityPair, isRelativeTimeEntityPair } = require("./intentParser");
const { tryTimeComparisonAndDriver } = require("./deterministicAnalytics");

const MONTH_WORDS = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

function normMonthToken(t) {
  const s = String(t || "")
    .toLowerCase()
    .replace(/\./g, "")
    .trim();
  if (!s) return null;
  if (MONTH_WORDS[s] !== undefined) return MONTH_WORDS[s];
  return MONTH_WORDS[s.slice(0, 3)] ?? null;
}

/**
 * Single primary intent — strict priority (do not mix).
 * Order: DRIVER → COMPARISON → TREND → TOP_N → BREAKDOWN → SUMMARY.
 */
function detectIntent(question) {
  const lower = String(question || "").toLowerCase();

  if (/\b(why|cause|causes|reason|reasons|what caused|what drove|due to|driver)\b/i.test(lower)) {
    return { type: "driver", raw: question };
  }
  if (
    /\bacross\b.*\b(regions?|products?|channels?|categor|segments?)\b/i.test(lower) ||
    /\b(compare|comparison|versus|vs\.?)\b/i.test(lower) ||
    /\bbetween\s+.+\s+and\s+/i.test(question)
  ) {
    return { type: "comparison", raw: question };
  }
  if (/\b(trend|over time|over the period|trajectory)\b/i.test(lower)) {
    return { type: "trend", raw: question };
  }
  if (
    /\b(top\s*\d+|bottom\s*\d+|highest\s+\d+|best\s+\d+|worst\s+\d+)\b/i.test(lower) ||
    /\b(top|highest|lowest)\b/i.test(lower)
  ) {
    return { type: "top_n", raw: question };
  }
  if (
    /\b(summary|overview|recap|snapshot)\b/i.test(lower) ||
    /\b(monthly|weekly|daily)\s+(analysis|review|report)\b/i.test(lower) ||
    /\bgive me (a )?monthly analysis\b/i.test(lower) ||
    /\banalyze (this month|the latest month)\b/i.test(lower) ||
    /\b(latest|this) month analysis\b/i.test(lower)
  ) {
    return { type: "summary", raw: question };
  }
  if (/\b(breakdown|composition)\b/i.test(lower) || /\bby\b/i.test(lower)) {
    return { type: "breakdown", raw: question };
  }
  return { type: "general", raw: question };
}

/** User-requested series grain from wording (null = no explicit constraint). */
function inferRequestedSeriesGrain(question) {
  const lower = String(question || "").toLowerCase();
  if (/\bdaily\b|day[- ]by[- ]day|each\s+day|per\s+day\b/i.test(lower)) return "day";
  if (/\bweekly\b|week[- ]level|wow\b|week\s+over\s+week/i.test(lower)) return "week";
  if (/\bmonthly\b|month[- ]level|mom\b|month\s+over\s+month/i.test(lower)) return "month";
  return null;
}

/**
 * Validate that we can answer questions about the requested metric/dimension/time.
 */
function validateData({ question, columns, rows, metrics, dateCol, timeGrainRequired, strictIntentType, intent }) {
  const warnings = [];
  let status = "ok";

  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, message: "No data rows to analyze.", validation_status: "empty", warnings: [] };
  }
  if (!metrics.primaryColumn && metrics.numericColumns.length === 0) {
    return {
      ok: false,
      message: "The dataset has no numeric columns to aggregate.",
      validation_status: "missing_metric",
      warnings: [],
    };
  }

  const lower = question.toLowerCase();
  const revenueDef = METRIC_DICTIONARY.find((d) => d.id === "Revenue");
  if (revenueDef && /\b(revenue|sales|income|turnover)\b/i.test(lower)) {
    const revCol = findColumnForAliases(columns, revenueDef.aliases);
    if (!revCol) {
      return {
        ok: false,
        message: "The dataset does not contain a revenue-related column.",
        validation_status: "missing_metric",
        warnings: [],
      };
    }
  }

  const asksRegionAnalysis =
    /\b(across|by|per|for each|split|breakdown|compare|comparison)\b/i.test(lower) &&
    /\b(regions?|territor|geo)\b/i.test(lower);
  if (asksRegionAnalysis) {
    const rcol = findColumnForAliases(columns, ["region", "area", "territory"]);
    if (!rcol) {
      return {
        ok: false,
        message: "The dataset does not contain a region column.",
        validation_status: "missing_dimension",
        warnings: [],
      };
    }
  }

  const requestedGrain = inferRequestedSeriesGrain(question);
  const dataGrain = dateCol ? inferDatasetTemporalGranularity(rows, dateCol).grain : "unknown";

  const wantsDailySummary =
    intent?.isDailySummary ||
    /\bdaily\s+summary\b/i.test(lower) ||
    /\b(summary|overview|recap)\b.*\bdaily\b/i.test(lower) ||
    /\bdaily\b.*\b(summary|overview|recap)\b/i.test(lower);

  const wantsDailyAnalysis =
    /\bdaily\s+(analysis|review|report)\b/i.test(lower) || /\banalyze (today|this day)\b/i.test(lower);

  if ((wantsDailySummary || wantsDailyAnalysis) && dataGrain !== "day") {
    return {
      ok: false,
      message: "This dataset does not support daily analysis.",
      validation_status: "unsupported_granularity",
      warnings: ["no_daily_grain"],
    };
  }

  const wantsWeeklySummaryOrAnalysis =
    intent?.isWeeklySummary ||
    /\bweekly\s+(summary|analysis|review|report)\b/i.test(lower) ||
    /\bgive me (a )?weekly summary\b/i.test(lower);

  if (wantsWeeklySummaryOrAnalysis && dateCol && (dataGrain === "month" || dataGrain === "unknown")) {
    return {
      ok: false,
      message: "Weekly summary is not supported because the dataset granularity is monthly.",
      validation_status: "unsupported_granularity",
      warnings: ["dataset_not_weekly"],
    };
  }

  if (timeGrainRequired === "week" || requestedGrain === "week") {
    if (!dateCol) {
      return {
        ok: false,
        message: "This dataset has monthly granularity, not weekly.",
        validation_status: "unsupported_granularity",
        warnings: ["dataset_not_weekly"],
      };
    }
    if (dataGrain === "month" || dataGrain === "unknown") {
      return {
        ok: false,
        message: "This dataset has monthly granularity, not weekly.",
        validation_status: "unsupported_granularity",
        warnings: ["dataset_not_weekly"],
      };
    }
  }

  if (
    (strictIntentType === "trend" || /\btrend\b/i.test(lower)) &&
    requestedGrain === "day" &&
    (dataGrain === "month" || dataGrain === "week")
  ) {
    return {
      ok: false,
      message: "This dataset does not support daily analysis.",
      validation_status: "unsupported_granularity",
      warnings: ["no_daily_grain"],
    };
  }

  if (
    (strictIntentType === "trend" || /\btrend\b/i.test(lower)) &&
    requestedGrain === "week" &&
    dataGrain === "month"
  ) {
    return {
      ok: false,
      message: "This dataset has monthly granularity, not weekly.",
      validation_status: "unsupported_granularity",
      warnings: ["dataset_not_weekly"],
    };
  }

  return { ok: true, validation_status: status, warnings };
}

function checkCompleteness({ timeBundle, question }) {
  const warnings = [];
  const lower = question.toLowerCase();
  if (/\bthis week\b/i.test(lower) && /\blast week\b/i.test(lower) && timeBundle?.partialWeekIncomplete) {
    warnings.push(
      "This week's data is incomplete relative to a full calendar week; interpret week-over-week deltas cautiously."
    );
  }
  if (timeBundle?.resolvedTimeRange?.partialNote) {
    warnings.push(timeBundle.resolvedTimeRange.partialNote);
  }
  if (timeBundle?.comparison?.partialNote) {
    warnings.push(timeBundle.comparison.partialNote);
  }
  return { warnings };
}

function logDebug(payload) {
  if (process.env.DATASPEAK_DEBUG === "1" || process.env.DATASPEAK_DEBUG === "true") {
    console.log("[DataSpeak]", JSON.stringify({ ts: new Date().toISOString(), ...payload }));
  }
}

/** Latest calendar year present in the time column (uses bucket keys + parseable dates). */
function latestDataYear(rows, dateCol) {
  if (!dateCol || !rows.length) return null;
  const orderedKeys = computeOrderedMonthBucketKeys(rows, dateCol);
  let maxY = 0;
  for (let i = 0; i < rows.length; i++) {
    const sk = parseDateToken(rows[i]?.[dateCol]).sortKey;
    if (sk > 0) maxY = Math.max(maxY, Math.floor(sk / 10000));
    const b = orderedKeys[i];
    if (b != null && typeof b === "number") maxY = Math.max(maxY, Math.floor(b / 10000));
  }
  return maxY > 0 ? maxY : null;
}

function rowCalendarYearMonthFromTimeCol(rows, dateCol, rowIndex, orderedKeys) {
  const raw = String(rows[rowIndex]?.[dateCol] ?? "").trim();
  if (!raw) return null;
  const bucket = orderedKeys[rowIndex];
  if (bucket != null && typeof bucket === "number") {
    const y = Math.floor(bucket / 10000);
    const mo = Math.floor((bucket % 10000) / 100);
    if (mo >= 1 && mo <= 12) return { y, mo };
  }
  const sk = parseDateToken(raw).sortKey;
  if (sk > 0) {
    const y = Math.floor(sk / 10000);
    const mo = Math.floor((sk % 10000) / 100);
    if (mo >= 1 && mo <= 12) return { y, mo };
  }
  const moOnly = parseMonthNameOnly(raw);
  if (moOnly !== null) {
    const yFromBucket =
      bucket != null && typeof bucket === "number" ? Math.floor(bucket / 10000) : null;
    return { y: yFromBucket, mo: moOnly, monthNameOnly: yFromBucket == null };
  }
  return null;
}

/** Sum metric where calendar month index (1–12) matches — aggregates across years (month-name rows included). */
function sumMetricForMonthIndex(rows, dateCol, valueCol, monthIndex) {
  const orderedKeys = computeOrderedMonthBucketKeys(rows, dateCol);
  let s = 0;
  for (let i = 0; i < rows.length; i++) {
    const ym = rowCalendarYearMonthFromTimeCol(rows, dateCol, i, orderedKeys);
    if (!ym || ym.mo !== monthIndex) continue;
    const n = parseNumber(rows[i]?.[valueCol]);
    if (n !== null) s += n;
  }
  return s;
}

/** Sum for specific calendar year + month */
function sumMetricForYearMonth(rows, dateCol, valueCol, year, monthIndex) {
  const orderedKeys = computeOrderedMonthBucketKeys(rows, dateCol);
  let s = 0;
  for (let i = 0; i < rows.length; i++) {
    const ym = rowCalendarYearMonthFromTimeCol(rows, dateCol, i, orderedKeys);
    if (!ym || ym.mo !== monthIndex) continue;
    if (ym.y === null || ym.y !== year) continue;
    if (ym.monthNameOnly) continue;
    const n = parseNumber(rows[i]?.[valueCol]);
    if (n !== null) s += n;
  }
  return s;
}

function quarterFromMonth(m) {
  return Math.floor((m - 1) / 3) + 1;
}

function sumMetricForQuarter(rows, dateCol, valueCol, year, quarter) {
  const startM = (quarter - 1) * 3 + 1;
  const endM = startM + 2;
  const orderedKeys = computeOrderedMonthBucketKeys(rows, dateCol);
  let s = 0;
  for (let i = 0; i < rows.length; i++) {
    const ym = rowCalendarYearMonthFromTimeCol(rows, dateCol, i, orderedKeys);
    if (!ym || ym.y === null || ym.y !== year) continue;
    if (ym.mo < startM || ym.mo > endM) continue;
    const n = parseNumber(rows[i]?.[valueCol]);
    if (n !== null) s += n;
  }
  return s;
}

function sumMetricForYear(rows, dateCol, valueCol, year) {
  const orderedKeys = computeOrderedMonthBucketKeys(rows, dateCol);
  let s = 0;
  for (let i = 0; i < rows.length; i++) {
    const ym = rowCalendarYearMonthFromTimeCol(rows, dateCol, i, orderedKeys);
    if (!ym || ym.y === null || ym.y !== year) continue;
    const n = parseNumber(rows[i]?.[valueCol]);
    if (n !== null) s += n;
  }
  return s;
}

function extractTwoMonthsFromQuestion(q) {
  const between = q.match(/\bbetween\s+([a-zA-Z]+)\s+and\s+([a-zA-Z]+)\b/i);
  if (between) {
    const a = normMonthToken(between[1]);
    const b = normMonthToken(between[2]);
    if (a && b) return { left: a, right: b, labels: [between[1], between[2]] };
  }
  const re =
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/gi;
  const found = [];
  let m;
  while ((m = re.exec(q)) !== null) {
    const idx = normMonthToken(m[1]);
    if (idx) found.push({ idx, label: m[1] });
  }
  if (found.length >= 2) {
    return { left: found[0].idx, right: found[1].idx, labels: [found[0].label, found[1].label] };
  }
  return null;
}

function extractTwoQuarters(q) {
  const m = q.match(/\bq([1-4])\b.*\bq([1-4])\b/i);
  if (m) return { q1: Number(m[1]), q2: Number(m[2]) };
  return null;
}

function extractTwoYears(q) {
  const m = q.match(/\b(20[0-9]{2})\b.*\b(20[0-9]{2})\b/);
  if (m) return { y1: Number(m[1]), y2: Number(m[2]) };
  return null;
}

/** Two explicit month+year pairs in order (e.g. Jan 2023 vs Feb 2023, or Jan 2023 vs Jan 2024). */
function extractTwoYearMonthSpecs(q) {
  const re =
    /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)\s+(20[0-9]{2})\b/gi;
  const hits = [...q.matchAll(re)];
  if (hits.length < 2) return null;
  const mo1 = normMonthToken(hits[0][1]);
  const mo2 = normMonthToken(hits[1][1]);
  const y1 = Number(hits[0][2]);
  const y2 = Number(hits[1][2]);
  if (mo1 && mo2) return { mo1, y1, mo2, y2 };
  return null;
}

function formatMoney(n) {
  return `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatVal(n, colName) {
  if (/revenue|sales|cost|spend|price|amount/i.test(colName)) return formatMoney(n);
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * Pairwise comparison: months, quarters, years, or two category values.
 */
function comparisonAnalysis(ctx) {
  const { question, rows, columns, metrics, dateCol } = ctx;
  const valueCol = metrics.primaryColumn || metrics.columnMap?.[metrics.primaryMetricId];
  if (!valueCol) {
    return {
      answer: "Could not determine which numeric column to compare.",
      source: "computed",
      confidence: "low",
      validation_status: "missing_metric",
      warnings: [],
    };
  }

  const metricLabel = metrics.primaryMetricId || valueCol;
  const q = String(question);

  const looksTimeCompare =
    extractTwoMonthsFromQuestion(q) ||
    extractTwoYearMonthSpecs(q) ||
    (extractTwoYears(q) && /\b(compare|versus|vs|between)\b/i.test(q)) ||
    (extractTwoQuarters(q) && /\b(compare|versus|vs|between|\bq[1-4]\b.*\bq[1-4]\b)/i.test(q));
  if (looksTimeCompare && !dateCol) {
    return {
      answer:
        "This comparison needs a parseable date column in the dataset. None was detected with enough confidence.",
      source: "computed",
      confidence: "high",
      validation_status: "missing_time",
      warnings: ["no_date_column"],
    };
  }

  const ym = extractTwoYearMonthSpecs(q);
  if (ym && dateCol) {
    const v1 = sumMetricForYearMonth(rows, dateCol, valueCol, ym.y1, ym.mo1);
    const v2 = sumMetricForYearMonth(rows, dateCol, valueCol, ym.y2, ym.mo2);
    return buildPairAnswer({
      leftLabel: `${ym.mo1}/${ym.y1}`,
      rightLabel: `${ym.mo2}/${ym.y2}`,
      v1,
      v2,
      valueCol,
      metricLabel,
      dimension: "year-month",
    });
  }

  const yy = extractTwoYears(q);
  if (yy && dateCol && /\bcompare\b|\bcomparison\b|\bvs\b|\bversus\b|\bbetween\b/i.test(q)) {
    const v1 = sumMetricForYear(rows, dateCol, valueCol, yy.y1);
    const v2 = sumMetricForYear(rows, dateCol, valueCol, yy.y2);
    return buildPairAnswer({
      leftLabel: String(yy.y1),
      rightLabel: String(yy.y2),
      v1,
      v2,
      valueCol,
      metricLabel,
      dimension: "year",
    });
  }

  const qq = extractTwoQuarters(q);
  if (qq && dateCol) {
    const refSk = rows.map((r) => parseDateToken(r[dateCol]).sortKey).filter(Boolean);
    const maxSk = refSk.length ? Math.max(...refSk) : 0;
    const y = latestDataYear(rows, dateCol) || (maxSk ? Math.floor(maxSk / 10000) : null);
    if (!y) return null;
    const v1 = sumMetricForQuarter(rows, dateCol, valueCol, y, qq.q1);
    const v2 = sumMetricForQuarter(rows, dateCol, valueCol, y, qq.q2);
    const out = buildPairAnswer({
      leftLabel: `Q${qq.q1} ${y}`,
      rightLabel: `Q${qq.q2} ${y}`,
      v1,
      v2,
      valueCol,
      metricLabel,
      dimension: "quarter",
    });
    out.warnings = [
      ...(out.warnings || []),
      `Quarters use year **${y}** from your latest dated row unless you specified otherwise.`,
    ];
    return out;
  }

  const mo = extractTwoMonthsFromQuestion(q);
  if (mo && dateCol) {
    const yLatest = latestDataYear(rows, dateCol);
    const monthNames = [
      "",
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];
    let v1;
    let v2;
    let leftLabel;
    let rightLabel;
    if (yLatest) {
      v1 = sumMetricForYearMonth(rows, dateCol, valueCol, yLatest, mo.left);
      v2 = sumMetricForYearMonth(rows, dateCol, valueCol, yLatest, mo.right);
      leftLabel = `${monthNames[mo.left]} ${yLatest}`;
      rightLabel = `${monthNames[mo.right]} ${yLatest}`;
    } else {
      v1 = sumMetricForMonthIndex(rows, dateCol, valueCol, mo.left);
      v2 = sumMetricForMonthIndex(rows, dateCol, valueCol, mo.right);
      leftLabel = monthNames[mo.left];
      rightLabel = monthNames[mo.right];
    }
    const out = buildPairAnswer({
      leftLabel,
      rightLabel,
      v1,
      v2,
      valueCol,
      metricLabel,
      dimension: "calendar_month",
    });
    if (yLatest) {
      out.warnings = [
        ...(out.warnings || []),
        `Compared months within **${yLatest}** (latest year found in the date column).`,
      ];
    }
    return out;
  }

  const pair = extractEntityPair(q);
  if (pair && isRelativeTimeEntityPair(pair)) {
    return null;
  }
  if (pair) {
    const dim =
      findColumnForAliases(columns, ["region", "area", "territory"]) ||
      findColumnForAliases(columns, ["product", "sku", "item"]) ||
      findColumnForAliases(columns, ["channel", "segment", "department"]);
    if (!dim) {
      return {
        answer: "I need a region/product/channel column to compare those values, but none was found.",
        source: "computed",
        confidence: "low",
        validation_status: "missing_dimension",
        warnings: [],
      };
    }
    const norm = (s) => String(s || "").trim().toLowerCase();
    const a = norm(pair.a);
    const b = norm(pair.b);
    let s1 = 0;
    let s2 = 0;
    for (const row of rows) {
      const lab = norm(row[dim]);
      const n = parseNumber(row?.[valueCol]);
      if (n === null) continue;
      if (lab.includes(a) || a.includes(lab)) s1 += n;
      if (lab.includes(b) || b.includes(lab)) s2 += n;
    }
    return buildPairAnswer({
      leftLabel: pair.a,
      rightLabel: pair.b,
      v1: s1,
      v2: s2,
      valueCol,
      metricLabel,
      dimension: dim,
    });
  }

  return null;
}

/**
 * True when the question is asking for a two-sided numeric comparison.
 */
function looksLikePairwiseComparisonQuestion(q) {
  const s = String(q);
  const lower = s.toLowerCase();
  if (/\b(compare|comparison|versus|vs\.?)\b/i.test(lower)) return true;
  if (/\bbetween\s+.+\s+and\s+/i.test(s)) return true;
  if (extractTwoMonthsFromQuestion(s)) return true;
  if (extractTwoYearMonthSpecs(s)) return true;
  const yy = extractTwoYears(s);
  if (yy && /\b(compare|versus|vs|between)\b/i.test(lower)) return true;
  if (extractTwoQuarters(s) && /\b(compare|versus|vs|between|\bq[1-4]\b.*\bq[1-4]\b)/i.test(s)) return true;
  if (extractEntityPair(s)) return true;
  return false;
}

function buildPairAnswer({ leftLabel, rightLabel, v1, v2, valueCol, metricLabel, dimension }) {
  const diff = v2 - v1;
  const pct = v1 !== 0 ? ((diff / Math.abs(v1)) * 100).toFixed(1) : v2 === 0 ? "0" : "∞";
  const winner = v1 > v2 ? leftLabel : v2 > v1 ? rightLabel : "tie";
  const higher = v2 > v1 ? rightLabel : v1 > v2 ? leftLabel : null;

  const fv1 = formatVal(v1, valueCol);
  const fv2 = formatVal(v2, valueCol);
  const fdiff = formatVal(Math.abs(diff), valueCol);

  let answer = `**${metricLabel}** (${valueCol}) aggregated by **${dimension}**: **${leftLabel}** = **${fv1}**, **${rightLabel}** = **${fv2}**.`;
  if (higher && v1 !== v2) {
    answer += ` **${higher}** is higher by **${fdiff}** (${Math.abs(Number(pct))}% vs the other).`;
  } else if (v1 === v2) {
    answer += " Both totals are equal.";
  }

  return {
    answer,
    source: "computed",
    confidence: "high",
    reasoning_mode: "pairwise_comparison",
    validation_status: "ok",
    comparison: {
      metric: metricLabel,
      dimension,
      left: { label: leftLabel, value: v1 },
      right: { label: rightLabel, value: v2 },
      diff,
      pctDiff: pct,
      winner: winner === "tie" ? null : winner,
    },
    chartData: {
      labels: [leftLabel, rightLabel],
      values: [v1, v2],
      type: "bar",
    },
    warnings: [],
  };
}

function metricAggMode(metricCol = "") {
  return /\b(price|rate|ratio|score|rating|index|temperature|avg|average|mean|percent|%)\b/i.test(
    metricCol
  )
    ? "avg"
    : "sum";
}

function computeLatestVsPrevious(rows, dateCol, metricCol) {
  if (!dateCol || !metricCol) {
    return { ok: false, reason: "missing_time_or_metric" };
  }

  const series = groupByTime(rows, dateCol, [metricCol], metricAggMode(metricCol));
  if (!Array.isArray(series) || series.length < 2) {
    return { ok: false, reason: "not_enough_periods" };
  }

  const current = series[series.length - 1];
  const previous = series[series.length - 2];

  const currentValue = Number(current?.[metricCol] || 0);
  const previousValue = Number(previous?.[metricCol] || 0);
  const delta = currentValue - previousValue;
  const pct = previousValue !== 0 ? (delta / Math.abs(previousValue)) * 100 : null;

  return {
    ok: true,
    currentLabel: current.label,
    previousLabel: previous.label,
    currentValue,
    previousValue,
    delta,
    pct,
  };
}

/** Why/driver analysis based only on latest two available dataset periods. */
function driverAnalysis(ctx) {
  const q = String(ctx?.question || "");
  const lower = q.toLowerCase();

  if (!/\b(why|cause|causes|reason|reasons|what caused|what drove|driver)\b/i.test(lower)) {
    return null;
  }

  const curWin = ctx?.timeBundle?.resolvedTimeRange;
  const prevWin = ctx?.timeBundle?.comparison;
  if (
    ctx?.dateCol &&
    curWin?.start != null &&
    curWin?.end != null &&
    prevWin?.start != null &&
    prevWin?.end != null
  ) {
    const rich = tryTimeComparisonAndDriver(ctx);
    if (rich) {
      return {
        ...rich,
        source: "computed",
        reasoning_mode: "dataset_period_comparison",
        validation_status: "ok",
      };
    }
  }

  const metricCol = ctx?.metrics?.primaryColumn || ctx?.metrics?.columnMap?.[ctx?.metrics?.primaryMetricId];
  if (!metricCol) {
    return {
      answer: "Could not determine which metric to compare.",
      source: "computed",
      confidence: "low",
      reasoning_mode: "dataset_period_comparison",
      validation_status: "missing_metric",
      warnings: ["missing_metric"],
    };
  }

  if (!ctx?.dateCol) {
    return {
      answer: "I can’t compare the latest two periods because the dataset has no usable time column.",
      source: "computed",
      confidence: "high",
      reasoning_mode: "dataset_period_comparison",
      validation_status: "missing_time",
      warnings: ["no_date_column"],
    };
  }

  const cmp = computeLatestVsPrevious(ctx.rows, ctx.dateCol, metricCol);
  if (!cmp.ok) {
    return {
      answer: "I can’t compare the latest two periods because the dataset contains only one available period.",
      source: "computed",
      confidence: "high",
      reasoning_mode: "dataset_period_comparison",
      validation_status: "insufficient_periods",
      warnings: ["only_one_period"],
    };
  }

  const pctText = cmp.pct === null ? "" : ` (${Math.abs(cmp.pct).toFixed(1)}%)`;
  let answer;

  if (cmp.delta < 0) {
    answer =
      `**${ctx?.metrics?.primaryMetricId || metricCol}** decreased by **${formatNumber(Math.abs(cmp.delta))}**${pctText} ` +
      `from **${cmp.previousLabel}** to **${cmp.currentLabel}** ` +
      `(${formatNumber(cmp.previousValue)} → ${formatNumber(cmp.currentValue)}).`;
  } else if (cmp.delta > 0) {
    answer =
      `There was no drop in the latest dataset period. ` +
      `**${ctx?.metrics?.primaryMetricId || metricCol}** increased by **${formatNumber(cmp.delta)}**${pctText} ` +
      `from **${cmp.previousLabel}** to **${cmp.currentLabel}** ` +
      `(${formatNumber(cmp.previousValue)} → ${formatNumber(cmp.currentValue)}).`;
  } else {
    answer =
      `There was no change in the latest dataset period. ` +
      `**${ctx?.metrics?.primaryMetricId || metricCol}** stayed at **${formatNumber(cmp.currentValue)}** ` +
      `in both **${cmp.previousLabel}** and **${cmp.currentLabel}**.`;
  }

  return {
    answer,
    source: "computed",
    confidence: "high",
    reasoning_mode: "dataset_period_comparison",
    validation_status: "ok",
    comparison: {
      type: "dataset_previous_period",
      current: cmp.currentLabel,
      previous: cmp.previousLabel,
      currentValue: cmp.currentValue,
      previousValue: cmp.previousValue,
      delta: cmp.delta,
      pct: cmp.pct,
    },
    chartData: {
      labels: [cmp.previousLabel, cmp.currentLabel],
      values: [cmp.previousValue, cmp.currentValue],
      type: "bar",
    },
    warnings: [],
  };
}

/**
 * @returns {object|null} Structured answer or null to defer to rules / LLM.
 */
function trendAnalysis({ question, rows, columns, metrics, dateCol }) {
  const valueCol = metrics.primaryColumn;
  if (!valueCol || !rows.length) return null;

  const reqG = inferRequestedSeriesGrain(question);
  const dataGrain = dateCol ? inferDatasetTemporalGranularity(rows, dateCol).grain : "unknown";
  if (reqG === "day" && (dataGrain === "month" || dataGrain === "week")) {
    return {
      answer: "This dataset does not support daily analysis.",
      source: "computed",
      confidence: "high",
      reasoning_mode: "safe_refusal",
      validation_status: "unsupported_granularity",
      warnings: ["no_daily_grain"],
    };
  }
  if (reqG === "week" && dataGrain === "month") {
    return {
      answer: "This dataset has monthly granularity, not weekly.",
      source: "computed",
      confidence: "high",
      reasoning_mode: "safe_refusal",
      validation_status: "unsupported_granularity",
      warnings: ["dataset_not_weekly"],
    };
  }

  const labelCol = dateCol || detectTemporalColumn(columns);
  if (!labelCol) {
    return {
      answer:
        "A date or time column is required to describe how this metric changes over time; none was detected.",
      source: "computed",
      confidence: "high",
      reasoning_mode: "safe_refusal",
      validation_status: "missing_time",
      warnings: ["no_date_column"],
    };
  }

  const avgKeywords = /\b(price|rate|ratio|score|rating|index|temperature|avg|average|mean|percent|%)\b/i;
  const agg = avgKeywords.test(valueCol) ? "avg" : "sum";
  const trend = detectTrend(rows, valueCol, labelCol, agg);
  if (!trend) return null;

  const { direction, from, to, min, max, labels } = trend;
  const firstLabel = labels[0] || "start";
  const lastLabel = labels[labels.length - 1] || "end";
  const change = to - from;
  const changePct = from !== 0 ? ((change / Math.abs(from)) * 100).toFixed(1) : null;

  let answer = `**${metrics.primaryMetricId || valueCol}** (${valueCol}) over **${labelCol}**: `;
  answer += `from **${formatNumber(from)}** (${firstLabel}) to **${formatNumber(to)}** (${lastLabel})`;
  if (changePct !== null) answer += ` — about **${change >= 0 ? "+" : ""}${changePct}%** vs the start of the series.`;
  answer += ` Direction: **${direction}** (range **${formatNumber(min)}**–**${formatNumber(max)}** across **${labels.length}** time periods).`;

  return {
    answer,
    source: "computed",
    confidence: "high",
    reasoning_mode: "trend",
    validation_status: "ok",
    warnings: [],
    chartData: {
      labels: labels.slice(-15),
      values: trend.values.slice(-15).map((v) => parseFloat(Number(v).toFixed(2))),
      type: "line",
    },
  };
}

function breakdownAnalysis({ question, rows, columns, metrics }) {
  const valueCol = metrics.primaryColumn;
  if (!valueCol) {
    return {
      answer: "Could not determine which numeric column to break down.",
      source: "computed",
      confidence: "low",
      validation_status: "missing_metric",
      warnings: [],
    };
  }

  const numericCols = getNumericColumns(rows, columns);
  const nonNumeric = columns.filter((c) => !numericCols.includes(c));
  const lower = String(question || "").toLowerCase();

  let dim = columnMentionedInQuestion(question, nonNumeric);
  let prefix = "";

  if (!dim && /\bcategory|categories\b/i.test(lower)) {
    const productCol = findColumnForAliases(columns, ["product", "sku", "item"]);
    const regionCol = findColumnForAliases(columns, ["region", "area", "territory", "country"]);
    dim = productCol || regionCol || detectGroupColumn(rows, columns, numericCols);

    if (dim) {
      prefix = `Category is not present in the dataset, so I used **${dim}** instead. `;
    } else {
      return {
        answer: "Category is not present in the dataset, and I could not find a close fallback like region or product.",
        source: "computed",
        confidence: "medium",
        validation_status: "missing_dimension",
        warnings: ["missing_category_dimension"],
      };
    }
  }

  if (!dim) {
    dim =
      findColumnForAliases(columns, ["region", "area", "territory", "country"]) ||
      findColumnForAliases(columns, ["product", "sku", "item"]) ||
      findColumnForAliases(columns, ["channel", "segment", "department"]) ||
      detectGroupColumn(rows, columns, numericCols);
  }

  if (!dim) {
    return {
      answer:
        "I could not find a categorical column (for example region or product) to split this metric by.",
      source: "computed",
      confidence: "medium",
      validation_status: "missing_dimension",
      warnings: [],
    };
  }

  const grouped = groupBy(rows, dim, [valueCol]);
  if (!grouped.length) return null;

  const total = grouped.reduce((a, g) => a + (g[`${valueCol}_sum`] || 0), 0);
  const top = grouped.slice(0, 8);
  const parts = top.map((g) => {
    const v = g[`${valueCol}_sum`] || 0;
    const pct = total > 0 ? ((v / total) * 100).toFixed(1) : "0";
    return `**${g.group}** ${pct}% (${formatNumber(v)})`;
  });

  const answer =
    prefix +
    `**${metrics.primaryMetricId || valueCol}** by **${dim}** (share of total **${formatNumber(total)}**): ` +
    `${parts.join(", ")}.`;

  return {
    answer,
    source: "computed",
    confidence: "high",
    reasoning_mode: "breakdown",
    validation_status: "ok",
    warnings: [],
    chartData: {
      labels: top.map((g) => g.group),
      values: top.map((g) => parseFloat((g[`${valueCol}_sum`] || 0).toFixed(2))),
      type: "bar",
    },
  };
}

function summaryAnalysis({ rows, columns, metrics, dateCol }) {
  const primary = metrics.primaryColumn;
  if (!primary) return null;

  const stats = summaryStats(rows, columns);
  const s0 = stats[primary];
  if (!s0) return null;

  const temporal = dateCol || detectTemporalColumn(columns);
  let latestChange = "";
  let overallTrend = "";
  let stability = "";

  if (temporal) {
    const buckets = groupByTime(rows, temporal, [primary], "sum");
    if (buckets.length >= 2) {
      const vals = buckets.map((b) => Number(b[primary]) || 0);
      const last = vals[vals.length - 1];
      const prev = vals[vals.length - 2];
      const pct = prev !== 0 ? (((last - prev) / Math.abs(prev)) * 100).toFixed(1) : last === 0 ? "0" : "—";
      latestChange = `Latest period vs prior: **${formatNumber(last)}** vs **${formatNumber(prev)}** (${pct}%). `;

      const dir = detectTrendDirection(vals);
      overallTrend = `Overall series trend: **${dir}** (from **${formatNumber(vals[0])}** to **${formatNumber(last)}**). `;

      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const std = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length) || 0;
      const cv = mean !== 0 ? std / Math.abs(mean) : 0;
      stability =
        cv < 0.15
          ? "Period-to-period variation is **low** relative to the mean."
          : cv < 0.35
            ? "Period-to-period variation is **moderate**."
            : "Period-to-period variation is **high**.";
    }
  }

  const answer =
    `**${metrics.primaryMetricId || primary}** — total **${formatNumber(s0.sum)}**, average **${formatNumber(s0.avg)}**, range **${formatNumber(s0.min)}**–**${formatNumber(s0.max)}**. ` +
    (latestChange || "") +
    (overallTrend || `Across all rows, values span **${formatNumber(s0.min)}** to **${formatNumber(s0.max)}**. `) +
    (stability || "");

  return {
    answer,
    source: "computed",
    confidence: temporal ? "high" : "medium",
    reasoning_mode: "summary",
    validation_status: "ok",
    warnings: [],
  };
}

module.exports = {
  detectIntent,
  inferRequestedSeriesGrain,
  validateData,
  checkCompleteness,
  comparisonAnalysis,
  looksLikePairwiseComparisonQuestion,
  driverAnalysis,
  trendAnalysis,
  breakdownAnalysis,
  summaryAnalysis,
  logDebug,
  MONTH_WORDS,
};