/**
 * Shared utilities for channel message attachment rendering.
 * Used by both the inbox channel page and the ChannelView component.
 */

export interface AttachmentMeta {
  originalName: string;
  size: number;
  mimeType: string;
  contentHash: string;
}

export interface FileRelation {
  id: string;
  mimeType: string | null;
  sizeBytes: number;
}

interface MessageWithAttachment {
  fileId?: string | null;
  attachmentMeta?: AttachmentMeta | null;
  file?: FileRelation | null;
}

export function isImageAttachment(m: MessageWithAttachment): boolean {
  if (m.attachmentMeta?.mimeType?.startsWith('image/')) return true;
  if (m.file?.mimeType?.startsWith('image/')) return true;
  return false;
}

export function getFileId(m: MessageWithAttachment): string | null {
  return m.fileId || m.file?.id || null;
}

export function getAttachmentName(m: MessageWithAttachment): string {
  return m.attachmentMeta?.originalName || 'Attachment';
}

export function getAttachmentMimeType(m: MessageWithAttachment): string {
  return m.attachmentMeta?.mimeType || m.file?.mimeType || '';
}

export function getAttachmentSize(m: MessageWithAttachment): number | null {
  return m.attachmentMeta?.size ?? m.file?.sizeBytes ?? null;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function hasAttachment(m: MessageWithAttachment): boolean {
  return !!(m.attachmentMeta || m.file) && getFileId(m) !== null;
}
