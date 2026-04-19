/**
 * Representative pipeline tests: filters, metrics, time windows, deterministic analytics.
 */

const { groupByTime, inferDatasetTemporalGranularity } = require("../src/utils/datasetAnalysis");
const { resolveFilters } = require("../src/services/filterResolver");
const { resolveMetrics } = require("../src/services/metricResolver");
const { resolveComparisonWindows, referenceSortKeyFromData } = require("../src/services/timeResolver");
const { parseIntent } = require("../src/services/intentParser");
const {
  runDeterministicPipeline,
  tryGroupedDimensionComparison,
} = require("../src/services/deterministicAnalytics");
const { breakdownAnalysis, comparisonAnalysis, detectIntent } = require("../src/services/queryAnalysis");
const { tryRuleBasedAnswer } = require("../src/services/ruleBasedQuery");
const { isRelativeTimeEntityPair } = require("../src/services/intentParser");

describe("metricResolver", () => {
  it("maps revenue and sales synonyms to the same column consistently", () => {
    const columns = ["Region", "net_sales", "cost"];
    const rows = [
      { Region: "A", net_sales: 10, cost: 2 },
      { Region: "B", net_sales: 20, cost: 3 },
    ];
    const m1 = resolveMetrics({ question: "total revenue by region", columns, rows });
    const m2 = resolveMetrics({ question: "sum of sales", columns, rows });
    expect(m1.primaryColumn).toBe("net_sales");
    expect(m2.primaryColumn).toBe("net_sales");
    expect(m1.primaryMetricId).toBe("Revenue");
  });

  it("does not substitute another metric when the user names profit but no profit column exists", () => {
    const columns = ["month", "revenue"];
    const rows = [
      { month: "2024-01-01", revenue: 10 },
      { month: "2024-02-01", revenue: 20 },
    ];
    const m = resolveMetrics({ question: "Why did profit drop last month?", columns, rows });
    expect(m.missingRequestedMetricId).toBe("Profit");
    expect(m.primaryColumn).toBeNull();
  });

  it("binds profit to a profit column when present", () => {
    const columns = ["Region", "net_profit", "revenue"];
    const rows = [
      { Region: "A", net_profit: 5, revenue: 10 },
      { Region: "B", net_profit: 8, revenue: 20 },
    ];
    const m = resolveMetrics({ question: "total profit by region", columns, rows });
    expect(m.primaryMetricId).toBe("Profit");
    expect(m.primaryColumn).toBe("net_profit");
  });
});

describe("filterResolver", () => {
  it("matches multi-word category values as substrings", () => {
    const rows = [
      { Region: "South Region", Product: "X", revenue: 1 },
      { Region: "North", Product: "Y", revenue: 2 },
      { Region: "South Region", Product: "Z", revenue: 3 },
      { Region: "North", Product: "W", revenue: 4 },
    ];
    const r = resolveFilters({
      question: 'Show revenue for South Region',
      rows,
      columns: ["Region", "Product", "revenue"],
      numericColumns: ["revenue"],
    });
    expect(r.filteredRows).toHaveLength(2);
    expect(r.filteredRows.every((x) => x.Region === "South Region")).toBe(true);
  });

  it("respects quoted filter literals", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      Dept: i % 3 === 0 ? "Customer Success" : i % 3 === 1 ? "Sales" : "Marketing",
      amt: i + 1,
    }));
    const r = resolveFilters({
      question: 'costs for "Customer Success"',
      rows,
      columns: ["Dept", "amt"],
      numericColumns: ["amt"],
    });
    expect(r.filteredRows.length).toBeGreaterThanOrEqual(1);
    expect(r.filteredRows.every((x) => x.Dept === "Customer Success")).toBe(true);
  });
});

describe("timeResolver + driver window", () => {
  it("refuses week-over-week when the series is monthly only", () => {
    const rows = [
      { order_date: "2024-01-01", revenue: 10 },
      { order_date: "2024-02-01", revenue: 20 },
    ];
    const bundle = resolveComparisonWindows("This week vs last week on revenue", rows, "order_date", parseIntent("x"));
    expect(bundle.weekUnsupportedOnMonthlyData).toBe(true);
    expect(bundle.warnings.some((w) => /monthly/i.test(w))).toBe(true);
  });

  it("resolves this year vs last year from distinct years in the dataset", () => {
    const rows = [
      { d: "2000-01-01", v: 10 },
      { d: "2001-12-01", v: 20 },
    ];
    const bundle = resolveComparisonWindows("this year vs last year", rows, "d", parseIntent("x"));
    expect(bundle.resolvedTimeRange?.label).toBe("2001");
    expect(bundle.comparison?.label).toBe("2000");
    expect(bundle.resolvedTimeRange?.start).toBeTruthy();
  });

  it('pairs "last month" with prior month when question asks why / change', () => {
    const rows = [
      { order_date: "2023-12-05", revenue: 90 },
      { order_date: "2024-01-10", revenue: 100 },
      { order_date: "2024-02-10", revenue: 80 },
    ];
    const intent = parseIntent("Why did revenue drop last month?");
    const bundle = resolveComparisonWindows("Why did revenue drop last month?", rows, "order_date", intent);
    expect(bundle.comparison).toBeTruthy();
    expect(bundle.resolvedTimeRange.grain).toBe("month");
    expect(bundle.comparison.grain).toBe("month");
    expect(bundle.resolvedTimeRange.start).toBeGreaterThan(0);
    expect(bundle.resolvedTimeRange.end).toBeGreaterThanOrEqual(bundle.resolvedTimeRange.start);
    expect(bundle.comparison.start).toBeGreaterThan(0);
    expect(bundle.comparison.end).toBeGreaterThanOrEqual(bundle.comparison.start);
  });

  it("explicit named month + why uses prior calendar month as comparison (not dataset-latest only)", () => {
    const rows = [
      { order_date: "2024-01-05", revenue: 100 },
      { order_date: "2024-02-05", revenue: 50 },
    ];
    const intent = parseIntent("Why did revenue drop in February?");
    const bundle = resolveComparisonWindows("Why did revenue drop in February?", rows, "order_date", intent);
    expect(bundle.comparison).toBeTruthy();
    expect(bundle.resolvedTimeRange.label).toMatch(/February/i);
    expect(bundle.comparison.label).toMatch(/January/i);
    expect(bundle.resolvedTimeRange.start).toBeGreaterThan(bundle.comparison.start);
  });

  it("parses YYYY-MM as a single explicit calendar month", () => {
    const rows = [{ order_date: "2024-02-01", revenue: 10 }];
    const bundle = resolveComparisonWindows("total revenue in 2024-02", rows, "order_date", parseIntent("x"));
    expect(bundle.resolvedTimeRange?.label).toMatch(/2024|February|Feb/i);
    expect(bundle.comparison).toBeFalsy();
  });
});

describe("groupByTime (year-month buckets)", () => {
  it("collapses duplicate calendar-month names across years into 12 buckets (month-name labels)", () => {
    const monthNames = [
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
    const rows = [];
    for (let y = 0; y < 2; y++) {
      for (const m of monthNames) {
        rows.push({ period: m, revenue: 100 + rows.length });
      }
    }
    const buckets = groupByTime(rows, "period", ["revenue"], "sum");
    expect(buckets.length).toBe(12);
    expect(buckets[0].label).toBe("January");
    expect(buckets[11].label).toBe("December");
  });

  it("labels ISO date months as Mon YYYY (chronological key)", () => {
    const rows = [
      { d: "2023-01-01", v: 1 },
      { d: "2024-01-01", v: 2 },
    ];
    const buckets = groupByTime(rows, "d", ["v"], "sum");
    expect(buckets.map((b) => b.label)).toEqual(["Jan 2023", "Jan 2024"]);
  });

  it("day grain buckets by YYYY-MM-DD without collapsing same month", () => {
    const rows = [
      { d: "2024-01-05", v: 1 },
      { d: "2024-01-20", v: 2 },
    ];
    const buckets = groupByTime(rows, "d", ["v"], "sum", "day");
    expect(buckets.length).toBe(2);
    expect(buckets[0].label).toBe("2024-01-05");
    expect(buckets[1].label).toBe("2024-01-20");
  });
});

describe("inferDatasetTemporalGranularity", () => {
  it("flags monthly aggregates so week-over-week can be refused", () => {
    const rows = [
      { order_date: "2024-01-01", x: 1 },
      { order_date: "2024-02-01", x: 2 },
    ];
    expect(inferDatasetTemporalGranularity(rows, "order_date").grain).toBe("month");
  });
});

describe("referenceSortKeyFromData", () => {
  it("uses the latest dataset date, not the system clock", () => {
    const rows = [{ d: "2022-06-15", v: 1 }];
    const ref = referenceSortKeyFromData(rows, "d");
    expect(ref).toBe(20220615);
  });
});

describe("intent and comparison routing", () => {
  it("flags this month vs last month as time phrasing, not entity A vs B", () => {
    expect(isRelativeTimeEntityPair({ a: "this month", b: "last month" })).toBe(true);
  });

  it("classifies revenue across regions as comparison intent", () => {
    expect(detectIntent("Compare revenue across regions").type).toBe("comparison");
    expect(detectIntent("revenue across regions").type).toBe("comparison");
  });

  it("defers this month vs last month out of pairwise entity comparison", () => {
    const rows = [
      { order_date: "2024-01-01", revenue: 10 },
      { order_date: "2024-02-01", revenue: 30 },
    ];
    const columns = ["order_date", "revenue"];
    const metrics = resolveMetrics({ question: "this month vs last month", columns, rows });
    const out = comparisonAnalysis({
      question: "this month vs last month revenue",
      rows,
      columns,
      metrics,
      dateCol: "order_date",
    });
    expect(out).toBeNull();
  });
});

describe("deterministicAnalytics", () => {
  it("compares metric across regions when asked", () => {
    const rows = [
      { Region: "East", revenue: 100 },
      { Region: "West", revenue: 60 },
    ];
    const columns = ["Region", "revenue"];
    const metrics = resolveMetrics({ question: "Compare revenue across regions", columns, rows });
    const out = tryGroupedDimensionComparison("Compare revenue across regions", rows, columns, metrics, null, {});
    expect(out).toBeTruthy();
    expect(out.answer).toMatch(/East/);
    expect(out.answer).toMatch(/Region/);
  });

  it("does not return grouped comparison for WHY / driver questions (avoid totals-only breakdown)", () => {
    const rows = [
      { Region: "East", revenue: 100 },
      { Region: "West", revenue: 60 },
    ];
    const columns = ["Region", "revenue"];
    const metrics = resolveMetrics({ question: "Why compare revenue across regions?", columns, rows });
    const intent = parseIntent("Why compare revenue across regions?");
    const out = tryGroupedDimensionComparison(
      "Why compare revenue across regions?",
      rows,
      columns,
      metrics,
      null,
      intent
    );
    expect(out).toBeNull();
  });

  it("routes monthly analysis through summary logic (latest vs prior period)", () => {
    const rows = [
      { order_date: "2024-01-01", revenue: 100 },
      { order_date: "2024-02-01", revenue: 130 },
    ];
    const columns = ["order_date", "revenue"];
    const intent = parseIntent("Give me a monthly analysis");
    const metrics = resolveMetrics({ question: intent.rawQuestion, columns, rows });
    const out = runDeterministicPipeline({
      question: intent.rawQuestion,
      rows,
      columns,
      intent,
      metrics,
      dateCol: "order_date",
      timeBundle: resolveComparisonWindows(intent.rawQuestion, rows, "order_date", intent),
      filterDescription: "",
    });
    expect(out).toBeTruthy();
    expect(out.answer.toLowerCase()).toMatch(/recent|most recent|prior/);
  });

  it("does not let breakdown swallow explicit top-N phrasing", () => {
    const rows = [
      { product: "A", revenue: 30 },
      { product: "B", revenue: 80 },
      { product: "C", revenue: 50 },
      { product: "D", revenue: 10 },
    ];
    const columns = ["product", "revenue"];
    const intent = parseIntent("Top 3 products by revenue");
    const metrics = resolveMetrics({ question: intent.rawQuestion, columns, rows });
    const out = runDeterministicPipeline({
      question: intent.rawQuestion,
      rows,
      columns,
      intent,
      metrics,
      dateCol: null,
      timeBundle: {},
      filterDescription: "",
    });
    expect(out).toBeNull();
  });

  it("compares latest two periods for why-questions with bounded date windows", () => {
    const rows = [
      { order_date: "2024-01-01", revenue: 100, region: "East" },
      { order_date: "2024-02-01", revenue: 50, region: "East" },
    ];
    const columns = ["order_date", "revenue", "region"];
    const question = "Why did revenue drop last month?";
    const intent = parseIntent(question);
    const metrics = resolveMetrics({ question, columns, rows });
    const timeBundle = resolveComparisonWindows(question, rows, "order_date", intent);
    const out = runDeterministicPipeline({
      question,
      rows,
      columns,
      intent,
      metrics,
      dateCol: "order_date",
      timeBundle,
      filterDescription: "",
    });
    expect(out).toBeTruthy();
    expect(out.answer).toMatch(/decreased|drop/i);
  });

  it("profit count uses the resolved profit column, not schema listing", () => {
    const rows = [
      { id: 1, gross_profit: 10 },
      { id: 2, gross_profit: null },
    ];
    const columns = ["id", "gross_profit"];
    const metrics = resolveMetrics({ question: "profit count", columns, rows });
    const ruled = tryRuleBasedAnswer({
      question: "profit count",
      rows,
      columns,
      metricHint: metrics.primaryColumn,
      dateCol: null,
      metrics,
    });
    expect(ruled).toBeTruthy();
    expect(ruled.answer).toMatch(/gross_profit/);
    expect(ruled.answer).toMatch(/\*\*2\*\* rows/);
  });

  it("rule engine returns exactly N groups for top-N when possible", () => {
    const rows = [
      { product: "A", revenue: 30 },
      { product: "B", revenue: 80 },
      { product: "C", revenue: 50 },
      { product: "D", revenue: 10 },
    ];
    const columns = ["product", "revenue"];
    const metrics = resolveMetrics({ question: "Top 3 products by revenue", columns, rows });
    const ruled = tryRuleBasedAnswer({
      question: "Top 3 products by revenue",
      rows,
      columns,
      metricHint: metrics.primaryColumn,
      dateCol: null,
      metrics,
    });
    expect(ruled).toBeTruthy();
    expect(ruled.chartData.labels).toHaveLength(3);
  });

  it("category breakdown states missing category and names fallback dimension", () => {
    const rows = [
      { product: "P1", revenue: 10 },
      { product: "P2", revenue: 20 },
    ];
    const columns = ["product", "revenue"];
    const metrics = resolveMetrics({ question: "Break down revenue by category", columns, rows });
    const out = breakdownAnalysis({
      question: "Break down revenue by category",
      rows,
      columns,
      metrics,
    });
    expect(out).toBeTruthy();
    expect(out.answer.toLowerCase()).toMatch(/category is not present/);
    expect(out.answer).toMatch(/product/i);
  });

  it("computes Pearson correlation without claiming causation in copy (association wording)", () => {
    const rows = [];
    for (let i = 0; i < 20; i++) {
      rows.push({ ad_spend: i * 10, revenue: i * 50 + (i % 3) });
    }
    const columns = ["ad_spend", "revenue"];
    const intent = parseIntent("Does ad spend correlate with revenue?");
    const metrics = resolveMetrics({ question: intent.rawQuestion, columns, rows });
    const out = runDeterministicPipeline({
      question: intent.rawQuestion,
      rows,
      columns,
      intent,
      metrics,
      dateCol: null,
      timeBundle: {},
      filterDescription: "",
    });
    expect(out).toBeTruthy();
    const a = out.answer.toLowerCase();
    expect(a).toMatch(/association|correlation/);
    expect(a).toMatch(/not.*causation|does not prove/);
  });
});
