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
import { putObject } from './s3-effects';

/** Folder (at the Home-drive root) that collects auto-filed generated images. */
export const GENERATED_IMAGES_FOLDER = 'Generated Images';

export interface CreateImageFilePageInput {
  userId: string;
  buffer: Buffer;
  mimeType: string;
  title: string;
  /** Optional prompt to stamp into fileMetadata for provenance. */
  prompt?: string;
  /** When set, file the image here instead of the Home-drive gallery. */
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
  persist?: (write: FilePageWrite) => Promise<void>;
}

/** Pure: content-address bytes with SHA-256 (lowercase 64-hex), matching upload storage. */
export function sha256Hex(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
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
    processingStatus: 'pending',
    position: params.position,
    driveId: params.driveId,
    parentId: params.parentId,
    fileSize: params.fileSize,
    mimeType: params.mimeType,
    originalFileName: params.title,
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

/** Shell: the three-insert transaction (files → pages(FILE) → filePages junction). */
async function defaultPersist(write: FilePageWrite): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(files).values(write.fileRow).onConflictDoNothing();
    await tx.insert(pages).values(write.pageValues);
    await tx.insert(filePages).values(write.junction).onConflictDoNothing();
  });
}

/**
 * Persist `buffer` as a FILE page. Defaults to the user's Home-drive "Generated Images"
 * gallery; pass `targetDriveId`/`targetParentId` to file it elsewhere. Returns the new
 * page id (viewable at `/api/files/${pageId}/view`).
 */
export async function createImageFilePage(
  input: CreateImageFilePageInput,
  deps: CreateImageFilePageDeps = {},
): Promise<{ pageId: string; driveId: string; parentId: string | null }> {
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
  const fileSize = input.buffer.length;

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

  await (deps.persist ?? defaultPersist)(write);
  return { pageId, driveId, parentId };
}
