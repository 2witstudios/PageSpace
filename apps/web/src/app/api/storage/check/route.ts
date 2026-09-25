import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import {
  resolveUploadQuotaTarget,
  checkUploadQuotaTarget,
  getUserStorageQuota,
  STORAGE_TIERS
} from '@pagespace/lib/services/storage-limits';
import { getUserDrivePermissions } from '@pagespace/lib/permissions/permissions';
import { countLiveUploadsForUser } from '@pagespace/lib/services/pending-uploads';
import { uploadSemaphore } from '@pagespace/lib/services/upload-semaphore';
import { safeParseBody } from '@/lib/validation/parse-body';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const storageCheckSchema = z.object({
  fileSize: z.number().positive('Invalid file size'),
  driveId: z.string().min(1).optional(),
});

/**
 * The drive whose quota a drop is checked against (WAL-9, #2719 review P1-1): the drop's drive,
 * but only when the permissions seam says the caller may upload into it (drive-wide edit, as
 * presign requires). A missing or inaccessible drive fails CLOSED to the caller's personal
 * quota, and answers the same whether the drive does not exist or the caller cannot see it.
 */
async function quotaDriveId(userId: string, driveId: string | undefined): Promise<string | null> {
  if (!driveId) return null;
  const drivePerms = await getUserDrivePermissions(userId, driveId);
  return drivePerms?.canEdit ? driveId : null;
}

export async function POST(request: NextRequest) {
  try {
    // Verify authentication
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    // Parse and validate request body
    const parsed = await safeParseBody(request, storageCheckSchema);
    if (!parsed.success) {
      return parsed.response;
    }

    const { fileSize, driveId } = parsed.data;

    // The quota presign will check this upload against: an org drive's org, else the caller's.
    const quotaTarget = await resolveUploadQuotaTarget(userId, await quotaDriveId(userId, driveId));
    const quotaCheck = await checkUploadQuotaTarget(quotaTarget, fileSize);
    if (!quotaCheck.allowed) {
      return NextResponse.json({
        allowed: false,
        reason: quotaCheck.reason,
        quota: quotaCheck.quota,
        requiredBytes: quotaCheck.requiredBytes
      }, { status: 413 }); // Payload Too Large
    }

    // The per-user concurrency limit is the uploader's own tier, as presign's atomic reserve
    // (reserveConcurrentUploadSlot) enforces it; the replica semaphore takes the target's tier,
    // as presign's acquireUploadSlot does.
    const personalQuota = quotaTarget?.payer.kind === 'user' ? quotaTarget.quota : await getUserStorageQuota(userId);
    if (!quotaTarget || !personalQuota) {
      return NextResponse.json({ error: 'Could not retrieve storage quota' }, { status: 500 });
    }
    const { quota } = quotaTarget;

    // Check if user can acquire an upload slot: the per-user tier limit reads
    // the same pending_uploads rows presign's atomic reserve enforces
    // (#2225 review — Codex round 5), since the process-local semaphore alone
    // can't see slots reserved on other web replicas. The replaced
    // `canAcquireSlot` ALSO covered THIS replica's global concurrency limit
    // (a separate, deliberately process-local cap — see upload-semaphore.ts),
    // which countLiveUploadsForUser doesn't know about; dropping it would let
    // this preflight say "allowed" while presign's acquireUploadSlot on the
    // same replica then rejects at the global limit (#2225 review — Codex
    // round 6). Both checks are required.
    const [hasGlobalCapacity, liveUploads] = await Promise.all([
      uploadSemaphore.canAcquireSlot(userId, quota.tier),
      countLiveUploadsForUser(userId),
    ]);
    const canUpload = hasGlobalCapacity && liveUploads < STORAGE_TIERS[personalQuota.tier].maxConcurrentUploads;
    if (!canUpload) {
      return NextResponse.json({
        allowed: false,
        reason: 'Too many concurrent uploads. Please wait for current uploads to complete.',
        quota: quotaCheck.quota
      }, { status: 429 }); // Too Many Requests
    }

    // All checks passed
    return NextResponse.json({
      allowed: true,
      quota: quotaCheck.quota,
      tier: quota.tier,
      tierLimits: STORAGE_TIERS[quota.tier]
    });

  } catch (error) {
    console.error('Storage check error:', error);
    return NextResponse.json(
      { error: 'Failed to check storage quota' },
      { status: 500 }
    );
  }
}

// GET endpoint to retrieve current storage status
export async function GET(request: NextRequest) {
  try {
    // Verify authentication
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    // Get user's storage quota
    const quota = await getUserStorageQuota(userId);
    if (!quota) {
      return NextResponse.json({ error: 'Could not retrieve storage quota' }, { status: 500 });
    }

    // Cross-process live-upload count (#2225 review — Codex round 5), same
    // basis presign's atomic reserve enforces. Also checked alongside this
    // replica's global semaphore capacity (#2225 review — CodeRabbit round 7)
    // so GET's canUpload can't disagree with what POST /check (and presign
    // itself) would decide on the same replica.
    const [hasGlobalCapacity, userActiveUploads] = await Promise.all([
      uploadSemaphore.canAcquireSlot(userId, quota.tier),
      countLiveUploadsForUser(userId),
    ]);

    auditRequest(request, { eventType: 'data.read', userId, resourceType: 'storage', resourceId: userId });

    return NextResponse.json({
      quota,
      tierLimits: STORAGE_TIERS[quota.tier],
      activeUploads: userActiveUploads,
      canUpload: hasGlobalCapacity && userActiveUploads < STORAGE_TIERS[quota.tier].maxConcurrentUploads
    });

  } catch (error) {
    console.error('Storage info error:', error);
    return NextResponse.json(
      { error: 'Failed to get storage info' },
      { status: 500 }
    );
  }
}