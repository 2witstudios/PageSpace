import 'server-only';

import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import type { TakedownOriginal, TakedownStorage } from '@pagespace/lib/content-safety/takedown';
import { normalizeContentHash } from '@pagespace/lib/content-safety/policy';
import { getS3Bucket, getS3Client } from '@/lib/presigned-url';
import {
  deletePublishedAssetsForHash,
  headPublishedAsset,
  isPublishConfigured,
  publishedAssetObjectsExist,
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

function isNotFound(err: unknown): boolean {
  const anyErr = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return anyErr?.name === 'NotFound' || anyErr?.name === 'NoSuchKey' || anyErr?.$metadata?.httpStatusCode === 404;
}

/** Size of an object, or null on a definite not-found. Any other failure throws. */
async function headObject(bucket: string, key: string): Promise<{ size: number } | null> {
  try {
    const head = await getS3Client().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { size: head.ContentLength ?? 0 };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
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

/** Delete every object under a prefix in the uploads bucket. Returns the number deleted. */
async function deleteUploadsPrefix(prefix: string): Promise<number> {
  const client = getS3Client();
  const bucket = getS3Bucket();
  let deleted = 0;
  let continuationToken: string | undefined;
  do {
    const listed = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }),
    );
    const keys = (listed.Contents ?? []).flatMap((obj) => (obj.Key ? [obj.Key] : []));
    if (keys.length > 0) {
      const result = await client.send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })) } }),
      );
      // Not Quiet: a partial failure must fail the step so it is retried, not be counted as deleted.
      if (result.Errors && result.Errors.length > 0) {
        throw new Error(`Failed to delete ${result.Errors.length} object(s) under ${prefix}`);
      }
      deleted += keys.length;
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
  return deleted;
}

export function createTakedownStorage(): TakedownStorage {
  return {
    evidenceConfigured: () => getEvidenceBucket() !== null,

    async findOriginal(contentHash): Promise<TakedownOriginal | null> {
      const hash = requireHash(contentHash);
      for (const key of uploadsOriginalKeysFor(hash)) {
        const head = await headObject(getS3Bucket(), key);
        if (head) return { store: 'uploads', key, size: head.size };
      }
      // The private original may already have been reaped while its public copy lives on.
      if (isPublishConfigured()) {
        const asset = await headPublishedAsset(hash);
        if (asset) return { store: 'publish', key: asset.key, size: asset.size };
      }
      return null;
    },

    async hasAnyObjects(contentHash) {
      const hash = requireHash(contentHash);
      for (const prefix of uploadsPrefixesFor(hash)) {
        const listed = await getS3Client().send(
          new ListObjectsV2Command({ Bucket: getS3Bucket(), Prefix: prefix, MaxKeys: 1 }),
        );
        if ((listed.Contents ?? []).length > 0) return true;
      }
      return isPublishConfigured() ? publishedAssetObjectsExist(hash) : false;
    },

    headEvidence: (evidenceKey) => headObject(requireEvidenceBucket(), evidenceKey),

    async copyToEvidence(source, evidenceKey) {
      const evidenceBucket = requireEvidenceBucket();
      if (source.store === 'uploads') {
        // Server-side copy: the bytes never pass through this process.
        await getS3Client().send(
          new CopyObjectCommand({
            Bucket: evidenceBucket,
            CopySource: `${getS3Bucket()}/${source.key}`,
            Key: evidenceKey,
            MetadataDirective: 'COPY',
          }),
        );
        return;
      }
      // The publish bucket may sit behind different credentials, so read it with
      // its own client and write the bytes with the uploads client.
      const hash = source.key.slice('assets/'.length);
      const asset = await readPublishedAsset(hash);
      await getS3Client().send(
        new PutObjectCommand({
          Bucket: evidenceBucket,
          Key: evidenceKey,
          Body: asset.body,
          ContentType: asset.contentType ?? 'application/octet-stream',
        }),
      );
    },

    async deleteFromUploads(contentHash) {
      const hash = requireHash(contentHash);
      let deleted = 0;
      for (const prefix of uploadsPrefixesFor(hash)) deleted += await deleteUploadsPrefix(prefix);
      return deleted;
    },

    async deleteFromPublish(contentHash) {
      const hash = requireHash(contentHash);
      return isPublishConfigured() ? deletePublishedAssetsForHash(hash) : 0;
    },
  };
}
