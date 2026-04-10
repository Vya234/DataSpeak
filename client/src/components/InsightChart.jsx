import { useEffect, useRef } from "react";
import Chart from "chart.js/auto";

/** Renders chart when API returns labels + values (type defaults to bar). */
export default function InsightChart({ chartData, title }) {
  const canvasRef = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!chartData?.labels?.length || !chartData?.values?.length || !canvasRef.current) return;
    if (chartData.labels.length !== chartData.values.length) return;

    if (chartRef.current) {
      chartRef.current.destroy();
      chartRef.current = null;
    }

    const type = chartData.type || "bar";
    const fill = "rgba(99, 102, 241, 0.55)";
    const stroke = "#6366f1";
    const pieFills = ["rgba(99,102,241,0.7)", "rgba(99,102,241,0.45)", "rgba(99,102,241,0.3)"];

    const dataset = {
      label: "Value",
      data: chartData.values.map((v) => Number(v)),
      backgroundColor:
        type === "pie"
          ? chartData.labels.map((_, i) => pieFills[i % pieFills.length])
          : fill,
      borderColor: stroke,
      borderWidth: type === "pie" ? 1 : 0,
      borderRadius: type === "bar" ? 4 : 0,
      borderSkipped: false,
    };

    chartRef.current = new Chart(canvasRef.current, {
      type,
      data: {
        labels: chartData.labels,
        datasets: [dataset],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 400 },
        plugins: {
          legend: { display: type === "pie", labels: { color: "#a1a1aa" } },
          tooltip: {
            backgroundColor: "#18181f",
            borderColor: "#27272f",
            borderWidth: 1,
            titleColor: "#e4e4e7",
            bodyColor: "#e4e4e7",
          },
        },
        scales:
          type === "pie"
            ? {}
            : {
                x: {
                  ticks: { color: "#a1a1aa", maxRotation: 0, autoSkip: true },
                  grid: { color: "#27272f" },
                },
                y: {
                  beginAtZero: true,
                  ticks: { color: "#a1a1aa" },
                  grid: { color: "#27272f" },
                },
              },
      },
    });

    return () => {
      if (chartRef.current) {
        chartRef.current.destroy();
        chartRef.current = null;
      }
    };
  }, [chartData]);

  if (!chartData?.labels?.length || !chartData?.values?.length) return null;
  if (chartData.labels.length !== chartData.values.length) return null;

  return (
    <div className="chartWrap">
      <h3 className="chartTitle">{title || "Chart"}</h3>
      <div className="chartCanvas">
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}
