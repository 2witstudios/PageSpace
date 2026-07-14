import { formatBytes, type FileReadResult } from "../../lib/pagespace";

interface FileViewProps {
  file: FileReadResult;
}

const STATUS_LABEL: Record<FileReadResult["status"], string> = {
  pending: "Pending",
  processing: "Processing",
  failed: "Failed",
  visual: "Ready",
};

export function FileView({ file }: FileViewProps) {
  const meta = file.fileMetadata;
  return (
    <div className="file-card">
      <div className="file-card-icon">📎</div>
      <div className="file-card-body">
        <h3>{meta?.originalFileName ?? "Untitled file"}</h3>
        <p className="muted">
          {meta?.mimeType ?? "unknown type"} · {formatBytes(meta?.fileSize)}
        </p>
        <span className={`badge file-status-${file.status}`}>{STATUS_LABEL[file.status]}</span>
        {file.error && <p className="error-text">{file.error}</p>}
        {file.suggestion && <p className="muted">{file.suggestion}</p>}
        {file.processingError && <p className="error-text">{file.processingError}</p>}
        {file.message && <p className="muted">{file.message}</p>}
      </div>
    </div>
  );
}
