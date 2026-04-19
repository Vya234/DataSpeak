const { parseCsvBufferToRows } = require("../services/csvService");
const { datasetStore } = require("../utils/datasetStore");

async function uploadCsv(req, res, next) {
  try {
    // Multer provides the uploaded file on `req.file`.
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded. Use form-data field name 'file'." });
    }

    const originalName = req.file.originalname || "uploaded.csv";
    const mime = req.file.mimetype;

    // Basic guardrail: allow typical CSV mimetypes and fall back to extension checks.
    if (
      mime &&
      ![
        "text/csv",
        "application/vnd.ms-excel",
        "application/csv",
        "text/plain",
        "application/octet-stream",
      ].includes(mime)
    ) {
      return res.status(400).json({ error: "Unsupported file type. Please upload a CSV file." });
    }

    const { rows, columns, sampleRows } = await parseCsvBufferToRows(req.file.buffer);

    datasetStore.setDataset({
      originalName,
      uploadedAt: new Date().toISOString(),
      rows,
      columns,
      sampleRows,
    });

    return res.json({
      message: "CSV uploaded and parsed successfully.",
      dataset: {
        originalName,
        rowCount: rows.length,
        columns,
        sampleRows,
      },
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { uploadCsv };

