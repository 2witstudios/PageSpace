import { NextResponse } from 'next/server';
import { createId } from '@paralleldrive/cuid2';
import { and, eq, isNull } from '@pagespace/db/operators';
import { authenticateRequestWithOptions, isAuthError, checkMCPCreateScope, isScopedMCPAuth } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { pages } from '@pagespace/db/schema/core';
import { files, filePages } from '@pagespace/db/schema/storage';
import { PageType } from '@pagespace/lib/utils/enums';
import { getUserDrivePermissions } from '@pagespace/lib/permissions/permissions';
import { getAppDriveAccessLevel } from '@pagespace/lib/permissions/app-permissions';
import { updateStorageUsage, shouldChargeForStore } from '@pagespace/lib/services/storage-limits';
import { releasePendingUpload } from '@pagespace/lib/services/pending-uploads';
import { uploadSemaphore } from '@pagespace/lib/services/upload-semaphore';
import { buildS3Key, canLinkExistingFileRow } from '@pagespace/lib/services/upload-validation';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { getActorInfo, logFileActivity } from '@pagespace/lib/monitoring/activity-logger';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { enqueueProcessorJob } from '@/lib/upload/processor-effects';
import { checkObjectExists } from '@/lib/upload/s3-effects';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

// Thrown inside the completion transaction to roll it back when the caller is
// trying to link a content-addressed blob they neither uploaded nor reference
// (H3 cross-tenant claim). Caught by the route and mapped to a 409.
class CrossTenantClaimError extends Error {
  constructor() {
    super('Cross-tenant file claim rejected');
    this.name = 'CrossTenantClaimError';
  }
}

// The transaction executor passed to db.transaction's callback — also satisfied
// by `db` itself. resolveUploadPosition takes this so the sibling reads run on
// the same transactional client as the insert.
type Executor = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
 *
 * Runs on the caller's transaction executor so the read and the subsequent
 * insert share one transaction (a stricter isolation level then serializes
 * concurrent inserts into the same sibling list; under READ COMMITTED two
 * simultaneous appends can still tie, which fractional ordering tolerates).
 */
async function resolveUploadPosition(
  tx: Executor,
  parentId: string | null,
  position: 'before' | 'after' | null | undefined,
  afterNodeId: string | null | undefined,
): Promise<number> {
  const parentWhere = parentId ? eq(pages.parentId, parentId) : isNull(pages.parentId);
  // Match the page tree, which only renders non-trashed siblings, so the
  // fractional math is computed against the same set the user sees.
  const siblingWhere = and(parentWhere, eq(pages.isTrashed, false));

  // Common case (plain append): a single indexed lookup of the last sibling.
  const appendToEnd = async (): Promise<number> => {
    const lastPage = await tx.query.pages.findFirst({
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
  // eslint-disable-next-line no-restricted-syntax -- pre-existing unbounded findMany, not fixed by Phase 8 (PageSpace epic j44e35jwzlhr54fbmruk3k4i follow-up)
  const siblings = await tx.query.pages.findMany({
    where: siblingWhere,
    orderBy: (p, { asc }) => [asc(p.position)],
  });
  const targetIndex = siblings.findIndex((s) => s.id === afterNodeId);
  if (targetIndex === -1) return appendToEnd();

  const target = siblings[targetIndex];

  if (position === 'before') {
    // Anchor below the target when it's the first sibling, so we don't collide
    // with a first sibling sitting at position 0 ((0 + 0) / 2 === 0).
    const prevPos = targetIndex > 0 ? siblings[targetIndex - 1].position : target.position - 1;
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
  // H3 hint captured at presign (server-trusted). The authoritative anti-claim
  // check is the atomic `files`-row ownership claim in the transaction below;
  // this only short-circuits the legitimate-dedup case. Default to the safe
  // (most restrictive) value if an older slot lacks it.
  const callerAlreadyReferences = reserved.callerAlreadyReferences ?? false;

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

  // A client-supplied parentId is only gated by drive-level edit access above, so
  // confirm the parent actually lives in this (reserved) drive and isn't trashed —
  // otherwise an editor of one drive could nest the upload under a page in another
  // (or private) drive.
  const resolvedParentId = parentId ?? null;
  if (resolvedParentId) {
    const parent = await db.query.pages.findFirst({ where: eq(pages.id, resolvedParentId) });
    if (!parent || parent.driveId !== driveId || parent.isTrashed) {
      return NextResponse.json({ error: 'Invalid parent page' }, { status: 400 });
    }
  }

  // The UI uploads straight to S3, so /complete can be reached without the PUT
  // ever happening. Confirm the object is actually present before creating a
  // page/file record and charging storage, so a skipped or failed upload can't
  // leave an orphaned file page pointing at a missing object.
  const objectExists = await checkObjectExists(buildS3Key(contentHash));
  if (!objectExists) {
    uploadSemaphore.releaseUploadSlot(jobId);
    await releasePendingUpload(jobId).catch(() => undefined);
    return NextResponse.json({ error: 'Uploaded object not found in storage' }, { status: 409 });
  }

  let newPage: typeof pages.$inferSelect;
  // M8: storage is content-addressed — only the FIRST physical store of a blob
  // inserts a `files` row (createdBy = uploader). Charge once, on that insert, so
  // dedup completes don't N-charge while the reaper only ever credits once.
  let fileWasInserted = false;
  try {
    const result = await db.transaction(async (tx) => {
      // H3 (race-proof): claim the content-addressed `files` row FIRST. The first
      // completion to insert it owns the blob (createdBy). If a row already exists,
      // linking is allowed only when the caller owns it or already references the
      // hash — otherwise this is a cross-tenant claim (incl. a presign→complete
      // race where another tenant created the object) and we roll back.
      const insertedFiles = await tx
        .insert(files)
        .values({
          id: contentHash,
          driveId,
          sizeBytes: fileSize,
          mimeType,
          storagePath: contentHash,
          createdBy: userId,
        })
        .onConflictDoNothing()
        .returning({ id: files.id });
      const fileWasInsertedInTx = insertedFiles.length > 0;

      let ownedByCaller = false;
      if (!fileWasInsertedInTx) {
        const existing = await tx.query.files.findFirst({
          where: eq(files.id, contentHash),
          columns: { createdBy: true },
        });
        ownedByCaller = existing?.createdBy === userId;
      }

      if (!canLinkExistingFileRow({ fileWasInserted: fileWasInsertedInTx, ownedByCaller, callerAlreadyReferences })) {
        throw new CrossTenantClaimError();
      }

      // Compute position inside the transaction so the sibling read and the
      // insert share one transactional snapshot.
      const calculatedPosition = await resolveUploadPosition(tx, resolvedParentId, position, afterNodeId);
      const record = buildPageRecord({ contentHash, driveId, title, mimeType, fileSize, userId, parentId: resolvedParentId, position: calculatedPosition });
      const [createdPage] = await tx.insert(pages).values(record).returning();

      await tx
        .insert(filePages)
        .values({ fileId: contentHash, pageId: createdPage.id, linkedBy: userId, linkSource: 'presigned-upload' })
        .onConflictDoUpdate({
          target: [filePages.fileId, filePages.pageId],
          set: { linkedBy: userId, linkedAt: new Date(), linkSource: 'presigned-upload' },
        });

      return { createdPage, fileWasInserted: fileWasInsertedInTx };
    });
    newPage = result.createdPage;
    fileWasInserted = result.fileWasInserted;
  } catch (err) {
    uploadSemaphore.releaseUploadSlot(jobId);
    await releasePendingUpload(jobId).catch(() => undefined);
    if (err instanceof CrossTenantClaimError) {
      return NextResponse.json(
        { error: 'This file could not be verified for upload. Please re-upload the original file.' },
        { status: 409 },
      );
    }
    throw err;
  }

  uploadSemaphore.releaseUploadSlot(jobId);

  // The page is committed. Everything below is best-effort bookkeeping — a
  // failure here must not turn a successful upload into a 500 (which would make
  // the client retry and duplicate the page).
  try {
    // Isolated from the rest of this block: a transient failure releasing the
    // pending_uploads row must not skip the processor enqueue, storage charge,
    // or audit/activity logging below (#2225 review — CodeRabbit).
    await releasePendingUpload(jobId).catch((err) => {
      loggers.api.warn('releasePendingUpload failed after successful complete', {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    try {
      await enqueueProcessorJob(userId, driveId, newPage.id);
    } catch (err) {
      // Best-effort by design, but the page now has no derived content
      // (thumbnails/OCR/extraction) until reprocessed — keep this loud.
      loggers.api.error('Failed to enqueue processor job', err instanceof Error ? err : new Error(String(err)), {
        userId,
        driveId,
        pageId: newPage.id,
      });
    }

    // M8: charge only on the first physical store of the blob (symmetric with the
    // single credit the reaper issues at unlink). Dedup completes store no new
    // bytes and must not be charged.
    if (shouldChargeForStore(fileWasInserted)) {
      await updateStorageUsage(userId, fileSize, { pageId: newPage.id, driveId, eventType: 'upload' });
    }

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
