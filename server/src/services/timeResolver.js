// /**
//  * timeResolver.js — Date column detection, calendar windows, comparable partial periods.
//  * Uses parseDateToken sort keys for ordering (avoids lexicographic month bugs).
//  */

// const {
//   parseDateToken,
//   dateColumnScore,
//   detectTemporalColumn,
//   inferDatasetTemporalGranularity,
// } = require("../utils/datasetAnalysis");

// /** Name-based hints (supplement data-driven detection). */
// function nameHintDateColumn(columns) {
//   const hinted = detectTemporalColumn(columns);
//   return hinted;
// }

// /**
//  * Pick the column whose values most often look like dates.
//  */
// function findBestDateColumn(rows, columns, numericColSet) {
//   const candidates = (columns || []).filter((c) => !numericColSet.has(c));
//   let best = null;
//   let bestScore = 0;
//   for (const col of candidates) {
//     const s = dateColumnScore(rows, col);
//     if (s > bestScore) {
//       bestScore = s;
//       best = col;
//     }
//   }
//   // Require minimal signal so we do not treat arbitrary text as time
//   if (best && bestScore >= 0.35) return { column: best, score: bestScore };
//   const fallback = nameHintDateColumn(columns);
//   if (fallback && !numericColSet.has(fallback)) return { column: fallback, score: bestScore };
//   return { column: null, score: bestScore };
// }

// function rowSortKey(row, col) {
//   if (!col || !row) return 0;
//   return parseDateToken(row[col]).sortKey;
// }

// function maxSortKeyInRows(rows, col) {
//   let m = 0;
//   for (const row of rows) {
//     const k = rowSortKey(row, col);
//     if (k > m) m = k;
//   }
//   return m;
// }

// function sortKeyToYmd(sortKey) {
//   if (!sortKey || sortKey <= 0) return null;
//   const y = Math.floor(sortKey / 10000);
//   const mo = Math.floor((sortKey % 10000) / 100);
//   const d = sortKey % 100;
//   return { y, mo, d: d || 1 };
// }

// function utcDate(y, m, d) {
//   return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
// }

// function ymdToSortKey(y, m, d) {
//   return y * 10000 + m * 100 + d;
// }

// /**
//  * Reference instant for all relative phrases ("last month", "this week", MoM, etc.):
//  * always the **latest date present in the dataset** for this column — never the wall clock.
//  */
// function referenceSortKeyFromData(rows, dateCol) {
//   return maxSortKeyInRows(rows, dateCol);
// }

// function previousCalendarMonth(y, mo) {
//   if (mo <= 1) return { y: y - 1, mo: 12 };
//   return { y, mo: mo - 1 };
// }

// function daysInMonth(y, mo) {
//   return new Date(Date.UTC(y, mo, 0)).getUTCDate();
// }

// function calendarQuarterFromMonth(y, mo) {
//   const q = Math.floor((mo - 1) / 3) + 1;
//   const startMo = (q - 1) * 3 + 1;
//   return { y, q, startMo, endMo: startMo + 2 };
// }

// function previousCalendarQuarter(y, q) {
//   if (q <= 1) return { y: y - 1, q: 4 };
//   return { y, q: q - 1 };
// }

// /**
//  * Resolve primary time comparison windows from the question (calendar-based on date column).
//  */
// function resolveComparisonWindows(question, rows, dateCol, intent) {
//   if (!dateCol || !rows.length) {
//     return {
//       resolvedTimeRange: null,
//       comparison: null,
//       warnings: ["No reliable date column found for calendar comparisons."],
//     };
//   }

//   const lower = question.toLowerCase();
//   const refK = referenceSortKeyFromData(rows, dateCol);
//   const warnings = [];

//   if (!refK) {
//     return {
//       resolvedTimeRange: null,
//       comparison: null,
//       warnings: ["Could not read any parseable dates from the time column."],
//     };
//   }

//   // --- Explicit quarter: Q2, Q2 2024
//   const qm = lower.match(/\bq([1-4])\b(?:\s*(\d{4}))?/i);
//   if (qm) {
//     const q = Number(qm[1]);
//     const ymd = sortKeyToYmd(refK);
//     const year = qm[2] ? Number(qm[2]) : ymd.y;
//     const startMo = (q - 1) * 3 + 1;
//     const start = ymdToSortKey(year, startMo, 1);
//     const endMo = startMo + 2;
//     const end = ymdToSortKey(year, endMo, daysInMonth(year, endMo));
//     return {
//       resolvedTimeRange: { label: `Q${q} ${year}`, start, end, grain: "quarter" },
//       comparison: null,
//       warnings,
//     };
//   }

//   // --- This week vs last week (needs day- or week-level timestamps, not month-only aggregates)
//   if (/\bthis week\b/i.test(question) && /\blast week\b/i.test(question)) {
//     warnings.push(
//       "Weeks are UTC Monday-start, aligned to the **latest date in your dataset** (not today’s calendar date)."
//     );
//   }
//   if (/\bthis week\b|\blast week\b|\bweek over week\b|\bwow\b/i.test(lower)) {
//     const gran = inferDatasetTemporalGranularity(rows, dateCol);
//     if (gran.grain === "month") {
//       return {
//         resolvedTimeRange: null,
//         comparison: null,
//         weekUnsupportedOnMonthlyData: true,
//         warnings: [
//           "Week-over-week needs daily or weekly timestamps. Your date column looks **monthly (or coarser)** only, so this comparison is not supported. Try **month over month** instead.",
//         ],
//       };
//     }

//     const ref = utcDateFromSortKey(refK);
//     if (!ref) return { resolvedTimeRange: null, comparison: null, warnings: ["Could not parse reference date."] };
//     const { weekStart: thisStart, weekEnd: thisEnd } = utcWeekBounds(ref);
//     const prevRef = new Date(ref.getTime() - 7 * 86400000);
//     const { weekStart: lastStart, weekEnd: lastEnd } = utcWeekBounds(prevRef);

//     const partial = !intent.explicitFullCurrentPeriod && thisEnd > refK;
//     let curStart = thisStart;
//     let curEnd = Math.min(thisEnd, refK);
//     let prevComparableStart = lastStart;
//     let prevComparableEnd = lastEnd;

//     if (partial) {
//       const days = countDaysInclusive(curStart, curEnd);
//       prevComparableEnd = advanceSortKey(lastStart, days - 1);
//     }

//     return {
//       resolvedTimeRange: {
//         label: "this week (calendar)",
//         start: curStart,
//         end: curEnd,
//         grain: "week",
//       },
//       comparison: {
//         label: "last week (comparable)",
//         start: prevComparableStart,
//         end: prevComparableEnd,
//         grain: "week",
//         partialNote: partial
//           ? "Current week is partial; previous week uses the same number of days for a fair comparison."
//           : null,
//       },
//       partialWeekIncomplete: Boolean(partial),
//       warnings,
//     };
//   }

//   // --- Month-based windows (uses dataset max date as "current")
//   if (/\blast month\b/i.test(lower) || /\bthis month\b/i.test(lower) || /\bmom\b|\bmonth over month\b/i.test(lower)) {
//     const ymd = sortKeyToYmd(refK);
//     if (!ymd) return { resolvedTimeRange: null, comparison: null, warnings };

//     const thisMonth = { y: ymd.y, mo: ymd.mo };
//     const lastM = previousCalendarMonth(thisMonth.y, thisMonth.mo);

//     const lastMonthStart = ymdToSortKey(lastM.y, lastM.mo, 1);
//     const lastMonthEnd = ymdToSortKey(lastM.y, lastM.mo, daysInMonth(lastM.y, lastM.mo));

//     const thisMonthStart = ymdToSortKey(thisMonth.y, thisMonth.mo, 1);
//     const thisMonthEndFull = ymdToSortKey(thisMonth.y, thisMonth.mo, daysInMonth(thisMonth.y, thisMonth.mo));

//     const partialThisMonth = refK < thisMonthEndFull && !intent.explicitFullCurrentPeriod;

//     const asksBothThisLast = /\bthis month\b/i.test(lower) && /\blast month\b/i.test(lower);
//     const asksLastMonth = /\blast month\b/i.test(lower);
//     const asksMoMPhrase = /\bmom\b|\bmonth over month\b/i.test(lower);

//     // MoM / "how has X changed month over month" → latest month in data vs prior month (fair slice)
//     if (asksMoMPhrase && !asksBothThisLast && !asksLastMonth) {
//       const prevEndCap = sortKeyToYmd(refK).d;
//       const prevEnd = ymdToSortKey(lastM.y, lastM.mo, Math.min(prevEndCap, daysInMonth(lastM.y, lastM.mo)));
//       return {
//         resolvedTimeRange: {
//           label: `${thisMonth.y}-${String(thisMonth.mo).padStart(2, "0")} (latest in data)`,
//           start: thisMonthStart,
//           end: refK,
//           grain: "month",
//         },
//         comparison: {
//           label: `${lastM.y}-${String(lastM.mo).padStart(2, "0")} (same day-of-month)`,
//           start: lastMonthStart,
//           end: prevEnd,
//           grain: "month",
//           partialNote: partialThisMonth
//             ? "Latest month in the dataset is incomplete; compared to the same day range in the previous month."
//             : null,
//         },
//         warnings: [
//           ...warnings,
//           "Relative months are anchored to the **latest date in your upload**, not the computer’s clock.",
//         ],
//       };
//     }

//     if (asksBothThisLast) {
//       let curStart = thisMonthStart;
//       let curEnd = refK;
//       let prevEndCap = sortKeyToYmd(refK).d;
//       const prevMonthY = lastM.y;
//       const prevMonthMo = lastM.mo;
//       const prevStart = ymdToSortKey(prevMonthY, prevMonthMo, 1);
//       const prevEnd = ymdToSortKey(prevMonthY, prevMonthMo, Math.min(prevEndCap, daysInMonth(prevMonthY, prevMonthMo)));

//       return {
//         resolvedTimeRange: {
//           label: `${thisMonth.y}-${String(thisMonth.mo).padStart(2, "0")} (partial to data)`,
//           start: curStart,
//           end: curEnd,
//           grain: "month",
//         },
//         comparison: {
//           label: `${prevMonthY}-${String(prevMonthMo).padStart(2, "0")} (same day-of-month)`,
//           start: prevStart,
//           end: prevEnd,
//           grain: "month",
//           partialNote: partialThisMonth
//             ? "Current month is incomplete; compared to the same day range in the previous month."
//             : null,
//         },
//         warnings,
//       };
//     }

//     // "last month" alone → calendar month before the month of the latest data date
//     if (asksLastMonth) {
//       const wantsDriver =
//         /\b(why|what caused|driver|drop|dropped|rise|rose|change|mom|compare)\b/i.test(lower);

//       // Driver / change questions: compare last completed month to the one before it
//       if (wantsDriver) {
//         const prev2 = previousCalendarMonth(lastM.y, lastM.mo);
//         const p2Start = ymdToSortKey(prev2.y, prev2.mo, 1);
//         const p2End = ymdToSortKey(prev2.y, prev2.mo, daysInMonth(prev2.y, prev2.mo));
//         return {
//           resolvedTimeRange: {
//             label: `${lastM.y}-${String(lastM.mo).padStart(2, "0")} (last month)`,
//             start: lastMonthStart,
//             end: lastMonthEnd,
//             grain: "month",
//           },
//           comparison: {
//             label: `${prev2.y}-${String(prev2.mo).padStart(2, "0")} (prior month)`,
//             start: p2Start,
//             end: p2End,
//             grain: "month",
//             partialNote: null,
//           },
//           warnings,
//         };
//       }

//       return {
//         resolvedTimeRange: {
//           label: `${lastM.y}-${String(lastM.mo).padStart(2, "0")}`,
//           start: lastMonthStart,
//           end: lastMonthEnd,
//           grain: "month",
//         },
//         comparison: null,
//         warnings,
//       };
//     }

//     // this month
//     return {
//       resolvedTimeRange: {
//         label: `${thisMonth.y}-${String(thisMonth.mo).padStart(2, "0")}`,
//         start: thisMonthStart,
//         end: partialThisMonth ? refK : thisMonthEndFull,
//         grain: "month",
//       },
//       comparison: null,
//       warnings: partialThisMonth ? [...warnings, "Current month is partial through the latest data date."] : warnings,
//     };
//   }

//   // --- Quarter over quarter (latest quarter in data vs previous quarter, fair partial slice)
//   if (/\bqoq\b|\bquarter over quarter\b/i.test(lower)) {
//     const ymd = sortKeyToYmd(refK);
//     if (!ymd) return { resolvedTimeRange: null, comparison: null, warnings };
//     const curQ = calendarQuarterFromMonth(ymd.y, ymd.mo);
//     const curQStart = ymdToSortKey(curQ.y, curQ.startMo, 1);
//     const curQEndFull = ymdToSortKey(curQ.y, curQ.endMo, daysInMonth(curQ.y, curQ.endMo));
//     const partialQ = refK < curQEndFull && !intent.explicitFullCurrentPeriod;

//     const prevQ = previousCalendarQuarter(curQ.y, curQ.q);
//     const pqStartMo = (prevQ.q - 1) * 3 + 1;
//     const pqEndMo = pqStartMo + 2;
//     const prevStart = ymdToSortKey(prevQ.y, pqStartMo, 1);
//     const prevEndFull = ymdToSortKey(prevQ.y, pqEndMo, daysInMonth(prevQ.y, pqEndMo));

//     let prevEnd = prevEndFull;
//     if (partialQ) {
//       const daysInto = countDaysInclusive(curQStart, Math.min(refK, curQEndFull));
//       prevEnd = advanceSortKey(prevStart, daysInto - 1);
//     }

//     return {
//       resolvedTimeRange: {
//         label: `Q${curQ.q} ${curQ.y} (latest in data)`,
//         start: curQStart,
//         end: Math.min(refK, curQEndFull),
//         grain: "quarter",
//       },
//       comparison: {
//         label: `Q${prevQ.q} ${prevQ.y} (comparable)`,
//         start: prevStart,
//         end: Math.min(prevEnd, prevEndFull),
//         grain: "quarter",
//         partialNote: partialQ
//           ? "Latest quarter is incomplete in the data; previous quarter uses a matching in-quarter day span."
//           : null,
//       },
//       warnings: [...warnings, "Quarters are anchored to the **latest date in your dataset**."],
//     };
//   }

//   // --- YoY: same month-to-date window vs prior year
//   if (/\byoy\b|\byear over year\b/i.test(lower)) {
//     const ymd = sortKeyToYmd(refK);
//     if (!ymd) return { resolvedTimeRange: null, comparison: null, warnings };
//     const start = ymdToSortKey(ymd.y, ymd.mo, 1);
//     const end = Math.min(refK, ymdToSortKey(ymd.y, ymd.mo, daysInMonth(ymd.y, ymd.mo)));
//     const py = ymd.y - 1;
//     const pStart = ymdToSortKey(py, ymd.mo, 1);
//     const pEndCap = sortKeyToYmd(end).d;
//     const pEnd = ymdToSortKey(py, ymd.mo, Math.min(pEndCap, daysInMonth(py, ymd.mo)));
//     return {
//       resolvedTimeRange: { label: `${ymd.y} period`, start, end, grain: "month" },
//       comparison: { label: `${py} comparable`, start: pStart, end: pEnd, grain: "month", partialNote: null },
//       warnings: [...warnings, "YoY window is anchored to the **latest date in your dataset**."],
//     };
//   }

//   // --- "Why did X change" with no explicit period: compare latest month in data vs prior month (never wall-clock)
//   if (
//     intent.wantsWhy &&
//     /\b(why|what caused|what drove)\b/i.test(lower) &&
//     /\b(drop|drops|dropped|decrease|decreas|increase|increas|rose|fall|falls|fell|grew|grow|change|changed|declin|higher|lower)\b/i.test(
//       lower
//     )
//   ) {
//     const ymd = sortKeyToYmd(refK);
//     if (!ymd) return { resolvedTimeRange: null, comparison: null, warnings };
//     const thisMonth = { y: ymd.y, mo: ymd.mo };
//     const lastM = previousCalendarMonth(thisMonth.y, thisMonth.mo);
//     const thisMonthStart = ymdToSortKey(thisMonth.y, thisMonth.mo, 1);
//     const lastMonthStart = ymdToSortKey(lastM.y, lastM.mo, 1);
//     const prevEndCap = ymd.d;
//     const prevEnd = ymdToSortKey(lastM.y, lastM.mo, Math.min(prevEndCap, daysInMonth(lastM.y, lastM.mo)));
//     const thisMonthEndFull = ymdToSortKey(thisMonth.y, thisMonth.mo, daysInMonth(thisMonth.y, thisMonth.mo));
//     const partialThisMonth = refK < thisMonthEndFull && !intent.explicitFullCurrentPeriod;
//     return {
//       resolvedTimeRange: {
//         label: `${thisMonth.y}-${String(thisMonth.mo).padStart(2, "0")} (latest in data)`,
//         start: thisMonthStart,
//         end: refK,
//         grain: "month",
//       },
//       comparison: {
//         label: `${lastM.y}-${String(lastM.mo).padStart(2, "0")} (prior month, comparable days)`,
//         start: lastMonthStart,
//         end: prevEnd,
//         grain: "month",
//         partialNote: partialThisMonth
//           ? "Latest month is partial through the latest data date; compared to the same day range in the previous month."
//           : null,
//       },
//       warnings: [
//         ...warnings,
//         "Time periods use the **latest date in your dataset** as “current”, not the system date.",
//       ],
//     };
//   }

//   return { resolvedTimeRange: null, comparison: null, warnings: [] };
// }

// function utcDateFromSortKey(sk) {
//   const ymd = sortKeyToYmd(sk);
//   if (!ymd) return null;
//   return utcDate(ymd.y, ymd.mo, ymd.d || 1);
// }

// function utcWeekBounds(d) {
//   const day = d.getUTCDay();
//   const diff = (day + 6) % 7; // Monday = 0
//   const monday = new Date(d.getTime() - diff * 86400000);
//   const y = monday.getUTCFullYear();
//   const m = monday.getUTCMonth() + 1;
//   const dd = monday.getUTCDate();
//   const start = ymdToSortKey(y, m, dd);
//   const sunday = new Date(monday.getTime() + 6 * 86400000);
//   const end = ymdToSortKey(sunday.getUTCFullYear(), sunday.getUTCMonth() + 1, sunday.getUTCDate());
//   return { weekStart: start, weekEnd: end };
// }

// function countDaysInclusive(a, b) {
//   const da = utcDateFromSortKey(a);
//   const db = utcDateFromSortKey(b);
//   if (!da || !db) return 1;
//   return Math.max(1, Math.round((db - da) / 86400000) + 1);
// }

// function advanceSortKey(startSk, daysToAdd) {
//   const d = utcDateFromSortKey(startSk);
//   if (!d) return startSk;
//   const n = new Date(d.getTime() + daysToAdd * 86400000);
//   return ymdToSortKey(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate());
// }

// function filterRowsBySortKeyRange(rows, dateCol, start, end) {
//   if (!dateCol || !start || !end) return rows;
//   return rows.filter((r) => {
//     const k = rowSortKey(r, dateCol);
//     return k >= start && k <= end;
//   });
// }

// module.exports = {
//   findBestDateColumn,
//   rowSortKey,
//   resolveComparisonWindows,
//   filterRowsBySortKeyRange,
//   maxSortKeyInRows,
//   sortKeyToYmd,
//   ymdToSortKey,
//   nameHintDateColumn,
//   referenceSortKeyFromData,
// };
/**
 * timeResolver.js — Date column detection, dataset-based relative periods.
 * Uses the latest available period in the dataset, never the system clock.
 */

const {
  parseDateToken,
  dateColumnScore,
  detectTemporalColumn,
  inferDatasetTemporalGranularity,
  computeOrderedMonthBucketKeys,
} = require("../utils/datasetAnalysis");

/** Name-based hints (supplement data-driven detection). */
function nameHintDateColumn(columns) {
  return detectTemporalColumn(columns);
}

/**
 * Pick the column whose values most often look like dates.
 */
function findBestDateColumn(rows, columns, numericColSet) {
  const candidates = (columns || []).filter((c) => !numericColSet.has(c));
  let best = null;
  let bestScore = 0;
  for (const col of candidates) {
    const s = dateColumnScore(rows, col);
    if (s > bestScore) {
      bestScore = s;
      best = col;
    }
  }
  if (best && bestScore >= 0.35) return { column: best, score: bestScore };
  const fallback = nameHintDateColumn(columns);
  if (fallback && !numericColSet.has(fallback)) return { column: fallback, score: bestScore };
  return { column: null, score: bestScore };
}

function rowSortKey(row, col) {
  if (!col || !row) return 0;
  return parseDateToken(row[col]).sortKey;
}

function maxSortKeyInRows(rows, col) {
  let m = 0;
  for (const row of rows) {
    const k = rowSortKey(row, col);
    if (k > m) m = k;
  }
  return m;
}

function sortKeyToYmd(sortKey) {
  if (!sortKey || sortKey <= 0) return null;
  const y = Math.floor(sortKey / 10000);
  const mo = Math.floor((sortKey % 10000) / 100);
  const d = sortKey % 100;
  return { y, mo, d: d || 1 };
}

function utcDate(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

function ymdToSortKey(y, m, d) {
  return y * 10000 + m * 100 + d;
}

/**
 * Always anchored to dataset max date, never wall clock.
 */
function referenceSortKeyFromData(rows, dateCol) {
  return maxSortKeyInRows(rows, dateCol);
}

function bucketLabelFromKey(bucketKey) {
  if (typeof bucketKey !== "number" || bucketKey <= 0) return String(bucketKey || "");
  const y = Math.floor(bucketKey / 10000);
  const m = Math.floor((bucketKey % 10000) / 100);
  if (m >= 1 && m <= 12) return `${y}-${String(m).padStart(2, "0")}`;
  return String(bucketKey);
}

/**
 * Month bucket keys from the dataset are YYYYMM00; map to inclusive sort-key bounds for row filters.
 */
function monthBucketSortKeyToRange(bucketSortKey) {
  const ymd = sortKeyToYmd(bucketSortKey);
  if (!ymd || ymd.mo < 1 || ymd.mo > 12) return null;
  const y = ymd.y;
  const mo = ymd.mo;
  const start = ymdToSortKey(y, mo, 1);
  const end = ymdToSortKey(y, mo, daysInMonth(y, mo));
  return { start, end };
}

function attachDatasetMonthWindow(range, period) {
  if (!range || !period?.sortKey) return range;
  const bounds = monthBucketSortKeyToRange(period.sortKey);
  if (!bounds) return range;
  return { ...range, start: bounds.start, end: bounds.end, sortKey: period.sortKey };
}

function getAvailableDatasetPeriods(rows, dateCol) {
  if (!dateCol || !Array.isArray(rows) || rows.length === 0) return [];

  const orderedKeys = computeOrderedMonthBucketKeys(rows, dateCol);
  const seen = new Map();

  for (let i = 0; i < rows.length; i++) {
    const raw = String(rows[i]?.[dateCol] ?? "").trim();
    if (!raw) continue;

    let bucketKey = null;
    const precomputed = orderedKeys[i];

    if (precomputed !== null && precomputed !== undefined) {
      bucketKey = precomputed;
    } else {
      const parsed = parseDateToken(raw);
      if (parsed.sortKey > 0) {
        bucketKey = Math.floor(parsed.sortKey / 100) * 100;
      }
    }

    if (bucketKey === null) continue;
    if (!seen.has(bucketKey)) {
      seen.set(bucketKey, {
        sortKey: bucketKey,
        label: bucketLabelFromKey(bucketKey),
      });
    }
  }

  return [...seen.values()].sort((a, b) => a.sortKey - b.sortKey);
}

function previousCalendarMonth(y, mo) {
  if (mo <= 1) return { y: y - 1, mo: 12 };
  return { y, mo: mo - 1 };
}

function daysInMonth(y, mo) {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

function calendarQuarterFromMonth(y, mo) {
  const q = Math.floor((mo - 1) / 3) + 1;
  const startMo = (q - 1) * 3 + 1;
  return { y, q, startMo, endMo: startMo + 2 };
}

function previousCalendarQuarter(y, q) {
  if (q <= 1) return { y: y - 1, q: 4 };
  return { y, q: q - 1 };
}

const MONTH_NAME_RE =
  "january|february|march|april|may|june|july|august|september|october|november|december|jan\\.?|feb\\.?|mar\\.?|apr\\.?|jun\\.?|jul\\.?|aug\\.?|sep\\.?|sept\\.?|oct\\.?|nov\\.?|dec\\.?";

function monthIndexFromToken(tok) {
  const t = String(tok || "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/^sept$/, "sep");
  const map = {
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
  return map[t] || null;
}

function yearsHavingMonth(rows, dateCol, monthIndex) {
  const ys = new Set();
  for (const row of rows) {
    const k = rowSortKey(row, dateCol);
    if (k <= 0) continue;
    const mo = Math.floor((k % 10000) / 100);
    if (mo === monthIndex) ys.add(Math.floor(k / 10000));
  }
  return [...ys].sort((a, b) => a - b);
}

function hasRowsInMonthYear(rows, dateCol, y, monthIndex) {
  const start = ymdToSortKey(y, monthIndex, 1);
  const end = ymdToSortKey(y, monthIndex, daysInMonth(y, monthIndex));
  for (const row of rows) {
    const k = rowSortKey(row, dateCol);
    if (k >= start && k <= end) return true;
  }
  return false;
}

function explicitMonthWindow(y, monthIndex) {
  const start = ymdToSortKey(y, monthIndex, 1);
  const end = ymdToSortKey(y, monthIndex, daysInMonth(y, monthIndex));
  const labelNames = [
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
  const name = labelNames[monthIndex - 1] || `Month ${monthIndex}`;
  return {
    label: `${name} ${y}`,
    start,
    end,
    grain: "month",
    mode: "explicit_calendar_month",
  };
}

/**
 * Collect explicit calendar month mentions (with optional years) in left-to-right order.
 * @returns {{ mo: number, year: number|null, pos: number }[]}
 */
function collectExplicitCalendarMonthHits(lower) {
  const hits = [];
  const reYearFirst = new RegExp(`\\b(20\\d{2})\\s*,?\\s*(${MONTH_NAME_RE})\\b`, "gi");
  let m;
  while ((m = reYearFirst.exec(lower)) !== null) {
    const mo = monthIndexFromToken(m[2]);
    if (mo) hits.push({ mo, year: Number(m[1]), pos: m.index, len: m[0].length });
  }
  const reMonthFirst = new RegExp(`\\b(${MONTH_NAME_RE})\\s*,?\\s*(20\\d{2})\\b`, "gi");
  while ((m = reMonthFirst.exec(lower)) !== null) {
    const mo = monthIndexFromToken(m[1]);
    if (mo) hits.push({ mo, year: Number(m[2]), pos: m.index, len: m[0].length });
  }
  const seenKey = new Set();
  const deduped = [];
  for (const h of hits) {
    const k = `${h.pos}|${h.mo}|${h.year}`;
    if (seenKey.has(k)) continue;
    seenKey.add(k);
    deduped.push(h);
  }
  hits.length = 0;
  hits.push(...deduped);
  hits.sort((a, b) => a.pos - b.pos);
  const used = new Array(lower.length).fill(false);
  for (const h of hits) {
    for (let i = h.pos; i < h.pos + h.len; i++) used[i] = true;
  }
  const reMonthOnly = new RegExp(`\\b(${MONTH_NAME_RE})\\b`, "gi");
  while ((m = reMonthOnly.exec(lower)) !== null) {
    let overlap = false;
    for (let i = m.index; i < m.index + m[0].length; i++) {
      if (used[i]) {
        overlap = true;
        break;
      }
    }
    if (overlap) continue;
    const mo = monthIndexFromToken(m[1]);
    if (mo) hits.push({ mo, year: null, pos: m.index, len: m[0].length });
  }
  hits.sort((a, b) => a.pos - b.pos);
  const out = [];
  for (const h of hits) {
    if (!out.length || out[out.length - 1].mo !== h.mo || out[out.length - 1].year !== h.year) {
      out.push({ mo: h.mo, year: h.year, pos: h.pos });
    }
  }
  return out;
}

function betweenTwoMonthsMatch(lower) {
  const m = lower.match(
    new RegExp(`\\bbetween\\s+(${MONTH_NAME_RE})\\s+and\\s+(${MONTH_NAME_RE})\\b`, "i")
  );
  if (!m) return null;
  const mo1 = monthIndexFromToken(m[1]);
  const mo2 = monthIndexFromToken(m[2]);
  if (!mo1 || !mo2) return null;
  return { mo1, mo2 };
}

function versusTwoMonthsMatch(lower) {
  const m = lower.match(
    new RegExp(`\\b(${MONTH_NAME_RE})\\s+(?:vs\\.?|versus|compared\\s+to)\\s+(${MONTH_NAME_RE})\\b`, "i")
  );
  if (!m) return null;
  const mo1 = monthIndexFromToken(m[1]);
  const mo2 = monthIndexFromToken(m[2]);
  if (!mo1 || !mo2) return null;
  return { mo1, mo2 };
}

function latestYearWithBothMonths(rows, dateCol, mo1, mo2) {
  const y1 = new Set(yearsHavingMonth(rows, dateCol, mo1));
  const y2 = new Set(yearsHavingMonth(rows, dateCol, mo2));
  let best = null;
  for (const y of y1) {
    if (y2.has(y) && (best === null || y > best)) best = y;
  }
  return best;
}

/**
 * When the user names calendar month(s) (e.g. "February", "Feb vs March"), anchor windows
 * to those months in the file — not the default latest dataset period.
 */
function parseIsoYearMonthToken(lower) {
  const m = String(lower || "").match(/\b(20\d{2})[-/](0?[1-9]|1[0-2])\b/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  return { y, mo };
}

/**
 * Why / change questions about a single named month compare that month to the prior calendar month
 * (e.g. February vs January), not dataset-latest vs dataset-latest.
 */
function wantsExplicitMonthPeriodDriver(lower) {
  return (
    /\b(why|what caused|what drove)\b/i.test(lower) &&
    /\b(drop|drops|dropped|decrease|decreas|increase|increas|rose|fall|falls|fell|grew|grow|change|changed|declin|higher|lower|worse|better)\b/i.test(
      lower
    )
  );
}

/** Causal / ROI questions naming one month still need the prior month for comparison. */
function wantsSingleNamedMonthPriorWindow(lower) {
  if (wantsExplicitMonthPeriodDriver(lower)) return true;
  if (
    /\b(did|does|do)\b/i.test(lower) &&
    /\bcause\b/i.test(lower) &&
    /\b(drop|drops|dropped|decrease|declin|change|cut|cutting|spend|revenue|roi|improv)\b/i.test(lower)
  ) {
    return true;
  }
  if (/\broi\b|\broas\b|return on ad|ad spend efficiency/i.test(lower)) return true;
  if (/\bcutting\b/i.test(lower) && /\b(ad\s*)?spend\b/i.test(lower)) return true;
  return false;
}

function tryResolveExplicitCalendarMonthWindows(lower, rows, dateCol, latestPeriod, previousPeriod, warnings) {
  if (!rows.length || !dateCol) return null;
  if (/\b(this|last|next)\s+month\b/i.test(lower)) return null;

  const bt = betweenTwoMonthsMatch(lower);
  const vs = versusTwoMonthsMatch(lower);
  let moFirst;
  let moSecond;
  if (bt) {
    moFirst = bt.mo1;
    moSecond = bt.mo2;
  } else if (vs) {
    moFirst = vs.mo1;
    moSecond = vs.mo2;
  }

  const hits = collectExplicitCalendarMonthHits(lower);
  const isoYm = !bt && !vs ? parseIsoYearMonthToken(lower) : null;
  const isoHit =
    isoYm && hasRowsInMonthYear(rows, dateCol, isoYm.y, isoYm.mo)
      ? { mo: isoYm.mo, year: isoYm.y, pos: lower.search(/\b20\d{2}[-/]/) }
      : null;

  if (!bt && !vs && hits.length === 0 && !isoHit) return null;

  if (bt || vs) {
    if (moFirst === moSecond) return null;
    const yShared = latestYearWithBothMonths(rows, dateCol, moFirst, moSecond);
    if (yShared !== null) {
      const a = explicitMonthWindow(yShared, Math.min(moFirst, moSecond));
      const b = explicitMonthWindow(yShared, Math.max(moFirst, moSecond));
      warnings.push(
        `Compared **${a.label}** to **${b.label}** (latest calendar year in the file that contains both months).`
      );
      return {
        resolvedTimeRange: b,
        comparison: a,
        latestPeriod,
        previousPeriod,
        warnings: [...warnings],
      };
    }
    const y1 = yearsHavingMonth(rows, dateCol, moFirst);
    const y2 = yearsHavingMonth(rows, dateCol, moSecond);
    const yA = y1.length ? Math.max(...y1) : null;
    const yB = y2.length ? Math.max(...y2) : null;
    if (yA === null || yB === null) return null;
    warnings.push("The two months appear in different years in this file; each window uses the latest year available for that month.");
    const wA = explicitMonthWindow(yA, moFirst);
    const wB = explicitMonthWindow(yB, moSecond);
    const [earlier, later] =
      yA * 100 + moFirst < yB * 100 + moSecond
        ? [wA, wB]
        : yA * 100 + moFirst > yB * 100 + moSecond
          ? [wB, wA]
          : moFirst <= moSecond
            ? [wA, wB]
            : [wB, wA];
    return {
      resolvedTimeRange: later,
      comparison: earlier,
      latestPeriod,
      previousPeriod,
      warnings: [...warnings],
    };
  }

  if (hits.length >= 2) {
    const h1 = hits[0];
    const h2 = hits[1];
    let y1 = h1.year;
    let y2 = h2.year;
    if (y1 === null) {
      const ys = yearsHavingMonth(rows, dateCol, h1.mo);
      y1 = ys.length ? Math.max(...ys) : null;
    }
    if (y2 === null) {
      const ys = yearsHavingMonth(rows, dateCol, h2.mo);
      y2 = ys.length ? Math.max(...ys) : null;
    }
    if (y1 === null || y2 === null) return null;
    if (h1.year === null && h2.year === null && y1 === y2) {
      const y = latestYearWithBothMonths(rows, dateCol, h1.mo, h2.mo);
      if (y !== null) {
        y1 = y;
        y2 = y;
        warnings.push(`Used calendar year **${y}** for both named months (latest year in the file containing each).`);
      }
    }
    const w1 = explicitMonthWindow(y1, h1.mo);
    const w2 = explicitMonthWindow(y2, h2.mo);
    const [earlier, later] =
      y1 * 100 + h1.mo < y2 * 100 + h2.mo
        ? [w1, w2]
        : y1 * 100 + h1.mo > y2 * 100 + h2.mo
          ? [w2, w1]
          : h1.pos <= h2.pos
            ? [w1, w2]
            : [w2, w1];
    return {
      resolvedTimeRange: later,
      comparison: earlier,
      latestPeriod,
      previousPeriod,
      warnings: [...warnings],
    };
  }

  const singleNamed =
    !bt && !vs && hits.length === 1 ? hits[0] : !bt && !vs && hits.length === 0 && isoHit ? isoHit : null;

  if (singleNamed) {
    const h = singleNamed;
    let y = h.year;
    if (y === null) {
      const ys = yearsHavingMonth(rows, dateCol, h.mo);
      y = ys.length ? Math.max(...ys) : null;
    }
    if (y === null || !hasRowsInMonthYear(rows, dateCol, y, h.mo)) return null;
    if (isoHit && h === isoHit) {
      warnings.push(`Used calendar month **${explicitMonthWindow(y, h.mo).label}** from the **YYYY-MM** / **YYYY/MM** token in your question.`);
    } else if (h.year === null) {
      warnings.push(
        `Interpreted **${explicitMonthWindow(y, h.mo).label}** as the latest calendar year in the file containing that month.`
      );
    }
    const cur = explicitMonthWindow(y, h.mo);
    if (wantsSingleNamedMonthPriorWindow(lower)) {
      const prevM = previousCalendarMonth(y, h.mo);
      if (hasRowsInMonthYear(rows, dateCol, prevM.y, prevM.mo)) {
        const comparison = explicitMonthWindow(prevM.y, prevM.mo);
        warnings.push(`For this question, compared **${comparison.label}** (earlier) to **${cur.label}** (later).`);
        return {
          resolvedTimeRange: cur,
          comparison,
          latestPeriod,
          previousPeriod,
          warnings: [...warnings],
        };
      }
      warnings.push(
        `The month before **${cur.label}** has no rows in the date column, so only **${cur.label}** is scoped (no prior-month comparison).`
      );
    }
    return {
      resolvedTimeRange: cur,
      comparison: null,
      latestPeriod,
      previousPeriod,
      warnings: [...warnings],
    };
  }

  return null;
}

/**
 * Resolve primary time comparison windows from the question.
 * Rules:
 * - "this month" = latest available dataset period
 * - "last month" = previous available dataset period
 * - why/change/MoM = latest available period vs previous available period
 */
function resolveComparisonWindows(question, rows, dateCol, intent = {}) {
  if (!dateCol || !rows.length) {
    return {
      resolvedTimeRange: null,
      comparison: null,
      latestPeriod: null,
      previousPeriod: null,
      warnings: ["No reliable date column found for calendar comparisons."],
    };
  }

  const lower = String(question || "").toLowerCase();
  const warnings = [];
  const periods = getAvailableDatasetPeriods(rows, dateCol);

  if (!periods.length) {
    return {
      resolvedTimeRange: null,
      comparison: null,
      latestPeriod: null,
      previousPeriod: null,
      warnings: ["Could not read any parseable dates from the time column."],
    };
  }

  const latestPeriod = periods[periods.length - 1];
  const previousPeriod = periods.length >= 2 ? periods[periods.length - 2] : null;

  const explicitCalendar = tryResolveExplicitCalendarMonthWindows(
    lower,
    rows,
    dateCol,
    latestPeriod,
    previousPeriod,
    warnings
  );
  if (explicitCalendar) return explicitCalendar;

  const wantsWeek =
    /\b(this week|last week|previous week|prior week|week over week|wow)\b/i.test(lower);
  const grainInfo = inferDatasetTemporalGranularity(rows, dateCol);

  if (wantsWeek && grainInfo.grain === "month") {
    return {
      resolvedTimeRange: null,
      comparison: null,
      latestPeriod,
      previousPeriod,
      weekUnsupportedOnMonthlyData: true,
      warnings: [
        "Week-over-week needs daily or weekly timestamps. Your date column looks monthly only.",
      ],
    };
  }

  const wantsThisMonth =
    /\bthis month\b/i.test(lower) ||
    /\b(latest|most recent|current)\s+month\b/i.test(lower) ||
    /\bmonth\s+in\s+(the\s+)?(data|dataset)\b/i.test(lower);
  const wantsLastMonth =
    /\blast month\b/i.test(lower) || /\b(previous|prior)\s+month\b/i.test(lower);
  const wantsMoM = /\bmom\b|\bmonth over month\b/i.test(lower);
  const wantsWhyChange =
    /\b(why|what caused|what drove)\b/i.test(lower) &&
    /\b(drop|drops|dropped|decrease|decreas|increase|increas|rose|fall|falls|fell|grew|grow|change|changed|declin|higher|lower)\b/i.test(
      lower
    );
  /** Any parsed WHY / driver intent with ≥2 dataset months → always compare latest vs previous (before LLM). */
  const intentWhyNeedsPairWindows =
    (intent?.wantsWhy || intent?.tasks?.includes("driver_analysis")) && Boolean(previousPeriod);

  if (
    (wantsThisMonth || wantsLastMonth || wantsMoM || wantsWhyChange || intentWhyNeedsPairWindows) &&
    !previousPeriod
  ) {
    return {
      resolvedTimeRange: attachDatasetMonthWindow(
        {
          label: latestPeriod.label,
          grain: "month",
          mode: "dataset_latest_period",
        },
        latestPeriod
      ),
      comparison: null,
      latestPeriod,
      previousPeriod: null,
      warnings: ["Only one time period exists in the dataset."],
    };
  }

  if (wantsMoM || wantsWhyChange || intentWhyNeedsPairWindows || (wantsThisMonth && wantsLastMonth)) {
    if (intentWhyNeedsPairWindows && !wantsWhyChange) {
      warnings.push(
        "Why-style question: using **latest month vs previous month** in your file for period-over-period context."
      );
    }
    return {
      resolvedTimeRange: attachDatasetMonthWindow(
        {
          label: latestPeriod.label,
          grain: "month",
          mode: "dataset_latest_period",
        },
        latestPeriod
      ),
      comparison: attachDatasetMonthWindow(
        {
          label: previousPeriod.label,
          grain: "month",
          mode: "dataset_previous_period",
        },
        previousPeriod
      ),
      latestPeriod,
      previousPeriod,
      warnings,
    };
  }

  if (wantsThisMonth) {
    return {
      resolvedTimeRange: attachDatasetMonthWindow(
        {
          label: latestPeriod.label,
          grain: "month",
          mode: "dataset_latest_period",
        },
        latestPeriod
      ),
      comparison: null,
      latestPeriod,
      previousPeriod,
      warnings,
    };
  }

  if (wantsLastMonth) {
    return {
      resolvedTimeRange: attachDatasetMonthWindow(
        {
          label: previousPeriod.label,
          grain: "month",
          mode: "dataset_previous_period",
        },
        previousPeriod
      ),
      comparison: null,
      latestPeriod,
      previousPeriod,
      warnings,
    };
  }

  /** Dataset-anchored calendar years present in the time column (not wall clock). */
  const yearsInData = (() => {
    const ys = new Set();
    for (const row of rows) {
      const k = rowSortKey(row, dateCol);
      if (k > 0) ys.add(Math.floor(k / 10000));
    }
    return [...ys].sort((a, b) => a - b);
  })();
  const latestDataYear = yearsInData.length ? yearsInData[yearsInData.length - 1] : null;
  const priorDataYear =
    yearsInData.length >= 2 ? yearsInData[yearsInData.length - 2] : null;

  const wantsThisYear =
    /\bthis\s+year\b/i.test(lower) || /\b(latest|current)\s+year\b/i.test(lower);
  const wantsLastYear = /\blast\s+year\b/i.test(lower) || /\b(previous|prior)\s+year\b/i.test(lower);

  if ((wantsThisYear || wantsLastYear) && latestDataYear) {
    if (!priorDataYear && (wantsThisYear && wantsLastYear)) {
      return {
        resolvedTimeRange: {
          label: String(latestDataYear),
          grain: "year",
          mode: "dataset_latest_year",
          start: ymdToSortKey(latestDataYear, 1, 1),
          end: ymdToSortKey(latestDataYear, 12, 31),
        },
        comparison: null,
        latestPeriod,
        previousPeriod,
        warnings: [...warnings, "Only one calendar year appears in the dataset; cannot compare two years."],
      };
    }
    if (wantsThisYear && wantsLastYear && priorDataYear) {
      return {
        resolvedTimeRange: {
          label: String(latestDataYear),
          grain: "year",
          mode: "dataset_latest_year",
          start: ymdToSortKey(latestDataYear, 1, 1),
          end: ymdToSortKey(latestDataYear, 12, 31),
        },
        comparison: {
          label: String(priorDataYear),
          grain: "year",
          mode: "dataset_prior_year_in_data",
          start: ymdToSortKey(priorDataYear, 1, 1),
          end: ymdToSortKey(priorDataYear, 12, 31),
        },
        latestPeriod,
        previousPeriod,
        warnings: [
          ...warnings,
          "Years are the latest and second-latest years **present in the file**, not today’s calendar.",
        ],
      };
    }
    if (wantsThisYear && !wantsLastYear) {
      return {
        resolvedTimeRange: {
          label: String(latestDataYear),
          grain: "year",
          mode: "dataset_latest_year",
          start: ymdToSortKey(latestDataYear, 1, 1),
          end: ymdToSortKey(latestDataYear, 12, 31),
        },
        comparison: null,
        latestPeriod,
        previousPeriod,
        warnings,
      };
    }
    if (wantsLastYear && !wantsThisYear) {
      if (!priorDataYear) {
        return {
          resolvedTimeRange: null,
          comparison: null,
          latestPeriod,
          previousPeriod,
          warnings: [
            ...warnings,
            "The dataset does not include an earlier year to interpret “last year” (only one year appears).",
          ],
        };
      }
      return {
        resolvedTimeRange: {
          label: String(priorDataYear),
          grain: "year",
          mode: "dataset_prior_year_in_data",
          start: ymdToSortKey(priorDataYear, 1, 1),
          end: ymdToSortKey(priorDataYear, 12, 31),
        },
        comparison: null,
        latestPeriod,
        previousPeriod,
        warnings,
      };
    }
  }

  // Keep explicit quarter handling dataset-anchored.
  const qm = lower.match(/\bq([1-4])\b(?:\s*(\d{4}))?/i);
  if (qm) {
    const q = Number(qm[1]);
    const refK = referenceSortKeyFromData(rows, dateCol);
    const ymd = sortKeyToYmd(refK);
    const year = qm[2] ? Number(qm[2]) : ymd?.y;
    if (year) {
      const startMo = (q - 1) * 3 + 1;
      const start = ymdToSortKey(year, startMo, 1);
      const endMo = startMo + 2;
      const end = ymdToSortKey(year, endMo, daysInMonth(year, endMo));
      return {
        resolvedTimeRange: { label: `Q${q} ${year}`, start, end, grain: "quarter" },
        comparison: null,
        latestPeriod,
        previousPeriod,
        warnings,
      };
    }
  }

  if (/\bqoq\b|\bquarter over quarter\b/i.test(lower)) {
    const refK = referenceSortKeyFromData(rows, dateCol);
    const ymd = sortKeyToYmd(refK);
    if (ymd) {
      const curQ = calendarQuarterFromMonth(ymd.y, ymd.mo);
      const prevQ = previousCalendarQuarter(curQ.y, curQ.q);
      return {
        resolvedTimeRange: {
          label: `Q${curQ.q} ${curQ.y}`,
          grain: "quarter",
          mode: "dataset_latest_quarter",
        },
        comparison: {
          label: `Q${prevQ.q} ${prevQ.y}`,
          grain: "quarter",
          mode: "dataset_previous_quarter",
        },
        latestPeriod,
        previousPeriod,
        warnings: [...warnings, "Quarters are anchored to the latest date in your dataset."],
      };
    }
  }

  if (/\byoy\b|\byear over year\b/i.test(lower)) {
    const refK = referenceSortKeyFromData(rows, dateCol);
    const ymd = sortKeyToYmd(refK);
    if (ymd) {
      return {
        resolvedTimeRange: {
          label: `${ymd.y}-${String(ymd.mo).padStart(2, "0")}`,
          grain: "month",
          mode: "dataset_latest_month",
        },
        comparison: {
          label: `${ymd.y - 1}-${String(ymd.mo).padStart(2, "0")}`,
          grain: "month",
          mode: "dataset_prior_year_same_month",
        },
        latestPeriod,
        previousPeriod,
        warnings: [...warnings, "YoY is anchored to the latest date in your dataset."],
      };
    }
  }

  return {
    resolvedTimeRange: null,
    comparison: null,
    latestPeriod,
    previousPeriod,
    warnings: [],
  };
}

function utcDateFromSortKey(sk) {
  const ymd = sortKeyToYmd(sk);
  if (!ymd) return null;
  return utcDate(ymd.y, ymd.mo, ymd.d || 1);
}

function utcWeekBounds(d) {
  const day = d.getUTCDay();
  const diff = (day + 6) % 7;
  const monday = new Date(d.getTime() - diff * 86400000);
  const y = monday.getUTCFullYear();
  const m = monday.getUTCMonth() + 1;
  const dd = monday.getUTCDate();
  const start = ymdToSortKey(y, m, dd);
  const sunday = new Date(monday.getTime() + 6 * 86400000);
  const end = ymdToSortKey(sunday.getUTCFullYear(), sunday.getUTCMonth() + 1, sunday.getUTCDate());
  return { weekStart: start, weekEnd: end };
}

function countDaysInclusive(a, b) {
  const da = utcDateFromSortKey(a);
  const db = utcDateFromSortKey(b);
  if (!da || !db) return 1;
  return Math.max(1, Math.round((db - da) / 86400000) + 1);
}

function advanceSortKey(startSk, daysToAdd) {
  const d = utcDateFromSortKey(startSk);
  if (!d) return startSk;
  const n = new Date(d.getTime() + daysToAdd * 86400000);
  return ymdToSortKey(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate());
}

function filterRowsBySortKeyRange(rows, dateCol, start, end) {
  if (!dateCol || !start || !end) return rows;
  return rows.filter((r) => {
    const k = rowSortKey(r, dateCol);
    return k >= start && k <= end;
  });
}

module.exports = {
  findBestDateColumn,
  rowSortKey,
  resolveComparisonWindows,
  filterRowsBySortKeyRange,
  maxSortKeyInRows,
  sortKeyToYmd,
  ymdToSortKey,
  nameHintDateColumn,
  referenceSortKeyFromData,
  getAvailableDatasetPeriods,
};