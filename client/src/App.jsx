import { useState } from "react";
import UploadPanel from "./components/UploadPanel.jsx";
import ChatPanel from "./components/ChatPanel.jsx";
import InsightChart from "./components/InsightChart.jsx";
import DatasetPreview from "./components/DatasetPreview.jsx";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000";

const FRIENDLY_ERROR = "⚠️ Unable to process request. Please try again.";

const WELCOME_MESSAGE = {
  role: "assistant",
  content:
    "Upload a CSV to get started. Then ask questions like “What are the top 5 categories by sales?”",
};

export default function App() {
  const [datasetInfo, setDatasetInfo] = useState(null);
  const [messages, setMessages] = useState([WELCOME_MESSAGE]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [chartData, setChartData] = useState(null);

  const canQuery = Boolean(datasetInfo);

  async function handleUpload(file) {
    setError("");
    setChartData(null);

    const form = new FormData();
    form.append("file", file);

    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/upload`, {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Upload failed");

      setDatasetInfo(data.dataset);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `Loaded **${data.dataset.originalName}** with **${data.dataset.rowCount}** rows.`,
        },
      ]);
      return true;
    } catch {
      setError(FRIENDLY_ERROR);
      return false;
    } finally {
      setLoading(false);
    }
  }

  function handleResetUpload() {
    setDatasetInfo(null);
    setMessages([WELCOME_MESSAGE]);
    setChartData(null);
    setError("");
  }

  async function handleAsk(question) {
    setError("");
    setChartData(null);

    const trimmed = question.trim();
    if (!trimmed) return;

    setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Query failed");

      const source = data.source === "rule-based" || data.source === "AI" ? data.source : undefined;
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.answer || "No answer returned.",
          ...(source ? { source } : {}),
        },
      ]);
      const cd = data.chartData;
      if (
        cd &&
        Array.isArray(cd.labels) &&
        Array.isArray(cd.values) &&
        cd.labels.length > 0 &&
        cd.labels.length === cd.values.length
      ) {
        setChartData(cd);
      }
    } catch {
      setError(FRIENDLY_ERROR);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: FRIENDLY_ERROR,
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>DataSpeak</h1>
          <p className="subtle">AI-powered “Talk to Data” for CSVs.</p>
        </div>
      </header>

      <main className="grid">
        <section className="card">
          <h2>1) Upload CSV</h2>
          <UploadPanel
            onUpload={handleUpload}
            onReset={handleResetUpload}
            disabled={loading}
            uploadedFileName={datasetInfo?.originalName ?? null}
          />
          {datasetInfo ? (
            <div className="dataset">
              <div className="row">
                <span className="label">File</span>
                <span className="value">{datasetInfo.originalName}</span>
              </div>
              <div className="row">
                <span className="label">Rows</span>
                <span className="value">{datasetInfo.rowCount}</span>
              </div>
              <div className="row">
                <span className="label">Columns</span>
                <span className="value">{datasetInfo.columns.join(", ")}</span>
              </div>
              <DatasetPreview
                columns={datasetInfo.columns}
                rows={(datasetInfo.sampleRows || []).slice(0, 5)}
              />
            </div>
          ) : (
            <p className="subtle">
              Your CSV is parsed on the server and stored in memory for this session.
            </p>
          )}
        </section>

        <section className="card">
          <h2>2) Ask questions</h2>
          <ChatPanel
            messages={messages}
            onAsk={handleAsk}
            disabled={!canQuery || loading}
            loading={loading}
          />
          {error ? <p className="error">{error}</p> : null}
        </section>

        <section className="card">
          <h2>3) Chart (optional)</h2>
          <InsightChart chartData={chartData} title={chartData ? "Comparison" : null} />
          {!chartData ? <p className="subtle">Charts appear when the AI returns chart data.</p> : null}
        </section>
      </main>

      <footer className="footer subtle">
        Built for hackathons: upload CSV → ask → get insights (+ optional charts).
      </footer>
    </div>
  );
}

