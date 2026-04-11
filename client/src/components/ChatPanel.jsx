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
    return <span className="sourceBadge sourceBadgeAi">✦ AI Insight</span>;
  }
  return null;
}

function TypingIndicator() {
  return (
    <div className="msg" style={{ marginBottom: 14 }}>
      <div className="msgInner">
        <div className="typingBubble">
          <div className="typingDot" />
          <div className="typingDot" />
          <div className="typingDot" />
        </div>
      </div>
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
                {renderRichText(m.content)}
              </div>
            </div>
          </div>
        ))}
        {loading && <TypingIndicator />}
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
            <>
              <span style={{ fontSize: 13 }}>···</span>
            </>
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
        Try totals, averages, top N, or ask to <strong>chart</strong> a column.
      </p>
    </div>
  );
}