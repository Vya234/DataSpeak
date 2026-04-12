# DataSpeak — Talk to Your Data (CSV)

**DataSpeak** is a hackathon-friendly web app: upload a CSV, ask questions in plain English, and get **computed or AI-backed answers** with optional charts, **transparent “Data used”** metadata, and **verification** hooks. It is built for **clarity** (plain language + structured context), **trust** (exact column names, direction checks, no silent time guesses for vague phrases), and **speed** (deterministic paths before any LLM call).

**Who it’s for:** demos, coursework, and anyone who wants quick CSV insights without SQL or BI tooling.

---

## Features (implemented)

- **CSV upload** — Parsed **server-side** (Multer + csv-parser), stored in memory for the session.
- **Hybrid pipeline** — (1) **Deterministic** analytics (time windows, comparisons, drivers), (2) **rule-based** numeric engine, (3) **Groq (Llama 3.1)** for open-ended questions.
- **Exact column names** — Semantic mapping never renames headers in user-facing text; prompts instruct the model to use **only** CSV headers (fixes issues like `customers` vs wrong labels).
- **Ambiguous vague time** — Questions with only **“recently” / “latest”** (etc.) and **multiple** periods in the file get a **clarifying prompt** instead of a silent default.
- **Wrong-direction handling** — “Why did X drop?” paths compare periods and **correct** the premise when the metric actually rose (especially with filters).
- **Data used** — Each API response includes structured `dataUsed` (columns, filter, time window, row counts); the UI shows it in a **collapsible** section. Answers also append a **Data used** block for raw JSON consumers.
- **Verification** — Computed answers are marked verified; AI answers can have totals checked against row sums when a single currency total appears.
- **Charts** — **Chart.js** with axis titles when provided, legend, and tooltips showing numeric values; comparisons/breakdowns/trends from Groq shortcuts **always** return chart data when computable.
- **Follow-up chips** — After each answer, the UI suggests **2–3** contextual next questions.
- **Loading UX** — **“Analysing your data…”** skeleton with animated bar while the query runs.

---

## Tech stack

| Layer | Stack |
|--------|--------|
| Frontend | **React**, **Vite**, **Chart.js** |
| Backend | **Node.js**, **Express** |
| LLM | **Groq** — `groq-sdk`, **llama-3.1-8b-instant** |
| Upload / CSV | **Multer**, **csv-parser** |
| Tests | **Jest**, **Supertest** |

---

## Architecture (short)

1. Browser uploads CSV → **POST /upload** → server parses and stores rows + headers.  
2. Browser sends **POST /query** with `{ question }` → `insightService.getInsight` runs filters, optional **ambiguous-time** gate, deterministic + rules + **Groq** with a **strict system prompt** (exact columns, metric dictionary JSON, Data used rules).  
3. Response is shaped with **`answer`**, **`source`**, optional **`chartData`**, **`dataUsed`**, **`suggestedQuestions`**.  
4. Client renders the answer, collapsible **Data used**, **follow-up chips**, and the **Visualize** panel when `chartData` is present.

Key server modules:

- `server/src/services/insightService.js` — Orchestration.  
- `server/src/lib/promptBuilder.js` — Groq system prompt.  
- `server/src/lib/metricDictionary.js` — Per-column definitions for prompts.  
- `server/src/lib/ambiguousTime.js` — Vague relative time → clarify.  
- `server/src/lib/answerVerifier.js` — Post-AI numeric check.  
- `server/src/services/deterministicAnalytics.js` — Time + driver logic.  
- `server/src/services/groqService.js` — Shortcuts + narrative.

Client layout:

- `client/src/components/DatasetPanel.jsx`, `QueryPanel.jsx`, `VisualizePanel.jsx`  
- `client/src/lib/csvParser.js` — Notes that parsing is server-side.  
- `client/src/lib/metricDictionary.js` — Pointer to server definitions.

---

## Dependencies

### Backend

Node.js 18+, Express, Groq SDK, Multer, csv-parser, dotenv, cors, Jest, Supertest.

### Frontend

React, Vite, Chart.js.

---

## Install and run

**Prerequisites:** Node.js **18+** (20+ recommended), a **Groq API key**.

1. Copy **`.env.example`** to **`.env`** at the **DataSpeak** project root (same level as `server/` and `client/`).  
2. Set **`GROQ_API_KEY`**. Optionally set **`PORT`** (default `5000`) and **`VITE_API_URL`** if the API is not at `http://localhost:5000`.

```bash
cd server && npm install
cd ../client && npm install
```

**Terminal 1 — API**

```bash
cd server && npm run dev
```

**Terminal 2 — UI**

```bash
cd client && npm run dev
```

Open the Vite URL (usually `http://localhost:5173`).

**Tests**

```bash
cd server && npm test
```

---

## Environment variables

| Variable | Where | Purpose |
|----------|--------|---------|
| `GROQ_API_KEY` | Server `.env` | Groq API (required for AI path). |
| `PORT` | Server `.env` | API port (default 5000). |
| `VITE_API_URL` | Client env | API base URL if not localhost:5000. |

**Do not commit** a real `.env` or keys in source. Only **`.env.example`** belongs in the repo.

---

## Known limitations

- **CSV only**; messy files may confuse heuristics.  
- **In-memory** dataset — lost on server restart; no multi-user persistence.  
- **Column quality** — Dates and metrics work best with recognizable headers.  
- **LLM** sees a **prepared subset** (aggregated or capped rows); it can still miss edge cases.  
- **Verification** is best-effort (e.g. first currency literal vs column sum), not a full semantic proof.  
- **Not** for regulated or secret data without your own governance.

---

## API (`POST /query`)

Body: `{ "question": "..." }`

Success (typical):

- `answer` (string)  
- `source`: `"rule-based"` | `"AI"`  
- `chartData` (optional): `{ labels, values, type, valueAxisLabel?, categoryAxisLabel? }`  
- `dataUsed`: `{ columnsUsed, filter, timeWindow, rowCount, totalRows }`  
- `suggestedQuestions`: string[]  
- `clarifying` (optional): `true` when the server asked for a clearer time period  

---

*Built for clear answers, honest feature listing, and a transparent path from question to data.*
