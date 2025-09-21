import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import {
  checkStorageQuota,
  getUserStorageQuota
} from '@pagespace/lib/services/storage-limits';
import { uploadSemaphore } from '@pagespace/lib/services/upload-semaphore';
import { checkMemoryMiddleware } from '@pagespace/lib/services/memory-monitor';
import { getStorageConfigFromSubscription, type SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { db, users, eq } from '@pagespace/db';

export async function POST(request: NextRequest) {
  try {
    // Verify authentication
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

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
    const quotaCheck = await checkStorageQuota(user.id, fileSize);
    if (!quotaCheck.allowed) {
      return NextResponse.json({
        allowed: false,
        reason: quotaCheck.reason,
        quota: quotaCheck.quota,
        requiredBytes: quotaCheck.requiredBytes
      }, { status: 413 }); // Payload Too Large
    }

    // Get user's storage tier
    const quota = await getUserStorageQuota(user.id);
    if (!quota) {
      return NextResponse.json({ error: 'Could not retrieve storage quota' }, { status: 500 });
    }

    // Check if user can acquire an upload slot
    const canUpload = await uploadSemaphore.canAcquireSlot(user.id, quota.tier);
    if (!canUpload) {
      return NextResponse.json({
        allowed: false,
        reason: 'Too many concurrent uploads. Please wait for current uploads to complete.',
        quota: quotaCheck.quota
      }, { status: 429 }); // Too Many Requests
    }

    // Get user's subscription tier for storage config
    const userWithSubscription = await db.query.users.findFirst({
      where: eq(users.id, user.id),
      columns: { subscriptionTier: true }
    });

    const subscriptionTier = (userWithSubscription?.subscriptionTier || 'free') as SubscriptionTier;
    const tierConfig = getStorageConfigFromSubscription(subscriptionTier);

    // All checks passed
    return NextResponse.json({
      allowed: true,
      quota: quotaCheck.quota,
      tier: quota.tier,
      tierLimits: {
        name: tierConfig.tier,
        quotaBytes: tierConfig.quotaBytes,
        maxFileSize: tierConfig.maxFileSize,
        maxConcurrentUploads: tierConfig.maxConcurrentUploads,
        maxFileCount: tierConfig.maxFileCount,
        features: tierConfig.features
      }
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
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get user's storage quota
    const quota = await getUserStorageQuota(user.id);
    if (!quota) {
      return NextResponse.json({ error: 'Could not retrieve storage quota' }, { status: 500 });
    }

    // Get user's subscription tier for storage config
    const userWithSubscription = await db.query.users.findFirst({
      where: eq(users.id, user.id),
      columns: { subscriptionTier: true }
    });

    const subscriptionTier = (userWithSubscription?.subscriptionTier || 'free') as SubscriptionTier;
    const tierConfig = getStorageConfigFromSubscription(subscriptionTier);

    // Get semaphore status
    const semaphoreStatus = uploadSemaphore.getStatus();
    const userActiveUploads = semaphoreStatus.userUploads.get(user.id) || 0;

    return NextResponse.json({
      quota,
      tierLimits: {
        name: tierConfig.tier,
        quotaBytes: tierConfig.quotaBytes,
        maxFileSize: tierConfig.maxFileSize,
        maxConcurrentUploads: tierConfig.maxConcurrentUploads,
        maxFileCount: tierConfig.maxFileCount,
        features: tierConfig.features
      },
      activeUploads: userActiveUploads,
      canUpload: userActiveUploads < tierConfig.maxConcurrentUploads
    });

  } catch (error) {
    console.error('Storage info error:', error);
    return NextResponse.json(
      { error: 'Failed to get storage info' },
      { status: 500 }
    );
  }
}