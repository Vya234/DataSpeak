import { useCallback, useRef, useState } from "react";

function FileIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="16 16 12 12 8 16" />
      <line x1="12" y1="12" x2="12" y2="21" />
      <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3" />
    </svg>
  );
}

export default function UploadPanel({ onUpload, onReset, disabled, uploadedFileName }) {
  const inputRef = useRef(null);
  const [pendingFile, setPendingFile] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [justUploaded, setJustUploaded] = useState(false);

  const openPicker = useCallback(() => {
    if (!disabled) inputRef.current?.click();
  }, [disabled]);

  function pickFile(file) {
    if (!file) return;
    const extOk = file.name.toLowerCase().endsWith(".csv");
    const typeOk =
      !file.type ||
      file.type.includes("csv") ||
      file.type === "text/plain" ||
      file.type === "application/vnd.ms-excel";
    if (!extOk && !typeOk) return;
    setPendingFile(file);
  }

  function onInputChange(e) {
    const f = e.target.files?.[0];
    if (f) pickFile(f);
    e.target.value = "";
  }

  function onDrop(e) {
    e.preventDefault();
    setDragOver(false);
    if (disabled) return;
    const f = e.dataTransfer.files?.[0];
    if (f) pickFile(f);
  }

  function clearPending() {
    setPendingFile(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function submitUpload(e) {
    e.preventDefault();
    if (!pendingFile) return;
    setJustUploaded(false);
    const ok = await onUpload(pendingFile);
    if (ok) {
      setPendingFile(null);
      setJustUploaded(true);
      setTimeout(() => setJustUploaded(false), 2400);
    }
  }

  function handleReset() {
    clearPending();
    setJustUploaded(false);
    onReset?.();
  }

  if (uploadedFileName) {
    return (
      <div className="uploadState">
        <div className="uploadSuccessRow">
          <span className="uploadFileIcon" aria-hidden>
            <FileIcon size={18} />
          </span>
          <span className="uploadFileName">{uploadedFileName}</span>
          <button type="button" className="btnGhost btnSm" onClick={handleReset} disabled={disabled}>
            Remove
          </button>
        </div>
        {justUploaded && <p className="uploadFlash">✓ Ready to query</p>}
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          className="srOnly"
          onChange={onInputChange}
          disabled={disabled}
        />
      </div>
    );
  }

  return (
    <div className="uploadState">
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        className="srOnly"
        onChange={onInputChange}
        disabled={disabled}
      />

      <div
        className={`dropzone${dragOver ? " dropzoneActive" : ""}${disabled ? " dropzoneDisabled" : ""}`}
        onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={openPicker}
        role="button"
        tabIndex={0}
        aria-label="Upload CSV file"
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPicker(); }
        }}
      >
        <div className="dropzoneIcon">
          <UploadIcon />
        </div>
        <p className="dropzoneText">Drop CSV here or click to browse</p>
        <p className="dropzoneHint">.csv files only · up to any size</p>
      </div>

      {pendingFile && (
        <div className="pendingFileRow">
          <span className="uploadFileIcon" style={{ color: "var(--accent)" }} aria-hidden>
            <FileIcon size={18} />
          </span>
          <span className="uploadFileName">{pendingFile.name}</span>
          <button type="button" className="btnGhost btnSm" onClick={clearPending} disabled={disabled}>
            Clear
          </button>
          <button
            type="button"
            className="button buttonInline"
            onClick={submitUpload}
            disabled={disabled}
          >
            Upload
          </button>
        </div>
      )}

      {justUploaded && <p className="uploadFlash">✓ Uploaded successfully</p>}
    </div>
  );
}