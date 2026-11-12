import 'server-only';

import { CopyObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { TakedownOriginal, TakedownStorage } from '@pagespace/lib/content-safety/takedown';
import { normalizeContentHash } from '@pagespace/lib/content-safety/policy';
import { getS3Bucket, getS3Client } from '@/lib/presigned-url';
import { deleteS3Keys, headS3Object, listS3Prefix, type S3ObjectInfo } from '@/lib/storage/s3-objects';
import {
  deletePublishedAssetsForHash,
  headPublishedAsset,
  isPublishConfigured,
  listPublishedObjectsForHash,
  quarantinePublishedAssetsForHash,
  readPublishedHashObject,
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

export function createTakedownStorage(): TakedownStorage {
  return {
    evidenceConfigured: () => getEvidenceBucket() !== null,

    async findOriginal(contentHash): Promise<TakedownOriginal | null> {
      const hash = requireHash(contentHash);
      for (const key of uploadsOriginalKeysFor(hash)) {
        const head = await headS3Object(getS3Client(), getS3Bucket(), key);
        if (head) return { store: 'uploads', ...head };
      }
      // The private original may already have been reaped while its public copy
      // lives on (by now in quarantine, unless that step has not run yet).
      if (isPublishConfigured()) {
        const asset = await headPublishedAsset(hash);
        if (asset) return { store: 'publish', key: asset.key, size: asset.size };
      }
      return null;
    },

    async listObjects(contentHash) {
      const hash = requireHash(contentHash);
      const uploads = await listUploadsObjects(hash);
      const published = isPublishConfigured() ? await listPublishedObjectsForHash(hash) : [];
      return [
        ...uploads.map((object) => ({ store: 'uploads' as const, ...object })),
        ...published.map((object) => ({ store: 'publish' as const, ...object })),
      ];
    },

    async quarantinePublic(contentHash) {
      const hash = requireHash(contentHash);
      return isPublishConfigured() ? quarantinePublishedAssetsForHash(hash) : 0;
    },

    async headEvidence(evidenceKey) {
      const head = await headS3Object(getS3Client(), requireEvidenceBucket(), evidenceKey);
      return head ? { size: head.size } : null;
    },

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
      const hash = source.key.match(/([0-9a-f]{64})/)?.[1];
      if (!hash) throw new Error('Publish-bucket evidence source has no content hash in its key');
      const object = await readPublishedHashObject(hash, source.key);
      await getS3Client().send(
        new PutObjectCommand({
          Bucket: evidenceBucket,
          Key: evidenceKey,
          Body: object.body,
          ContentType: object.contentType ?? 'application/octet-stream',
        }),
      );
    },

    async deleteFromUploads(contentHash) {
      const keys = (await listUploadsObjects(requireHash(contentHash))).map((object) => object.key);
      await deleteS3Keys(getS3Client(), getS3Bucket(), keys);
      return keys.length;
    },

    async deleteFromPublish(contentHash) {
      const hash = requireHash(contentHash);
      return isPublishConfigured() ? deletePublishedAssetsForHash(hash) : 0;
    },
  };
}
