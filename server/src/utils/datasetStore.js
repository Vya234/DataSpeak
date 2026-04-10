/**
 * A tiny in-memory dataset store.
 * Hackathon-friendly: no DB required, but this also means data is lost on server restart.
 */
const datasetStore = (() => {
  let current = null;

  return {
    setDataset(dataset) {
      current = dataset;
    },
    getDataset() {
      return current;
    },
  };
})();

module.exports = { datasetStore };

