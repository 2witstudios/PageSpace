import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db, pages, files, eq } from '@pagespace/db';
import { canUserEditPage } from '@pagespace/lib/server';
import {
  checkStorageQuota,
  updateStorageUsage,
  getUserStorageQuota,
  formatBytes
} from '@pagespace/lib/services/storage-limits';
import { uploadSemaphore } from '@pagespace/lib/services/upload-semaphore';
import { checkMemoryMiddleware } from '@pagespace/lib/services/memory-monitor';
import { createUploadServiceToken } from '@pagespace/lib/services/validated-service-token';
import { sanitizeFilenameForHeader } from '@pagespace/lib/utils/file-security';
import { getActorInfo, logFileActivity } from '@pagespace/lib/monitoring/activity-logger';

const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:3003';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

/**
 * Channel file upload endpoint
 *
 * Uploads a file for use as a channel message attachment.
 * The file is stored in the channel's drive and linked via the files table.
 * Returns file metadata to be included with the message.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ pageId: string }> }
) {
  const { pageId } = await context.params;

  let uploadSlotReleased = false;
  let uploadSlot: string | null = null;
  let userId: string | null = null;

  try {
    // Verify authentication
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) {
      return auth.error;
    }
    userId = auth.userId;

    // Get the channel page to verify it exists and get its driveId
    const channelPage = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
    });

    if (!channelPage) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 });
    }

    if (channelPage.type !== 'CHANNEL') {
      return NextResponse.json({ error: 'Not a channel' }, { status: 400 });
    }

    if (!channelPage.driveId) {
      return NextResponse.json({ error: 'Channel has no associated drive' }, { status: 400 });
    }

    // Check if user has edit permission to post in this channel
    const canEdit = await canUserEditPage(userId, pageId);
    if (!canEdit) {
      return NextResponse.json({
        error: 'You need edit permission to upload files in this channel',
      }, { status: 403 });
    }

    // Parse form data
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    // Check memory availability
    const memCheck = await checkMemoryMiddleware();
    if (!memCheck.allowed) {
      return NextResponse.json({
        error: memCheck.reason || 'Server is busy. Please try again later.',
      }, { status: 503 });
    }

    // Check storage quota
    const quotaCheck = await checkStorageQuota(userId, file.size);
    if (!quotaCheck.allowed) {
      return NextResponse.json({
        error: quotaCheck.reason,
        storageInfo: quotaCheck.quota
      }, { status: 413 });
    }

    // Get user's storage tier for upload slot
    const userQuota = await getUserStorageQuota(userId);
    if (!userQuota) {
      return NextResponse.json({ error: 'Could not retrieve storage quota' }, { status: 500 });
    }

    // Try to acquire upload slot
    uploadSlot = await uploadSemaphore.acquireUploadSlot(
      userId,
      userQuota.tier,
      file.size
    );
    if (!uploadSlot) {
      return NextResponse.json({
        error: 'Too many concurrent uploads. Please wait for current uploads to complete.',
      }, { status: 429 });
    }

    const mimeType = file.type || 'application/octet-stream';
    const sanitizedFileName = sanitizeFilenameForHeader(file.name);
    const driveId = channelPage.driveId;

    // Create service token for processor
    const { token: serviceToken } = await createUploadServiceToken({
      userId,
      driveId,
      pageId, // Channel page ID for permission validation
    });

    // Forward file to processor service
    const processorFormData = new FormData();
    processorFormData.append('file', file);
    processorFormData.append('userId', userId);
    processorFormData.append('driveId', driveId);

    const processorResponse = await fetch(`${PROCESSOR_URL}/api/upload/single`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceToken}`
      },
      body: processorFormData,
    });

    if (!processorResponse.ok) {
      const errorData = await processorResponse.json().catch(() => ({}));
      throw new Error(errorData.error || 'Processor upload failed');
    }

    const processorResult = await processorResponse.json();
    const { contentHash, size } = processorResult;
    const resolvedSize = typeof size === 'number' ? size : file.size;

    // Insert or update file record (for deduplication)
    const inserted = await db
      .insert(files)
      .values({
        id: contentHash,
        driveId,
        sizeBytes: resolvedSize,
        mimeType,
        storagePath: contentHash,
        createdBy: userId,
      })
      .onConflictDoNothing()
      .returning();

    // If file already existed, just use it (deduplication)
    if (inserted.length === 0) {
      const existing = await db.query.files.findFirst({
        where: eq(files.id, contentHash),
      });
      if (!existing) {
        throw new Error('Failed to load existing file metadata');
      }
    }

    // Update storage usage
    await updateStorageUsage(userId, file.size, {
      driveId,
      eventType: 'upload'
    });

    // Log activity
    const actorInfo = await getActorInfo(userId);
    logFileActivity(userId, 'upload', {
      fileId: contentHash,
      fileName: file.name,
      fileType: mimeType,
      fileSize: resolvedSize,
      driveId,
      pageId,
    }, actorInfo);

    // Release upload slot
    uploadSemaphore.releaseUploadSlot(uploadSlot);
    uploadSlotReleased = true;

    // Get updated storage quota
    const updatedQuota = await getUserStorageQuota(userId);

    // Return file info for the client to include with the message
    return NextResponse.json({
      success: true,
      file: {
        id: contentHash,
        originalName: file.name,
        sanitizedName: sanitizedFileName,
        size: resolvedSize,
        mimeType,
        contentHash,
      },
      storageInfo: updatedQuota ? {
        used: updatedQuota.usedBytes,
        quota: updatedQuota.quotaBytes,
        formattedUsed: formatBytes(updatedQuota.usedBytes),
        formattedQuota: formatBytes(updatedQuota.quotaBytes)
      } : undefined
    });

  } catch (error) {
    console.error('Channel upload error:', error);

    // Clean up on error
    if (!uploadSlotReleased && uploadSlot && userId) {
      uploadSemaphore.releaseUploadSlot(uploadSlot);
    }

    return NextResponse.json(
      { error: 'Failed to upload file' },
      { status: 500 }
    );
  }
}
