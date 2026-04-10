import { useCallback, useRef, useState } from "react";

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
      setTimeout(() => setJustUploaded(false), 2200);
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
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="12" y1="18" x2="12" y2="12" />
              <line x1="9" y1="15" x2="15" y2="15" />
            </svg>
          </span>
          <span className="uploadFileName">{uploadedFileName}</span>
          <button type="button" className="btnGhost btnSm" onClick={handleReset} disabled={disabled}>
            Remove
          </button>
        </div>
        {justUploaded ? <p className="uploadFlash">✓ Ready to query</p> : null}
        <input ref={inputRef} type="file" accept=".csv,text/csv" className="srOnly" onChange={onInputChange} disabled={disabled} />
      </div>
    );
  }

  return (
    <div className="uploadState">
      <input ref={inputRef} type="file" accept=".csv,text/csv" className="srOnly" onChange={onInputChange} disabled={disabled} />
      <div
        className={`dropzone ${dragOver ? "dropzoneActive" : ""} ${disabled ? "dropzoneDisabled" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={openPicker}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openPicker();
          }
        }}
      >
        <p className="dropzoneText">Drag &amp; drop CSV or click to upload</p>
        <p className="dropzoneHint">.csv files only</p>
      </div>

      {pendingFile ? (
        <form className="pendingFileRow" onSubmit={submitUpload}>
          <span className="uploadFileIcon" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
          </span>
          <span className="uploadFileName">{pendingFile.name}</span>
          <button type="button" className="btnGhost btnSm" onClick={clearPending} disabled={disabled}>
            Clear
          </button>
          <button type="submit" className="button buttonInline" disabled={disabled}>
            Upload
          </button>
        </form>
      ) : null}

      {justUploaded ? <p className="uploadFlash">✓ Uploaded</p> : null}
    </div>
  );
}
