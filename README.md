# DataSpeak — Talk to Your Data (CSV)

## Project Overview

Many people need **quick, trustworthy answers from data** without learning spreadsheets, SQL, or BI tools. **DataSpeak** is a small full-stack app for the **“Talk to Data”** idea: you **upload a CSV**, then ask **plain-language questions** and get **short answers**, optional **charts**, and a clear signal whether the reply was **computed** or **AI-generated**.

**Key idea:** natural language → structured checks on your rows → clear insights, with **fast** paths first and **Groq (Llama 3.1)** only when needed.

**Who it’s for:** hackathon demos, students, analysts, or anyone who wants to explore a CSV through a simple chat UI.

---

## Features (only what the codebase does today)

- **CSV upload** (`POST /upload`): file is parsed and held **in memory** for the server session.
- **Natural language queries** (`POST /query`): one question at a time over the uploaded dataset.
- **Hybrid pipeline** (in order):
  1. **Deterministic analytics** — time windows, comparisons, breakdowns, summaries, correlation, driver-style attribution when the question and columns match (`deterministicAnalytics.js`).
  2. **Rule-based engine** — totals, averages, top/bottom N, trends, simple group-by/chart-style answers (`ruleBasedQuery.js`).
  3. **LLM fallback** — **Groq** for remaining questions; prompts use a **limited preview** of data (after aggregation when possible, then capped) so answers stay grounded (`groqService.js`).
- **Breakdowns, comparisons, and summaries** — covered by the deterministic + rule layers where patterns match your columns and wording.
- **Driver-style analysis** — when the deterministic pipeline can align **time periods** and dimensions in your data (e.g. “why did revenue drop last month?” with a usable date column and metrics).
- **Charts** — when the API returns valid `chartData` (`labels`, `values`, `type`), the React UI renders **Chart.js** (bar / line / pie-style).
- **Source badge** — responses are labeled **Computed** (`rule-based`) or **AI Insight** (`AI`) when applicable.
- **Tests** — Jest tests under `server/tests/` (e.g. health, analytics helpers).

---

## Architecture

```text
Browser (React)
    → POST /upload  → CSV → in-memory datasetStore
    → POST /query   → queryController → insightService.getInsight
```

**`insightService.js`** (main orchestrator):

1. Normalises columns/rows from the stored dataset.  
2. Applies **light categorical filtering** from the question when it can match values in the data.  
3. Runs **`runDeterministicPipeline`** (`deterministicAnalytics.js`) with resolved **metrics**, **date column**, **time windows**, and **intent** — if it returns an answer, that result is sent back (response is shaped to `answer`, `source`, optional `chartData`).  
4. Else **`tryRuleBasedAnswer`** (`ruleBasedQuery.js`).  
5. Else builds an **LLM payload** (full small tables, or aggregates / samples for larger sets) and calls **`askGroqForInsight`** (`groqService.js`), which still runs its own deterministic shortcuts before any pure LLM call.

**Key files**

| File | Role |
|------|------|
| `server/src/services/insightService.js` | Request routing: deterministic → rules → Groq; response shaping. |
| `server/src/services/deterministicAnalytics.js` | Calendar comparisons, drivers, breakdowns, correlation, summaries. |
| `server/src/services/ruleBasedQuery.js` | Fast numeric/trend/group-by rules. |
| `server/src/services/groqService.js` | Metric/time detection, extra deterministic answers, Groq JSON narrative. |
| `server/src/services/metricResolver.js` | Maps synonyms to canonical metrics where used by the pipeline. |
| `server/src/services/timeResolver.js` | Date column picking and relative period windows from the **dataset** (not wall-clock). |
| `client/src/App.jsx` | Upload, chat, chart panel. |

---

## Tech Stack

- **Frontend:** React + Vite  
- **Backend:** Node.js + Express  
- **LLM:** Groq API — `groq-sdk`, model **`llama-3.1-8b-instant`**  
- **Charts:** Chart.js  
- **Upload / CSV:** Multer, csv-parser  
- **Tests:** Jest + Supertest  

---

## Setup Instructions

### Prerequisites

- **Node.js 18+** (20+ recommended)  
- A **Groq API key** from [console.groq.com](https://console.groq.com/)

### 1. Clone and enter the project

Use the folder that contains **`server/`** and **`client/`** (repository root).

### 2. Environment variables

1. Copy **`.env.example`** to **`.env`** at the **repository root** (same level as `server/` and `client/`).  
2. Set at least:
   - **`GROQ_API_KEY`** — your key  
   - **`PORT`** — optional; default **5000** for the API  

Do **not** commit `.env` or real secrets. Only **`.env.example`** belongs in the repo.

### 3. Install dependencies

```bash
cd server && npm install
cd ../client && npm install
```

### 4. Run the app (two terminals)

**API (from repository root):**

```bash
cd server && npm run dev
```

API: `http://localhost:5000` (or your `PORT`).

**UI:**

```bash
cd client && npm run dev
```

UI: `http://localhost:5173`

Optional: set **`VITE_API_URL`** when building or running the client if the API is not on `http://localhost:5000`.

### 5. Run tests (optional)

```bash
cd server && npm test
```

---

## Usage

1. Open the web UI and **upload a CSV** (headers in the first row work best).  
2. Wait for the confirmation message with row/column counts.  
3. Ask questions in natural language, for example:
   - *“Why did revenue drop last month?”*  
   - *“Compare revenue across regions.”*  
   - *“Give me a weekly summary.”* / *“This week vs last week”* (needs week-level or daily-style dates in the data where applicable)  
   - *“Break down sales by region.”*  
   - *“Top 5 products by revenue.”*  
4. If the response includes a chart, it appears in the **Visualize** panel; you can switch chart types in the UI.

---

## Project structure (submission layout)

```text
DataSpeak/
├── client/
│   ├── src/
│   ├── public/
│   ├── package.json
│   └── vite.config.js
├── server/
│   ├── src/
│   │   ├── routes/
│   │   ├── controllers/
│   │   ├── services/
│   │   └── utils/
│   ├── tests/
│   ├── package.json
│   └── server.js
├── README.md
├── .env.example
└── .gitignore
```

---

## Limitations (honest)

- **Tabular CSV only** — messy or non-tabular files may parse poorly or confuse heuristics.  
- **Column names and types matter** — dates should be parseable; metrics like revenue/sales/orders match faster when columns follow common names (synonyms are heuristics, not a full BI semantic layer).  
- **In-memory data** — uploads are lost when the server restarts; there is no multi-user persistence.  
- **LLM answers** — the model only sees a **preview** of prepared data (aggregated when possible, then capped); it can still miss nuance or return no chart.  
- **Not a substitute for governance** — do not upload confidential data you are not allowed to process; the app is intended for demos and learning.  

---

## Future improvements (optional)

- Stronger **semantic layer** and column typing across more domains  
- **Statistical tests** surfaced consistently in the UI (beyond current correlation / simple anomaly-style logic)  
- More **chart types** and export  
- **Persistence** (database) and optional auth  
- **Streaming** replies and server-side chat history  

---

## API response shape (`POST /query`)

JSON body: `{ "question": "..." }`  

Success fields:

- **`answer`** (string)  
- **`source`**: `"rule-based"` or `"AI"`  
- **`chartData`** (optional): `{ "labels": [], "values": [], "type": "bar" | "line" | "pie" }`  

---

*Built for clarity, honest feature listing, and a clean path from question to data-backed answers.*
