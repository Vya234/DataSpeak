/** First rows of the uploaded dataset as a compact table. */
export default function DatasetPreview({ columns, rows }) {
  if (!columns?.length || !rows?.length) return null;

  return (
    <div className="previewWrap">
      <p className="previewTitle">Preview (first {rows.length} rows)</p>
      <div className="tableScroll">
        <table className="dataTable">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri}>
                {columns.map((c) => (
                  <td key={c}>{row[c] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
