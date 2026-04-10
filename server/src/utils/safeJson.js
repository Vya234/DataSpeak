function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (_err) {
    // Sometimes models wrap JSON in triple-backticks; attempt a minimal extraction.
    const trimmed = String(text || "").trim();
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenceMatch && fenceMatch[1]) {
      try {
        return { ok: true, value: JSON.parse(fenceMatch[1]) };
      } catch (err2) {
        return { ok: false, error: err2 };
      }
    }
    return { ok: false, error: new Error("Invalid JSON") };
  }
}

module.exports = { safeJsonParse };

