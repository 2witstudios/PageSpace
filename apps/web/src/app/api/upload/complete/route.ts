import { NextResponse } from 'next/server';
import { createId } from '@paralleldrive/cuid2';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { pages } from '@pagespace/db/schema/core';
import { files, filePages } from '@pagespace/db/schema/storage';
import { PageType } from '@pagespace/lib/utils/enums';
import { getUserDrivePermissions } from '@pagespace/lib/permissions/permissions';
import { updateActiveUploads, updateStorageUsage } from '@pagespace/lib/services/storage-limits';
import { uploadSemaphore } from '@pagespace/lib/services/upload-semaphore';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { getActorInfo, logFileActivity } from '@pagespace/lib/monitoring/activity-logger';
import { enqueueProcessorJob } from '@/lib/upload/processor-effects';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

interface CompleteRequestBody {
  jobId: string;
  contentHash: string;
  driveId: string;
  title: string;
  mimeType: string;
  fileSize: number;
  parentId?: string | null;
}

interface NewPageRecord {
  id: string;
  title: string;
  type: (typeof PageType)[keyof typeof PageType];
  content: string;
  processingStatus: string;
  position: number;
  driveId: string;
  parentId: string | null;
  fileSize: number;
  mimeType: string;
  originalFileName: string;
  filePath: string;
  contentHash: string;
  fileMetadata: Record<string, string | number | boolean | undefined>;
  createdAt: Date;
  updatedAt: Date;
}

function buildPageRecord(params: {
  contentHash: string;
  driveId: string;
  title: string;
  mimeType: string;
  fileSize: number;
  userId: string;
  parentId?: string | null;
}): NewPageRecord {
  return {
    id: createId(),
    title: params.title,
    type: PageType.FILE,
    content: '',
    processingStatus: 'pending',
    position: Date.now(),
    driveId: params.driveId,
    parentId: params.parentId ?? null,
    fileSize: params.fileSize,
    mimeType: params.mimeType,
    originalFileName: params.title,
    // Store the raw content hash — the processor reads filePath directly as the
    // content hash (SELECT "filePath" as "contentHash"). The S3 key is derived
    // from the hash at read time via buildS3Key / generatePresignedUrl.
    filePath: params.contentHash,
    contentHash: params.contentHash,
    fileMetadata: {
      uploadedAt: new Date().toISOString(),
      uploadedBy: params.userId,
      originalName: params.title,
      contentHash: params.contentHash,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;

  const { userId } = auth;

  let body: CompleteRequestBody;
  try {
    body = await request.json() as CompleteRequestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { jobId, contentHash, driveId, title, mimeType, fileSize, parentId } = body;

  if (!jobId || !contentHash || !driveId || !title || !mimeType || typeof fileSize !== 'number') {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  if (!uploadSemaphore.verifySlotOwner(jobId, userId)) {
    return NextResponse.json({ error: 'Invalid or expired jobId' }, { status: 403 });
  }

  const drivePerms = await getUserDrivePermissions(userId, driveId);
  if (!drivePerms) {
    return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
  }
  if (!drivePerms.canEdit) {
    return NextResponse.json({ error: 'You do not have permission to upload to this drive' }, { status: 403 });
  }

  const record = buildPageRecord({ contentHash, driveId, title, mimeType, fileSize, userId, parentId });

  let newPage: typeof pages.$inferSelect;
  try {
    newPage = await db.transaction(async (tx) => {
      const [createdPage] = await tx.insert(pages).values(record).returning();

      await tx
        .insert(files)
        .values({
          id: contentHash,
          driveId,
          sizeBytes: fileSize,
          mimeType,
          storagePath: contentHash,
          createdBy: userId,
        })
        .onConflictDoNothing();

      await tx
        .insert(filePages)
        .values({ fileId: contentHash, pageId: createdPage.id, linkedBy: userId, linkSource: 'presigned-upload' })
        .onConflictDoUpdate({
          target: [filePages.fileId, filePages.pageId],
          set: { linkedBy: userId, linkedAt: new Date(), linkSource: 'presigned-upload' },
        });

      return createdPage;
    });
  } catch (err) {
    uploadSemaphore.releaseUploadSlot(jobId);
    await updateActiveUploads(userId, -1).catch(() => undefined);
    throw err;
  }

  uploadSemaphore.releaseUploadSlot(jobId);
  await updateActiveUploads(userId, -1);

  try {
    await enqueueProcessorJob(userId, driveId, newPage.id);
  } catch (err) {
    // Processor enqueue failure must not fail the upload response — page record is committed
    console.error('Failed to enqueue processor job:', err);
  }

  await updateStorageUsage(userId, fileSize, { pageId: newPage.id, driveId, eventType: 'upload' });

  auditRequest(request, {
    eventType: 'data.write',
    userId,
    resourceType: 'file',
    resourceId: contentHash,
    details: { driveId, pageId: newPage.id },
  });

  const actorInfo = await getActorInfo(userId);
  logFileActivity(userId, 'upload', { fileId: contentHash, fileName: title, fileType: mimeType, fileSize, driveId, pageId: newPage.id }, actorInfo);

  return NextResponse.json({ success: true, page: newPage });
}
