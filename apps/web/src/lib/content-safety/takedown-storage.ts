import 'server-only';

import { createHash } from 'crypto';
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import {
  holdKeyFor,
  type ObjectDigest,
  type TakedownOriginal,
  type TakedownStorage,
} from '@pagespace/lib/content-safety/takedown';
import { ENVELOPE_HEADER_LENGTH, createEnvelopeDecipher, hasEnvelopeMagic } from '@pagespace/lib/encryption/envelope-crypto';
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
 * Read an object once, as it streams, and hash it: the bytes as stored, and
 * the content they hold. An original the processor stored encrypted at rest is
 * an envelope whose content is the plaintext the content hash was computed
 * over; it is decrypted chunk by chunk (the GCM tag is in its header), so
 * nothing is held in memory beyond the header.
 *
 * An envelope that cannot be opened (a wrong key, tampered bytes, or a plain
 * file that merely starts with the magic) reports its stored hash as its
 * content: it is then never taken for the content, and is preserved byte for
 * byte like any other object that is not. Null only on not-found.
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
  const content = createHash('sha256');
  let size = 0;
  let header: Buffer[] | null = [];
  let headerLength = 0;
  let decipher: ReturnType<typeof createEnvelopeDecipher> | null = null;
  let unreadable = false;
  const decrypt = (bytes: Buffer) => {
    if (!decipher || unreadable) return;
    try {
      content.update(decipher.update(bytes));
    } catch {
      unreadable = true;
    }
  };

  for await (const chunk of bodyChunks(body)) {
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    stored.update(bytes);
    size += bytes.length;
    if (!header) {
      decrypt(bytes);
      continue;
    }
    // Until the header is complete: collect it, then decide once.
    header.push(bytes);
    headerLength += bytes.length;
    if (headerLength < ENVELOPE_HEADER_LENGTH) continue;
    const head = Buffer.concat(header);
    header = null;
    if (!hasEnvelopeMagic(head)) continue;
    try {
      decipher = createEnvelopeDecipher(head.subarray(0, ENVELOPE_HEADER_LENGTH), process.env.ENCRYPTION_KEY ?? '');
    } catch {
      unreadable = true;
    }
    decrypt(head.subarray(ENVELOPE_HEADER_LENGTH));
  }

  const sha256 = stored.digest('hex');
  if (!decipher) return { size, sha256, contentSha256: sha256 };
  if (!unreadable) {
    try {
      content.update(decipher.final());
    } catch {
      unreadable = true;
    }
  }
  return { size, sha256, contentSha256: unreadable ? sha256 : content.digest('hex') };
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

    async findOriginals(contentHash, caseId): Promise<TakedownOriginal[]> {
      const hash = requireHash(contentHash);
      const found: TakedownOriginal[] = [];
      for (const key of [...uploadsOriginalKeysFor(hash), holdKeyFor(caseId, hash)]) {
        const head = await headS3Object(getS3Client(), getS3Bucket(), key);
        if (head) found.push(head);
      }
      return found;
    },

    async takePublicOffline(contentHash, caseId) {
      const hash = requireHash(contentHash);
      if (!isPublishConfigured()) return { deleted: 0, held: false };

      // The public copy is deleted at once, and always kept privately first. A
      // private original's KEY says nothing about its bytes (a presigned PUT
      // need not match the hash), so its existence is no proof the content is
      // safe elsewhere; the copy made here is checked by checksum instead.
      const asset = await headPublishedAsset(hash);
      if (asset) await holdPublicAssetPrivately(hash, caseId);
      return { deleted: await deletePublishedAssetsForHash(hash), held: asset !== null };
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
