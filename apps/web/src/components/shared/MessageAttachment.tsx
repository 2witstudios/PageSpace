import { FileIcon, FileText, Download } from 'lucide-react';
import {
  type MessageWithAttachment,
  isImageAttachment,
  getFileId,
  getAttachmentName,
  getAttachmentMimeType,
  getAttachmentSize,
  formatFileSize,
  hasAttachment,
} from '@/lib/attachment-utils';

interface MessageAttachmentProps {
  message: MessageWithAttachment;
}

export function MessageAttachment({ message }: MessageAttachmentProps) {
  if (!hasAttachment(message)) return null;

  const fileId = getFileId(message);
  const name = getAttachmentName(message);
  const mimeType = getAttachmentMimeType(message);
  const size = getAttachmentSize(message);

  if (isImageAttachment(message)) {
    return (
      <div className="mt-2">
        <a
          href={`/api/files/${fileId}/view?filename=${encodeURIComponent(name)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="block max-w-sm"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- auth-gated API route; processor already optimizes on upload */}
          <img
            src={`/api/files/${fileId}/view`}
            alt={name}
            className="rounded-lg max-h-64 object-contain border border-border/50"
          />
        </a>
      </div>
    );
  }

  return (
    <div className="mt-2">
      <a
        href={`/api/files/${fileId}/download?filename=${encodeURIComponent(name)}`}
        className="flex items-center gap-3 p-3 bg-muted/50 hover:bg-muted rounded-lg border border-border/50 max-w-sm transition-colors"
      >
        <div className="w-10 h-10 rounded bg-muted flex items-center justify-center shrink-0">
          {mimeType.includes('pdf') ? (
            <FileText className="h-5 w-5 text-red-500" />
          ) : mimeType.includes('document') || mimeType.includes('word') ? (
            <FileText className="h-5 w-5 text-blue-500" />
          ) : (
            <FileIcon className="h-5 w-5 text-muted-foreground" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{name}</p>
          {size != null && (
            <p className="text-xs text-muted-foreground">
              {formatFileSize(size)}
            </p>
          )}
        </div>
        <Download className="h-4 w-4 text-muted-foreground shrink-0" />
      </a>
    </div>
  );
}
