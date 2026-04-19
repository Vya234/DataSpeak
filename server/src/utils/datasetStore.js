/**
 * A tiny in-memory dataset store.
 * Hackathon-friendly: no DB required, but this also means data is lost on server restart.
 */
const datasetStore = (() => {
  let current = null;
  /** @type {object|null} Last answer computation metadata (source-transparency). */
  let lastQueryMeta = null;

  return {
    setDataset(dataset) {
      current = dataset;
    },
    getDataset() {
      return current;
    },
    setLastQueryMeta(meta) {
      lastQueryMeta = meta && typeof meta === "object" ? { ...meta } : null;
    },
    getLastQueryMeta() {
      return lastQueryMeta;
    },
  };
})();

module.exports = { datasetStore };

