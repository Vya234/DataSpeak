// Load environment variables before any other imports that read process.env.
const path = require("path");
const dotenv = require("dotenv");

const envRoot = path.join(__dirname, "..", ".env");
const envLocal = path.join(__dirname, ".env");

// Repo root .env (dataspeak/.env) — primary for local dev
const resultRoot = dotenv.config({ path: envRoot });
// Optional server/.env — does not override keys already set
dotenv.config({ path: envLocal });

if (resultRoot.error && !process.env.GROQ_API_KEY) {
  console.warn(
    `[DataSpeak] No env loaded from ${envRoot} (${resultRoot.error.message}). Using server/.env or shell env if present.`
  );
}

if (!process.env.GROQ_API_KEY?.trim()) {
  console.warn("[DataSpeak] GROQ_API_KEY is missing — set it in .env (see .env.example).");
}

const express = require("express");
const cors = require("cors");

const uploadRoutes = require("./src/routes/uploadRoutes");
const queryRoutes = require("./src/routes/queryRoutes");

const app = express();

app.use(
  cors({
    origin: true,
    credentials: false,
  })
);

app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "dataspeak-server" });
});

app.use("/upload", uploadRoutes);
app.use("/query", queryRoutes);

app.use((err, _req, res, _next) => {
  const status = err.statusCode || 500;
  res.status(status).json({
    error: err.message || "Unexpected server error",
  });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 5000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`DataSpeak server running on port ${PORT}`);
  });
}

module.exports = app;
