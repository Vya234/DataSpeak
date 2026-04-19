import InsightChart from "./InsightChart.jsx";

export default function VisualizePanel({ chartData }) {
  return (
    <>
      <h2>Visualize</h2>
      <InsightChart chartData={chartData} title={chartData ? "Result chart" : null} />
      {!chartData && (
        <p className="subtle">
          Charts appear here when your question returns numeric series (trend, comparison, or breakdown).
        </p>
      )}
    </>
  );
}
