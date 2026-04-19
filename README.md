# DataSpeak — Talk to Your Data (CSV)

## Overview

DataSpeak is a web app that lets anyone upload a CSV file and ask 
questions about it in plain English — no SQL, no BI tools, no technical 
knowledge required. It instantly returns verified, deterministically 
computed answers with charts and transparent data sources.

**Problem it solves:** Most people struggle to get quick, accurate, and 
trustworthy answers from data. Existing tools require SQL knowledge, 
complex dashboards, or produce AI answers that hallucinate numbers. 
DataSpeak removes that friction.

**Target users:** Business analysts, students, hackathon participants, 
and anyone who needs fast insights from a CSV without writing code.

---

## Features (implemented and working)

- **CSV upload** — Parsed server-side (Multer + csv-parser), stored in memory for the session.
- **Deterministic computation engine** — All numbers (sums, percentages, comparisons, trends) are computed by backend JS. The LLM never does math — it only explains pre-computed results.
- **Intent classifier** — Detects query type (comparison, trend, breakdown, why, summary) using keyword/pattern matching with no ML dependency.
- **Strict metric dictionary** — Maps user terms (e.g. "revenue", "tickets") to exact CSV column names. Prevents hallucinated or wrong column references.
- **Driver analysis** — "Why" questions compute per-group period-over-period deltas ranked by absolute impact. LLM only narrates the pre-computed result.
- **Confidence badges** — Every answer is tagged: ⚡ Computed (high confidence), ✦ AI-assisted (medium), or low confidence so users always know how the answer was produced.
- **Numeric guardrails** — Post-LLM verification layer detects and overrides any AI numbers that disagree with server-computed values.
- **In-memory query cache** — Dataset fingerprint + question hash avoids redundant recomputation for repeated queries.
- **Granularity-aware summaries** — Daily, weekly, and monthly summaries respect the user's requested granularity. Falls back gracefully with an explanatory note if data is too sparse.
- **Graceful fallback** — When a question cannot be answered, lists the available metrics from the uploaded file instead of returning confusing output.
- **Exact column names** — Answers always use real CSV header names, never renamed or guessed labels.
- **Ambiguous time handling** — Vague phrases like "recently" or "latest" with multiple time periods trigger a clarifying prompt instead of a silent wrong assumption.
- **Wrong-direction handling** — "Why did X drop?" corrects the premise automatically when the metric actually rose.
- **Data used panel** — Every response includes structured metadata (columns used, filter, time window, row counts) shown in a collapsible section.
- **Charts** — Chart.js bar, line, and donut charts with axis titles, legends, and tooltips. Comparisons, breakdowns, and trends always include chart data when computable.
- **Dynamic follow-up chips** — Suggested next questions are generated from actual CSV column names, never hardcoded.
- **Loading UX** — "Analysing your data…" skeleton with animated bar while the query runs.
- **Auto-scroll** — Chat scrolls smoothly to the latest answer after each response.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React, Vite, Chart.js |
| Backend | Node.js, Express |
| LLM | Groq API — llama-3.1-8b-instant |
| Upload / CSV parsing | Multer, csv-parser |
| Tests | Jest, Supertest |

---

## Setup Instructions

**Prerequisites:** Node.js 18+ (20+ recommended), a Groq API key
(free at console.groq.com).

**Step 1 — Clone the repository:**
```bash
git clone <your-repo-url>
cd DataSpeak
```

**Step 2 — Set up environment variables:**
```bash
cp .env.example .env
```
Open .env and set:
GROQ_API_KEY=your_groq_api_key_here
PORT=5000

**Step 3 — Install dependencies:**
```bash
cd server && npm install
cd ../client && npm install
```

**Step 4 — Run the app (two terminals):**

Terminal 1 (API server):
```bash
cd server && npm run dev
```

Terminal 2 (Frontend):
```bash
cd client && npm run dev
```

Open http://localhost:5173 in your browser.

**Step 5 — Run tests:**
```bash
cd server && npm test
```

---

## Environment Variables

| Variable | Location | Purpose |
|----------|----------|---------|
| GROQ_API_KEY | server/.env | Groq LLM API key (required) |
| PORT | server/.env | API port (default: 5000) |
| VITE_API_URL | client/.env | API base URL if not localhost:5000 |

Never commit your real .env file. Only .env.example belongs in the repo.

---

## Usage Examples

**Upload a CSV** — Click the upload area in the Dataset panel and select
any CSV file. The app shows row count, column count, and a preview.

**Ask questions in plain English:**
- "What is the total sales?" → Returns exact sum with verification badge
- "Compare revenue by region" → Returns bar chart + ranked breakdown
- "Why did sales drop last month?" → Returns driver analysis with top contributors
- "Show monthly sales trend" → Returns period-over-period percentage changes
- "Break down tickets by department" → Returns percentage breakdown with chart
- "Give me a weekly summary" → Returns most recent week vs previous week

**Example API call:**
```bash
curl -X POST http://localhost:5000/query \
  -H "Content-Type: application/json" \
  -d '{"question": "Compare revenue by region"}'
```

**Example API response:**
```json
{
  "answer": "Revenue compared across Region: East: $115,800 (26.5%); West: $110,300 (25.2%)",
  "source": "rule-based",
  "confidence": "high",
  "chartData": {
    "labels": ["East","West"],
    "values": [115800, 110300],
    "type": "bar"
  },
  "dataUsed": {
    "columnsUsed": ["Sales","Region"],
    "rowCount": 48,
    "totalRows": 48
  },
  "suggestedQuestions": [
    "Why did East outperform West?",
    "Show Sales trend over time"
  ]
}
```

---

## Architecture
```text
CSV Upload
↓
Server-side Parser (csv-parser + Multer)
↓
Dataset Fingerprint + In-memory Cache Check
↓
Intent Classifier (comparison / trend / breakdown / why / summary)
↓
Structured Query Builder (metric, groupBy, aggregation, dateColumn)
↓
Deterministic Computation Engine (groupBySum, timeSeries, driverAnalysis)
↓
[Only if needed] Groq LLM — receives pre-computed JSON, returns plain English explanation only
↓
Numeric Guardrails (post-LLM number verification + override)
↓
Confidence Badge (high / medium / low) + Response
```

**Key server modules:**

| Module | Purpose |
|--------|---------|
| insightService.js | Main orchestration, cache, confidence assignment |
| intentClassifier.js | Keyword/pattern intent detection |
| computationEngine.js | groupBySum, timeSeries, computeChange, anomaly detection |
| driverAnalysis.js | Period-over-period driver ranking by impact |
| verifier.js | Post-LLM numeric guardrails |
| structuredQuery.js | Builds JSON query plan from question + schema |
| deterministicAnalytics.js | Time window and driver logic |
| groqService.js | Explain-only LLM path (no math) |
| promptBuilder.js | Groq system prompt builder |
| answerVerifier.js | Currency and percent verification |
| ambiguousTime.js | Vague time phrase detection |

---

## Technical Depth

**Why deterministic-first?**
Most talk-to-data tools send raw rows to an LLM and ask it to compute
totals. LLMs are not calculators — they estimate, round incorrectly, and
ignore filters. DataSpeak inverts this: backend JavaScript computes all
numbers with exact arithmetic, and the LLM is only called to write a
plain English sentence around the pre-computed result. This guarantees
accuracy and satisfies the Trust pillar of the hackathon brief.

**Why Groq + llama-3.1-8b-instant?**
Groq's inference hardware delivers sub-second LLM responses. The 8b
model is fast and sufficient for explanation-only tasks since it never
needs to reason about numbers. This satisfies the Speed pillar without
paid API tiers.

**Why intent classification before LLM?**
Routing queries through a keyword classifier first means the most common
query types (comparison, trend, breakdown, why, summary) never touch the
LLM at all. This reduces latency, eliminates hallucination risk for
structured queries, and makes answers fully reproducible.

**Why a metric dictionary?**
Different users say "revenue", "sales", "income" — all meaning the same
column. The metric dictionary creates a stable mapping from user language
to exact CSV headers, preventing the model from guessing or inventing
column names.

---

## Limitations

- CSV only — Excel, JSON, and database connections are not supported.
- In-memory storage — dataset is lost on server restart, no multi-user persistence.
- Column quality — date and metric detection works best with recognizable header names.
- Driver analysis covers the last 2 available time periods only.
- Daily/weekly summary falls back to monthly if data granularity is too sparse.
- LLM sees an aggregated subset of rows, not raw data — edge cases may be missed.
- Verification is best-effort, not a full semantic proof.
- Not suitable for regulated or sensitive data without additional governance.

---

## Future Improvements

- Support for Excel (.xlsx) and JSON file formats
- Persistent sessions and multi-user support with a database
- Natural language to SQL preview for power users
- Anomaly detection with automatic flagging on charts
- Scheduled summaries (daily/weekly email digests)
- Multi-file joins and cross-dataset comparison

---

## Screenshots

![DataSpeak Interface](screenshots/DataSpeak.png)

*Built for clear answers, honest feature listing, and a transparent path
from question to data.*
