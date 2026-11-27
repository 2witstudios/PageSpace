/**
 * create-file-page — reusable server-side path to persist raw bytes as a FILE page.
 *
 * Extracted from the inline logic in `api/upload/complete/route.ts` so the server can
 * file bytes it holds the same way an upload does: content-address the bytes → store
 * the original → insert `files` / `pages`(FILE) / `filePages` rows → charge storage.
 *
 * Two callers, one shell (`createFilePage`):
 *   - `generate_image` (`createImageFilePage`): the bytes are the final artifact, so the
 *     page is stamped `visual` and no processor job runs. Bytes go to S3 directly.
 *   - `copy_content` → `new_file_page`: an agent's sandbox file. It is NOT known-final,
 *     so the page starts `pending` and `afterCommit` enqueues the processor's
 *     pull-verify pipeline (re-hash + Magika + extraction), exactly as an upload does.
 *     Bytes go through the processor (`storeOriginal`), where at-rest encryption applies.
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
import { assertUploadNotBlocked } from '@pagespace/lib/content-safety/upload-gate';
import { pageRepository } from '@pagespace/lib/repositories/page-repository';
import { checkStorageQuotaForDrive, chargeStorageForStore, shouldChargeForStore } from '@pagespace/lib/services/storage-limits';
import { putObject } from './s3-effects';

/** Folder (at the Home-drive root) that collects auto-filed generated images. */
export const GENERATED_IMAGES_FOLDER = 'Generated Images';

/** Thrown when persisting the bytes would exceed the payer's storage quota or per-file limit. */
export class FileStorageQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileStorageQuotaError';
  }
}

/** Where server-held bytes came from. Doubles as the `filePages.linkSource` and blocklist entry point. */
export type FilePageSource = 'image-generation' | 'sandbox-copy';

export interface CreateImageFilePageInput {
  userId: string;
  buffer: Buffer;
  mimeType: string;
  title: string;
  /** Optional prompt to stamp into fileMetadata for provenance. */
  prompt?: string;
  /**
   * Optional target location instead of the Home-drive gallery.
   *
   * `targetDriveId` alone files the image into THAT drive's "Generated Images"
   * folder (find-or-create at its root); pass `targetParentId` as well to place it
   * under an exact page. Omit both for the Home-drive gallery.
   *
   * SECURITY: this helper does NOT check drive/parent edit permissions. The caller
   * MUST verify the actor can edit the target first — `generate_image` does expose
   * these to the model and runs `canActorEditPage` on `targetParentId ?? targetDriveId`
   * before calling here. Any new caller must do the same.
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
  /** The S3 put behind the default `storeOriginal`. */
  putObject?: (key: string, body: Buffer, contentType: string) => Promise<void>;
  /**
   * Stores the original. Called BEFORE any row is written, with the id the page row
   * will carry so a page-bound service token can be minted for it. Defaults to a
   * bare S3 put of the plaintext bytes; `copy_content` stores through the processor.
   */
  storeOriginal?: (args: {
    contentHash: string;
    buffer: Buffer;
    mimeType: string;
    title: string;
    pageId: string;
    driveId: string;
    parentId: string | null;
  }) => Promise<void>;
  /**
   * Runs once the rows are committed (e.g. enqueue the processor job). Best-effort,
   * like the upload route's post-commit block: a failure is logged by the caller's
   * seam and never un-creates a page that already exists.
   */
  afterCommit?: (args: { pageId: string; driveId: string }) => Promise<void>;
  resolveGalleryParent?: (userId: string, driveId?: string) => Promise<{ driveId: string; parentId: string }>;
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

/**
 * Pure: the media type a file name declares, by extension. Only a DECLARATION —
 * the processor's pull-verify pipeline runs Magika on the real bytes and refuses
 * anything its denylist blocks regardless of what is declared here.
 */
export function mimeTypeForFileName(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    bmp: 'image/bmp',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    tsv: 'text/tab-separated-values',
    json: 'application/json',
    zip: 'application/zip',
    gz: 'application/gzip',
    tar: 'application/x-tar',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    // Listed so the declaration is HONEST: these are browser-executable, and
    // `validateMimeTypeDeclaration` refuses them by name, as presign does.
    html: 'text/html',
    htm: 'text/html',
    xhtml: 'application/xhtml+xml',
    svg: 'image/svg+xml',
    js: 'text/javascript',
    mjs: 'text/javascript',
    xml: 'application/xml',
  };
  return map[ext] ?? 'application/octet-stream';
}

/**
 * Pure: build the FILE page row for server-held bytes. `filePath` = the content hash
 * (the view route reads it). A generated image is final; anything else starts
 * `pending`, the status an upload starts in, for the processor to verify and extract.
 */
export function buildFilePageValues(params: {
  pageId: string;
  contentHash: string;
  driveId: string;
  parentId: string | null;
  title: string;
  mimeType: string;
  fileSize: number;
  userId: string;
  position: number;
  source: FilePageSource;
  prompt?: string;
  now?: Date;
}): typeof pages.$inferInsert {
  const now = params.now ?? new Date();
  const generated = params.source === 'image-generation';
  return {
    id: params.pageId,
    title: params.title,
    type: PageType.FILE,
    content: '',
    // A generated image needs no extraction: the bytes ARE the final artifact and no
    // processor job is enqueued for it. Stamp the terminal status the processor would
    // assign to an image ('visual'), NOT 'pending' — otherwise the page would sit in
    // "still being processed" forever and `read_page` could never show the assistant
    // the image it just created. Anything else gets the pull-verify job, which sets
    // the real status (visual / completed / failed) once it has looked at the bytes.
    ...(generated
      ? { processingStatus: 'visual', extractionMethod: 'visual' }
      : { processingStatus: 'pending' }),
    position: params.position,
    driveId: params.driveId,
    parentId: params.parentId,
    fileSize: params.fileSize,
    mimeType: params.mimeType,
    originalFileName: generated ? imageFileName(params.title, params.mimeType) : params.title,
    filePath: params.contentHash,
    contentHash: params.contentHash,
    fileMetadata: generated
      ? {
          generatedAt: now.toISOString(),
          generatedBy: params.userId,
          originalName: params.title,
          contentHash: params.contentHash,
          ...(params.prompt ? { prompt: params.prompt } : {}),
          source: params.source,
        }
      : {
          uploadedAt: now.toISOString(),
          uploadedBy: params.userId,
          originalName: params.title,
          contentHash: params.contentHash,
          source: params.source,
        },
    createdAt: now,
    updatedAt: now,
  };
}

/** Pure: the generated-image row — {@link buildFilePageValues} with the image-generation source. */
export function buildImageFilePageValues(
  params: Omit<Parameters<typeof buildFilePageValues>[0], 'source'>,
): typeof pages.$inferInsert {
  return buildFilePageValues({ ...params, source: 'image-generation' });
}

/**
 * Shell: find-or-create the "Generated Images" folder at the root of `targetDriveId`,
 * or of the user's Home drive when no drive is named. The gallery semantics travel
 * with the drive so an image filed into a work drive lands somewhere just as tidy as
 * one filed into Home.
 */
async function defaultResolveGalleryParent(
  userId: string,
  targetDriveId?: string,
): Promise<{ driveId: string; parentId: string }> {
  let driveId = targetDriveId;
  if (!driveId) {
    const home = await getHomeDrive(userId);
    if (!home) {
      throw new Error(`Home drive not found for user ${userId}`);
    }
    driveId = home.id;
  }

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
 * is attacker-chosen — a client can claim a hash it doesn't own. Here the server HOLDS the bytes
 * (an image model's output, or a sandbox file the server read itself) and hashes them itself, so
 * a caller cannot name a hash without possessing exactly those bytes — which is what an upload of
 * them would prove anyway — and the guard has nothing to defend. Linking an existing
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

/** Input for {@link createFilePage}: the image input plus where the bytes came from. */
export interface CreateFilePageInput extends CreateImageFilePageInput {
  source: FilePageSource;
}

/**
 * Persist `buffer` as a FILE page — the one shell behind every server-side filing.
 *
 * Defaults to the user's Home-drive "Generated Images" gallery; `targetDriveId` files
 * it into that drive's gallery and `targetParentId` under an exact page (caller MUST
 * have verified edit permission — see the input type). Enforces the storage quota
 * (bytes and the tier's per-file limit) before writing, checks the content blocklist,
 * stores the original, writes the rows, charges storage on first store, then runs
 * `afterCommit`. Returns the new page id (viewable at `/api/files/${pageId}/view`).
 */
export async function createFilePage(
  input: CreateFilePageInput,
  deps: CreateImageFilePageDeps = {},
): Promise<{ pageId: string; driveId: string; parentId: string | null; contentHash: string }> {
  const fileSize = input.buffer.length;

  // Enforce the storage quota BEFORE writing any bytes, mirroring the upload flow.
  // WAL-9: bytes filed into an org drive check the org's quota, never the user's. With no
  // target drive they land in the user's Home drive, which is never an org drive.
  const checkQuota = deps.checkQuota ?? ((u, b) => checkStorageQuotaForDrive(u, input.targetDriveId, b));
  const quota = await checkQuota(input.userId, fileSize);
  if (!quota.allowed) {
    throw new FileStorageQuotaError(quota.reason ?? 'Saving this file would exceed your storage quota.');
  }

  const hash = (deps.hash ?? sha256Hex)(input.buffer);

  // Content blocklist: these bytes are server-held, but a model can reproduce (or be
  // handed) blocked content, so they get the same check as an upload — before
  // anything is written. Throws ContentBlockedError; the gate audits the attempt.
  await assertUploadNotBlocked({
    contentHash: hash,
    userId: input.userId,
    entryPoint: input.source,
    details: { driveId: input.targetDriveId },
  });

  // Branch on the PARENT, not the drive: a named parent is an exact placement the
  // caller already authorized, while a drive alone means "that drive's gallery".
  let driveId: string;
  let parentId: string | null;
  if (input.targetParentId) {
    if (!input.targetDriveId) {
      throw new Error('targetDriveId is required when targetParentId is provided');
    }
    driveId = input.targetDriveId;
    parentId = input.targetParentId;
  } else {
    const gallery = await (deps.resolveGalleryParent ?? defaultResolveGalleryParent)(
      input.userId,
      input.targetDriveId,
    );
    driveId = gallery.driveId;
    parentId = gallery.parentId;
  }

  // Minted before the bytes are stored: a processor store authenticates with a token
  // bound to THIS page id, so the id has to exist before the row does.
  const pageId = createId();

  const storeOriginal = deps.storeOriginal
    ?? (({ contentHash, buffer, mimeType }) => (deps.putObject ?? putObject)(buildS3Key(contentHash), buffer, mimeType));
  await storeOriginal({ contentHash: hash, buffer: input.buffer, mimeType: input.mimeType, title: input.title, pageId, driveId, parentId });

  const position = await (deps.getNextPosition ?? pageRepository.getNextPosition)(driveId, parentId);

  const write: FilePageWrite = {
    fileRow: {
      id: hash,
      driveId,
      sizeBytes: fileSize,
      mimeType: input.mimeType,
      storagePath: hash,
      createdBy: input.userId,
    },
    pageValues: buildFilePageValues({
      pageId,
      contentHash: hash,
      driveId,
      parentId,
      title: input.title,
      mimeType: input.mimeType,
      fileSize,
      userId: input.userId,
      position,
      source: input.source,
      prompt: input.prompt,
    }),
    junction: { fileId: hash, pageId, linkedBy: input.userId, linkSource: input.source },
  };

  const { fileWasInserted } = await (deps.persist ?? defaultPersist)(write);

  // Charge storage once, only on the first physical store of the blob (symmetric with
  // the credit issued at unlink) — dedup stores add no bytes. Best-effort: a bookkeeping
  // failure must not fail an already-committed page.
  if (shouldChargeForStore(fileWasInserted)) {
    // WAL-9: bytes in an org drive bill the org (derived usage), never the user's quota.
    const charge = deps.chargeStorage
      ?? (async (u, b, ctx) => { await chargeStorageForStore(u, ctx.driveId, b, { pageId: ctx.pageId, eventType: ctx.eventType }); });
    await charge(input.userId, fileSize, { pageId, driveId, eventType: 'upload' }).catch(() => {});
  }

  if (deps.afterCommit) {
    await deps.afterCommit({ pageId, driveId }).catch(() => {});
  }

  return { pageId, driveId, parentId, contentHash: hash };
}

/**
 * Persist a generated image as a FILE page — `createFilePage` with the
 * image-generation source (final `visual` page, no processor run).
 */
export async function createImageFilePage(
  input: CreateImageFilePageInput,
  deps: CreateImageFilePageDeps = {},
): Promise<{ pageId: string; driveId: string; parentId: string | null }> {
  const { pageId, driveId, parentId } = await createFilePage({ ...input, source: 'image-generation' }, deps);
  return { pageId, driveId, parentId };
}
