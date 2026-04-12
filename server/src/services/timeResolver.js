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

  if ((wantsThisMonth || wantsLastMonth || wantsMoM || wantsWhyChange) && !previousPeriod) {
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

  if (wantsMoM || wantsWhyChange || (wantsThisMonth && wantsLastMonth)) {
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