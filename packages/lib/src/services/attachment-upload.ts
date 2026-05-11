/**
 * Polymorphic attachment upload pipeline.
 *
 * Channel uploads (target.type === 'page') and DM uploads (target.type === 'conversation')
 * share quota, semaphore, dedup, and audit logic. The route layer constructs an
 * AttachmentTarget and delegates here; differences between page and conversation flows
 * (token resource binding, file row driveId, linkage table) are concentrated in this module.
 *
 * @module @pagespace/lib/services/attachment-upload
 */

import { createHash } from 'node:crypto';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { dmConversations } from '@pagespace/db/schema/social';
import { sessionService } from '../auth/session-service';
import type { EnforcedAuthContext } from '../permissions/enforced-context';
import { loggers } from '../logging/logger-config';
import {
  createUploadServiceToken,
  isPermissionDeniedError,
  PermissionDeniedError,
  type ServiceScope,
} from './validated-service-token';
import { attachmentUploadRepository } from './attachment-upload-repository';
import {
  checkStorageQuota,
  formatBytes,
  getUserStorageQuota,
  updateStorageUsage,
} from './storage-limits';
import { uploadSemaphore } from './upload-semaphore';
import { sanitizeFilenameForHeader } from '../utils/file-security';
import { auditRequest } from '../audit/audit-log';
import { getActorInfo, logFileActivity } from '../monitoring/activity-logger';

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

const UPLOAD_SCOPES: ServiceScope[] = ['files:write'];
const CONVERSATION_TOKEN_EXPIRY_MS = 10 * 60 * 1000; // match createUploadServiceToken default

export interface CreateAttachmentUploadServiceTokenArgs {
  userId: string;
  target: AttachmentTarget;
}

export interface AttachmentUploadServiceToken {
  token: string;
}

/**
 * Mint an upload service token bound to the given attachment target.
 *
 * Page target delegates to {@link createUploadServiceToken} with `parentId === pageId`,
 * preserving the channel-route behavior at apps/web/src/app/api/channels/[pageId]/upload/route.ts:127-144.
 *
 * Conversation target validates participant membership of the DM, then mints a session
 * with `resourceType: 'conversation'` and no driveId — DM files have no drive.
 *
 * @throws PermissionDeniedError if the caller lacks permission for the target.
 */
export async function createAttachmentUploadServiceToken(
  args: CreateAttachmentUploadServiceTokenArgs
): Promise<AttachmentUploadServiceToken> {
  const { userId, target } = args;

  switch (target.type) {
    case 'page': {
      const result = await createUploadServiceToken({
        userId,
        driveId: target.driveId,
        pageId: target.pageId,
        parentId: target.pageId,
      });
      loggers.api.info('Attachment upload token grant', {
        userId,
        targetType: 'page',
        pageId: target.pageId,
        driveId: target.driveId,
        scopes: UPLOAD_SCOPES,
      });
      return { token: result.token };
    }

    case 'conversation': {
      const conversation = await db.query.dmConversations.findFirst({
        where: eq(dmConversations.id, target.conversationId),
        columns: {
          id: true,
          participant1Id: true,
          participant2Id: true,
        },
      });

      if (!conversation) {
        loggers.api.warn('Upload token denied: conversation not found', {
          userId,
          conversationId: target.conversationId,
        });
        throw new PermissionDeniedError('Permission denied');
      }

      const isParticipant =
        conversation.participant1Id === userId || conversation.participant2Id === userId;
      if (!isParticipant) {
        loggers.api.warn('Upload token denied: not a conversation participant', {
          userId,
          conversationId: target.conversationId,
        });
        throw new PermissionDeniedError('Permission denied');
      }

      const token = await sessionService.createSession({
        userId,
        type: 'service',
        scopes: UPLOAD_SCOPES as string[],
        resourceType: 'conversation',
        resourceId: target.conversationId,
        expiresInMs: CONVERSATION_TOKEN_EXPIRY_MS,
        createdByService: 'web',
      });

      loggers.api.info('Attachment upload token grant', {
        userId,
        targetType: 'conversation',
        conversationId: target.conversationId,
        scopes: UPLOAD_SCOPES,
      });

      return { token };
    }

    default: {
      // Exhaustiveness check — the type system should prevent reaching this branch,
      // but a runtime guard protects against unsafe casts at the route boundary.
      const _exhaustive: never = target;
      void _exhaustive;
      throw new Error(
        `Unknown attachment target type: ${(target as { type?: unknown }).type}`
      );
    }
  }
}

const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:3003';
const PROCESSOR_TIMEOUT_MS = 60_000;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

export interface ProcessAttachmentUploadArgs {
  request: Request;
  target: AttachmentTarget;
  authContext: EnforcedAuthContext;
}

export interface AttachmentUploadFileResult {
  id: string;
  originalName: string;
  sanitizedName: string;
  size: number;
  mimeType: string;
  contentHash: string;
}

interface ProcessorUploadResult {
  contentHash?: unknown;
  size?: unknown;
}

type SingleFileResult =
  | { ok: true; file: AttachmentUploadFileResult; storageInfo?: { used: number; quota: number; formattedUsed: string; formattedQuota: string } }
  | { ok: false; error: string; status: number };

async function uploadOneFile(
  file: File,
  target: AttachmentTarget,
  userId: string,
  request: Request
): Promise<SingleFileResult> {
  let uploadSlot: string | null = null;
  let uploadSlotReleased = false;

  const releaseSlot = () => {
    if (uploadSlot && !uploadSlotReleased) {
      uploadSemaphore.releaseUploadSlot(uploadSlot);
      uploadSlotReleased = true;
    }
  };

  try {
    const quotaCheck = await checkStorageQuota(userId, file.size);
    if (!quotaCheck.allowed) {
      return { ok: false, error: quotaCheck.reason ?? 'Storage quota exceeded', status: 413 };
    }

    const userQuota = await getUserStorageQuota(userId);
    if (!userQuota) {
      return { ok: false, error: 'Could not retrieve storage quota', status: 500 };
    }

    uploadSlot = await uploadSemaphore.acquireUploadSlot(userId, userQuota.tier, file.size);
    if (!uploadSlot) {
      return {
        ok: false,
        error: 'Too many concurrent uploads. Please wait for current uploads to complete.',
        status: 429,
      };
    }

    const mimeType = file.type || 'application/octet-stream';
    const sanitizedFileName = sanitizeFilenameForHeader(file.name);
    const expectedContentHash = await computeFileSha256(file);

    let serviceToken: string;
    try {
      const tok = await createAttachmentUploadServiceToken({ userId, target });
      serviceToken = tok.token;
    } catch (error) {
      if (isPermissionDeniedError(error)) {
        releaseSlot();
        return { ok: false, error: 'Permission denied for file upload', status: 403 };
      }
      throw error;
    }

    const processorFormData = new FormData();
    processorFormData.append('file', file);
    processorFormData.append('userId', userId);
    if (target.type === 'page') {
      processorFormData.append('pageId', target.pageId);
      processorFormData.append('driveId', target.driveId);
    } else {
      processorFormData.append('conversationId', target.conversationId);
    }

    const processorResponse = await fetch(`${PROCESSOR_URL}/api/upload/single`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${serviceToken}` },
      body: processorFormData,
      signal: AbortSignal.timeout(PROCESSOR_TIMEOUT_MS),
    });

    if (!processorResponse.ok) {
      const errorData = await processorResponse.json().catch(() => ({}));
      throw new Error((errorData as { error?: string })?.error || 'Processor upload failed');
    }

    const processorResult = (await processorResponse.json()) as ProcessorUploadResult;
    const integrityCheck = validateProcessorResult(processorResult, {
      expectedContentHash,
      expectedSize: file.size,
    });

    if (!integrityCheck.valid) {
      loggers.api.warn('Processor upload integrity check failed', {
        reason: integrityCheck.reason,
        targetType: target.type,
        userId,
      });
      releaseSlot();
      return { ok: false, error: 'Processor upload integrity check failed', status: 502 };
    }

    const { contentHash, resolvedSize } = integrityCheck;
    const fileDriveId = target.type === 'page' ? target.driveId : null;

    await attachmentUploadRepository.saveFileRecord({
      id: contentHash,
      driveId: fileDriveId,
      sizeBytes: resolvedSize,
      mimeType,
      storagePath: contentHash,
      createdBy: userId,
    });

    await attachmentUploadRepository.linkFileToTarget({
      target,
      fileId: contentHash,
      userId,
    });

    await updateStorageUsage(userId, file.size, {
      driveId: target.type === 'page' ? target.driveId : undefined,
      eventType: 'upload',
    });

    auditRequest(request, {
      eventType: 'data.write',
      userId,
      resourceType: target.type === 'page' ? 'channel_upload' : 'dm_upload',
      resourceId: contentHash,
    });

    const actorInfo = await getActorInfo(userId);
    logFileActivity(
      userId,
      'upload',
      {
        fileId: contentHash,
        fileName: file.name,
        fileType: mimeType,
        fileSize: resolvedSize,
        driveId: fileDriveId,
        pageId: target.type === 'page' ? target.pageId : undefined,
      },
      actorInfo
    );

    releaseSlot();

    const updatedQuota = await getUserStorageQuota(userId);

    auditRequest(request, {
      eventType: 'data.write',
      userId,
      resourceType: 'file',
      resourceId: target.type === 'page' ? target.pageId : target.conversationId,
      details: { source: target.type === 'page' ? 'channel-upload' : 'dm-upload' },
    });

    return {
      ok: true,
      file: {
        id: contentHash,
        originalName: file.name,
        sanitizedName: sanitizedFileName,
        size: resolvedSize,
        mimeType,
        contentHash,
      },
      storageInfo: updatedQuota
        ? {
            used: updatedQuota.usedBytes,
            quota: updatedQuota.quotaBytes,
            formattedUsed: formatBytes(updatedQuota.usedBytes),
            formattedQuota: formatBytes(updatedQuota.quotaBytes),
          }
        : undefined,
    };
  } catch (error) {
    loggers.api.error('Attachment upload error', error as Error);
    releaseSlot();
    return { ok: false, error: 'Failed to upload file', status: 500 };
  } finally {
    releaseSlot();
  }
}

/**
 * Owns the full attachment-upload pipeline shared by channel and DM uploads.
 *
 * The caller is responsible for target-specific authorization (e.g. canUserEditPage
 * for channels), but the user identity must come from a validated EnforcedAuthContext.
 * This function then enforces user-scoped concerns — quota, semaphore, dedup, audit —
 * that must be identical across targets.
 *
 * Returns a Response with a target-agnostic JSON shape so the client uploader
 * does not have to branch.
 */
export async function processAttachmentUpload(
  args: ProcessAttachmentUploadArgs
): Promise<Response> {
  const { request, target, authContext } = args;
  const { userId } = authContext;

  const formData = await request.formData();
  const file = formData.get('file');
  if (!(file instanceof File)) {
    return jsonResponse({ error: 'No file provided' }, 400);
  }

  const result = await uploadOneFile(file, target, userId, request);
  if (!result.ok) {
    return jsonResponse({ error: result.error }, result.status);
  }
  return jsonResponse({ success: true, ...result });
}

export interface ProcessAttachmentUploadsArgs {
  request: Request;
  target: AttachmentTarget;
  authContext: EnforcedAuthContext;
}

/**
 * Batch variant of the attachment-upload pipeline. Reads all `file` fields from the
 * request body, processes them serially (to avoid semaphore contention), and returns
 * an array of per-file results. Partial failures are included inline so the client can
 * surface per-file errors without aborting the whole batch.
 */
export async function processAttachmentUploads(
  args: ProcessAttachmentUploadsArgs
): Promise<Response> {
  const { request, target, authContext } = args;
  const { userId } = authContext;

  const formData = await request.formData();
  const files = formData.getAll('file').filter((f): f is File => f instanceof File);

  if (files.length === 0) {
    return jsonResponse({ error: 'No files provided' }, 400);
  }

  const results: Array<{ success: true; file: AttachmentUploadFileResult } | { success: false; error: string; fileName?: string }> = [];

  for (const file of files) {
    const result = await uploadOneFile(file, target, userId, request);
    if (result.ok) {
      results.push({ success: true, file: result.file });
    } else {
      results.push({ success: false, error: result.error, fileName: file.name });
    }
  }

  return jsonResponse({ files: results });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function computeFileSha256(file: File): Promise<string> {
  return createHash('sha256')
    .update(Buffer.from(await file.arrayBuffer()))
    .digest('hex');
}

function validateProcessorResult(
  processorResult: ProcessorUploadResult,
  expected: { expectedContentHash: string; expectedSize: number }
):
  | { valid: true; contentHash: string; resolvedSize: number }
  | { valid: false; reason: string } {
  const contentHash =
    typeof processorResult.contentHash === 'string' ? processorResult.contentHash : null;
  if (!contentHash || !SHA256_HEX_PATTERN.test(contentHash)) {
    return { valid: false, reason: 'invalid_content_hash' };
  }

  if (contentHash !== expected.expectedContentHash) {
    return { valid: false, reason: 'content_hash_mismatch' };
  }

  if (typeof processorResult.size !== 'number') {
    return { valid: false, reason: 'invalid_size' };
  }

  if (processorResult.size !== expected.expectedSize) {
    return { valid: false, reason: 'size_mismatch' };
  }

  return {
    valid: true,
    contentHash,
    resolvedSize: processorResult.size,
  };
}
