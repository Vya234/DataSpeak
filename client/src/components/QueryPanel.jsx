import ChatPanel from "./ChatPanel.jsx";

export default function QueryPanel({
  messages,
  onAsk,
  canQuery,
  loading,
  error,
}) {
  return (
    <>
      <h2>Ask your data</h2>
      <ChatPanel
        messages={messages}
        onAsk={onAsk}
        disabled={!canQuery || loading}
        loading={loading}
      />
      {error ? <p className="error">{error}</p> : null}
    </>
  );
}
