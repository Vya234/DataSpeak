import { useEffect, useRef, useState } from "react";

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
    return <span className="sourceBadge sourceBadgeAi">🤖 AI Insight</span>;
  }
  return null;
}

export default function ChatPanel({ messages, onAsk, disabled, loading }) {
  const [input, setInput] = useState("");
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, loading]);

  async function submit(e) {
    e.preventDefault();
    const q = input;
    setInput("");
    await onAsk(q);
  }

  return (
    <div className="chat">
      <div className="messages">
        {messages.map((m, idx) => (
          <div key={idx} className={`msg ${m.role}`}>
            <div className="msgInner">
              {m.role === "assistant" && m.source ? (
                <SourceBadge source={m.source} />
              ) : null}
              <div
                className={
                  m.role === "user"
                    ? "bubble bubbleUser"
                    : "bubble bubbleAssistant"
                }
              >
                {renderRichText(m.content)}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div ref={endRef} />
      <form className="chatForm" onSubmit={submit}>
        <input
          className="chatInput"
          value={input}
          placeholder={
            disabled ? "Upload a CSV to enable questions…" : "Ask a question about your data…"
          }
          onChange={(e) => setInput(e.target.value)}
          disabled={disabled}
        />
        <button className="button" type="submit" disabled={disabled || !input.trim()}>
          {loading ? "Thinking…" : "Send"}
        </button>
      </form>
      <p className="subtle chatTip">
        Tip: Try totals, averages, highest/lowest, ranges, or ask for a <strong>chart</strong> of a
        numeric column.
      </p>
    </div>
  );
}
