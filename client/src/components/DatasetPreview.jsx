import { useState, useEffect } from "react";

function isNumeric(val) {
  if (val === null || val === undefined || val === "") return false;
  return !isNaN(Number(String(val).replace(/[$,%]/g, "")));
}

function detectNumericCols(columns, rows) {
  if (!rows.length) return new Set();
  return new Set(columns.filter((c) => isNumeric(rows[0]?.[c])));
}

function DataTable({ columns, rows, numericCols }) {
  if (!columns?.length || !rows?.length) return null;
  return (
    <table className="dataTable">
      <thead>
        <tr>
          <th className="dataTableRowNum" aria-hidden="true">#</th>
          {columns.map((col) => (
            <th
              key={col}
              title={col}
              style={{ textAlign: numericCols.has(col) ? "right" : "left", position: "static" }}
            >
              {col}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, ri) => (
          <tr key={ri}>
            <td className="dataTableRowNum" aria-hidden="true">{ri + 1}</td>
            {columns.map((col) => {
              const val = row[col] ?? "";
              return (
                <td
                  key={col}
                  title={String(val)}
                  className={numericCols.has(col) ? "dataTableNum" : undefined}
                  style={{ textAlign: numericCols.has(col) ? "right" : "left" }}
                >
                  {String(val)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Expand modal — shows same 8 preview rows in a large comfortable view */
function ExpandModal({ columns, rows, totalRows, numericCols, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="modalBackdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="expandModalCard">
        {/* Header */}
        <div className="expandModalHeader">
          <div className="expandModalTitleBlock">
            <p className="expandModalTitle">Dataset Preview</p>
            <p className="expandModalSub">
              {rows.length} rows shown &nbsp;·&nbsp; {totalRows.toLocaleString()} total &nbsp;·&nbsp; {columns.length} columns
            </p>
          </div>
          <button className="modalClose" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {/* Table — not scrollable, just fits naturally */}
        <div className="expandModalBody">
          <table className="dataTable expandModalTable">
            <thead>
              <tr>
                <th className="dataTableRowNum" aria-hidden="true">#</th>
                {columns.map((col) => (
                  <th
                    key={col}
                    title={col}
                    style={{ textAlign: numericCols.has(col) ? "right" : "left" }}
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri}>
                  <td className="dataTableRowNum" aria-hidden="true">{ri + 1}</td>
                  {columns.map((col) => {
                    const val = row[col] ?? "";
                    return (
                      <td
                        key={col}
                        title={String(val)}
                        className={numericCols.has(col) ? "dataTableNum" : undefined}
                        style={{ textAlign: numericCols.has(col) ? "right" : "left" }}
                      >
                        {String(val)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default function DatasetPreview({ columns, rows, totalRows }) {
  const [modalOpen, setModalOpen] = useState(false);

  if (!columns?.length || !rows?.length) return null;

  const previewRows = rows.slice(0, 8);
  const total = totalRows ?? rows.length;
  const numericCols = detectNumericCols(columns, previewRows);
  const remaining = total - previewRows.length;

  return (
    <div className="previewWrap">
      <div className="previewMeta">
        <div className="previewMetaLeft">
          <span className="previewTitle">Preview</span>
          <span className="previewBadge">{previewRows.length} of {total.toLocaleString()} rows</span>
        </div>
        <button className="previewExpandBtn" onClick={() => setModalOpen(true)}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="15 3 21 3 21 9" />
            <polyline points="9 21 3 21 3 15" />
            <line x1="21" y1="3" x2="14" y2="10" />
            <line x1="3" y1="21" x2="10" y2="14" />
          </svg>
          Expand
        </button>
      </div>

      <div className="tableScroll">
        <DataTable columns={columns} rows={previewRows} numericCols={numericCols} />
      </div>

      {remaining > 0 && (
        <p className="previewFooterText">+{remaining.toLocaleString()} more rows in dataset</p>
      )}

      {modalOpen && (
        <ExpandModal
          columns={columns}
          rows={previewRows}
          totalRows={total}
          numericCols={numericCols}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}