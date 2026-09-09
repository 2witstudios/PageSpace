/**
 * Pure decision core for the direct-to-S3 attachment-upload pipeline.
 *
 * Everything here is deterministic and side-effect free — no DB, no S3, no
 * fetch, no clock. The effectful orchestration (S3 presign, semaphore, DB
 * writes, processor verify) lives in apps/web and calls these helpers, so the
 * decision logic stays exhaustively unit-testable without mocks.
 *
 * @module @pagespace/lib/services/attachment-upload-core
 */

import {
  validateContentHash,
  validateFileSize,
  validateMimeTypeDeclaration,
} from './upload-validation';
import type { SubscriptionTier } from './subscription-utils';
import type { AttachmentMeta } from '@pagespace/db/schema/storage';

/**
 * Most files one message may carry.
 *
 * Enforced in four places, deliberately: the composer (UX), both send routes
 * (the actual limit), the repositories (defense in depth for non-HTTP callers
 * like page webhooks and AI tools), and the database itself — the
 * `*_position_range` CHECK plus the unique (messageId, position) index cap
 * cardinality with no trigger and no counter column. The DB literal cannot
 * import this constant, so `attachment-upload-core.test.ts` pins the two together;
 * raising the cap means a new migration, not just editing this line.
 */
export const MAX_MESSAGE_ATTACHMENTS = 10;

/** One attachment as it arrives on a send request. */
export interface MessageAttachmentInput {
  fileId: string;
  attachmentMeta: AttachmentMeta;
}

/**
 * Shape check for a client-supplied `attachmentMeta`. Hoisted out of the DM
 * send route, which was the only surface validating it — the channel route
 * accepted any JSON at all.
 */
function isValidAttachmentMeta(value: unknown): value is AttachmentMeta {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.originalName === 'string' &&
    typeof m.size === 'number' &&
    typeof m.mimeType === 'string' &&
    typeof m.contentHash === 'string'
  );
}

type ParseAttachmentsResult =
  | { kind: 'ok'; attachments: MessageAttachmentInput[] }
  | { kind: 'invalid'; error: string };

/**
 * Normalize a send request's attachment payload into an ordered array.
 *
 * Accepts both the new `attachments: [{ fileId, attachmentMeta }]` shape and
 * the legacy singular `fileId` + `attachmentMeta` pair, so the published SDK
 * and CLI keep working unchanged against a server that understands N.
 * Supplying both is rejected rather than guessed at.
 */
export function parseMessageAttachments(body: {
  attachments?: unknown;
  fileId?: unknown;
  attachmentMeta?: unknown;
}): ParseAttachmentsResult {
  const hasLegacy = typeof body.fileId === 'string' && body.fileId.length > 0;
  const hasArray = body.attachments !== undefined && body.attachments !== null;

  if (hasArray && hasLegacy) {
    return { kind: 'invalid', error: 'Provide either attachments or fileId, not both' };
  }

  if (!hasArray) {
    if (!hasLegacy) return { kind: 'ok', attachments: [] };
    if (!isValidAttachmentMeta(body.attachmentMeta)) {
      return { kind: 'invalid', error: 'attachmentMeta required when fileId is provided' };
    }
    return {
      kind: 'ok',
      attachments: [{ fileId: body.fileId as string, attachmentMeta: body.attachmentMeta }],
    };
  }

  if (!Array.isArray(body.attachments)) {
    return { kind: 'invalid', error: 'attachments must be an array' };
  }
  if (body.attachments.length > MAX_MESSAGE_ATTACHMENTS) {
    return {
      kind: 'invalid',
      error: `A message may carry at most ${MAX_MESSAGE_ATTACHMENTS} attachments`,
    };
  }

  const attachments: MessageAttachmentInput[] = [];
  for (const raw of body.attachments) {
    if (typeof raw !== 'object' || raw === null) {
      return { kind: 'invalid', error: 'Each attachment must be an object' };
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.fileId !== 'string' || entry.fileId.length === 0) {
      return { kind: 'invalid', error: 'Each attachment requires a fileId' };
    }
    if (!isValidAttachmentMeta(entry.attachmentMeta)) {
      return { kind: 'invalid', error: 'Each attachment requires a valid attachmentMeta' };
    }
    attachments.push({ fileId: entry.fileId, attachmentMeta: entry.attachmentMeta });
  }
  return { kind: 'ok', attachments };
}

/** Insert shape for the content-addressed `files` row. */
export interface FileRecordInput {
  id: string;
  driveId: string | null;
  sizeBytes: number;
  mimeType: string;
  storagePath: string;
  createdBy: string;
}

/**
 * Upload destination — discriminated by target type.
 *
 * - `page`: channel page in a drive. Files get a real driveId and a `file_pages` linkage.
 * - `conversation`: DM conversation outside any drive. Files have null driveId and a
 *   `file_conversations` linkage; access is governed by participant membership.
 */
export type AttachmentTarget =
  | { type: 'page'; pageId: string; driveId: string }
  | { type: 'conversation'; conversationId: string };

export interface AttachmentUploadFileResult {
  id: string;
  originalName: string;
  sanitizedName: string;
  size: number;
  mimeType: string;
  contentHash: string;
}

export type PresignValidation =
  | { ok: true; canonicalHash: string }
  | { ok: false; status: number; error: string };

/**
 * Validate a presign request the same way the page-file flow does: hash shape,
 * declared MIME against the inline-dangerous denylist, and per-tier size limit.
 * Returns the canonicalized (lowercase) hash so the same digest always maps to
 * one S3 key. Status codes mirror the page-file routes (400 for bad hash/MIME,
 * 413 for an oversize file).
 */
export function validateAttachmentPresign(input: {
  contentHash: string;
  mimeType: string;
  fileSize: number;
  tier: SubscriptionTier;
}): PresignValidation {
  const hashResult = validateContentHash(input.contentHash);
  if (!hashResult.ok) return { ok: false, status: 400, error: hashResult.error.message };

  const mimeResult = validateMimeTypeDeclaration(input.mimeType);
  if (!mimeResult.ok) return { ok: false, status: 400, error: mimeResult.error.message };

  const sizeResult = validateFileSize(input.fileSize, input.tier);
  if (!sizeResult.ok) return { ok: false, status: 413, error: sizeResult.error.message };

  return { ok: true, canonicalHash: hashResult.value };
}

/** A page target's drive id; null for a conversation (DM files live outside any drive). */
export function attachmentFileDriveId(target: AttachmentTarget): string | null {
  return target.type === 'page' ? target.driveId : null;
}

/**
 * Build the content-addressed `files` row for an attachment. The row id and
 * storagePath are both the content hash; the S3 key is derived from the hash at
 * read time via buildS3Key / generatePresignedUrl.
 */
export function buildAttachmentFileRecord(input: {
  contentHash: string;
  target: AttachmentTarget;
  fileSize: number;
  mimeType: string;
  userId: string;
}): FileRecordInput {
  return {
    id: input.contentHash,
    driveId: attachmentFileDriveId(input.target),
    sizeBytes: input.fileSize,
    mimeType: input.mimeType,
    storagePath: input.contentHash,
    createdBy: input.userId,
  };
}

/** Map a stored attachment to the target-agnostic client `FileAttachment` shape. */
export function buildAttachmentResult(input: {
  contentHash: string;
  originalName: string;
  sanitizedName: string;
  size: number;
  mimeType: string;
}): AttachmentUploadFileResult {
  return {
    id: input.contentHash,
    originalName: input.originalName,
    sanitizedName: input.sanitizedName,
    size: input.size,
    mimeType: input.mimeType,
    contentHash: input.contentHash,
  };
}

/**
 * Whether a presign-reserved slot's target identity matches the target of the
 * /complete (or /cancel) route it's being replayed against. Binds a jobId to its
 * conversation/page so a slot reserved for one target can't complete against
 * another (even one the same user can access).
 */
export function slotTargetMatches(a: AttachmentTarget, b: AttachmentTarget): boolean {
  if (a.type === 'page' && b.type === 'page') {
    return a.pageId === b.pageId && a.driveId === b.driveId;
  }
  if (a.type === 'conversation' && b.type === 'conversation') {
    return a.conversationId === b.conversationId;
  }
  return false;
}
