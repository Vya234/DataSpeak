import UploadPanel from "./UploadPanel.jsx";
import DatasetPreview from "./DatasetPreview.jsx";

export default function DatasetPanel({
  datasetInfo,
  loading,
  onUpload,
  onResetUpload,
}) {
  return (
    <>
      <h2>Dataset</h2>
      <UploadPanel
        onUpload={onUpload}
        onReset={onResetUpload}
        disabled={loading}
        uploadedFileName={datasetInfo?.originalName ?? null}
      />
      {datasetInfo ? (
        <div className="dataset">
          <div className="row">
            <span className="label">File</span>
            <span className="value">{datasetInfo.originalName}</span>
          </div>
          <div className="row">
            <span className="label">Rows</span>
            <span className="value">{datasetInfo.rowCount.toLocaleString()}</span>
          </div>
          <div className="row">
            <span className="label">Cols</span>
            <span className="value">{datasetInfo.columns.length}</span>
          </div>
          <DatasetPreview
            columns={datasetInfo.columns}
            rows={datasetInfo.sampleRows || []}
            totalRows={datasetInfo.rowCount}
          />
        </div>
      ) : (
        <p className="subtle" style={{ marginTop: 12 }}>
          CSV is parsed server-side and held in memory for this session.
        </p>
      )}
    </>
  );
}
