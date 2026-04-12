import { useEffect, useRef, useState } from "react";
import Chart from "chart.js/auto";

/**
 * Curated 8-color palette — indigo → violet → cyan → green → amber → orange
 * No random colors. Max 8 colors, cycling if more data points.
 */
const PALETTE = [
  "#6366f1", // indigo
  "#7c3aed", // violet-dark
  "#8b5cf6", // violet
  "#a78bfa", // violet-light
  "#06b6d4", // cyan
  "#22c55e", // green
  "#eab308", // amber
  "#f97316", // orange
];

const PALETTE_HOVER = PALETTE.map((c) => c + "cc");

function buildChart(canvas, chartData, type) {
  const n = chartData.labels.length;

  const stroke   = "#6366f1";
  const barFill  = "rgba(99,102,241,0.58)";
  const lineFill = "rgba(99,102,241,0.12)";

  const colors      = Array.from({ length: n }, (_, i) => PALETTE[i % PALETTE.length]);
  const colorsHover = Array.from({ length: n }, (_, i) => PALETTE_HOVER[i % PALETTE_HOVER.length]);

  const valueAxis = chartData.valueAxisLabel || "Value";
  const categoryAxis = chartData.categoryAxisLabel || "Category";

  const dataset = {
    label: chartData.title || valueAxis,
    data: chartData.values.map((v) => Number(v)),

    backgroundColor:
      type === "doughnut" || type === "pie" ? colors
      : type === "line"                     ? lineFill
      :                                       barFill,

    hoverBackgroundColor:
      type === "doughnut" || type === "pie" ? colorsHover : undefined,

    borderColor:
      type === "doughnut" || type === "pie"
        ? colors.map(() => "#09090f")
        : stroke,

    borderWidth:
      type === "doughnut" ? 3
      : type === "pie"    ? 2
      : type === "line"   ? 2
      :                     0,

    borderRadius:  type === "bar" ? 6 : 0,
    borderSkipped: false,

    // Donut inner radius — 50% gives clean donut look
    ...(type === "doughnut" ? { cutout: "50%" } : {}),

    // Line specifics
    tension: 0.42,
    fill: type === "line",
    pointBackgroundColor: stroke,
    pointBorderColor: "#09090f",
    pointBorderWidth: 2,
    pointRadius: type === "line" ? 4 : 0,
    pointHoverRadius: type === "line" ? 6 : 0,
  };

  return new Chart(canvas, {
    type: type === "doughnut" ? "doughnut" : type,
    data: { labels: chartData.labels, datasets: [dataset] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 500, easing: "easeOutQuart" },
      plugins: {
        legend: {
          display: true,
          position: "bottom",
          labels: {
            color: "#9494aa",
            font: { size: 11.5, family: "'DM Sans', sans-serif" },
            padding: 14,
            usePointStyle: true,
            pointStyleWidth: 9,
            boxHeight: 8,
          },
        },
        tooltip: {
          backgroundColor: "#121220",
          borderColor: "#26263c",
          borderWidth: 1,
          titleColor: "#e8e8f0",
          bodyColor: "#9494aa",
          padding: 11,
          cornerRadius: 9,
          callbacks: {
            label: (ctx) => {
              const raw = ctx.parsed.y ?? ctx.parsed;
              const val = typeof raw === "number"
                ? raw.toLocaleString(undefined, { maximumFractionDigits: 2 })
                : raw;
              return `  ${ctx.label ?? ctx.dataset.label}: ${val}`;
            },
          },
        },
      },
      scales:
        type === "pie" || type === "doughnut"
          ? {}
          : {
              x: {
                title: {
                  display: Boolean(categoryAxis),
                  text: categoryAxis,
                  color: "#6b6b80",
                  font: { size: 11, weight: "600" },
                },
                ticks: { color: "#4e4e66", maxRotation: 0, autoSkip: true, font: { size: 11 } },
                grid: { color: "rgba(38,38,60,0.7)", drawBorder: false },
                border: { color: "transparent" },
              },
              y: {
                beginAtZero: true,
                title: {
                  display: Boolean(valueAxis),
                  text: valueAxis,
                  color: "#6b6b80",
                  font: { size: 11, weight: "600" },
                },
                ticks: {
                  color: "#4e4e66",
                  font: { size: 11 },
                  callback: (v) =>
                    v >= 1000
                      ? v.toLocaleString(undefined, { notation: "compact" })
                      : v,
                },
                grid: { color: "rgba(38,38,60,0.7)", drawBorder: false },
                border: { color: "transparent" },
              },
            },
    },
  });
}

function ChartCanvas({ chartData, chartType, height = "220px", className = "chartCanvas" }) {
  const canvasRef = useRef(null);
  const chartRef  = useRef(null);

  useEffect(() => {
    if (!chartData?.labels?.length || !chartData?.values?.length || !canvasRef.current) return;
    if (chartData.labels.length !== chartData.values.length) return;

    chartRef.current?.destroy();
    chartRef.current = buildChart(canvasRef.current, chartData, chartType);

    return () => { chartRef.current?.destroy(); chartRef.current = null; };
  }, [chartData, chartType]);

  return (
    <div className={className} style={{ height }}>
      <canvas ref={canvasRef} />
    </div>
  );
}

const TYPE_LABELS = {
  bar:      "▐ Bar",
  line:     "∿ Line",
  doughnut: "◎ Donut",
};

export default function InsightChart({ chartData, title }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [chartType, setChartType] = useState("bar");

  const hasData =
    chartData?.labels?.length > 0 &&
    chartData?.values?.length > 0 &&
    chartData.labels.length === chartData.values.length;

  // Honour server-side type hint; map "pie" → "doughnut" for better look
  useEffect(() => {
    if (!chartData?.type) return;
    setChartType(chartData.type === "pie" ? "doughnut" : chartData.type);
  }, [chartData]);

  // Close modal on Escape
  useEffect(() => {
    if (!modalOpen) return;
    const fn = (e) => { if (e.key === "Escape") setModalOpen(false); };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [modalOpen]);

  if (!hasData) return null;

  const displayTitle = title || chartData?.title || "Chart";

  return (
    <div className="chartWrap">
      {/* Controls */}
      <div className="chartControls">
        <div className="chartToggle">
          {Object.keys(TYPE_LABELS).map((t) => (
            <button
              key={t}
              className={`chartToggleBtn${chartType === t ? " active" : ""}`}
              onClick={() => setChartType(t)}
            >
              {TYPE_LABELS[t]}
            </button>
          ))}
        </div>
        <button className="chartExpand" onClick={() => setModalOpen(true)} title="Expand">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
            <line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
          </svg>
          Expand
        </button>
      </div>

      {/* Inline chart */}
      <div className="chartClickable" onClick={() => setModalOpen(true)}>
        <ChartCanvas chartData={chartData} chartType={chartType} />
      </div>
      <p className="chartHint">Click to expand</p>

      {/* Modal */}
      {modalOpen && (
        <div
          className="modalBackdrop"
          onClick={(e) => { if (e.target === e.currentTarget) setModalOpen(false); }}
        >
          <div className="modalCard">
            <div className="modalHeader">
              <div>
                <p className="modalTitle">{displayTitle}</p>
                <p className="modalSub">{chartData.labels.length} data points</p>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div className="chartToggle">
                  {Object.keys(TYPE_LABELS).map((t) => (
                    <button
                      key={t}
                      className={`chartToggleBtn${chartType === t ? " active" : ""}`}
                      onClick={() => setChartType(t)}
                    >
                      {TYPE_LABELS[t]}
                    </button>
                  ))}
                </div>
                <button className="modalClose" onClick={() => setModalOpen(false)} aria-label="Close">✕</button>
              </div>
            </div>
            <ChartCanvas chartData={chartData} chartType={chartType} height="400px" className="modalChartCanvas" />
          </div>
        </div>
      )}
    </div>
  );
}