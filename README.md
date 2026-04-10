# DataSpeak — AI-Powered “Talk to Data” (CSV)

DataSpeak is a hackathon-ready full-stack web app where you **upload a CSV** and then **ask natural language questions** to get clear insights, explanations, and (when helpful) an optional chart.

## Project Overview

Spreadsheets are powerful, but asking questions like “What’s driving revenue?” often requires filters, pivots, or code. DataSpeak lets non-technical users explore CSV data through a simple chat interface, powered by **Groq** (Llama 3.1 8B Instant), with fast rule-based answers for simple questions.

**Who it’s for**
- Hackathon judges and demo viewers
- Students / analysts with CSV files
- Teams who want a quick “talk to data” prototype

## Features (implemented)

- **CSV upload** via `POST /upload` (Multer memory upload)
- **CSV parsing** into JSON (stored **in memory** for the current server session)
- **Natural language queries** via `POST /query`
- **Hybrid answers**: rule-based totals (e.g. questions containing “total”) when possible; otherwise **Groq** (`groq-sdk`, `llama-3.1-8b-instant`, `GROQ_API_KEY`)
- **Optional Chart.js visualization** when the API returns `chartData`
- **Loading + error states** in the UI
- **Basic backend test** (`GET /health`) using Jest + Supertest

## Tech Stack

- **Frontend**: React (Vite)
- **Backend**: Node.js + Express
- **AI**: Groq API (`groq-sdk`, model `llama-3.1-8b-instant`)
- **Charts**: Chart.js
- **File Upload**: Multer
- **CSV Parsing**: csv-parser
- **Testing**: Jest + Supertest

## Installation & Run Steps

### 1) Prerequisites

- Node.js 18+ (recommended: Node 20)
- A [Groq](https://console.groq.com/) API key

### 2) Setup environment variables

From the repo root (`dataspeak/`):

1. Create a `.env` file by copying `.env.example`
2. Set:
   - `GROQ_API_KEY`
   - `PORT` (default: `5000`)

### 3) Install dependencies

Install **server** and **client** separately (each has its own `package.json`):

```bash
cd server && npm install
cd ../client && npm install
```

### 4) Run the app

Use **two terminals** from `dataspeak/`:

**Terminal A — API**

```bash
cd server && npm run dev
```

Backend: `http://localhost:5000`

**Terminal B — UI**

```bash
cd client && npm run dev
```

Frontend: `http://localhost:5173`

### 5) Run tests (optional)

```bash
cd server && npm test
```

## Usage Examples (sample queries)

After uploading a CSV, try:
- “What columns are available, and what do they represent?”
- “What are the top 5 values in the `category` column by total `sales`?”
- “Show a breakdown of total `revenue` by `region` as a chart.”
- “Is there an upward trend in `signups` over time?”

## Project Structure (required)

```
dataspeak/
├── client/
│   ├── src/
│   ├── public/
│   ├── package.json
│   └── vite.config.js
│
├── server/
│   ├── src/
│   │   ├── routes/
│   │   ├── controllers/
│   │   ├── services/
│   │   └── utils/
│   ├── tests/
│   ├── package.json
│   └── server.js
│
├── README.md
├── .env.example
└── .gitignore
```

## Architecture Overview (brief)

- **Client (React)** uploads a CSV and sends chat questions.
- **Server (Express)**:
  - `/upload`: parses CSV to JSON rows and stores it in an in-memory `datasetStore`.
  - `/query`: runs **rule-based** logic first (totals, averages, high/low, range, **compare** / chart / plot / graph with `chartData`); if no match, sends column names + first 20 rows to Groq. JSON body includes:
    - `answer`: string
    - `source`: `"rule-based"` or `"AI"`
    - `chartData`: optional (`labels[]`, `values[]`, chart `type`)

## Limitations

- **In-memory storage**: uploaded data is lost when the server restarts.
- **Sampling**: rule-based paths use the full in-memory dataset; Groq requests include only the first 20 rows plus column names (by design, to reduce cost and protect data).
- **LLM output variability**: the server validates/normalizes chart data, but some questions may still produce “no chart”.

## Future Improvements

- Persist datasets (SQLite/Postgres) and support multiple uploads/users
- Add column type inference (numbers/dates/categoricals) for more accurate analysis
- Add client-side data preview + column picker for chart requests
- Add streaming responses and conversation history stored on the server
- Add more tests (upload route, CSV parsing edge cases)

