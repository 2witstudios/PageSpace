import { copyStoredObject, deleteStoredObject, digestStoredObject } from './s3-effects';
import { buildUploadHoldingKey, buildUploadStagingKey } from './upload-staging';

export type PromoteStagedUploadResult =
  /** The verified bytes are now at the served key. */
  | { status: 'promoted' }
  /** Nothing was staged for this job (the dedup fast-path skips the PUT). */
  | { status: 'no_staging' }
  /** The staged bytes don't hash to the declared hash (or exceed the reserved size). Nothing was published. */
  | { status: 'mismatch' };

/**
 * Publish a job's staged upload to its content-addressed served key, but only
 * bytes this server has hashed.
 *
 * The client can rewrite its staging key at any time until its presigned PUT
 * expires, so the staging object itself is never trusted after a read:
 *   1. server-side copy staging → a holding key unique to this attempt, which
 *      no client and no other completion can write;
 *   2. delete staging;
 *   3. hash the holding copy (streamed, bounded by `maxBytes`);
 *   4. on a match, copy holding → served key; the holding copy cannot have
 *      changed between 3 and 4.
 * No ETag or version is relied on. On a mismatch, or on any error, only the
 * per-job keys are deleted — never the served key, which other completed
 * uploads of the same hash may own.
 */
export async function promoteStagedUpload(args: {
  jobId: string;
  contentHash: string;
  maxBytes: number;
  servedKey: string;
}): Promise<PromoteStagedUploadResult> {
  const stagingKey = buildUploadStagingKey(args.jobId);
  const holdingKey = buildUploadHoldingKey(args.jobId);

  if ((await copyStoredObject(stagingKey, holdingKey)) === 'missing') {
    return { status: 'no_staging' };
  }
  // Best-effort: what is left in staging is served by nothing (the sweep-expired cron reclaims it).
  await deleteStoredObject(stagingKey).catch(() => undefined);
  try {
    const digest = await digestStoredObject(holdingKey, args.maxBytes);
    if (digest.status !== 'ok' || digest.sha256 !== args.contentHash) {
      return { status: 'mismatch' };
    }
    if ((await copyStoredObject(holdingKey, args.servedKey)) === 'missing') {
      throw new Error('Upload holding copy vanished before publication');
    }
    return { status: 'promoted' };
  } finally {
    await deleteStoredObject(holdingKey).catch(() => undefined);
  }
}
