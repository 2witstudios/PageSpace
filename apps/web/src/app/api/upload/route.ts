import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { db, pages, drives, filePages, files, eq, isNull } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';
import { PageType, canUserEditPage, getUserDriveAccess } from '@pagespace/lib/server';
import {
  checkStorageQuota,
  updateStorageUsage,
  updateActiveUploads,
  getUserStorageQuota,
  formatBytes
} from '@pagespace/lib/services/storage-limits';
import { uploadSemaphore } from '@pagespace/lib/services/upload-semaphore';
import { checkMemoryMiddleware } from '@pagespace/lib/services/memory-monitor';
import { createServiceToken } from '@pagespace/lib/auth-utils';

// Define allowed file types and size limits

// Type for file metadata
interface FileMetadata {
  uploadedAt: string;
  uploadedBy: string;
  originalName: string;
  contentHash?: string;
  [key: string]: string | number | boolean | undefined;
}

// Processor service URL
const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:3003';

export async function POST(request: NextRequest) {
  // Declare variables at function scope for proper cleanup
  let uploadSlotReleased = false;
  let uploadSlot: string | null = null;
  let userId: string | null = null;
  let pageCreated = false;

  try {
    // Verify authentication
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    userId = user.id;

    // Parse form data
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const driveId = formData.get('driveId') as string | null;
    const parentId = formData.get('parentId') as string | null;
    const title = formData.get('title') as string | null;
    const position = formData.get('position') as string | null;
    const afterNodeId = formData.get('afterNodeId') as string | null;

    // Validate required fields
    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    if (!driveId) {
      return NextResponse.json({ error: 'Drive ID is required' }, { status: 400 });
    }

    // Verify drive exists and user has access
    const drive = await db.query.drives.findFirst({
      where: eq(drives.id, driveId),
    });

    if (!drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    const hasDriveAccess = await getUserDriveAccess(user.id, driveId);
    if (!hasDriveAccess) {
      return NextResponse.json({ error: 'You do not have permission to upload to this drive' }, { status: 403 });
    }

    if (parentId) {
      const parentPage = await db.query.pages.findFirst({
        where: eq(pages.id, parentId),
      });

      if (!parentPage || parentPage.driveId !== driveId) {
        return NextResponse.json({ error: 'Invalid parent page' }, { status: 400 });
      }

      const canEditParent = await canUserEditPage(user.id, parentId);
      if (!canEditParent) {
        return NextResponse.json({ error: 'You do not have permission to upload to this folder' }, { status: 403 });
      }
    }

    // Check memory availability first
    const memCheck = await checkMemoryMiddleware();
    if (!memCheck.allowed) {
      return NextResponse.json({
        error: memCheck.reason || 'Server is busy. Please try again later.',
        memoryStatus: memCheck.status
      }, { status: 503 });
    }

    // Check storage quota
    const quotaCheck = await checkStorageQuota(user.id, file.size);
    if (!quotaCheck.allowed) {
      return NextResponse.json({
        error: quotaCheck.reason,
        storageInfo: quotaCheck.quota
      }, { status: 413 });
    }

    // Get user's storage tier for upload slot
    const userQuota = await getUserStorageQuota(user.id);
    if (!userQuota) {
      return NextResponse.json({ error: 'Could not retrieve storage quota' }, { status: 500 });
    }

    // Try to acquire upload slot
    uploadSlot = await uploadSemaphore.acquireUploadSlot(
      user.id,
      userQuota.tier,
      file.size
    );
    if (!uploadSlot) {
      return NextResponse.json({
        error: 'Too many concurrent uploads. Please wait for current uploads to complete.',
        storageInfo: userQuota
      }, { status: 429 });
    }

    // Check if mime type is allowed (with fallback for unknown types)
    const mimeType = file.type || 'application/octet-stream';

    // Generate page ID
    const pageId = createId();
    
    // Sanitize filename: Replace Unicode spaces (especially U+202F from macOS screenshots) with regular spaces
    const sanitizedFileName = file.name
      .replace(/[\u202F\u00A0\u2000-\u200B\uFEFF]/g, ' ') // Replace various Unicode spaces with regular space
      .replace(/\s+/g, ' ') // Normalize multiple spaces to single space
      .trim();

    // Increment active uploads counter
    await updateActiveUploads(user.id, 1);

    // Forward file to processor service for streaming upload and processing
    const processorFormData = new FormData();
    processorFormData.append('file', file);
    processorFormData.append('pageId', pageId);
    processorFormData.append('userId', user.id);
    processorFormData.append('driveId', driveId);

    try {
      // Create service JWT token for processor authentication
      const serviceToken = await createServiceToken('web', ['files:write'], {
        userId: user.id,
        tenantId: pageId,
        driveIds: [driveId],
        expirationTime: '10m'
      });

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
      const { contentHash, deduplicated, size, jobs, path: storedPath } = processorResult;
      const resolvedSize = typeof size === 'number' ? size : file.size;
      const storagePath = typeof storedPath === 'string' && storedPath.length > 0 ? storedPath : contentHash;

      // Calculate position for new page
      let calculatedPosition: number;
      
      if (position && position === 'before' && afterNodeId) {
        // Insert before a specific node
        const targetNode = await db.query.pages.findFirst({
          where: eq(pages.id, afterNodeId),
        });
        
        if (targetNode) {
          // Get all siblings to find the previous one
          const siblings = await db.query.pages.findMany({
            where: parentId ? eq(pages.parentId, parentId) : isNull(pages.parentId),
            orderBy: (pages, { asc }) => [asc(pages.position)],
          });
          
          const targetIndex = siblings.findIndex(s => s.id === afterNodeId);
          const prevSibling = targetIndex > 0 ? siblings[targetIndex - 1] : null;
          
          // Position between previous and target
          const prevPos = prevSibling?.position || 0;
          const targetPos = targetNode.position;
          calculatedPosition = (prevPos + targetPos) / 2;
        } else {
          // Fallback to end of list
          const lastPage = await db.query.pages.findFirst({
            where: parentId ? eq(pages.parentId, parentId) : isNull(pages.parentId),
            orderBy: (pages, { desc }) => [desc(pages.position)],
          });
          calculatedPosition = lastPage ? lastPage.position + 1 : 0;
        }
      } else if (position && position === 'after' && afterNodeId) {
        // Insert after a specific node
        const targetNode = await db.query.pages.findFirst({
          where: eq(pages.id, afterNodeId),
        });
        
        if (targetNode) {
          // Get the next sibling
          const siblings = await db.query.pages.findMany({
            where: parentId ? eq(pages.parentId, parentId) : isNull(pages.parentId),
            orderBy: (pages, { asc }) => [asc(pages.position)],
          });
          
          const targetIndex = siblings.findIndex(s => s.id === afterNodeId);
          const nextSibling = siblings[targetIndex + 1];
          
          // Position between target and next
          const targetPos = targetNode.position;
          const nextPos = nextSibling?.position || targetPos + 2;
          calculatedPosition = (targetPos + nextPos) / 2;
        } else {
          // Fallback to end of list
          const lastPage = await db.query.pages.findFirst({
            where: parentId ? eq(pages.parentId, parentId) : isNull(pages.parentId),
            orderBy: (pages, { desc }) => [desc(pages.position)],
          });
          calculatedPosition = lastPage ? lastPage.position + 1 : 0;
        }
      } else {
        // Default: add at the end
        const lastPage = await db.query.pages.findFirst({
          where: parentId ? eq(pages.parentId, parentId) : isNull(pages.parentId),
          orderBy: (pages, { desc }) => [desc(pages.position)],
        });
        calculatedPosition = lastPage ? lastPage.position + 1 : 0;
      }

      // Create file metadata with content hash
      const fileMetadata: FileMetadata = {
        uploadedAt: new Date().toISOString(),
        uploadedBy: user.id,
        originalName: file.name, // Store original name with Unicode characters
        contentHash, // Store content hash for deduplication
      };

      // Persist page, file metadata, and linkage atomically
      const newPage = await db.transaction(async (tx) => {
        const [createdPage] = await tx.insert(pages).values({
          id: pageId,
          title: title || sanitizedFileName, // Use sanitized name for title
          type: PageType.FILE,
          content: '', // Will be populated by background job for text/ocr results
          processingStatus: deduplicated ? 'completed' :
            (mimeType.startsWith('image/') ? 'visual' : 'pending'),
          position: calculatedPosition,
          driveId,
          parentId: parentId || null,
          fileSize: resolvedSize,
          mimeType,
          originalFileName: sanitizedFileName, // Store sanitized filename
          filePath: contentHash, // Store content hash as file identifier
          fileMetadata,
          createdAt: new Date(),
          updatedAt: new Date(),
        }).returning();

        const canonicalStoragePath = storagePath ?? contentHash;

        const inserted = await tx
          .insert(files)
          .values({
            id: contentHash,
            driveId,
            sizeBytes: resolvedSize,
            mimeType,
            storagePath: canonicalStoragePath,
            createdBy: user.id,
          })
          .onConflictDoNothing()
          .returning();

        if (inserted.length === 0) {
          const existing = await tx.query.files.findFirst({
            where: eq(files.id, contentHash),
          });

          if (!existing) {
            throw new Error('Failed to load existing file metadata for deduplicated upload');
          }

          if (existing.driveId !== driveId) {
            throw new Error('File hash already associated with another drive');
          }

          const requiresUpdate =
            existing.mimeType !== mimeType ||
            existing.sizeBytes !== resolvedSize ||
            existing.storagePath !== canonicalStoragePath;

          if (requiresUpdate) {
            await tx
              .update(files)
              .set({
                mimeType,
                sizeBytes: resolvedSize,
                storagePath: canonicalStoragePath,
                updatedAt: new Date(),
              })
              .where(eq(files.id, contentHash));
          }
        }

        await tx
          .insert(filePages)
          .values({
            fileId: contentHash,
            pageId,
            linkedBy: user.id,
            linkSource: 'web-upload',
          })
          .onConflictDoUpdate({
            target: filePages.pageId,
            set: {
              fileId: contentHash,
              linkedBy: user.id,
              linkedAt: new Date(),
              linkSource: 'web-upload',
            },
          });

        return createdPage;
      });
      pageCreated = true;

      // Update user storage usage (has its own transaction internally)
      await updateStorageUsage(user.id, file.size, {
        pageId: newPage.id,
        driveId,
        eventType: 'upload'
      });

      // Release upload slot and decrement counter
      uploadSemaphore.releaseUploadSlot(uploadSlot);
      uploadSlotReleased = true;
      await updateActiveUploads(user.id, -1);

      // If file needs any processing (ingest, text extraction, OCR, or image optimization)
      if (jobs && (jobs.ingest || jobs.textExtraction || jobs.ocr || jobs.imageOptimization)) {
        try {
          let message = 'File uploaded successfully. Processing in background.';
          
          if (jobs.ingest) {
            // Processor service already enqueued unified ingestion; do not enqueue web worker job
            console.log(`Processor handling ingestion for page ${pageId}, contentHash ${contentHash}`);
            message = 'File uploaded successfully. Processor is ingesting in background.';
          }
          
          // Get updated storage quota
          const updatedQuota = await getUserStorageQuota(user.id);

          // Return 202 Accepted to indicate async processing
          return NextResponse.json(
            {
              success: true,
              page: {
                ...newPage,
                contentHash,
                deduplicated,
              },
              message: deduplicated
                ? 'File already exists (deduplicated). Processing may be complete.'
                : message,
              processingStatus: deduplicated ? 'completed' : 'pending',
              storageInfo: updatedQuota ? {
                used: updatedQuota.usedBytes,
                quota: updatedQuota.quotaBytes,
                formattedUsed: formatBytes(updatedQuota.usedBytes),
                formattedQuota: formatBytes(updatedQuota.quotaBytes)
              } : undefined
            },
            { status: 202 }
          );
        } catch (error) {
          console.error('Failed to enqueue text extraction:', error);
        }
      }

      // Get updated storage quota
      const updatedQuota = await getUserStorageQuota(user.id);

      // File uploaded and optimized successfully
      return NextResponse.json({
        success: true,
        page: {
          ...newPage,
          contentHash,
          deduplicated,
        },
        message: deduplicated
          ? 'File already exists (deduplicated).'
          : 'File uploaded and processed successfully.',
        processingStatus: 'completed',
        storageInfo: updatedQuota ? {
          used: updatedQuota.usedBytes,
          quota: updatedQuota.quotaBytes,
          formattedUsed: formatBytes(updatedQuota.usedBytes),
          formattedQuota: formatBytes(updatedQuota.quotaBytes)
        } : undefined
      });

    } catch (processorError) {
      console.error('Processor service error:', processorError);

      // Clean up on error
      if (!uploadSlotReleased && uploadSlot && userId) {
        uploadSemaphore.releaseUploadSlot(uploadSlot);
        uploadSlotReleased = true;
        await updateActiveUploads(userId, -1);
      }
      
      if (pageCreated) {
        throw processorError;
      }

      // Fallback: Still create the page entry but mark as failed
      const fileMetadata: FileMetadata = {
        uploadedAt: new Date().toISOString(),
        uploadedBy: user.id,
        originalName: file.name,
      };

      const [newPage] = await db.insert(pages).values({
        id: pageId,
        title: title || sanitizedFileName,
        type: PageType.FILE,
        content: '',
        processingStatus: 'failed',
        position: 0,
        driveId,
        parentId: parentId || null,
        fileSize: file.size,
        mimeType,
        originalFileName: sanitizedFileName,
        filePath: sanitizedFileName,
        fileMetadata,
        createdAt: new Date(),
        updatedAt: new Date(),
      }).returning();

      return NextResponse.json({
        success: false,
        page: newPage,
        error: 'File upload succeeded but processing failed.',
        processingStatus: 'failed'
      }, { status: 500 });
    }

  } catch (error) {
    console.error('Upload error:', error);

    // Clean up on error
    if (!uploadSlotReleased && uploadSlot && userId) {
      uploadSemaphore.releaseUploadSlot(uploadSlot);
      uploadSlotReleased = true;
      await updateActiveUploads(userId, -1);
    }

    return NextResponse.json(
      { error: 'Failed to upload file' },
      { status: 500 }
    );
  } finally {
    // Ensure upload slot is always released
    if (!uploadSlotReleased && uploadSlot && userId) {
      uploadSemaphore.releaseUploadSlot(uploadSlot);
      uploadSlotReleased = true;
      await updateActiveUploads(userId, -1);
    }
  }
}
