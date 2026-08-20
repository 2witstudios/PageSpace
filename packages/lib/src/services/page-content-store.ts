import { promises as fs } from 'fs';
import { join } from 'path';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { db } from '@pagespace/db/db';
import { eq, sql } from '@pagespace/db/operators';
import * as dbSchema from '@pagespace/db/schema';
import { decideBlobReclaim, type BlobRetainReason } from './page-content-reclaim';
import { CONTENT_REF_LOCK_CLASS, contentRefLockId } from './page-content-lock';
import { hashWithPrefix } from '../utils/hash-utils';
import {
  compress,
  compressIfNeeded,
  decompressIfNeeded,
  COMPRESSION_THRESHOLD_BYTES,
} from '../utils/compression';
import type { PageContentFormat } from '../content/page-content-format';

const CONTENT_SUBDIR = 'page-content';
const CONTENT_REF_REGEX = /^[a-f0-9]{64}$/i;

const COMPRESSION_MAGIC = 'PSCOMP\0';

export interface WritePageContentOptions {
  compress?: boolean | 'auto';
}

/**
 * Blobs younger than this are never reclaimed — see `decideBlobReclaim` for
 * why the floor exists. A day is far longer than any request that could be
 * mid-flight between a dedupe HEAD and its row insert.
 */
export const RECLAIM_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export interface DeletePageContentOptions {
  /** Override the age floor. Lower it only in tests. */
  minAgeMs?: number;
  /** Clock injection point for tests. */
  now?: Date;
}

/**
 * A reason is present exactly when the blob was kept, so the two travel
 * together rather than as a boolean a caller could read without the why.
 */
export type DeletePageContentResult =
  | { ref: string; deleted: true }
  | { ref: string; deleted: false; reason: BlobRetainReason };

export interface WritePageContentResult {
  ref: string;
  size: number;
  compressed: boolean;
  storedSize: number;
  compressionRatio: number;
}

// --- S3 helpers ---

let _s3: S3Client | null = null;

function s3(): S3Client {
  if (!_s3) {
    _s3 = new S3Client({
      region: process.env.AWS_REGION ?? 'auto',
      endpoint: process.env.AWS_ENDPOINT_URL_S3,
      credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          }
        : undefined,
    });
  }
  return _s3;
}

function getBucket(): string {
  return process.env.BUCKET_NAME ?? process.env.TIGRIS_BUCKET ?? process.env.S3_BUCKET ?? 'pagespace-files';
}

function assertContentRef(ref: string): void {
  if (!CONTENT_REF_REGEX.test(ref)) {
    throw new Error('Invalid content reference');
  }
}

/** Anything that can run a statement — the db singleton or a transaction. */
type Executor = Pick<typeof db, 'execute' | 'select'>;

/**
 * Hold the reclaim lock for `ref` until `tx` commits. See page-content-lock.ts
 * for why write and reclaim must serialise on it.
 */
async function lockContentRef(tx: Executor, ref: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${CONTENT_REF_LOCK_CLASS}, ${contentRefLockId(ref)})`
  );
}

function getS3Key(ref: string): string {
  assertContentRef(ref);
  return `${CONTENT_SUBDIR}/${ref.slice(0, 2)}/${ref}`;
}

function shouldApplyCompression(
  contentSize: number,
  options?: WritePageContentOptions
): boolean {
  const compressOption = options?.compress ?? 'auto';
  if (compressOption === true) return true;
  if (compressOption === false) return false;
  return contentSize >= COMPRESSION_THRESHOLD_BYTES;
}

export async function writePageContent(
  content: string,
  format: PageContentFormat,
  options?: WritePageContentOptions
): Promise<WritePageContentResult> {
  const ref = hashWithPrefix(format, content);
  const key = getS3Key(ref);
  const bucket = getBucket();

  const originalSize = Buffer.byteLength(content, 'utf8');
  const applyCompression = shouldApplyCompression(originalSize, options);

  let dataToStore: string;
  let compressed = false;
  let storedSize: number;
  let compressionRatio = 1;

  if (applyCompression) {
    const forceCompression = options?.compress === true;
    const compressionResult = forceCompression
      ? { ...compress(content), compressed: true }
      : compressIfNeeded(content);

    if (compressionResult.compressed) {
      dataToStore = COMPRESSION_MAGIC + compressionResult.data;
      compressed = true;
      storedSize = Buffer.byteLength(dataToStore, 'utf8');
      compressionRatio = compressionResult.compressionRatio;
    } else {
      dataToStore = content;
      storedSize = originalSize;
    }
  } else {
    dataToStore = content;
    storedSize = originalSize;
  }

  // Serialised against reclaim for this ref, so the object cannot be deleted
  // between the existence check and this function returning the ref to a caller
  // that is about to persist it.
  await db.transaction(async (tx) => {
    await lockContentRef(tx, ref);

    let exists = true;
    try {
      await s3().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    } catch {
      exists = false;
    }

    if (!exists) {
      await s3().send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: Buffer.from(dataToStore, 'utf8'),
        ContentType: 'text/plain; charset=utf-8',
      }));
      return;
    }

    // Content-addressable: the bytes are already right, so this copies the
    // object onto itself purely to move its LastModified forward. That is what
    // makes the reclaim age floor mean "nothing has written this blob recently"
    // rather than "this blob was created recently" — without it, a dedupe hit
    // on an old blob returns a ref the reclaimer still considers fair game.
    await s3().send(new CopyObjectCommand({
      Bucket: bucket,
      Key: key,
      CopySource: `${bucket}/${key}`,
      MetadataDirective: 'REPLACE',
      ContentType: 'text/plain; charset=utf-8',
    }));
  });

  return { ref, size: originalSize, compressed, storedSize, compressionRatio };
}

export async function readPageContent(ref: string): Promise<string> {
  const key = getS3Key(ref);
  try {
    const response = await s3().send(new GetObjectCommand({ Bucket: getBucket(), Key: key }));
    if (!response.Body) throw new Error(`Empty S3 response body for ref ${ref}`);
    const bytes = await response.Body.transformToByteArray();
    const storedContent = Buffer.from(bytes).toString('utf8');
    if (storedContent.startsWith(COMPRESSION_MAGIC)) {
      const compressedData = storedContent.slice(COMPRESSION_MAGIC.length);
      return decompressIfNeeded(compressedData, true);
    }
    return storedContent;
  } catch (err: unknown) {
    const code = (err as { Code?: string; name?: string }).Code ?? (err as { name?: string }).name;
    // Fall back to filesystem for pre-cutover content not yet backfilled to S3.
    // Remove this fallback once the aws s3 sync migration is complete.
    if (code !== 'NoSuchKey') throw err;
    return readPageContentFromFilesystem(ref);
  }
}

function contentFilesystemPath(ref: string): string {
  assertContentRef(ref);
  const base = process.env.PAGE_CONTENT_STORAGE_PATH
    ?? process.env.FILE_STORAGE_PATH
    ?? join(process.cwd(), 'storage');
  return join(base, CONTENT_SUBDIR, ref.slice(0, 2), ref);
}

async function readPageContentFromFilesystem(ref: string): Promise<string> {
  const storedContent = await fs.readFile(contentFilesystemPath(ref), 'utf8');
  if (storedContent.startsWith(COMPRESSION_MAGIC)) {
    const compressedData = storedContent.slice(COMPRESSION_MAGIC.length);
    return decompressIfNeeded(compressedData, true);
  }
  return storedContent;
}

export async function isContentCompressed(ref: string): Promise<boolean> {
  const key = getS3Key(ref);
  const response = await s3().send(new GetObjectCommand({
    Bucket: getBucket(),
    Key: key,
    Range: `bytes=0-${COMPRESSION_MAGIC.length - 1}`,
  }));
  if (!response.Body) return false;
  const bytes = await response.Body.transformToByteArray();
  return Buffer.from(bytes).toString('utf8') === COMPRESSION_MAGIC;
}

export async function getContentMetadata(ref: string): Promise<{
  storedSize: number;
  compressed: boolean;
}> {
  const key = getS3Key(ref);
  const [headResponse, compressed] = await Promise.all([
    s3().send(new HeadObjectCommand({ Bucket: getBucket(), Key: key })),
    isContentCompressed(ref),
  ]);

  return {
    storedSize: headResponse.ContentLength ?? 0,
    compressed,
  };
}

/**
 * Every table that can hold a content ref, derived from the schema itself.
 *
 * A blob is reclaimable only when none of them still points at it, so this list
 * being short by one table means deleting content that is still in use. Reading
 * it off the schema rather than maintaining it by hand means a new `contentRef`
 * column is covered the day it is added — including one declared with a
 * different column type or built by a shared helper, which a source-text guard
 * would miss.
 */
const CONTENT_REF_SOURCES = Object.values(dbSchema as Record<string, unknown>)
  .filter((value): value is PgTable => !!value && is(value, PgTable))
  .filter((table) => 'contentRef' in getTableColumns(table));

/** SQL names of the tables the reclaim path consults. Exported for the coverage test. */
export const CONTENT_REF_TABLE_NAMES: string[] = [
  ...new Set(CONTENT_REF_SOURCES.map((table) => getTableName(table))),
].sort();

/**
 * Whether any row, in any drive of any tenant, still references this blob.
 *
 * Deliberately an existence probe rather than a count: the decision is binary,
 * and neither `contentRef` column is indexed, so counting every match would scan
 * the whole version history and activity log to learn something the first row
 * already settles. (An index on those columns is worth adding in the change
 * that first calls this on a real workload.)
 */
export async function pageContentIsReferenced(ref: string, executor: Executor = db): Promise<boolean> {
  assertContentRef(ref);

  for (const table of CONTENT_REF_SOURCES) {
    const column = getTableColumns(table).contentRef;
    const rows = await executor.select({ contentRef: column }).from(table).where(eq(column, ref)).limit(1);
    if (rows.length > 0) return true;
  }
  return false;
}

/**
 * Age of the stored object, and where it lives. S3 is authoritative; the
 * filesystem branch mirrors `readPageContent`'s fallback for pre-cutover
 * content that has not been synced yet — without it, that content would be
 * permanently unreclaimable.
 */
async function statContentObject(
  ref: string
): Promise<{ lastModified: Date | null; location: 's3' | 'filesystem' } | null> {
  const key = getS3Key(ref);
  try {
    const head = await s3().send(new HeadObjectCommand({ Bucket: getBucket(), Key: key }));
    return { lastModified: head.LastModified ?? null, location: 's3' };
  } catch (err: unknown) {
    const code = (err as { Code?: string; name?: string }).Code ?? (err as { name?: string }).name;
    if (code !== 'NoSuchKey' && code !== 'NotFound') throw err;
  }

  try {
    const stat = await fs.stat(contentFilesystemPath(ref));
    return { lastModified: stat.mtime, location: 'filesystem' };
  } catch {
    return null;
  }
}

/**
 * Reclaim a content-addressed blob, if and only if nothing references it.
 *
 * Call this AFTER the rows that referenced the blob are deleted and committed:
 * the reference count is read from the database as it stands now, so an
 * uncommitted delete would read as "still referenced" and retain the blob — the
 * safe direction. The unsafe direction, deleting before the rows are gone, is
 * what the count is there to prevent.
 *
 * Returns without deleting — never throws — when the blob is still referenced,
 * too young, or already absent; the `reason` says which.
 */
export async function deletePageContent(
  ref: string,
  options?: DeletePageContentOptions
): Promise<DeletePageContentResult> {
  assertContentRef(ref);

  return db.transaction(async (tx) => {
    // Everything below runs under the ref's lock: a concurrent writer cannot
    // observe this object and skip its upload while we are deciding to delete
    // it, and cannot refresh it after we have read its age.
    await lockContentRef(tx, ref);

    // Settle the cheap, decisive question first: a referenced blob is kept
    // whatever its age, so there is no reason to go ask storage about it.
    if (await pageContentIsReferenced(ref, tx)) {
      return { ref, deleted: false, reason: 'still-referenced' } as const;
    }

    const stored = await statContentObject(ref);
    if (!stored) {
      return { ref, deleted: false, reason: 'not-stored' } as const;
    }

    const now = options?.now ?? new Date();
    const decision = decideBlobReclaim({
      blobAgeMs: stored.lastModified ? now.getTime() - stored.lastModified.getTime() : null,
      minAgeMs: options?.minAgeMs ?? RECLAIM_MIN_AGE_MS,
    });

    if (decision.action === 'retain') {
      return { ref, deleted: false, reason: decision.reason } as const;
    }

    if (stored.location === 's3') {
      await s3().send(new DeleteObjectCommand({ Bucket: getBucket(), Key: getS3Key(ref) }));
    } else {
      await fs.unlink(contentFilesystemPath(ref));
    }

    return { ref, deleted: true } as const;
  });
}

export { COMPRESSION_THRESHOLD_BYTES };
