import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError, checkMCPCreateScope, isScopedMCPAuth } from '@/lib/auth';
import { getAppDriveAccessLevel } from '@pagespace/lib/permissions/app-permissions';
import {
  validateContentHash,
  validateFileSize,
  validateMimeTypeDeclaration,
  buildS3Key,
  canClaimExistingObject,
} from '@pagespace/lib/services/upload-validation';
import { getUserDrivePermissions } from '@pagespace/lib/permissions/permissions';
import { checkStorageQuota, checkConcurrentUploads, getUserStorageQuota, userReferencesContentHash } from '@pagespace/lib/services/storage-limits';
import { registerPendingUpload, releasePendingUpload } from '@pagespace/lib/services/pending-uploads';
import { uploadSemaphore } from '@pagespace/lib/services/upload-semaphore';
import { checkObjectExists, issuePresignedPutUrl } from '@/lib/upload/s3-effects';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };
const PRESIGN_TTL = 900;

interface PresignRequestBody {
  contentHash: string;
  driveId: string;
  filename: string;
  mimeType: string;
  fileSize: number;
}

export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;

  const { userId } = auth;

  let body: PresignRequestBody;
  try {
    body = await request.json() as PresignRequestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { contentHash, driveId, filename, mimeType, fileSize } = body;

  if (!contentHash || !driveId || !filename || !mimeType || typeof fileSize !== 'number') {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  // Scoped MCP tokens may only act on the drive they were granted for.
  const scopeError = checkMCPCreateScope(auth, driveId);
  if (scopeError) return scopeError;

  // A scoped MCP token is its own drive member — uploads require the TOKEN's
  // role to grant edit, not the owning user's.
  if (isScopedMCPAuth(auth)) {
    const level = await getAppDriveAccessLevel(auth.tokenId, driveId);
    if (!level?.canEdit) {
      return NextResponse.json({ error: 'You do not have permission to upload to this drive' }, { status: 403 });
    }
  } else {
    const drivePerms = await getUserDrivePermissions(userId, driveId);
    if (!drivePerms) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }
    if (!drivePerms.canEdit) {
      return NextResponse.json({ error: 'You do not have permission to upload to this drive' }, { status: 403 });
    }
  }

  const hashResult = validateContentHash(contentHash);
  if (!hashResult.ok) {
    return NextResponse.json({ error: hashResult.error.message }, { status: 400 });
  }
  // Use the canonicalized (lowercased) hash everywhere downstream.
  const canonicalHash = hashResult.value;

  const mimeResult = validateMimeTypeDeclaration(mimeType);
  if (!mimeResult.ok) {
    return NextResponse.json({ error: mimeResult.error.message }, { status: 400 });
  }

  const quota = await getUserStorageQuota(userId);
  if (!quota) {
    return NextResponse.json({ error: 'Could not retrieve storage quota' }, { status: 500 });
  }

  const sizeResult = validateFileSize(fileSize, quota.tier);
  if (!sizeResult.ok) {
    return NextResponse.json({ error: sizeResult.error.message }, { status: 413 });
  }

  // Enforce remaining storage + file-count limits, not just per-file size.
  const quotaCheck = await checkStorageQuota(userId, fileSize);
  if (!quotaCheck.allowed) {
    return NextResponse.json({ error: quotaCheck.reason, storageInfo: quotaCheck.quota }, { status: 413 });
  }

  // #2154: cross-process concurrency gate, backed by live `pending_uploads`
  // rows. The semaphore below also gates concurrency, but only within THIS
  // process — with multiple web replicas a user's uploads can land on
  // different processes, each enforcing the tier limit independently. This
  // check catches that case; whichever gate is stricter wins.
  const canUpload = await checkConcurrentUploads(userId);
  if (!canUpload) {
    return NextResponse.json(
      { error: 'Too many concurrent uploads. Please wait for current uploads to complete.' },
      { status: 429 },
    );
  }

  const key = buildS3Key(canonicalHash);

  const exists = await checkObjectExists(key);

  // H3: storage is a GLOBAL content-addressed namespace, so a known hash alone
  // must NOT grant access to bytes the caller never uploaded. Only honor the
  // dedup fast-path (skip the proof-of-possession PUT) when the caller already
  // references the hash.
  const callerAlreadyReferences = await userReferencesContentHash(userId, canonicalHash, driveId);
  const allowFastPath = canClaimExistingObject({ contentHash: canonicalHash, callerAlreadyReferences });

  // The object already exists but the caller has never uploaded/linked it — this
  // is the cross-tenant claim. Reject before reserving a slot: we must NOT hand
  // out a presigned PUT for the canonical (content-addressed) key either, since a
  // non-possessor could overwrite another tenant's bytes with non-matching
  // content. Honoring possession requires per-drive namespacing (see WO-02 H3).
  if (exists && !allowFastPath) {
    return NextResponse.json(
      { error: 'This file could not be verified for upload. Please re-upload the original file.' },
      { status: 409 },
    );
  }

  // Reserve a slot in both paths so the client always has a jobId to pass to
  // /complete — the dedup fast-path skips the PUT but still creates a page record.
  // The slot carries the server-trusted upload params so /complete can't be
  // tricked with a divergent hash/drive/size/mime — and the H3 facts so it can
  // reject a claim without re-trusting the client.
  const jobId = await uploadSemaphore.acquireUploadSlot(userId, quota.tier, fileSize, {
    contentHash: canonicalHash,
    driveId,
    fileSize,
    mimeType,
    callerAlreadyReferences,
  });
  if (!jobId) {
    return NextResponse.json(
      { error: 'Too many concurrent uploads. Please wait for current uploads to complete.' },
      { status: 429 },
    );
  }

  // Once the slot is acquired, any failure before we return must release it,
  // or the slot leaks until the semaphore's stale-slot sweep.
  try {
    // #2154: TTL'd reservation row (replaces the users.activeUploads counter).
    // If the process dies before /complete, the row simply expires — no
    // permanent slot leak.
    await registerPendingUpload(jobId, userId, fileSize);

    if (exists && allowFastPath) {
      return NextResponse.json({ alreadyExists: true, jobId, key });
    }

    const url = await issuePresignedPutUrl(key, mimeType, fileSize, PRESIGN_TTL);
    const expiresAt = new Date(Date.now() + PRESIGN_TTL * 1000).toISOString();

    auditRequest(request, {
      eventType: 'data.write',
      userId,
      resourceType: 'file',
      resourceId: canonicalHash,
      details: { action: 'presign', driveId, filename, fileSize },
    });

    return NextResponse.json({ url, jobId, key, expiresAt });
  } catch (err) {
    uploadSemaphore.releaseUploadSlot(jobId);
    await releasePendingUpload(jobId).catch(() => undefined);
    throw err;
  }
}
