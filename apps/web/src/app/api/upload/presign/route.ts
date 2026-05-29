import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import {
  validateContentHash,
  validateFileSize,
  validateMimeTypeDeclaration,
  buildS3Key,
} from '@pagespace/lib/services/upload-validation';
import { getUserDrivePermissions } from '@pagespace/lib/permissions/permissions';
import { getUserStorageQuota, updateActiveUploads } from '@pagespace/lib/services/storage-limits';
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

  const drivePerms = await getUserDrivePermissions(userId, driveId);
  if (!drivePerms) {
    return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
  }
  if (!drivePerms.canEdit) {
    return NextResponse.json({ error: 'You do not have permission to upload to this drive' }, { status: 403 });
  }

  const hashResult = validateContentHash(contentHash);
  if (!hashResult.ok) {
    return NextResponse.json({ error: hashResult.error.message }, { status: 400 });
  }

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

  const key = buildS3Key(contentHash);

  const exists = await checkObjectExists(key);
  if (exists) {
    return NextResponse.json({ alreadyExists: true, key });
  }

  const url = await issuePresignedPutUrl(key, mimeType, fileSize, PRESIGN_TTL);

  const jobId = await uploadSemaphore.acquireUploadSlot(userId, quota.tier, fileSize);
  if (!jobId) {
    return NextResponse.json(
      { error: 'Too many concurrent uploads. Please wait for current uploads to complete.' },
      { status: 429 },
    );
  }

  await updateActiveUploads(userId, 1);

  const expiresAt = new Date(Date.now() + PRESIGN_TTL * 1000).toISOString();

  auditRequest(request, {
    eventType: 'data.write',
    userId,
    resourceType: 'file',
    resourceId: contentHash,
    details: { action: 'presign', driveId, filename, fileSize },
  });

  return NextResponse.json({ url, jobId, key, expiresAt });
}
