const { Readable } = require("stream");
const csv = require("csv-parser");

/**
 * Parse a CSV buffer into rows and some lightweight metadata.
 * We keep the full parsed dataset in memory (hackathon-friendly),
 * but we also compute a small sample to send to the LLM.
 */
function parseCsvBufferToRows(buffer, { maxRows = 20000, sampleSize = 25 } = {}) {
  return new Promise((resolve, reject) => {
    const rows = [];
    let columns = [];

    const stream = Readable.from(buffer);
    stream
      .pipe(csv())
      .on("headers", (headers) => {
        columns = Array.isArray(headers) ? headers : [];
      })
      .on("data", (data) => {
        if (rows.length < maxRows) {
          rows.push(data);
        }
      })
      .on("end", () => {
        const sampleRows = rows.slice(0, Math.min(sampleSize, rows.length));
        resolve({ rows, columns, sampleRows });
      })
      .on("error", (err) => {
        reject(err);
      });
  });
}

module.exports = { parseCsvBufferToRows };

