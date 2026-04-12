/**
 * deterministicAnalytics.js — Computes answers from structured intent + filtered rows.
 * No LLM arithmetic; outputs structured evidence for optional formatting.
 */

const {
  parseNumber,
  groupByTime,
  detectTemporalColumn,
  pearsonCorrelation,
  getNumericColumns,
  findPerfectCategoricalCorrelations,
} = require("../utils/datasetAnalysis");
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
  if (id === "Customers" || id === "Orders" || id === "Signups" || id === "Churn")
    return `${Math.round(Number(n) || 0).toLocaleString("en-US")}`;
  if (id === "ReturnRate" || id === "ChurnRate" || id === "GrossMarginPct") return `${(Number(n) || 0).toFixed(4)}`;
  if (id === "NPS" || id === "CSAT") return `${(Number(n) || 0).toFixed(2)}`;
  return `${(Number(n) || 0).toLocaleString("en-US")}`;
}

function sumMetricColumnRows(rows, col) {
  let s = 0;
  for (const r of rows || []) {
    const n = parseNumber(r?.[col]);
    if (n !== null) s += n;
  }
  return s;
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
  if (intent?.wantsWhy || intent?.tasks?.includes("driver_analysis")) return null;
  if (!intent?.tasks?.includes("correlation") && !/\bcorrelat|\brelationship\b|\bassociated\b/i.test(question)) {
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
  } else if (/\bcomplaints?\b|\bcustomers?\b/i.test(lower) && /\b(revenue|sales)\b/i.test(lower)) {
    colX = colMap.Customers;
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

function tryEntityCompare(question, rows, columns, metrics, dateCol, intent = {}) {
  if (intent?.wantsWhy || intent?.tasks?.includes("driver_analysis")) return null;
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

  const total = va + vb;
  const pa = total === 0 ? 0 : ((va / total) * 100).toFixed(1);
  const pb = total === 0 ? 0 : ((vb / total) * 100).toFixed(1);
  const lead = va >= vb ? pair.a : pair.b;
  const diff = Math.abs(va - vb);
  const answer =
    `Comparing **${pair.a}** vs **${pair.b}** on **${mid}** (${col}): ` +
    `**${pair.a}** **${formatVal(mid, va)}** (${pa}% of the pair total), **${pair.b}** **${formatVal(mid, vb)}** (${pb}%). ` +
    `**${lead}** leads by **${formatVal(mid, diff)}** (${rowsA.length} + ${rowsB.length} rows).`;

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
function tryGroupedDimensionComparison(question, rows, columns, metrics, dateCol, intent = {}) {
  const lower = String(question || "").toLowerCase();
  if (intent?.wantsWhy || intent?.tasks?.includes("driver_analysis")) return null;
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
function tryWhichDimensionBest(question, rows, columns, metrics, dateCol, intent = {}) {
  const lower = question.toLowerCase();
  if (intent?.wantsWhy || intent?.tasks?.includes("driver_analysis")) return null;
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
    const ql = String(question || "").toLowerCase();
    const needsComparisonExplanation =
      intent?.wantsWhy ||
      intent?.tasks?.includes("driver_analysis") ||
      /\b(why|what caused|what drove|reason|reasons|how come)\b/i.test(ql) ||
      /\bcauses?\b|\bcause\b/i.test(ql);
    if (needsComparisonExplanation) {
      const msg =
        `This question asks **why** something changed, which requires **comparing two time periods** (current vs previous) plus contribution by **region/product** columns. ` +
        `Only a **single** time window was resolved for **${cur.label}** in **${dateCol}**, so a causal period-over-period answer is not available. ` +
        `Try **month over month**, **last month vs this month**, or name **two calendar months**.`;
      return buildRichBase({
        answer: filterDescription ? `*(Filters: ${filterDescription})*\n\n${msg}` : msg,
        confidence: "low",
        reasoning_mode: "safe_refusal",
        resolvedTimeRange: cur,
        warnings: [...(timeBundle.warnings || []), "why_query_missing_comparison_window"],
      });
    }
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
  let vCur = aggCur[mid] ?? 0;
  let vPrev = aggPrev[mid] ?? 0;

  const preferAvg = metrics.aggregationHints?.[mid] === "avg";
  if (!preferAvg && col) {
    const rawCur = sumMetricColumnRows(curRows, col);
    const rawPrev = sumMetricColumnRows(prevRows, col);
    if (Number.isFinite(rawCur) && Number.isFinite(rawPrev)) {
      const tol =
        1e-3 *
        Math.max(1, Math.abs(vCur), Math.abs(vPrev), Math.abs(rawCur), Math.abs(rawPrev));
      if (Math.abs(rawCur - vCur) > tol || Math.abs(rawPrev - vPrev) > tol) {
        vCur = rawCur;
        vPrev = rawPrev;
      } else if (
        vCur !== vPrev &&
        rawCur !== rawPrev &&
        Math.sign(vCur - vPrev) !== Math.sign(rawCur - rawPrev)
      ) {
        vCur = rawCur;
        vPrev = rawPrev;
      }
    }
  }

  const pct = pctChange(vCur, vPrev);
  const dirWord = vCur > vPrev ? "increased" : vCur < vPrev ? "decreased" : null;
  const negligibleMove =
    vCur === vPrev || (pct !== null && Math.abs(pct) < 0.05);

  const numericSet = new Set(metrics.numericColumns);
  const dims = prioritizeDriverDimensions(listDimensionColumns(columns, numericSet, dateCol)).slice(0, 8);

  /** @type {{ label: string, delta: number }[]} */
  let contributors = null;
  let driverNote = "";

  if (intent?.wantsWhy || intent?.tasks?.includes("driver_analysis")) {
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
        const w = worstOverall.worst;
        contributors.push({
          dimension: worstOverall.dim,
          label: w.label,
          delta: w.delta,
          role: "largest_negative_contributor",
        });
        const totalSwing = vPrev - vCur;
        const share =
          totalSwing > 0 ? Math.min(100, Math.round((Math.abs(w.delta) / totalSwing) * 1000) / 10) : null;
        driverNote =
          ` **${w.label}** (${worstOverall.dim}): **${mid}** went from **${formatVal(mid, w.previous)}** in **${cmp.label}** ` +
          `to **${formatVal(mid, w.current)}** in **${cur.label}** (delta **${formatVal(mid, w.delta)}**)` +
          (share !== null ? ` — about **${share}%** of the overall decline between periods.` : ".");
      } else if (bestOverall?.best && metricRose) {
        const b = bestOverall.best;
        contributors.push({
          dimension: bestOverall.dim,
          label: b.label,
          delta: b.delta,
          role: "largest_positive_contributor",
        });
        const totalSwing = vCur - vPrev;
        const share =
          totalSwing > 0 ? Math.min(100, Math.round((Math.abs(b.delta) / totalSwing) * 1000) / 10) : null;
        driverNote =
          ` **${b.label}** (${bestOverall.dim}): **${mid}** went from **${formatVal(mid, b.previous)}** in **${cmp.label}** ` +
          `to **${formatVal(mid, b.current)}** in **${cur.label}** (delta **${formatVal(mid, b.delta)}**)` +
          (share !== null ? ` — about **${share}%** of the overall increase between periods.` : ".");
      } else {
        driverNote =
          dims.length === 0
            ? " No categorical breakdown explains the change — there are no region/product-style columns to compare between periods."
            : " **No categorical breakdown explains the change** with the available region/product columns (segment shifts are too small or evenly mixed).";
      }
    }

    // Supporting metrics: every other numeric column in the CSV (not the primary metric)
    const support = [];
    for (const [id, phys] of Object.entries(metrics.columnMap || {})) {
      if (!phys || id === mid) continue;
      const a = aggCur[id] ?? 0;
      const b = aggPrev[id] ?? 0;
      if (a === b) continue;
      support.push(`**${phys}** moved from **${formatVal(id, b)}** to **${formatVal(id, a)}**`);
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
  const explicitCalendarWindows =
    cur.mode === "explicit_calendar_month" || cmp?.mode === "explicit_calendar_month";
  const periodNoun = explicitCalendarWindows
    ? "those calendar months"
    : "the periods compared here (from your question and the date column)";
  let clarify = "";
  if ((intent?.wantsWhy || intent?.tasks?.includes("driver_analysis")) && assumesDrop) {
    const seg =
      filterDescription && /\b(perform|worse|drop|declin|bad|weak)\b/i.test(question)
        ? `For the filtered slice (**${filterDescription}**), `
        : "";
    if (vCur > vPrev) {
      clarify = `${seg}the data does **not** show a decline — **${mid}** (**${col}**) was **higher** in **${cur.label}** than in **${cmp.label}** (actually **increased**). `;
    } else if (vCur === vPrev) {
      clarify = `${seg}**${mid}** (**${col}**) was **unchanged** between **${cmp.label}** and **${cur.label}**. `;
    }
  }

  const changePhrase =
    dirWord === null
      ? "**was unchanged**"
      : `**${dirWord}**` + (pct !== null ? ` by **${Math.abs(pct).toFixed(1)}%**` : "");

  let answer =
    (cmp.partialNote ? `${cmp.partialNote} ` : "") +
    clarify +
    `**${mid}** (${col}) ${changePhrase}` +
    ` from **${formatVal(mid, vPrev)}** in the earlier window (**${cmp.label}**, column **${col}**${prevRows.length ? `, ${prevRows.length} rows` : ""}) ` +
    `to **${formatVal(mid, vCur)}** in the later window (**${cur.label}**${curRows.length ? `, ${curRows.length} rows` : ""}).` +
    rowHint +
    driverNote;

  if (timeBundle.warnings?.length) {
    answer += ` Notes: ${timeBundle.warnings.join(" ")}`;
  }

  const colRev = metrics.columnMap.Revenue;
  const colAd = metrics.columnMap.AdSpend;
  const qLow = String(question || "").toLowerCase();
  if (
    colRev &&
    colAd &&
    prevRows.length &&
    curRows.length &&
    (/\broi\b|\broas\b|return on ad|ad spend efficiency|per\s*\$1\s*ad|cause\b|\bcutting\b.*\bspend\b/i.test(qLow) ||
      /\bspend\b.*\b(revenue|drop|declin)/i.test(qLow))
  ) {
    const rFeb = sumMetricColumnRows(curRows, colRev);
    const rJan = sumMetricColumnRows(prevRows, colRev);
    const aFeb = sumMetricColumnRows(curRows, colAd);
    const aJan = sumMetricColumnRows(prevRows, colAd);
    if (aFeb > 0 && aJan > 0) {
      const roiLater = rFeb / aFeb;
      const roiEarlier = rJan / aJan;
      answer += ` **Revenue per $1 ad spend** (**${colRev}** ÷ **${colAd}**) was **${roiEarlier.toFixed(2)}×** in **${cmp.label}** and **${roiLater.toFixed(2)}×** in **${cur.label}**.`;
    }
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

function wantsCrossDimensionBreakdown(question) {
  const l = String(question || "").toLowerCase();
  if (!/\band\b/.test(l)) return false;
  if (/\bcombination|combinations|cross|every\s+combination\b/i.test(l)) return true;
  return /\bregion\b/.test(l) && /\bproduct\b/.test(l);
}

function trySuperlativeTimePeriod(ctx) {
  const { question, rows, columns, metrics, dateCol } = ctx;
  const lower = question.toLowerCase();
  const neg = /\b(worst|lowest|least|minimum|poorest|bottom|weakest)\b/i.test(lower);
  const pos = /\b(best|highest|most|maximum|top|strongest)\b/i.test(lower);
  if (!neg && !pos) return null;
  if (!/\b(month|months)\b/i.test(lower)) return null;
  const monthTok =
    lower.match(
      /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/g
    ) || [];
  if (monthTok.length >= 2 && /\b(between|vs\.?|versus)\b/.test(lower)) return null;

  const temporal = dateCol || detectTemporalColumn(columns);
  const mid = metrics.primaryMetricId;
  const col = (mid && metrics.columnMap[mid]) || metrics.primaryColumn;
  if (!temporal || !col || !mid) return null;

  const buckets = groupByTime(rows, temporal, [col], "sum");
  if (buckets.length < 2) return null;

  let pick = 0;
  for (let i = 1; i < buckets.length; i++) {
    const vi = buckets[i][col] || 0;
    const vb = buckets[pick][col] || 0;
    if (neg && vi < vb) pick = i;
    if (pos && vi > vb) pick = i;
  }
  const sel = buckets[pick];
  const prev = pick > 0 ? buckets[pick - 1] : null;
  const nextB = pick < buckets.length - 1 ? buckets[pick + 1] : null;
  const lbl = neg ? "worst" : "best";
  let answer = `**${sel.label}** was the **${lbl}** month on **${col}** (**${mid}**) at **${formatVal(mid, sel[col] || 0)}**`;
  const seg = [];
  if (prev) {
    const p = pctChange(sel[col] || 0, prev[col] || 0);
    if (p !== null) {
      seg.push(
        `**${prev.label}** → **${sel.label}**: **${p >= 0 ? "+" : ""}${p.toFixed(1)}%** (from **${formatVal(
          mid,
          prev[col] || 0
        )}**)`
      );
    }
  }
  if (nextB) {
    const p2 = pctChange(nextB[col] || 0, sel[col] || 0);
    if (p2 !== null) {
      seg.push(
        `**${sel.label}** → **${nextB.label}**: **${p2 >= 0 ? "+" : ""}${p2.toFixed(1)}%** (to **${formatVal(
          mid,
          nextB[col] || 0
        )}**)`
      );
    }
  }
  if (seg.length) answer += `. Period transitions: ${seg.join("; ")}.`;

  return buildRichBase({
    answer,
    resolvedMetric: mid,
    resolvedDimensions: [temporal],
    chartData: {
      labels: buckets.map((b) => b.label),
      values: buckets.map((b) => b[col] || 0),
      type: "line",
    },
    evidence: { buckets },
  });
}

function tryFullMonthlyAllMetrics(ctx) {
  const { question, rows, columns, metrics, dateCol, intent } = ctx;
  const lower = (intent?.rawQuestion || question || "").toLowerCase();
  if (!/\bmonth|\bmonthly\b/i.test(lower)) return null;
  if (
    !/\b(all|every|full)\s+metrics?\b/i.test(lower) &&
    !/\bnot\s+just\s+(revenue|orders)\b/i.test(lower) &&
    !/\bacross\s+all\s+metrics?\b/i.test(lower)
  ) {
    return null;
  }
  const temporal = dateCol || detectTemporalColumn(columns);
  const nums = (metrics.numericColumns || []).filter(Boolean);
  if (!temporal || nums.length === 0) return null;

  const buckets = groupByTime(rows, temporal, nums, "sum");
  if (buckets.length === 0) return null;

  const header = ["Month", ...nums];
  const lines = [header.join(" | ")];
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    const prev = i > 0 ? buckets[i - 1] : null;
    const cells = [b.label];
    for (const n of nums) {
      const v = b[n] ?? 0;
      let cell = Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 });
      if (prev) {
        const pv = prev[n] ?? 0;
        const ch = pv === 0 ? null : ((v - pv) / Math.abs(pv)) * 100;
        cell += ch !== null ? ` (${ch >= 0 ? "+" : ""}${ch.toFixed(1)}% MoM)` : "";
      }
      cells.push(cell);
    }
    lines.push(cells.join(" | "));
  }
  const answer =
    `Monthly totals for all numeric columns, with MoM % change per column:\n\n` + lines.join("\n");

  return buildRichBase({
    answer,
    resolvedMetric: metrics.primaryMetricId,
    resolvedDimensions: [temporal, ...nums],
    evidence: { buckets },
  });
}

function tryCrossDimensionBreakdown(ctx) {
  const { question, rows, columns, metrics, dateCol, intent } = ctx;
  if (intent?.wantsWhy || intent?.tasks?.includes("driver_analysis")) return null;
  if (!wantsCrossDimensionBreakdown(question)) return null;
  if (!intent.isBreakdownQuestion && !/\bbreakdown\b|\bcomposition\b|\bshare\b|\brevenue\b/i.test(question)) {
    return null;
  }

  const d1 = findColumnForAliases(columns, DIMENSION_ALIASES.Region);
  const d2 = findColumnForAliases(columns, DIMENSION_ALIASES.Product);
  if (!d1 || !d2) return null;

  const mid = metrics.primaryMetricId;
  const vcol = (mid && metrics.columnMap[mid]) || metrics.primaryColumn;
  if (!mid || !vcol) return null;

  const map = new Map();
  for (const row of rows) {
    const a = String(row[d1] ?? "").trim();
    const b = String(row[d2] ?? "").trim();
    if (!a || !b) continue;
    const k = `${a} + ${b}`;
    const n = parseNumber(row[vcol]);
    if (n === null) continue;
    map.set(k, (map.get(k) || 0) + n);
  }
  const entries = [...map.entries()].map(([label, sum]) => ({ label, sum }));
  if (!entries.length) return null;
  entries.sort((x, y) => y.sum - x.sum);
  const total = entries.reduce((s, e) => s + e.sum, 0);
  const parts = entries.map((e) => {
    const pct = total === 0 ? 0 : ((e.sum / total) * 100).toFixed(1);
    return `**${e.label}**: **${formatVal(mid, e.sum)}** (${pct}%)`;
  });

  const answer = `**${mid}** (**${vcol}**) by **${d1}** and **${d2}**: ${parts.join("; ")}.`;

  return buildRichBase({
    answer,
    resolvedMetric: mid,
    resolvedDimensions: [d1, d2],
    chartData: {
      labels: entries.map((e) => e.label),
      values: entries.map((e) => e.sum),
      type: "bar",
    },
    evidence: { entries, total },
  });
}

function tryDerivedMetricByGroup(ctx) {
  const { question, rows, columns, metrics, dateCol } = ctx;
  const lower = question.toLowerCase();
  let mode = null;
  if (/\brevenue\s*per\s*order|revenue-per-order|average order value|\baov\b/i.test(lower)) mode = "rpo";
  else if (/\borders\s*per\s*customer\b/i.test(lower)) mode = "opc";
  else if (/\brevenue\s*per\s*customer\b/i.test(lower)) mode = "rpc";
  else if (
    /\bper\s+dollar\s+spent|ad\s*spend\s*efficiency|\broi\b|\broas\b|return on ad|revenue\s*\/\s*ad/i.test(lower)
  ) {
    mode = "roi";
  }
  if (!mode) return null;

  const rev = metrics.columnMap.Revenue;
  const ord = metrics.columnMap.Orders;
  const ads = metrics.columnMap.AdSpend;
  const cust = metrics.columnMap.Customers;
  if (mode === "rpo" && (!rev || !ord)) return null;
  if (mode === "opc" && (!ord || !cust)) return null;
  if (mode === "rpc" && (!rev || !cust)) return null;
  if (mode === "roi" && (!rev || !ads)) return null;

  const numericSet = new Set(metrics.numericColumns);
  let dim = resolveDimensionColumn(question, columns, numericSet, dateCol);
  if (!dim) {
    const alt = findColumnForAliases(columns, DIMENSION_ALIASES.Region);
    if (alt) dim = alt;
  }

  const computeRatio = (subrows) => {
    if (mode === "opc") {
      let o = 0;
      let c = 0;
      for (const r of subrows) {
        o += parseNumber(r[ord]) || 0;
        c += parseNumber(r[cust]) || 0;
      }
      return c === 0 ? null : o / c;
    }
    let a = 0;
    let b = 0;
    for (const r of subrows) {
      if (mode === "rpo" || mode === "roi") {
        a += parseNumber(r[rev]) || 0;
        b += mode === "rpo" ? parseNumber(r[ord]) || 0 : parseNumber(r[ads]) || 0;
      } else if (mode === "rpc") {
        a += parseNumber(r[rev]) || 0;
        b += parseNumber(r[cust]) || 0;
      }
    }
    return b === 0 ? null : a / b;
  };

  let parts = [];
  if (dim) {
    const groups = new Map();
    for (const row of rows) {
      const g = String(row[dim] ?? "").trim() || "(blank)";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(row);
    }
    for (const [g, sub] of groups) {
      const ratio = computeRatio(sub);
      if (ratio === null) continue;
      if (mode === "rpo") parts.push(`**${g}**: **$${ratio.toFixed(2)} per order**`);
      else if (mode === "rpc") parts.push(`**${g}**: **$${ratio.toFixed(2)} revenue per customer**`);
      else if (mode === "opc") parts.push(`**${g}**: **${ratio.toFixed(2)} orders per customer**`);
      else if (mode === "roi") parts.push(`**${g}**: **${ratio.toFixed(2)}×** revenue per $1 **${ads}**`);
    }
  } else {
    const ratio = computeRatio(rows);
    if (ratio === null) return null;
    if (mode === "rpo") parts.push(`**Overall**: **$${ratio.toFixed(2)} per order**`);
    else if (mode === "roi") parts.push(`**Overall**: **${ratio.toFixed(2)}×** revenue per $1 **${ads}**`);
    else return null;
  }

  if (!parts.length) return null;
  const label =
    mode === "rpo"
      ? "Revenue per order"
      : mode === "rpc"
        ? "Revenue per customer"
        : mode === "opc"
          ? "Orders per customer"
          : "Revenue / ad spend (ROI-style)";
  const answer = `${label} by **${dim || "dataset"}**: ${parts.join("; ")}.`;

  return buildRichBase({
    answer,
    resolvedMetric: metrics.primaryMetricId,
    resolvedDimensions: dim ? [dim] : [],
    evidence: { mode },
  });
}

function tryBestTwoDimCombo(ctx) {
  const { question, rows, columns, metrics, dateCol, intent } = ctx;
  const lower = question.toLowerCase();
  if (intent?.wantsWhy || intent?.tasks?.includes("driver_analysis")) return null;
  if (!/\b(which|what)\b/i.test(lower)) return null;
  if (!/\b(combination|combo|and)\b/i.test(lower)) return null;
  if (!/\b(most|highest|best|drives?|leading|top|least|lowest|worst)\b/i.test(lower)) return null;

  const d1 = findColumnForAliases(columns, DIMENSION_ALIASES.Region);
  const d2 = findColumnForAliases(columns, DIMENSION_ALIASES.Product);
  if (!d1 || !d2) return null;

  const mid = metrics.primaryMetricId;
  const vcol = (mid && metrics.columnMap[mid]) || metrics.primaryColumn;
  if (!mid || !vcol) return null;

  const map = new Map();
  for (const row of rows) {
    const a = String(row[d1] ?? "").trim();
    const b = String(row[d2] ?? "").trim();
    if (!a || !b) continue;
    const k = `${a} + ${b}`;
    const n = parseNumber(row[vcol]);
    if (n === null) continue;
    map.set(k, (map.get(k) || 0) + n);
  }
  const entries = [...map.entries()].map(([label, sum]) => ({ label, sum }));
  if (!entries.length) return null;

  const neg = /\b(least|lowest|worst|minimum|bottom)\b/i.test(lower);
  entries.sort((x, y) => (neg ? x.sum - y.sum : y.sum - x.sum));
  const top = entries[0];
  const answer = `Aggregated across all rows, **${top.label}** has the **${neg ? "lowest" : "highest"}** **${mid}** (**${vcol}**) at **${formatVal(
    mid,
    top.sum
  )}** (sum of **${vcol}** per **${d1}**/**${d2}** pair).`;

  return buildRichBase({
    answer,
    resolvedMetric: mid,
    resolvedDimensions: [d1, d2],
    chartData: {
      labels: entries.slice(0, 12).map((e) => e.label),
      values: entries.slice(0, 12).map((e) => e.sum),
      type: "bar",
    },
    evidence: { entries },
  });
}

function tryBreakdown(question, rows, columns, metrics, dateCol, intent) {
  if (intent?.wantsWhy || intent?.tasks?.includes("driver_analysis")) return null;
  if (wantsCrossDimensionBreakdown(question)) return null;
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
  const lower = (intent?.rawQuestion || "").toLowerCase();
  const wantsAnomaly = intent?.tasks?.includes("anomaly");
  const wantsTrend = intent?.tasks?.includes("trend");
  if (!wantsAnomaly && !wantsTrend) return null;

  const temporal = dateCol || detectTemporalColumn(columns);
  const col = metrics.columnMap[metrics.primaryMetricId] || metrics.primaryColumn;
  const numericSet = new Set(getNumericColumns(rows, columns));
  const structural = findPerfectCategoricalCorrelations(rows, columns, numericSet);
  const structuralNote = structural.length
    ? structural
        .map(
          (p) =>
            `**${p.colA}** and **${p.colB}** look **perfectly correlated** in this upload (each value of one maps to exactly one value of the other) — they may represent the same business dimension.`
        )
        .join(" ")
    : "";

  if (!temporal || !col) {
    if (!structuralNote) return null;
    return buildRichBase({
      answer: `Structural note: ${structuralNote}`,
      evidence: { structural },
    });
  }

  const buckets = groupByTime(rows, temporal, [col], "sum");
  if (buckets.length < 2) {
    if (!structuralNote) return null;
    return buildRichBase({
      answer: `Structural note: ${structuralNote}`,
      evidence: { structural },
    });
  }

  const transitions = [];
  let allUp = true;
  let allDown = true;
  for (let i = 1; i < buckets.length; i++) {
    const a = buckets[i - 1][col] || 0;
    const b = buckets[i][col] || 0;
    const p = pctChange(b, a);
    if (p === null) continue;
    transitions.push(`**${buckets[i - 1].label}** → **${buckets[i].label}**: **${p >= 0 ? "+" : ""}${p.toFixed(1)}%**`);
    if (p <= 0) allUp = false;
    if (p >= 0) allDown = false;
  }

  let trendSentence = "";
  if (transitions.length) {
    if (allUp) trendSentence = `**${col}** rises every period (${transitions.join("; ")}).`;
    else if (allDown) trendSentence = `**${col}** falls every period (${transitions.join("; ")}).`;
    else trendSentence = `Period-to-period **${col}** changes: ${transitions.join("; ")}.`;
  }

  const vals = buckets.map((b) => b[col] || 0);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const std = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length) || 1;
  const last = vals[vals.length - 1];
  const z = std > 0 ? (last - mean) / std : 0;
  let tail = "";
  if (buckets.length >= 4 && Math.abs(z) >= 2) {
    tail = ` The latest bucket is about **${z.toFixed(2)}** σ from the mean of all buckets in this series.`;
  }

  const answer = [trendSentence, structuralNote, tail].filter(Boolean).join(" ");

  return buildRichBase({
    answer: answer || "Not enough structure to summarize anomalies for this question.",
    warnings: structural.length ? ["Perfect correlation is a data-shape observation, not causality."] : [],
    evidence: { z, mean, std, last, structural, transitions },
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
    trySuperlativeTimePeriod(ctx) ||
    tryFullMonthlyAllMetrics(ctx) ||
    tryCrossDimensionBreakdown(ctx) ||
    tryDerivedMetricByGroup(ctx) ||
    tryBestTwoDimCombo(ctx) ||
    tryGroupedDimensionComparison(ctx.question, rows, columns, metrics, dateCol, intent) ||
    tryProductMomGrowth(ctx) ||
    tryWhichDimensionBest(ctx.question, rows, columns, metrics, dateCol, intent) ||
    tryEntityCompare(ctx.question, rows, columns, metrics, dateCol, intent) ||
    tryCorrelation(ctx.question, rows, columns, metrics, intent) ||
    trySummary(intent, rows, columns, metrics, dateCol) ||
    tryAnomaly(intent, rows, columns, metrics, dateCol) ||
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
