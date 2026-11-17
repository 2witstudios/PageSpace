import { DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getS3Bucket, getS3Client } from '@/lib/presigned-url';

/**
 * Reclaim per-job upload objects nothing will ever read: a staging PUT that was
 * never completed or cancelled, a re-PUT after completion, or a holding copy
 * left by a crash mid-verify. None of them is served.
 *
 * 24 hours is far beyond the 15-minute presign TTL plus the time /complete
 * takes, so an upload in flight is never touched.
 */
const UPLOAD_STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PREFIXES = ['uploads/staging/', 'uploads/verifying/'] as const;
/** Listing pages per prefix per run; the next run picks up the rest. */
const MAX_PAGES_PER_PREFIX = 10;

/** Number of objects deleted. */
export async function sweepStaleUploadStaging(now: Date = new Date()): Promise<number> {
  const client = getS3Client();
  const bucket = getS3Bucket();
  const cutoff = now.getTime() - UPLOAD_STAGING_MAX_AGE_MS;
  let deleted = 0;

  for (const prefix of PREFIXES) {
    let continuationToken: string | undefined;
    for (let page = 0; page < MAX_PAGES_PER_PREFIX; page++) {
      const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }));
      const stale = (listed.Contents ?? [])
        .filter((object) => object.Key?.startsWith(prefix) && object.LastModified && object.LastModified.getTime() < cutoff)
        .map((object) => ({ Key: object.Key as string }));
      if (stale.length > 0) {
        await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: stale, Quiet: true } }));
        deleted += stale.length;
      }
      if (!listed.IsTruncated || !listed.NextContinuationToken) break;
      continuationToken = listed.NextContinuationToken;
    }
  }
  return deleted;
}
