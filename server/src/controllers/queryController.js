const { datasetStore } = require("../utils/datasetStore");
const { getInsight } = require("../services/insightService");

async function handleQuery(req, res, next) {
  try {
    const { question } = req.body || {};

    if (!question || typeof question !== "string" || question.trim().length === 0) {
      return res.status(400).json({ error: "Missing 'question' in request body." });
    }

    const dataset = datasetStore.getDataset();
    if (!dataset) {
      return res.status(400).json({ error: "No dataset uploaded yet. Please upload a CSV first." });
    }

    const result = await getInsight({
      question: question.trim(),
      dataset,
    });

    return res.json(result);
  } catch (err) {
    return next(err);
  }
}

module.exports = { handleQuery };

