import 'server-only';

import { createHash } from 'crypto';
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import {
  holdKeyFor,
  type ObjectDigest,
  type TakedownOriginal,
  type TakedownStorage,
} from '@pagespace/lib/content-safety/takedown';
import { hasEnvelopeMagic, maybeDecryptBuffer } from '@pagespace/lib/encryption/envelope-crypto';
import { normalizeContentHash } from '@pagespace/lib/content-safety/policy';
import { getS3Bucket, getS3Client } from '@/lib/presigned-url';
import { deleteS3Keys, headS3Object, isS3NotFound, listS3Prefix, type S3ObjectInfo } from '@/lib/storage/s3-objects';
import {
  deletePublishedAssetsForHash,
  headPublishedAsset,
  isPublishConfigured,
  readPublishedAsset,
} from '@/lib/canvas/published-storage';

/**
 * The object-store side of a content takedown.
 *
 * It runs in the web app because this is the only service holding credentials
 * for BOTH buckets: the private uploads bucket (presigned-url.ts) and the
 * public publish bucket (published-storage.ts).
 *
 * Deletes go straight to S3. They deliberately do not use the processor's
 * `DELETE /api/files/:hash`, which refuses while any row still references the
 * hash — the exact situation a takedown is in. Deleting the objects also makes
 * every presigned URL already issued for them fail.
 */

/** Every key prefix in the uploads bucket that holds bytes for a content hash. */
export function uploadsPrefixesFor(contentHash: string): string[] {
  return [`files/${contentHash}/`, `cache/${contentHash}/`, `chat-attachments/${contentHash}/`];
}

/** The originals a preserved copy can be made from, in order of preference. */
function uploadsOriginalKeysFor(contentHash: string): string[] {
  return [`files/${contentHash}/original`, `chat-attachments/${contentHash}/original`];
}

/**
 * The private bucket preserved copies go to, or null when none is configured.
 * It uses the uploads bucket's credentials and endpoint.
 */
export function getEvidenceBucket(): string | null {
  const bucket = process.env.EVIDENCE_BUCKET?.trim();
  if (!bucket) return null;
  // The publish bucket is world-readable. Preserving illegal material there
  // would republish it; refuse loudly rather than treat it as "configured".
  if (bucket === process.env.PUBLISH_BUCKET) {
    throw new Error('EVIDENCE_BUCKET must not be the public publish bucket');
  }
  return bucket;
}

function requireHash(contentHash: string): string {
  const hash = normalizeContentHash(contentHash);
  if (!hash) throw new Error('Invalid content hash');
  return hash;
}

function requireEvidenceBucket(): string {
  const bucket = getEvidenceBucket();
  if (!bucket) throw new Error('EVIDENCE_BUCKET is not configured');
  return bucket;
}

/** Every object the uploads bucket holds for a hash. The three prefixes are independent, so they are listed together. */
async function listUploadsObjects(hash: string): Promise<S3ObjectInfo[]> {
  const perPrefix = await Promise.all(
    uploadsPrefixesFor(hash).map((prefix) => listS3Prefix(getS3Client(), getS3Bucket(), prefix)),
  );
  return perPrefix.flat();
}

/** The private original for a hash, if one exists: the page-file original, else the chat attachment. */
async function findPrivateOriginal(hash: string): Promise<TakedownOriginal | null> {
  for (const key of uploadsOriginalKeysFor(hash)) {
    const head = await headS3Object(getS3Client(), getS3Bucket(), key);
    if (head) return head;
  }
  return null;
}

/** The chunks of an S3 object body: streamed when the SDK gives a stream, whole otherwise. */
async function* bodyChunks(body: unknown): AsyncIterable<Uint8Array> {
  if (body === undefined || body === null) return;
  if (typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function') {
    yield* body as AsyncIterable<Uint8Array>;
    return;
  }
  const whole = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof whole.transformToByteArray === 'function') {
    yield await whole.transformToByteArray();
    return;
  }
  throw new Error('Unreadable object body');
}

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Read an object once and hash it: the bytes as stored, and the content they
 * hold. An original the processor stored encrypted at rest is an envelope
 * whose content is the plaintext the content hash was computed over, so that
 * one object is kept in memory and decrypted (originals are size-capped);
 * anything else is hashed as it streams. An envelope that cannot be opened
 * throws: a copy is never called verified on a guess. Null only on not-found.
 */
async function digestS3Object(client: S3Client, bucket: string, key: string): Promise<ObjectDigest | null> {
  let body: unknown;
  try {
    ({ Body: body } = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key })));
  } catch (err) {
    if (isS3NotFound(err)) return null;
    throw err;
  }
  const stored = createHash('sha256');
  let size = 0;
  // Kept until the first bytes show whether this is an envelope; dropped at once if not.
  let kept: Buffer[] | null = [];
  for await (const chunk of bodyChunks(body)) {
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    stored.update(bytes);
    size += bytes.length;
    if (kept) {
      kept.push(bytes);
      const head = Buffer.concat(kept);
      if (head.length >= 4 && !hasEnvelopeMagic(head)) kept = null;
    }
  }
  const sha256 = stored.digest('hex');
  if (!kept) return { size, sha256, contentSha256: sha256 };
  const whole = Buffer.concat(kept);
  const content = maybeDecryptBuffer(whole, { masterKey: process.env.ENCRYPTION_KEY ?? '' });
  return { size, sha256, contentSha256: content === whole ? sha256 : sha256Hex(content) };
}

/**
 * Copy the public asset into the PRIVATE uploads bucket at the case's hold key,
 * and prove the copy holds the same bytes (by checksum, not size). GET with the
 * publish client and PUT with the uploads client, because the two buckets may
 * sit behind different credentials. Nothing suspected of being illegal is ever
 * parked in the public bucket.
 */
async function holdPublicAssetPrivately(hash: string, caseId: string): Promise<void> {
  const holdKey = holdKeyFor(caseId, hash);
  const asset = await readPublishedAsset(hash);
  const expected = sha256Hex(asset.body);
  const existing = await digestS3Object(getS3Client(), getS3Bucket(), holdKey);
  if (existing?.sha256 === expected) return;

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: getS3Bucket(),
      Key: holdKey,
      Body: asset.body,
      ContentType: asset.contentType ?? 'application/octet-stream',
    }),
  );
  const copy = await digestS3Object(getS3Client(), getS3Bucket(), holdKey);
  if (copy?.sha256 !== expected) {
    throw new Error('Private hold copy could not be verified; the public object was left in place');
  }
}

export function createTakedownStorage(): TakedownStorage {
  return {
    evidenceConfigured: () => getEvidenceBucket() !== null,

    async findOriginal(contentHash, caseId): Promise<TakedownOriginal | null> {
      const hash = requireHash(contentHash);
      return (await findPrivateOriginal(hash)) ?? headS3Object(getS3Client(), getS3Bucket(), holdKeyFor(caseId, hash));
    },

    async takePublicOffline(contentHash, caseId) {
      const hash = requireHash(contentHash);
      if (!isPublishConfigured()) return { deleted: 0, held: false };

      // The public copy is deleted at once. That is only safe if a private copy
      // exists: the uploaded original, or — for a file whose original was already
      // reaped — a copy made here first.
      let held = false;
      const asset = await headPublishedAsset(hash);
      if (asset && !(await findPrivateOriginal(hash))) {
        await holdPublicAssetPrivately(hash, caseId);
        held = true;
      }
      return { deleted: await deletePublishedAssetsForHash(hash), held };
    },

    digestSource: (key) => digestS3Object(getS3Client(), getS3Bucket(), key),

    digestEvidence: (evidenceKey) => digestS3Object(getS3Client(), requireEvidenceBucket(), evidenceKey),

    async copyToEvidence(source, evidenceKey) {
      // Server-side copy within the uploads credentials: the bytes never pass through this process.
      await getS3Client().send(
        new CopyObjectCommand({
          Bucket: requireEvidenceBucket(),
          CopySource: `${getS3Bucket()}/${source.key}`,
          Key: evidenceKey,
          MetadataDirective: 'COPY',
        }),
      );
    },

    async deleteFromUploads(contentHash, caseId) {
      const hash = requireHash(contentHash);
      const keys = (await listUploadsObjects(hash)).map((object) => object.key);
      await deleteS3Keys(getS3Client(), getS3Bucket(), keys);

      // The hold copy goes last, and only here: by the planner's order this step
      // runs after preservation is settled, so the copy has served its purpose.
      const holdKey = holdKeyFor(caseId, hash);
      const hold = await headS3Object(getS3Client(), getS3Bucket(), holdKey);
      if (hold) await getS3Client().send(new DeleteObjectCommand({ Bucket: getS3Bucket(), Key: holdKey }));
      return keys.length + (hold ? 1 : 0);
    },

    async deleteFromPublish(contentHash) {
      const hash = requireHash(contentHash);
      return isPublishConfigured() ? deletePublishedAssetsForHash(hash) : 0;
    },
  };
}
