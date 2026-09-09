/**
 * Shared utilities for channel message attachment rendering.
 * Used by both the inbox channel page and the ChannelView component.
 */

import type { AttachmentMeta } from '@pagespace/lib/types';
export type { AttachmentMeta };

export interface FileRelation {
  id: string;
  mimeType: string | null;
  sizeBytes: number;
}

/**
 * One attachment. Structurally a superset of the legacy per-message fields, so
 * every accessor below reads an attachment row and a legacy message row alike.
 */
export interface MessageAttachmentLike {
  id?: string;
  fileId?: string | null;
  attachmentMeta?: AttachmentMeta | null;
  file?: FileRelation | null;
}

export interface MessageWithAttachment extends MessageAttachmentLike {
  /** Present on rows read since messages gained real attachment rows. */
  attachments?: MessageAttachmentLike[] | null;
}

/**
 * The one compatibility seam between the new attachment rows and the legacy
 * single-attachment columns.
 *
 * A message written since the migration carries `attachments`; one written by
 * an older build carries only `fileId`/`attachmentMeta`/`file`. Callers go
 * through here so both shapes render on a single code path, and so a message
 * whose file was hard-deleted (fileId set to null, meta kept) drops just that
 * tile instead of the whole gallery.
 */
export function getAttachments(m: MessageWithAttachment): MessageAttachmentLike[] {
  if (m.attachments && m.attachments.length > 0) {
    return m.attachments.filter(hasAttachment);
  }
  return hasAttachment(m) ? [m] : [];
}

export function isImageAttachment(m: MessageAttachmentLike): boolean {
  if (m.attachmentMeta?.mimeType?.startsWith('image/')) return true;
  if (m.file?.mimeType?.startsWith('image/')) return true;
  return false;
}

export function isVideoAttachment(m: MessageAttachmentLike): boolean {
  if (m.attachmentMeta?.mimeType?.startsWith('video/')) return true;
  if (m.file?.mimeType?.startsWith('video/')) return true;
  return false;
}

export function getFileId(m: MessageAttachmentLike): string | null {
  return m.fileId || m.file?.id || null;
}

export function getAttachmentName(m: MessageAttachmentLike): string {
  return m.attachmentMeta?.originalName || 'Attachment';
}

export function getAttachmentMimeType(m: MessageAttachmentLike): string {
  return m.attachmentMeta?.mimeType || m.file?.mimeType || '';
}

export function getAttachmentSize(m: MessageAttachmentLike): number | null {
  return m.attachmentMeta?.size ?? m.file?.sizeBytes ?? null;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Whether a single attachment (or a legacy message row) is renderable. A row
 * whose file was hard-deleted keeps its meta but loses its fileId, and there is
 * nothing left to fetch — so it reads as no attachment, exactly as before.
 */
export function hasAttachment(m: MessageAttachmentLike): boolean {
  return !!(m.attachmentMeta || m.file) && getFileId(m) !== null;
}

/** Whether a message has anything to render in its attachment area. */
export function hasAnyAttachment(m: MessageWithAttachment): boolean {
  return getAttachments(m).length > 0;
}
