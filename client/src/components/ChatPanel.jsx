import { useEffect, useRef, useState } from "react";

function stripTrailingDataUsedBlock(text) {
  return String(text || "")
    .replace(/\n\n─────────────────────[\s\S]*─────────────────────\s*$/m, "")
    .replace(/\n\n✓ Verified[^\n]*$/m, "")
    .trim();
}

function renderRichText(text) {
  const safe = String(text || "");
  const parts = safe.split("**");
  return parts.map((p, idx) =>
    idx % 2 === 1 ? <strong key={idx}>{p}</strong> : <span key={idx}>{p}</span>
  );
}

function SourceBadge({ source }) {
  if (source === "rule-based") {
    return <span className="sourceBadge sourceBadgeRule">⚡ Computed</span>;
  }
  if (source === "AI") {
    return <span className="sourceBadge sourceBadgeAi">✦ AI Insight</span>;
  }
  return null;
}

function AnswerSkeleton() {
  return (
    <div className="msg assistant" style={{ marginBottom: 14 }}>
      <div className="msgInner">
        <div className="analyseSkeleton">
          <p className="analyseSkeletonTitle">Analysing your data…</p>
          <div className="analyseSkeletonBar" />
          <div className="analyseSkeletonBar short" />
        </div>
      </div>
    </div>
  );
}

function DataUsedBlock({ dataUsed }) {
  if (!dataUsed) return null;
  const cols = Array.isArray(dataUsed.columnsUsed) ? dataUsed.columnsUsed.join(", ") : "";
  const filter = dataUsed.filter || "none";
  const time = dataUsed.timeWindow || "none";
  const rows = `${dataUsed.rowCount ?? 0} of ${dataUsed.totalRows ?? 0}`;
  return (
    <details className="dataUsedDetails">
      <summary>Data used</summary>
      <div className="dataUsedBody">
        <div>
          <span className="dataUsedKey">Columns</span>
          <span className="dataUsedVal">{cols || "—"}</span>
        </div>
        <div>
          <span className="dataUsedKey">Filter</span>
          <span className="dataUsedVal">{filter}</span>
        </div>
        <div>
          <span className="dataUsedKey">Time</span>
          <span className="dataUsedVal">{time}</span>
        </div>
        <div>
          <span className="dataUsedKey">Rows</span>
          <span className="dataUsedVal">{rows}</span>
        </div>
      </div>
    </details>
  );
}

function FollowUpChips({ questions, onPick, disabled }) {
  if (!questions?.length) return null;
  return (
    <div className="followUpChips">
      {questions.map((q) => (
        <button
          key={q}
          type="button"
          className="followUpChip"
          disabled={disabled}
          onClick={() => onPick(q)}
        >
          {q}
        </button>
      ))}
    </div>
  );
}

export default function ChatPanel({ messages, onAsk, disabled, loading }) {
  const [input, setInput] = useState("");
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, loading]);

  async function submit(e) {
    e.preventDefault();
    const q = input.trim();
    if (!q) return;
    setInput("");
    await onAsk(q);
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit(e);
    }
  }

  return (
    <div className="chat">
      <div className="messages">
        {messages.map((m, idx) => (
          <div key={idx} className={`msg ${m.role}`}>
            <div className="msgInner">
              {m.role === "assistant" && m.source && (
                <SourceBadge source={m.source} />
              )}
              <div className={m.role === "user" ? "bubble bubbleUser" : "bubble bubbleAssistant"}>
                {renderRichText(
                  m.role === "assistant" && m.dataUsed
                    ? stripTrailingDataUsedBlock(m.content)
                    : m.content
                )}
              </div>
              {m.role === "assistant" && (m.dataUsed || m.suggestedQuestions?.length) ? (
                <>
                  <DataUsedBlock dataUsed={m.dataUsed} />
                  <FollowUpChips
                    questions={m.suggestedQuestions}
                    onPick={(q) => onAsk(q)}
                    disabled={disabled || loading}
                  />
                </>
              ) : null}
            </div>
          </div>
        ))}
        {loading && <AnswerSkeleton />}
        <div ref={endRef} />
      </div>

      <div className="chatInputWrap">
        <input
          className="chatInput"
          value={input}
          placeholder={disabled ? "Upload a CSV first…" : "Ask anything about your data…"}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled || loading}
          autoComplete="off"
        />
        <button
          className="chatSendBtn"
          onClick={submit}
          disabled={disabled || loading || !input.trim()}
          type="button"
        >
          {loading ? (
            <span style={{ fontSize: 13 }}>···</span>
          ) : (
            <>
              Send
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                <path d="M2 21l21-9L2 3v7l15 2-15 2v7z" />
              </svg>
            </>
          )}
        </button>
      </div>

      <p className="subtle chatTip">
        Try totals, comparisons, or <strong>why</strong> questions with your date column.
      </p>
    </div>
  );
}
