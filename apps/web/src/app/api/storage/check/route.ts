import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import {
  checkStorageQuota,
  getUserStorageQuota,
  STORAGE_TIERS
} from '@pagespace/lib/services/storage-limits';
import { uploadSemaphore } from '@pagespace/lib/services/upload-semaphore';
import { checkMemoryMiddleware } from '@pagespace/lib/services/memory-monitor';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

export async function POST(request: NextRequest) {
  try {
    // Verify authentication
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    // Parse request body
    const { fileSize } = await request.json();

    // Validate input
    if (!fileSize || fileSize <= 0) {
      return NextResponse.json({ error: 'Invalid file size' }, { status: 400 });
    }

    // Check memory availability first
    const memCheck = await checkMemoryMiddleware();
    if (!memCheck.allowed) {
      return NextResponse.json({
        allowed: false,
        reason: memCheck.reason || 'Server is busy',
        memoryStatus: memCheck.status
      }, { status: 503 }); // Service Unavailable
    }

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

    // Check if user can acquire an upload slot
    const canUpload = await uploadSemaphore.canAcquireSlot(userId, quota.tier);
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
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    // Get user's storage quota
    const quota = await getUserStorageQuota(userId);
    if (!quota) {
      return NextResponse.json({ error: 'Could not retrieve storage quota' }, { status: 500 });
    }

    // Get semaphore status
    const semaphoreStatus = uploadSemaphore.getStatus();
    const userActiveUploads = semaphoreStatus.userUploads.get(userId) || 0;

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