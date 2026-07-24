import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import {
  checkStorageQuota,
  getUserStorageQuota,
  STORAGE_TIERS
} from '@pagespace/lib/services/storage-limits';
import { countLiveUploadsForUser } from '@pagespace/lib/services/pending-uploads';
import { safeParseBody } from '@/lib/validation/parse-body';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const storageCheckSchema = z.object({
  fileSize: z.number().positive('Invalid file size'),
});

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

    const { fileSize } = parsed.data;

    // Check storage quota
    const quotaCheck = await checkStorageQuota(userId, fileSize);
    if (!quotaCheck.allowed) {
      return NextResponse.json({
        allowed: false,
        reason: quotaCheck.reason,
        quota: quotaCheck.quota,
        requiredBytes: quotaCheck.requiredBytes
      }, { status: 413 }); // Payload Too Large
    }

    // Get user's storage tier
    const quota = await getUserStorageQuota(userId);
    if (!quota) {
      return NextResponse.json({ error: 'Could not retrieve storage quota' }, { status: 500 });
    }

    // Check if user can acquire an upload slot. Reads the same pending_uploads
    // rows presign's atomic reserve enforces (#2225 review — Codex round 5):
    // the process-local semaphore alone can't see slots reserved on other web
    // replicas, so it could say "allowed" here only for presign to 429 moments
    // later.
    const liveUploads = await countLiveUploadsForUser(userId);
    const canUpload = liveUploads < STORAGE_TIERS[quota.tier].maxConcurrentUploads;
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
    // basis presign's atomic reserve enforces.
    const userActiveUploads = await countLiveUploadsForUser(userId);

    auditRequest(request, { eventType: 'data.read', userId, resourceType: 'storage', resourceId: userId });

    return NextResponse.json({
      quota,
      tierLimits: STORAGE_TIERS[quota.tier],
      activeUploads: userActiveUploads,
      canUpload: userActiveUploads < STORAGE_TIERS[quota.tier].maxConcurrentUploads
    });

  } catch (error) {
    console.error('Storage info error:', error);
    return NextResponse.json(
      { error: 'Failed to get storage info' },
      { status: 500 }
    );
  }
}