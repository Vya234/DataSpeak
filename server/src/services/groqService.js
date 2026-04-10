const Groq = require("groq-sdk");
const { safeJsonParse } = require("../utils/safeJson");
const { inferColumnsFromRows } = require("../utils/datasetAnalysis");

/** Stable Groq chat model — verify on console.groq.com if this id changes */
const GROQ_CHAT_MODEL = "llama-3.1-8b-instant";

const SOURCE_AI = "AI";

const PLACEHOLDER_KEYS = new Set(["your_groq_key_here", "your_key_here"]);

function getGroqApiKey() {
  const raw = process.env.GROQ_API_KEY;
  return typeof raw === "string" ? raw.trim() : "";
}

function userWantsChart(question) {
  const lower = String(question || "").toLowerCase();
  return /\b(compare|chart|plot|graph)\b/i.test(lower);
}

function buildStructuredUserPrompt({ question, rows, columns }) {
  const data = Array.isArray(rows) ? rows : [];
  const sample = data.slice(0, 20);
  const cols =
    Array.isArray(columns) && columns.length > 0 ? columns : inferColumnsFromRows(data);

  const lines = [
    `Column names: ${cols.length ? cols.join(", ") : "(none inferred)"}`,
    "",
    "First 20 rows (JSON):",
    JSON.stringify(sample),
    "",
    "Answer strictly based on the dataset. Be concise. Mention exact values and column names where relevant.",
    "",
    `Question: ${question}`,
  ];

  if (userWantsChart(question)) {
    lines.splice(
      -2,
      0,
      "The user asked to compare, chart, plot, or graph. Respond with JSON including chartData: { \"labels\": [category names], \"values\": [numbers] } — same length, numeric values only. Pair answer text with a clear comparison (e.g. range and who is highest/lowest) when the data supports it."
    );
  }

  return lines.join("\n");
}

function normalizeGroqResponse(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    return { answer: "No response from the model. Please try again.", source: SOURCE_AI };
  }

  const parsed = safeJsonParse(raw.trim());
  if (parsed.ok && typeof parsed.value.answer === "string") {
    const answer = parsed.value.answer;
    const chartData = parsed.value.chartData;

    if (chartData && typeof chartData === "object" && chartData !== null) {
      const labels = Array.isArray(chartData.labels) ? chartData.labels.map(String) : [];
      const values = Array.isArray(chartData.values)
        ? chartData.values
            .map((v) => (Number.isFinite(Number(v)) ? Number(v) : null))
            .filter((v) => v !== null)
        : [];
      const type = ["bar", "line", "pie"].includes(chartData.type) ? chartData.type : "bar";

      if (labels.length > 0 && values.length === labels.length) {
        return { answer, chartData: { labels, values, type }, source: SOURCE_AI };
      }
    }

    return { answer, source: SOURCE_AI };
  }

  return { answer: raw.trim(), source: SOURCE_AI };
}

/**
 * Groq-backed insight. Never throws — returns user-friendly { answer, source } on failure.
 *
 * @param {{ question: string, rows: object[], columns?: string[] }} params
 * @returns {Promise<{ answer: string, source: string, chartData?: object }>}
 */
async function askGroqForInsight({ question, rows, columns }) {
  const apiKey = getGroqApiKey();
  if (!apiKey || PLACEHOLDER_KEYS.has(apiKey.toLowerCase())) {
    return {
      answer:
        "AI is not configured: set a valid GROQ_API_KEY in dataspeak/.env (copy from .env.example).",
      source: SOURCE_AI,
    };
  }

  const userContent = buildStructuredUserPrompt({ question, rows, columns });

  const system = `You are an expert data analyst. Answer like a data analyst: use clear, complete sentences; cite exact values from the dataset; name relevant columns. Do not give one-word answers.

Always respond with ONLY valid JSON (no markdown) in this form:
{"answer":"string","chartData":null}
or, when a chart/plot/graph is requested or a chart would clarify the answer:
{"answer":"string","chartData":{"labels":[],"values":[],"type":"bar"|"line"|"pie"}}
The "answer" field must be insightful (explain what the numbers mean), not just list values. Use chartData: null when no chart is needed.`;

  try {
    const groq = new Groq({ apiKey });
    const response = await groq.chat.completions.create({
      model: GROQ_CHAT_MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
    });

    const raw = response.choices?.[0]?.message?.content ?? "";
    return normalizeGroqResponse(raw);
  } catch (err) {
    const status = err.status || err.statusCode;

    if (status === 401) {
      return {
        answer:
          "The AI service rejected the API key. Check GROQ_API_KEY in dataspeak/.env (Groq console).",
        source: SOURCE_AI,
      };
    }
    if (status === 429) {
      return {
        answer: "The AI service is busy (rate limit). Please wait a moment and try again.",
        source: SOURCE_AI,
      };
    }

    return {
      answer: "We could not get an AI answer right now. Please try again shortly.",
      source: SOURCE_AI,
    };
  }
}

module.exports = { askGroqForInsight, GROQ_CHAT_MODEL, SOURCE_AI };
