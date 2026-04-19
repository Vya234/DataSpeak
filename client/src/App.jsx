import { useState, useEffect } from "react";
import DatasetPanel from "./components/DatasetPanel.jsx";
import QueryPanel from "./components/QueryPanel.jsx";
import VisualizePanel from "./components/VisualizePanel.jsx";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000";

const FRIENDLY_ERROR = "⚠️ Unable to process request. Please try again.";

const WELCOME_MESSAGE = {
  role: "assistant",
  content:
    'Upload a CSV to get started. Then ask questions like "What are the top 5 categories by sales?"',
};

export default function App() {
  const [datasetInfo, setDatasetInfo] = useState(null);
  const [messages, setMessages] = useState([WELCOME_MESSAGE]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [chartData, setChartData] = useState(null);

  useEffect(() => {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, []);

  const canQuery = Boolean(datasetInfo);

  async function handleUpload(file) {
    setError("");
    setChartData(null);

    const form = new FormData();
    form.append("file", file);

    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/upload`, { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Upload failed");

      setDatasetInfo(data.dataset);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `Loaded **${data.dataset.originalName}** — **${data.dataset.rowCount}** rows, **${data.dataset.columns.length}** columns.`,
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

      const source =
        data.source === "rule-based" || data.source === "AI" ? data.source : undefined;
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.answer || "No answer returned.",
          ...(source ? { source } : {}),
          ...(data.dataUsed ? { dataUsed: data.dataUsed } : {}),
          ...(Array.isArray(data.suggestedQuestions) && data.suggestedQuestions.length
            ? { suggestedQuestions: data.suggestedQuestions }
            : {}),
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
        { role: "assistant", content: FRIENDLY_ERROR },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-logo" aria-hidden>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          </svg>
        </div>
        <div>
          <h1>DataSpeak</h1>
          <p className="subtle" style={{ margin: 0 }}>AI-powered natural language queries for CSV files</p>
        </div>
      </header>

      <main className="grid">
        <section className="card">
          <DatasetPanel
            datasetInfo={datasetInfo}
            loading={loading}
            onUpload={handleUpload}
            onResetUpload={handleResetUpload}
          />
        </section>

        <section className="card">
          <QueryPanel
            messages={messages}
            onAsk={handleAsk}
            canQuery={canQuery}
            loading={loading}
            error={error}
          />
        </section>

        <section className="card">
          <VisualizePanel chartData={chartData} />
        </section>
      </main>

      <footer className="footer subtle">
        DataSpeak · Upload a CSV, ask questions, get insights.
      </footer>
    </div>
  );
}
