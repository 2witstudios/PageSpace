/**
 * Effectful orchestration for direct-to-S3 channel/DM attachment uploads.
 *
 * Lives in apps/web (not @pagespace/lib) because the S3 presign effects are
 * web-local — mirroring the page-file presign/complete routes. All decision
 * logic is delegated to the pure core in @pagespace/lib/services/attachment-upload-core;
 * this module only sequences effects (quota, semaphore, S3, DB, processor verify,
 * audit) and maps them to an {status, body} result the thin routes return verbatim.
 */

import {
  getUserStorageQuota,
  checkStorageQuota,
  updateActiveUploads,
  updateStorageUsage,
} from '@pagespace/lib/services/storage-limits';
import { uploadSemaphore } from '@pagespace/lib/services/upload-semaphore';
import { buildS3Key } from '@pagespace/lib/services/upload-validation';
import { attachmentUploadRepository } from '@pagespace/lib/services/attachment-upload-repository';
import {
  validateAttachmentPresign,
  buildAttachmentFileRecord,
  buildAttachmentResult,
  slotTargetMatches,
  attachmentFileDriveId,
  type AttachmentTarget,
} from '@pagespace/lib/services/attachment-upload-core';
import { sanitizeFilenameForHeader } from '@pagespace/lib/utils/file-security';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { getActorInfo, logFileActivity } from '@pagespace/lib/monitoring/activity-logger';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { checkObjectExists, issuePresignedPutUrl } from './s3-effects';
import { verifyAttachmentBytes } from './attachment-verify-effect';

const PRESIGN_TTL = 900;

export interface OrchestratorResult {
  status: number;
  body: Record<string, unknown>;
}

export interface PresignAttachmentArgs {
  userId: string;
  target: AttachmentTarget;
  request: Request;
  contentHash: string;
  filename: string;
  mimeType: string;
  fileSize: number;
}

/**
 * Reserve an upload slot and issue a presigned PUT URL (or signal dedup). The
 * slot carries the server-trusted hash/size/mime + target binding so /complete
 * can't be replayed with divergent params or against a different target.
 */
export async function presignAttachment(args: PresignAttachmentArgs): Promise<OrchestratorResult> {
  const { userId, target, request, contentHash, filename, mimeType, fileSize } = args;

  const quota = await getUserStorageQuota(userId);
  if (!quota) return { status: 500, body: { error: 'Could not retrieve storage quota' } };

  const validation = validateAttachmentPresign({ contentHash, mimeType, fileSize, tier: quota.tier });
  if (!validation.ok) return { status: validation.status, body: { error: validation.error } };
  const canonicalHash = validation.canonicalHash;

  const quotaCheck = await checkStorageQuota(userId, fileSize);
  if (!quotaCheck.allowed) {
    return { status: 413, body: { error: quotaCheck.reason, storageInfo: quotaCheck.quota } };
  }

  const key = buildS3Key(canonicalHash);
  const exists = await checkObjectExists(key);

  const jobId = await uploadSemaphore.acquireUploadSlot(userId, quota.tier, fileSize, {
    contentHash: canonicalHash,
    driveId: attachmentFileDriveId(target) ?? '',
    fileSize,
    mimeType,
    attachmentTarget: target,
  });
  if (!jobId) {
    return {
      status: 429,
      body: { error: 'Too many concurrent uploads. Please wait for current uploads to complete.' },
    };
  }

  // Any failure after the slot is acquired must release it, or it leaks until the
  // semaphore's stale-slot sweep.
  try {
    await updateActiveUploads(userId, 1);

    if (exists) {
      return { status: 200, body: { alreadyExists: true, jobId, key } };
    }

    const url = await issuePresignedPutUrl(key, mimeType, fileSize, PRESIGN_TTL);
    const expiresAt = new Date(Date.now() + PRESIGN_TTL * 1000).toISOString();

    auditRequest(request, {
      eventType: 'data.write',
      userId,
      resourceType: 'file',
      resourceId: canonicalHash,
      details: { action: 'attachment-presign', targetType: target.type, filename, fileSize },
    });

    return { status: 200, body: { url, jobId, key, expiresAt } };
  } catch (err) {
    uploadSemaphore.releaseUploadSlot(jobId);
    await updateActiveUploads(userId, -1).catch(() => undefined);
    throw err;
  }
}

export interface CompleteAttachmentArgs {
  userId: string;
  target: AttachmentTarget;
  request: Request;
  jobId: string;
  filename: string;
}

/**
 * Finalize an attachment upload: verify the slot/target binding, re-hash the
 * stored bytes via the processor (zero-trust), then create the content-addressed
 * `files` row + the page/conversation linkage and charge storage. Returns the
 * target-agnostic FileAttachment the client references when sending the message.
 */
export async function completeAttachment(args: CompleteAttachmentArgs): Promise<OrchestratorResult> {
  const { userId, target, request, jobId, filename } = args;

  // hash/size/mime + target come from the presign-reserved slot, never the body —
  // and the slot must be an attachment slot bound to *this* target.
  const reserved = uploadSemaphore.getSlotMetadata(jobId, userId);
  if (!reserved || !reserved.attachmentTarget || !slotTargetMatches(reserved.attachmentTarget, target)) {
    return { status: 403, body: { error: 'Invalid or expired jobId' } };
  }
  // The slot's mimeType is the client-declared type; we persist the verified
  // (Magika-detected) MIME from the processor instead, so it isn't read here.
  const { contentHash, fileSize } = reserved;

  // Synchronous byte verification before any rows exist. The processor re-hashes
  // the stored object (deleting it on mismatch) and returns the true MIME type.
  const verify = await verifyAttachmentBytes({ userId, target, contentHash });
  if (!verify.ok) {
    uploadSemaphore.releaseUploadSlot(jobId);
    await updateActiveUploads(userId, -1).catch(() => undefined);
    return { status: verify.status, body: { error: verify.error } };
  }
  const storedMime = verify.detectedMime;

  try {
    await attachmentUploadRepository.saveFileRecord(
      buildAttachmentFileRecord({ contentHash, target, fileSize, mimeType: storedMime, userId }),
    );
    await attachmentUploadRepository.linkFileToTarget({ target, fileId: contentHash, userId });
  } catch (err) {
    uploadSemaphore.releaseUploadSlot(jobId);
    await updateActiveUploads(userId, -1).catch(() => undefined);
    throw err;
  }

  uploadSemaphore.releaseUploadSlot(jobId);

  // The file is linked. Everything below is best-effort bookkeeping — a failure
  // here must not turn a successful upload into a 500 (which would make the client
  // retry and double-charge storage).
  try {
    await updateActiveUploads(userId, -1);
    await updateStorageUsage(userId, fileSize, {
      driveId: attachmentFileDriveId(target) ?? undefined,
      eventType: 'upload',
    });
    auditRequest(request, {
      eventType: 'data.write',
      userId,
      resourceType: target.type === 'page' ? 'channel_upload' : 'dm_upload',
      resourceId: contentHash,
      details: { targetId: target.type === 'page' ? target.pageId : target.conversationId },
    });
    const actorInfo = await getActorInfo(userId);
    logFileActivity(
      userId,
      'upload',
      {
        fileId: contentHash,
        fileName: filename,
        fileType: storedMime,
        fileSize,
        driveId: attachmentFileDriveId(target),
        pageId: target.type === 'page' ? target.pageId : undefined,
      },
      actorInfo,
    );
  } catch (err) {
    loggers.api.error('Post-commit bookkeeping failed for attachment upload', err as Error);
  }

  const file = buildAttachmentResult({
    contentHash,
    originalName: filename,
    sanitizedName: sanitizeFilenameForHeader(filename),
    size: fileSize,
    mimeType: storedMime,
  });

  return { status: 200, body: { success: true, file } };
}

/**
 * Release a presign-reserved slot when the client-side PUT fails before
 * /complete. The slot is user-owned, so identity (not the target) gates it.
 */
export async function cancelAttachment(args: { userId: string; jobId: string }): Promise<OrchestratorResult> {
  const { userId, jobId } = args;

  if (!uploadSemaphore.verifySlotOwner(jobId, userId)) {
    return { status: 403, body: { error: 'Invalid or expired jobId' } };
  }

  uploadSemaphore.releaseUploadSlot(jobId);
  await updateActiveUploads(userId, -1).catch(() => undefined);
  return { status: 200, body: { success: true } };
}
