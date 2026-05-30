import { NextResponse } from 'next/server';
import { createId } from '@paralleldrive/cuid2';
import { eq, isNull } from '@pagespace/db/operators';
import { authenticateRequestWithOptions, isAuthError, checkMCPCreateScope } from '@/lib/auth';
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
  title: string;
  parentId?: string | null;
  // Tree ordering: drop a file before/after a sibling. Omitted = append at end.
  position?: 'before' | 'after' | null;
  afterNodeId?: string | null;
  // contentHash / driveId / mimeType / fileSize are intentionally NOT read from
  // the body — they are taken from the presign-reserved slot (see getSlotMetadata).
}

/**
 * Resolve the fractional `position` for a newly uploaded page among its
 * siblings. Ported from the legacy multipart route so drop-between-nodes
 * ordering in the page tree survives the direct-to-S3 cutover. An unknown
 * afterNodeId or no position falls back to appending at the end of the list.
 */
async function resolveUploadPosition(
  parentId: string | null,
  position: 'before' | 'after' | null | undefined,
  afterNodeId: string | null | undefined,
): Promise<number> {
  const siblingWhere = parentId ? eq(pages.parentId, parentId) : isNull(pages.parentId);

  // Common case (plain append): a single indexed lookup of the last sibling.
  const appendToEnd = async (): Promise<number> => {
    const lastPage = await db.query.pages.findFirst({
      where: siblingWhere,
      orderBy: (p, { desc }) => [desc(p.position)],
    });
    return lastPage ? lastPage.position + 1 : 0;
  };

  if ((position !== 'before' && position !== 'after') || !afterNodeId) {
    return appendToEnd();
  }

  // Resolve the target from the sibling set itself, so an afterNodeId that
  // belongs to a different parent (or doesn't exist) falls back to appending
  // rather than landing at an arbitrary position.
  const siblings = await db.query.pages.findMany({
    where: siblingWhere,
    orderBy: (p, { asc }) => [asc(p.position)],
  });
  const targetIndex = siblings.findIndex((s) => s.id === afterNodeId);
  if (targetIndex === -1) return appendToEnd();

  const target = siblings[targetIndex];

  if (position === 'before') {
    const prevPos = targetIndex > 0 ? siblings[targetIndex - 1].position : 0;
    return (prevPos + target.position) / 2;
  }

  const nextSibling = siblings[targetIndex + 1];
  const nextPos = nextSibling ? nextSibling.position : target.position + 2;
  return (target.position + nextPos) / 2;
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
  position: number;
}): NewPageRecord {
  return {
    id: createId(),
    title: params.title,
    type: PageType.FILE,
    content: '',
    processingStatus: 'pending',
    position: params.position,
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

  const { jobId, title, parentId, position, afterNodeId } = body;

  if (!jobId || !title) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  // contentHash / driveId / fileSize / mimeType come from the slot reserved at
  // presign time — never from the client body — so a verified jobId can't be
  // replayed against a different drive, hash, size, or MIME type.
  const reserved = uploadSemaphore.getSlotMetadata(jobId, userId);
  if (!reserved) {
    return NextResponse.json({ error: 'Invalid or expired jobId' }, { status: 403 });
  }
  const { contentHash, driveId, fileSize, mimeType } = reserved;

  // Scoped MCP tokens may only act on the drive they were granted for.
  const scopeError = checkMCPCreateScope(auth, driveId);
  if (scopeError) return scopeError;

  const drivePerms = await getUserDrivePermissions(userId, driveId);
  if (!drivePerms) {
    return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
  }
  if (!drivePerms.canEdit) {
    return NextResponse.json({ error: 'You do not have permission to upload to this drive' }, { status: 403 });
  }

  const resolvedParentId = parentId ?? null;
  const calculatedPosition = await resolveUploadPosition(resolvedParentId, position, afterNodeId);
  const record = buildPageRecord({ contentHash, driveId, title, mimeType, fileSize, userId, parentId: resolvedParentId, position: calculatedPosition });

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

  // The page is committed. Everything below is best-effort bookkeeping — a
  // failure here must not turn a successful upload into a 500 (which would make
  // the client retry and duplicate the page).
  try {
    await updateActiveUploads(userId, -1);

    try {
      await enqueueProcessorJob(userId, driveId, newPage.id);
    } catch (err) {
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
  } catch (err) {
    console.error('Post-commit bookkeeping failed for upload:', err);
  }

  return NextResponse.json({ success: true, page: newPage });
}
