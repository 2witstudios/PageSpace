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
/**
 * Each run lists both prefixes to the end, so a stale object is always reached
 * however many fresh ones sort before it. The prefixes hold at most a day of
 * in-flight uploads plus what is due for deletion, so a full listing is small;
 * this cap (1,000 pages = 1M objects) only stops a runaway loop.
 */
const MAX_PAGES_PER_PREFIX = 1000;

/**
 * Number of objects deleted. `DeleteObjects` reports per-object failures inside
 * a successful response; those are not counted, and after the whole sweep has
 * run they are thrown as one error so the cron reports a partial failure.
 */
export async function sweepStaleUploadStaging(now: Date = new Date()): Promise<number> {
  const client = getS3Client();
  const bucket = getS3Bucket();
  const cutoff = now.getTime() - UPLOAD_STAGING_MAX_AGE_MS;
  let deleted = 0;
  let attempted = 0;
  const errorCodes = new Set<string>();

  for (const prefix of PREFIXES) {
    let continuationToken: string | undefined;
    for (let page = 0; page < MAX_PAGES_PER_PREFIX; page++) {
      const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }));
      const stale = (listed.Contents ?? [])
        .filter((object) => object.Key?.startsWith(prefix) && object.LastModified && object.LastModified.getTime() < cutoff)
        .map((object) => ({ Key: object.Key as string }));
      if (stale.length > 0) {
        const result = await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: stale, Quiet: true } }));
        const failed = result.Errors ?? [];
        for (const error of failed) errorCodes.add(error.Code ?? 'Unknown');
        attempted += stale.length;
        deleted += stale.length - failed.length;
      }
      if (!listed.IsTruncated || !listed.NextContinuationToken) break;
      continuationToken = listed.NextContinuationToken;
    }
  }
  if (errorCodes.size > 0) {
    throw new Error(`${attempted - deleted} of ${attempted} stale upload objects were not deleted: ${[...errorCodes].join(', ')}`);
  }
  return deleted;
}
