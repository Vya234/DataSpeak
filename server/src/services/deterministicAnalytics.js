/**
 * deterministicAnalytics.js — Computes answers from structured intent + filtered rows.
 * No LLM arithmetic; outputs structured evidence for optional formatting.
 */

const { parseNumber, groupByTime, detectTemporalColumn, pearsonCorrelation } = require("../utils/datasetAnalysis");
const { filterRowsBySortKeyRange, maxSortKeyInRows, sortKeyToYmd, ymdToSortKey } = require("./timeResolver");
const { extractEntityPair, isRelativeTimeEntityPair } = require("./intentParser");
const { findColumnForAliases } = require("./metricResolver");

const DIMENSION_ALIASES = {
  Region: ["region", "area", "zone", "territory", "geo", "geography", "location"],
  Product: ["product", "item", "sku", "offering", "service", "plan"],
  Segment: ["segment", "customer segment", "user segment", "market segment"],
  Channel: ["channel", "source", "platform", "medium", "sales channel"],
  Category: ["category", "categories", "product category", "prod category"],
  Department: ["department", "dept", "function", "division", "team", "section", "business unit", "cost center"],
};

function listDimensionColumns(columns, numericSet, dateCol) {
  return (columns || []).filter((c) => c && !numericSet.has(c) && c !== dateCol);
}

/** Region / product / channel first for driver attribution. */
function prioritizeDriverDimensions(cols) {
  const rank = (c) => {
    const x = String(c || "").toLowerCase();
    if (/(region|territory|area|geo|location)/.test(x)) return 0;
    if (/(product|sku|item|plan)/.test(x)) return 1;
    if (/(channel|segment|department)/.test(x)) return 2;
    if (/(category|categor)/.test(x)) return 2;
    return 10;
  };
  return [...(cols || [])].sort((a, b) => rank(a) - rank(b));
}

function resolveDimensionColumn(question, columns, numericSet, dateCol) {
  const lower = question.toLowerCase();
  for (const aliases of Object.values(DIMENSION_ALIASES)) {
    for (const a of aliases) {
      if (lower.includes(a)) {
        const col = findColumnForAliases(columns, aliases);
        if (col) return col;
      }
    }
  }
  return findColumnForAliases(columns, [
    "region",
    "product",
    "channel",
    "segment",
    "department",
    "category",
    "categories",
  ]);
}

/**
 * Aggregate each resolved metric id using sum or avg hint.
 */
function aggregateMetrics(rows, columnMap, aggregationHints) {
  const out = {};
  for (const [id, col] of Object.entries(columnMap || {})) {
    if (!col) continue;
    const prefer = aggregationHints?.[id] || "sum";
    let sum = 0;
    let c = 0;
    for (const row of rows) {
      const n = parseNumber(row?.[col]);
      if (n !== null) {
        sum += n;
        c++;
      }
    }
    out[id] = prefer === "avg" && c > 0 ? sum / c : sum;
  }
  return out;
}

function pctChange(cur, prev) {
  if (prev === 0) return cur === 0 ? 0 : null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}

function daysInMonthUtc(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function calendarPreviousMonth(y, mo) {
  if (mo <= 1) return { y: y - 1, mo: 12 };
  return { y, mo: mo - 1 };
}

/** Top month-over-month % growth by product (dataset-latest month vs prior month). */
function tryProductMomGrowth(ctx) {
  const { question, rows, columns, metrics, dateCol } = ctx;
  if (!dateCol || !rows.length) return null;
  const lower = question.toLowerCase();
  const matches =
    /\b(top|fastest|best|which)\s+(\w+\s+)?growing\s+product/i.test(lower) ||
    (/\bproduct(s)?\b/i.test(lower) && /\b(mom|month[- ]over[- ]month|growth|growing)\b/i.test(lower));
  if (!matches) return null;

  const productCol = findColumnForAliases(columns, DIMENSION_ALIASES.Product);
  const mid = metrics.primaryMetricId;
  const col = (mid && metrics.columnMap[mid]) || metrics.primaryColumn;
  if (!productCol || !mid || !col) return null;

  const refK = maxSortKeyInRows(rows, dateCol);
  if (!refK) return null;
  const ymd = sortKeyToYmd(refK);
  if (!ymd) return null;

  const curStart = ymdToSortKey(ymd.y, ymd.mo, 1);
  const curEnd = refK;
  const pm = calendarPreviousMonth(ymd.y, ymd.mo);
  const prevStart = ymdToSortKey(pm.y, pm.mo, 1);
  const prevEndDay = Math.min(ymd.d, daysInMonthUtc(pm.y, pm.mo));
  const prevEnd = ymdToSortKey(pm.y, pm.mo, prevEndDay);

  const curRows = filterRowsBySortKeyRange(rows, dateCol, curStart, curEnd);
  const prevRows = filterRowsBySortKeyRange(rows, dateCol, prevStart, prevEnd);
  if (!curRows.length) return null;

  const curBy = contributionsByDimension(curRows, productCol, col);
  const prevBy = contributionsByDimension(prevRows, productCol, col);
  const prevMap = new Map(prevBy.map((p) => [p.label, p.sum]));
  let best = null;
  for (const c of curBy) {
    const p0 = prevMap.get(c.label) ?? 0;
    const csum = c.sum;
    const pchg = pctChange(csum, p0);
    if (pchg === null) continue;
    if (best === null || pchg > best.pct) best = { label: c.label, pct: pchg, cur: csum, prev: p0 };
  }
  if (!best) return null;

  const answer =
    `Comparing the **latest month in your file** to the **month before it**, **${best.label}** had the strongest month-over-month growth on **${mid}** ` +
    `at **${best.pct.toFixed(1)}%** (**${formatVal(mid, best.prev)}** to **${formatVal(mid, best.cur)}**).`;

  return buildRichBase({
    answer,
    resolvedMetric: mid,
    resolvedDimensions: [productCol],
    evidence: { topProductMom: best },
    warnings: ["Windows follow the latest date in your dataset, not the system clock."],
  });
}

function formatMoney(n) {
  const x = Number(n) || 0;
  return `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatVal(id, n) {
  if (id === "Revenue" || id === "AdSpend" || id === "Cost" || id === "Profit" || id === "ARPO") return formatMoney(n);
  if (id === "ReturnRate" || id === "ChurnRate" || id === "GrossMarginPct") return `${(Number(n) || 0).toFixed(4)}`;
  if (id === "NPS" || id === "CSAT") return `${(Number(n) || 0).toFixed(2)}`;
  return `${(Number(n) || 0).toLocaleString("en-US")}`;
}

function buildRichBase(overrides) {
  return {
    answer: "",
    source: "rule-based",
    confidence: "high",
    reasoning_mode: "deterministic_analytics",
    resolvedMetric: null,
    resolvedDimensions: [],
    resolvedFilters: [],
    resolvedTimeRange: null,
    comparison: null,
    contributors: null,
    chartData: undefined,
    warnings: [],
    evidence: null,
    ...overrides,
  };
}

/** Contribution of each group to metric total within rows (sum). */
function contributionsByDimension(rows, dimCol, valueCol) {
  if (!dimCol || !valueCol) return [];
  const map = new Map();
  for (const row of rows) {
    const k = String(row?.[dimCol] ?? "").trim() || "(blank)";
    const n = parseNumber(row?.[valueCol]);
    if (n === null) continue;
    map.set(k, (map.get(k) || 0) + n);
  }
  return [...map.entries()]
    .map(([label, sum]) => ({ label, sum }))
    .sort((a, b) => b.sum - a.sum);
}

function driverTable(curRows, prevRows, dimCol, valueCol, topN = 5) {
  const cur = contributionsByDimension(curRows, dimCol, valueCol);
  const prev = contributionsByDimension(prevRows, dimCol, valueCol);
  const prevMap = new Map(prev.map((p) => [p.label, p.sum]));
  const rows = cur.map((c) => {
    const p = prevMap.get(c.label) ?? 0;
    return { label: c.label, current: c.sum, previous: p, delta: c.sum - p };
  });
  const neg = [...rows].sort((a, b) => a.delta - b.delta).slice(0, topN);
  const pos = [...rows].sort((a, b) => b.delta - a.delta).slice(0, topN);
  return { neg, pos, all: rows };
}

function tryCorrelation(question, rows, columns, metrics, intent) {
  if (intent.wantsWhy || intent.tasks.includes("driver_analysis")) return null;
  if (!intent.tasks.includes("correlation") && !/\bcorrelat|\brelationship\b|\bassociated\b/i.test(question)) {
    return null;
  }

  const colMap = metrics.columnMap;
  const numericCols = metrics.numericColumns;
  if (numericCols.length < 2) {
    return buildRichBase({
      answer:
        "A correlation needs at least two numeric columns with enough paired values. This dataset does not meet that requirement.",
      confidence: "low",
      reasoning_mode: "safe_refusal",
      warnings: ["insufficient numeric columns"],
    });
  }

  const lower = question.toLowerCase();
  let colX;
  let colY;
  if (/\b(spend|cost|ad)\b/i.test(lower) && /\b(revenue|sales)\b/i.test(lower)) {
    colX = colMap.AdSpend || colMap.Cost;
    colY = colMap.Revenue;
  } else if (/\bcomplaints?\b/i.test(lower) && /\b(revenue|sales)\b/i.test(lower)) {
    colX = colMap.Complaints;
    colY = colMap.Revenue;
  }
  if (!colX || !colY) {
    colX = numericCols[0];
    colY = numericCols[1];
  }

  const { r, n, sufficient, reason } = pearsonCorrelation(rows, colX, colY);
  if (!sufficient || r === null) {
    return buildRichBase({
      answer: `There is not enough overlapping numeric data to compute a correlation between **${colX}** and **${colY}** (${reason || "n too small"}).`,
      confidence: "low",
      reasoning_mode: "safe_refusal",
      warnings: [reason || "insufficient pairs"],
      evidence: { colX, colY, n },
    });
  }

  const strength =
    Math.abs(r) >= 0.6 ? "strong" : Math.abs(r) >= 0.3 ? "moderate" : "weak";
  const dir = r > 0 ? "positive" : "negative";
  const answer =
    `Based on **${n}** rows with both **${colX}** and **${colY}** filled, the Pearson correlation is **${r.toFixed(
      3
    )}** — a **${strength} ${dir} association**. ` +
    `This does **not** prove causation; it only measures how the two columns moved together in this dataset.`;

  return buildRichBase({
    answer,
    resolvedMetric: null,
    evidence: { colX, colY, pearsonR: r, n },
    warnings: ["Association is not causation."],
  });
}

function tryEntityCompare(question, rows, columns, metrics, dateCol) {
  if (!/\bvs\.?\b|\bversus\b|\bcompare\b/i.test(question)) return null;
  const pair = extractEntityPair(question);
  if (!pair || isRelativeTimeEntityPair(pair)) return null;

  const numericSet = new Set(metrics.numericColumns);
  const dim = resolveDimensionColumn(question, columns, numericSet, dateCol);
  if (!dim) return null;

  const norm = (s) => String(s || "").trim().toLowerCase();
  const a = norm(pair.a);
  const b = norm(pair.b);

  const matchRow = (row, t) => norm(row[dim]).includes(t) || t.includes(norm(row[dim]));

  const rowsA = rows.filter((r) => matchRow(r, a));
  const rowsB = rows.filter((r) => matchRow(r, b));
  if (!rowsA.length || !rowsB.length) {
    return buildRichBase({
      answer: `I could not find both "${pair.a}" and "${pair.b}" in **${dim}** for comparison.`,
      confidence: "low",
      reasoning_mode: "safe_refusal",
      warnings: ["entity match failed"],
    });
  }

  const col = (metrics.primaryMetricId && metrics.columnMap[metrics.primaryMetricId]) || metrics.primaryColumn;
  if (!col) return null;

  const mid = metrics.primaryMetricId || col;
  let va = 0;
  let vb = 0;
  for (const row of rowsA) {
    const n = parseNumber(row?.[col]);
    if (n !== null) va += n;
  }
  for (const row of rowsB) {
    const n = parseNumber(row?.[col]);
    if (n !== null) vb += n;
  }

  const answer =
    `Comparing **${pair.a}** vs **${pair.b}** on **${mid}** (${col}): ` +
    `${pair.a} totals **${formatVal(mid, va)}** (${rowsA.length} rows) and ${pair.b} totals **${formatVal(
      mid,
      vb
    )}** (${rowsB.length} rows).`;

  return buildRichBase({
    answer,
    resolvedMetric: mid,
    resolvedDimensions: [dim],
    chartData: {
      labels: [pair.a, pair.b],
      values: [va, vb],
      type: "bar",
    },
    evidence: { dim, totals: { a: va, b: vb }, rowsA: rowsA.length, rowsB: rowsB.length },
  });
}

/**
 * "Compare revenue across regions" — grouped totals per dimension (not a time trend).
 */
function tryGroupedDimensionComparison(question, rows, columns, metrics, dateCol) {
  const lower = String(question || "").toLowerCase();
  if (!/\b(compare|comparison|versus|across)\b/i.test(lower)) return null;
  if (/\b(this|last|next|prior|previous|current)\s+month\b/i.test(lower) && /\b(vs\.?|versus)\b/i.test(lower)) {
    return null;
  }

  const al = (list) => findColumnForAliases(columns, list);
  let dim = null;
  if (/\bacross\s+regions?\b|\bby\s+region\b|\bper\s+region\b|\bfor\s+each\s+region\b|\bcompare\b.*\bregion\b/i.test(lower)) {
    dim = al(DIMENSION_ALIASES.Region);
  } else if (/\bacross\s+products?\b|\bby\s+product\b|\bper\s+product\b|\bcompare\b.*\bproduct\b/i.test(lower)) {
    dim = al(DIMENSION_ALIASES.Product);
  } else if (/\bacross\s+channels?\b|\bby\s+channel\b|\bcompare\b.*\bchannel\b/i.test(lower)) {
    dim = al(DIMENSION_ALIASES.Channel);
  } else if (/\bacross\s+categor|\bby\s+categor|\bper\s+categor|\bsplit\s+by\s+categor|\bcompare\b.*\bcategor/i.test(lower)) {
    dim = al(DIMENSION_ALIASES.Category);
  } else if (/\bacross\s+segments?\b|\bby\s+segment\b/i.test(lower)) {
    dim = al(DIMENSION_ALIASES.Segment);
  }
  if (!dim) return null;

  const mid = metrics.primaryMetricId;
  const col = (mid && metrics.columnMap[mid]) || metrics.primaryColumn;
  if (!mid || !col) return null;

  const contribs = contributionsByDimension(rows, dim, col);
  if (contribs.length < 2) {
    return buildRichBase({
      answer: `Not enough distinct **${dim}** values to compare (need at least two).`,
      reasoning_mode: "safe_refusal",
      confidence: "medium",
      resolvedDimensions: [dim],
      warnings: ["insufficient_groups"],
    });
  }

  const total = contribs.reduce((s, c) => s + c.sum, 0);
  const parts = contribs.slice(0, 15).map((c) => {
    const pct = total !== 0 ? ((c.sum / total) * 100).toFixed(1) : "0";
    return `**${c.label}**: **${formatVal(mid, c.sum)}** (${pct}%)`;
  });
  const top = contribs[0];
  const bottom = contribs[contribs.length - 1];
  const answer =
    `**${mid}** (${col}) compared across **${dim}**: ${parts.join("; ")}.` +
    (contribs.length > 15 ? ` Showing 15 of ${contribs.length} groups.` : "") +
    ` Largest share: **${top.label}** (**${formatVal(mid, top.sum)}**); smallest in this list: **${bottom.label}**.`;

  return buildRichBase({
    answer,
    resolvedMetric: mid,
    resolvedDimensions: [dim],
    chartData: {
      labels: contribs.slice(0, 15).map((c) => c.label),
      values: contribs.slice(0, 15).map((c) => c.sum),
      type: "bar",
    },
    evidence: { contribs: contribs.slice(0, 30), total },
  });
}

/**
 * "Which region performed better?" — pick best / second from grouped totals (no LLM).
 */
function tryWhichDimensionBest(question, rows, columns, metrics, dateCol) {
  const lower = question.toLowerCase();
  if (!/\bwhich\b/i.test(lower)) return null;
  if (!/\b(better|best|performed|stronger|leading|won|outperformed)\b/i.test(lower)) return null;
  if (/\bvs\.?\b|\bversus\b/i.test(lower)) return null;

  const numericSet = new Set(metrics.numericColumns);
  const dim = resolveDimensionColumn(question, columns, numericSet, dateCol);
  if (!dim) return null;

  const mid = metrics.primaryMetricId;
  const col = (mid && metrics.columnMap[mid]) || metrics.primaryColumn;
  if (!col) return null;

  const contribs = contributionsByDimension(rows, dim, col);
  if (contribs.length < 2) {
    return buildRichBase({
      answer: `There are not enough distinct **${dim}** values to compare (need at least two groups).`,
      reasoning_mode: "safe_refusal",
      confidence: "medium",
      resolvedDimensions: [dim],
      warnings: ["insufficient groups"],
    });
  }

  const top = contribs[0];
  const second = contribs[1];
  const labelId = mid || col;
  const answer =
    `**${top.label}** leads on **${col}** with **${formatVal(labelId, top.sum)}** total, ` +
    `vs **${second.label}** at **${formatVal(labelId, second.sum)}** (from **${rows.length}** rows after filters).`;

  return buildRichBase({
    answer,
    resolvedMetric: mid,
    resolvedDimensions: [dim],
    chartData: {
      labels: contribs.slice(0, 12).map((c) => c.label),
      values: contribs.slice(0, 12).map((c) => c.sum),
      type: "bar",
    },
    evidence: { contribs: contribs.slice(0, 20) },
  });
}

function tryTimeComparisonAndDriver(ctx) {
  const {
    question,
    rows,
    columns,
    intent,
    metrics,
    dateCol,
    timeBundle,
    filterDescription,
  } = ctx;

  if (!dateCol || !timeBundle?.resolvedTimeRange) return null;

  const cur = timeBundle.resolvedTimeRange;
  const cmp = timeBundle.comparison;

  if (!cur.start || !cur.end) return null;

  const curRows = filterRowsBySortKeyRange(rows, dateCol, cur.start, cur.end);
  if (!cmp) {
    const agg = aggregateMetrics(curRows, metrics.columnMap, metrics.aggregationHints);
    const mid = metrics.primaryMetricId;
    const answer =
      `For **${cur.label}**, **${mid || "primary metric"}** is **${formatVal(
        mid,
        agg[mid] ?? 0
      )}** (${curRows.length} rows).`;
    return buildRichBase({
      answer: filterDescription ? `*(Filters: ${filterDescription})*\n\n${answer}` : answer,
      resolvedMetric: mid,
      resolvedTimeRange: cur,
      evidence: { aggregates: agg, rowCount: curRows.length },
    });
  }

  if (!cmp.start || !cmp.end) return null;

  const prevRows = filterRowsBySortKeyRange(rows, dateCol, cmp.start, cmp.end);

  const mid = metrics.primaryMetricId;
  const col = (mid && metrics.columnMap[mid]) || metrics.primaryColumn;
  if (!mid || !col) return null;

  const aggCur = aggregateMetrics(curRows, metrics.columnMap, metrics.aggregationHints);
  const aggPrev = aggregateMetrics(prevRows, metrics.columnMap, metrics.aggregationHints);
  const vCur = aggCur[mid] ?? 0;
  const vPrev = aggPrev[mid] ?? 0;
  const pct = pctChange(vCur, vPrev);
  const dir = vCur >= vPrev ? "increased" : "decreased";
  const negligibleMove =
    vCur === vPrev || (pct !== null && Math.abs(pct) < 0.05);

  const numericSet = new Set(metrics.numericColumns);
  const dims = prioritizeDriverDimensions(listDimensionColumns(columns, numericSet, dateCol)).slice(0, 8);

  /** @type {{ label: string, delta: number }[]} */
  let contributors = null;
  let driverNote = "";

  if (intent.wantsWhy || intent.tasks.includes("driver_analysis")) {
    if (negligibleMove) {
      driverNote =
        " The metric barely moved between these two periods (< 0.05% change), so driver attribution is not meaningful.";
    } else {
      const tables = [];
      for (const d of dims) {
        tables.push({ dim: d, ...driverTable(curRows, prevRows, d, col) });
      }
      const summaries = tables
        .map((t) => ({ dim: t.dim, worst: t.neg[0], best: t.pos[0] }))
        .filter((t) => t.worst || t.best);

      const metricDropped = vCur < vPrev;
      const metricRose = vCur > vPrev;

      const worstOverall = metricDropped
        ? [...summaries].sort((a, b) => (a.worst?.delta || 0) - (b.worst?.delta || 0))[0]
        : null;
      const bestOverall = metricRose
        ? [...summaries].sort((a, b) => (b.best?.delta || 0) - (a.best?.delta || 0))[0]
        : null;

      contributors = [];
      if (worstOverall?.worst && metricDropped) {
        contributors.push({
          dimension: worstOverall.dim,
          label: worstOverall.worst.label,
          delta: worstOverall.worst.delta,
          role: "largest_negative_contributor",
        });
        driverNote =
          ` The largest contributor to the **drop** by **${worstOverall.dim}** was **${worstOverall.worst.label}** ` +
          `(delta **${formatVal(mid, worstOverall.worst.delta)}** between the two periods).`;
      } else if (bestOverall?.best && metricRose) {
        contributors.push({
          dimension: bestOverall.dim,
          label: bestOverall.best.label,
          delta: bestOverall.best.delta,
          role: "largest_positive_contributor",
        });
        driverNote =
          ` The largest contributor to the **increase** by **${bestOverall.dim}** was **${bestOverall.best.label}** ` +
          `(delta **${formatVal(mid, bestOverall.best.delta)}**).`;
      } else {
        driverNote =
          dims.length === 0
            ? " No categorical breakdown explains the change — there are no region/product-style columns to compare between periods."
            : " **No categorical breakdown explains the change** with the available region/product columns (segment shifts are too small or evenly mixed).";
      }
    }

    // Supporting metrics: mention direction only if column exists and change is non-zero
    const support = [];
    for (const id of ["Orders", "AdSpend", "Complaints", "ChurnRate", "ReturnRate"]) {
      if (!metrics.columnMap[id] || id === mid) continue;
      const a = aggCur[id] ?? 0;
      const b = aggPrev[id] ?? 0;
      if (a === b) continue;
      support.push(`${id} moved from **${formatVal(id, b)}** to **${formatVal(id, a)}**`);
    }
    if (support.length) {
      driverNote += ` Supporting metrics in the same windows: ${support.join("; ")}.`;
    }
  }

  const rowHint =
    curRows.length === 0 && prevRows.length === 0
      ? " (no rows fell in either period after filters — totals are zero.)"
      : curRows.length === 0 || prevRows.length === 0
        ? ` (${curRows.length ? "current" : "prior"} period has no rows after filters; the other period still compares.)`
        : "";

  const assumesDrop = /\b(drop|drops|dropped|declin|fall|falls|fell|decrease)\b/i.test(question);
  let clarify = "";
  if ((intent.wantsWhy || intent.tasks.includes("driver_analysis")) && assumesDrop) {
    if (vCur > vPrev) {
      clarify = "There was no drop between the latest two periods in the dataset. ";
    } else if (vCur === vPrev) {
      clarify = "There was no drop — the value was unchanged between the latest two periods. ";
    }
  }

  let answer =
    (cmp.partialNote ? `${cmp.partialNote} ` : "") +
    clarify +
    `**${mid}** (${col}) **${dir}**` +
    (pct !== null ? ` by **${Math.abs(pct).toFixed(1)}%**` : "") +
    ` from **${formatVal(mid, vPrev)}** in the earlier window (${cmp.label}${prevRows.length ? `, ${prevRows.length} rows` : ""}) ` +
    `to **${formatVal(mid, vCur)}** in the later window (${cur.label}${curRows.length ? `, ${curRows.length} rows` : ""}).` +
    rowHint +
    driverNote;

  if (timeBundle.warnings?.length) {
    answer += ` Notes: ${timeBundle.warnings.join(" ")}`;
  }

  return buildRichBase({
    answer: filterDescription ? `*(Filters: ${filterDescription})*\n\n${answer}` : answer,
    resolvedMetric: mid,
    resolvedTimeRange: cur,
    comparison: cmp,
    contributors,
    chartData: {
      labels: [cmp.label, cur.label],
      values: [vPrev, vCur],
      type: "bar",
    },
    warnings: [...(timeBundle.warnings || [])],
    evidence: { aggCur, aggPrev, curRows: curRows.length, prevRows: prevRows.length },
  });
}

function tryBreakdown(question, rows, columns, metrics, dateCol, intent) {
  if (!intent.isBreakdownQuestion && !/\bbreakdown\b|\bcomposition\b|\bshare\b/i.test(question)) return null;

  const qStr = String(question || "");
  if (/\b(top\s*\d+|bottom\s*\d+|highest\s+\d+|lowest\s+\d+|best\s+\d+|worst\s+\d+)\b/i.test(qStr)) {
    return null;
  }

  const numericSet = new Set(metrics.numericColumns);
  const dim = resolveDimensionColumn(question, columns, numericSet, dateCol);
  const mid = metrics.primaryMetricId;
  const col = (mid && metrics.columnMap[mid]) || metrics.primaryColumn;
  if (!dim || !mid || !col) return null;

  const contribs = contributionsByDimension(rows, dim, col);
  if (!contribs.length) return null;

  const total = contribs.reduce((s, c) => s + c.sum, 0);
  const parts = contribs.slice(0, 12).map((c) => {
    const share = total === 0 ? 0 : (c.sum / total) * 100;
    return `${c.label}: **${formatVal(mid, c.sum)}** (${share.toFixed(1)}%)`;
  });

  const answer =
    `**${mid}** breakdown by **${dim}** (column **${col}**): ${parts.join("; ")}.` +
    (contribs.length > 12 ? ` Showing 12 of ${contribs.length} groups.` : "");

  return buildRichBase({
    answer,
    resolvedMetric: mid,
    resolvedDimensions: [dim],
    chartData: {
      labels: contribs.slice(0, 15).map((c) => c.label),
      values: contribs.slice(0, 15).map((c) => c.sum),
      type: "bar",
    },
    evidence: { contribs: contribs.slice(0, 20), total },
  });
}

function trySummary(intent, rows, columns, metrics, dateCol) {
  const lower = (intent.rawQuestion || "").toLowerCase();
  const wantsMonthlyAnalysisPhrases =
    /\bmonthly\s+(analysis|review|report)\b/i.test(lower) ||
    /\bgive me (a )?monthly analysis\b/i.test(lower) ||
    /\banalyze (this month|the latest month)\b/i.test(lower) ||
    /\b(latest|this) month analysis\b/i.test(lower);

  if (
    !intent.isWeeklySummary &&
    !intent.isMonthlySummary &&
    !intent.isDailySummary &&
    !wantsMonthlyAnalysisPhrases
  ) {
    return null;
  }

  const temporal = dateCol || detectTemporalColumn(columns);
  const col = metrics.columnMap[metrics.primaryMetricId] || metrics.primaryColumn;
  if (!temporal || !col) return null;

  let grain = "month";
  if (intent.isWeeklySummary) grain = "week";
  if (intent.isDailySummary) grain = "day";
  if (wantsMonthlyAnalysisPhrases && !intent.isWeeklySummary && !intent.isDailySummary) grain = "month";

  const buckets = groupByTime(
    rows,
    temporal,
    [col],
    /\b(avg|average|rate|%)\b/i.test(intent.rawQuestion || "") ? "avg" : "sum"
  );
  if (buckets.length === 0) return null;

  const last = buckets[buckets.length - 1];
  const prev = buckets.length > 1 ? buckets[buckets.length - 2] : null;
  const vLast = last[col] ?? 0;
  const vPrev = prev ? prev[col] ?? 0 : null;

  const grainPhrase =
    grain === "day" ? "day" : grain === "week" ? "week" : grain === "month" ? "month" : "period";
  let answer = `The most recent **${grainPhrase}** in your data is **${last.label}**, with **${col}** at **${formatVal(
    metrics.primaryMetricId,
    vLast
  )}**.`;
  if (prev && vPrev !== null) {
    const p = pctChange(vLast, vPrev);
    answer += ` The **${grainPhrase}** before that is **${prev.label}** at **${formatVal(metrics.primaryMetricId, vPrev)}**`;
    if (p !== null) answer += ` (${p >= 0 ? "+" : ""}${p.toFixed(1)}% vs the prior ${grainPhrase}).`;
    if (p !== null) {
      answer += ` Trend vs prior ${grainPhrase}: **${p >= 0 ? "up" : "down"}**.`;
      const absP = Math.abs(p);
      if (absP < 0.5) answer += " Movement vs the prior period is very small.";
      else if (absP < 5) answer += " Change vs the prior period is modest.";
      else answer += " This is a sizeable change vs the prior period.";
    }
  }

  return buildRichBase({
    answer,
    resolvedMetric: metrics.primaryMetricId,
    resolvedTimeRange: { label: last.label, grain },
    chartData: {
      labels: buckets.slice(-20).map((b) => b.label),
      values: buckets.slice(-20).map((b) => b[col] ?? 0),
      type: "line",
    },
    evidence: { buckets: buckets.slice(-24) },
  });
}

function tryAnomaly(intent, rows, columns, metrics, dateCol) {
  if (!intent.tasks.includes("anomaly")) return null;
  const temporal = dateCol || detectTemporalColumn(columns);
  const col = metrics.columnMap[metrics.primaryMetricId] || metrics.primaryColumn;
  if (!temporal || !col) return null;

  const buckets = groupByTime(rows, temporal, [col], "sum");
  if (buckets.length < 4) return null;

  const vals = buckets.map((b) => b[col] || 0);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const std = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length) || 1;
  const last = vals[vals.length - 1];
  const z = (last - mean) / std;
  if (Math.abs(z) < 2) {
    return buildRichBase({
      answer:
        "No strong anomaly in the latest aggregated period: it is within about **2 standard deviations** of the recent average.",
      evidence: { z, mean, std, last },
    });
  }

  const direction = z > 0 ? "high" : "low";
  return buildRichBase({
    answer: `The latest period looks unusually **${direction}** for **${col}** (about **${z.toFixed(
      2
    )}** standard deviations from the recent average). Verify filters and seasonality before acting.`,
    warnings: ["Anomaly detection is statistical only, not a root-cause analysis."],
    evidence: { z, mean, std, last },
  });
}

/**
 * Run deterministic analytics in priority order. Returns null to fall through to rules / LLM.
 * @param {{ skipTimeDriver?: boolean }} [opts] — set when driver intent already handled explicitly.
 */
function runDeterministicPipeline(ctx, opts = {}) {
  const { rows, columns, intent, metrics, dateCol } = ctx;
  if (!rows.length) return null;

  return (
    (!opts.skipTimeDriver && tryTimeComparisonAndDriver(ctx)) ||
    tryGroupedDimensionComparison(ctx.question, rows, columns, metrics, dateCol) ||
    tryProductMomGrowth(ctx) ||
    tryWhichDimensionBest(ctx.question, rows, columns, metrics, dateCol) ||
    tryEntityCompare(ctx.question, rows, columns, metrics, dateCol) ||
    tryCorrelation(ctx.question, rows, columns, metrics, intent) ||
    trySummary(intent, rows, columns, metrics, dateCol) ||
    tryBreakdown(ctx.question, rows, columns, metrics, dateCol, intent) ||
    null
  );
}

module.exports = {
  runDeterministicPipeline,
  tryTimeComparisonAndDriver,
  tryGroupedDimensionComparison,
  tryProductMomGrowth,
  aggregateMetrics,
  contributionsByDimension,
  buildRichBase,
  tryCorrelation,
};
