/**
 * create-file-page — reusable server-side path to persist raw bytes as a FILE page.
 *
 * Extracted from the inline logic in `api/upload/complete/route.ts` so the image
 * generator can file a generated image the same way an upload does: content-address
 * the bytes → put to S3 → insert `files` / `pages`(FILE) / `filePages` rows. The image
 * is viewable immediately via `/api/files/[id]/view` (which serves from `filePath`
 * with no `processingStatus` gate — no processor run required).
 *
 * Pure builders (hash, page values) + a thin shell whose I/O seams (putObject, home-drive
 * resolution, position, persist) are injectable so unit tests never touch S3 or the DB.
 */

import crypto from 'crypto';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, eq, isNull } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { files, filePages } from '@pagespace/db/schema/storage';
import { PageType } from '@pagespace/lib/utils/enums';
import { getHomeDrive } from '@pagespace/lib/services/drive-service';
import { getDefaultContent } from '@pagespace/lib/content/page-types.config';
import { buildS3Key } from '@pagespace/lib/services/upload-validation';
import { pageRepository } from '@pagespace/lib/repositories/page-repository';
import { checkStorageQuota, updateStorageUsage, shouldChargeForStore } from '@pagespace/lib/services/storage-limits';
import { putObject } from './s3-effects';

/** Folder (at the Home-drive root) that collects auto-filed generated images. */
export const GENERATED_IMAGES_FOLDER = 'Generated Images';

/** Thrown when persisting a generated image would exceed the user's storage quota. */
export class ImageStorageQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageStorageQuotaError';
  }
}

export interface CreateImageFilePageInput {
  userId: string;
  buffer: Buffer;
  mimeType: string;
  title: string;
  /** Optional prompt to stamp into fileMetadata for provenance. */
  prompt?: string;
  /**
   * Optional target location instead of the Home-drive gallery. SECURITY: the caller
   * MUST verify the user can edit `targetDriveId`/`targetParentId` before passing them
   * (this helper does not check drive/parent edit permissions). The generate_image tool
   * deliberately does NOT expose these to the model — it always uses the owner's Home
   * gallery — so untrusted, model-supplied drive ids can't reach here.
   */
  targetDriveId?: string;
  targetParentId?: string;
}

export interface FilePageWrite {
  fileRow: typeof files.$inferInsert;
  pageValues: typeof pages.$inferInsert;
  junction: typeof filePages.$inferInsert;
}

export interface CreateImageFilePageDeps {
  hash?: (buffer: Buffer) => string;
  putObject?: (key: string, body: Buffer, contentType: string) => Promise<void>;
  resolveGalleryParent?: (userId: string) => Promise<{ driveId: string; parentId: string }>;
  getNextPosition?: (driveId: string, parentId: string | null) => Promise<number>;
  /** Returns whether the content-addressed `files` row was newly inserted (charge once). */
  persist?: (write: FilePageWrite) => Promise<{ fileWasInserted: boolean }>;
  /** Storage quota pre-check; throws-free, returns { allowed, reason? }. */
  checkQuota?: (userId: string, bytes: number) => Promise<{ allowed: boolean; reason?: string }>;
  /** Charge storage usage for a newly stored blob. */
  chargeStorage?: (
    userId: string,
    bytes: number,
    ctx: { pageId: string; driveId: string; eventType: 'upload' },
  ) => Promise<void>;
}

/** Pure: content-address bytes with SHA-256 (lowercase 64-hex), matching upload storage. */
export function sha256Hex(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Pure: file extension for a generated-image media type (used for the download filename).
 * Limited to the raster types `isAllowedImageType` accepts — SVG is deliberately absent
 * (it isn't an allowed image type, so a generated .svg would never render or be readable).
 */
export function extensionForMediaType(mediaType: string): string {
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
  };
  return map[mediaType.toLowerCase()] ?? '';
}

/** Pure: a download-friendly filename for the generated image (title + real extension). */
export function imageFileName(title: string, mediaType: string): string {
  const ext = extensionForMediaType(mediaType);
  return title.toLowerCase().endsWith(ext) ? title : `${title}${ext}`;
}

/** Pure: build the FILE page row. `filePath` = the content hash (the view route reads it). */
export function buildImageFilePageValues(params: {
  pageId: string;
  contentHash: string;
  driveId: string;
  parentId: string | null;
  title: string;
  mimeType: string;
  fileSize: number;
  userId: string;
  position: number;
  prompt?: string;
  now?: Date;
}): typeof pages.$inferInsert {
  const now = params.now ?? new Date();
  return {
    id: params.pageId,
    title: params.title,
    type: PageType.FILE,
    content: '',
    // A generated image needs no extraction: the bytes ARE the final artifact and no
    // processor job is enqueued for it. Stamp the terminal status the processor would
    // assign to an image ('visual'), NOT 'pending' — otherwise the page would sit in
    // "still being processed" forever and `read_page` could never show the assistant
    // the image it just created.
    processingStatus: 'visual',
    extractionMethod: 'visual',
    position: params.position,
    driveId: params.driveId,
    parentId: params.parentId,
    fileSize: params.fileSize,
    mimeType: params.mimeType,
    originalFileName: imageFileName(params.title, params.mimeType),
    filePath: params.contentHash,
    contentHash: params.contentHash,
    fileMetadata: {
      generatedAt: now.toISOString(),
      generatedBy: params.userId,
      originalName: params.title,
      contentHash: params.contentHash,
      ...(params.prompt ? { prompt: params.prompt } : {}),
      source: 'image-generation',
    },
    createdAt: now,
    updatedAt: now,
  };
}

/** Shell: find-or-create the "Generated Images" folder at the user's Home-drive root. */
async function defaultResolveGalleryParent(userId: string): Promise<{ driveId: string; parentId: string }> {
  const home = await getHomeDrive(userId);
  if (!home) {
    throw new Error(`Home drive not found for user ${userId}`);
  }
  const driveId = home.id;

  const existing = await db.query.pages.findFirst({
    where: and(
      eq(pages.driveId, driveId),
      isNull(pages.parentId),
      eq(pages.type, PageType.FOLDER),
      eq(pages.title, GENERATED_IMAGES_FOLDER),
      eq(pages.isTrashed, false),
    ),
    columns: { id: true },
  });
  if (existing) return { driveId, parentId: existing.id };

  const position = await pageRepository.getNextPosition(driveId, null);
  const folder = await pageRepository.create({
    title: GENERATED_IMAGES_FOLDER,
    type: PageType.FOLDER,
    content: getDefaultContent(PageType.FOLDER),
    driveId,
    parentId: null,
    position,
    createdBy: userId,
  });
  return { driveId, parentId: folder.id };
}

/**
 * Shell: the three-insert transaction (files → pages(FILE) → filePages junction).
 *
 * NOTE vs the upload path: `api/upload/complete` guards the content-addressed `files` row
 * with `canLinkExistingFileRow` (a cross-tenant claim check) because there the CONTENT HASH
 * is attacker-chosen — a client can claim a hash it doesn't own. Here the bytes are produced
 * server-side by the image model and hashed server-side, so a caller cannot steer the hash to
 * collide with another tenant's blob, and the guard has nothing to defend. Linking an existing
 * row is therefore safe (it is the same bytes, deduplicated) and storage is charged only on
 * first insert. If this helper ever accepts caller-supplied bytes/hashes, reinstate the guard.
 */
async function defaultPersist(write: FilePageWrite): Promise<{ fileWasInserted: boolean }> {
  return db.transaction(async (tx) => {
    // Content-addressed store: only the FIRST insert of a given hash adds bytes, so
    // storage is charged once (symmetric with the unlink credit) — dedup stores don't.
    const insertedFiles = await tx
      .insert(files)
      .values(write.fileRow)
      .onConflictDoNothing()
      .returning({ id: files.id });
    await tx.insert(pages).values(write.pageValues);
    await tx.insert(filePages).values(write.junction).onConflictDoNothing();
    return { fileWasInserted: insertedFiles.length > 0 };
  });
}

/**
 * Persist `buffer` as a FILE page. Defaults to the user's Home-drive "Generated Images"
 * gallery; `targetDriveId`/`targetParentId` file it elsewhere (caller MUST have verified
 * edit permission — see the input type). Enforces the storage quota before writing and
 * charges storage on first store. Returns the new page id (viewable at
 * `/api/files/${pageId}/view`).
 */
export async function createImageFilePage(
  input: CreateImageFilePageInput,
  deps: CreateImageFilePageDeps = {},
): Promise<{ pageId: string; driveId: string; parentId: string | null }> {
  const fileSize = input.buffer.length;

  // Enforce the storage quota BEFORE writing any bytes, mirroring the upload flow, so
  // generated images can't let a user exceed their plan storage.
  const quota = await (deps.checkQuota ?? checkStorageQuota)(input.userId, fileSize);
  if (!quota.allowed) {
    throw new ImageStorageQuotaError(quota.reason ?? 'Saving this image would exceed your storage quota.');
  }

  const hash = (deps.hash ?? sha256Hex)(input.buffer);
  await (deps.putObject ?? putObject)(buildS3Key(hash), input.buffer, input.mimeType);

  let driveId: string;
  let parentId: string | null;
  if (input.targetDriveId) {
    driveId = input.targetDriveId;
    parentId = input.targetParentId ?? null;
  } else {
    const gallery = await (deps.resolveGalleryParent ?? defaultResolveGalleryParent)(input.userId);
    driveId = gallery.driveId;
    parentId = gallery.parentId;
  }

  const position = await (deps.getNextPosition ?? pageRepository.getNextPosition)(driveId, parentId);
  const pageId = createId();

  const write: FilePageWrite = {
    fileRow: {
      id: hash,
      driveId,
      sizeBytes: fileSize,
      mimeType: input.mimeType,
      storagePath: hash,
      createdBy: input.userId,
    },
    pageValues: buildImageFilePageValues({
      pageId,
      contentHash: hash,
      driveId,
      parentId,
      title: input.title,
      mimeType: input.mimeType,
      fileSize,
      userId: input.userId,
      position,
      prompt: input.prompt,
    }),
    junction: { fileId: hash, pageId, linkedBy: input.userId, linkSource: 'image-generation' },
  };

  const { fileWasInserted } = await (deps.persist ?? defaultPersist)(write);

  // Charge storage once, only on the first physical store of the blob (symmetric with
  // the credit issued at unlink) — dedup stores add no bytes. Best-effort: a bookkeeping
  // failure must not fail an already-committed page.
  if (shouldChargeForStore(fileWasInserted)) {
    const charge = deps.chargeStorage ?? ((u, b, ctx) => updateStorageUsage(u, b, ctx));
    await charge(input.userId, fileSize, { pageId, driveId, eventType: 'upload' }).catch(() => {});
  }

  return { pageId, driveId, parentId };
}
