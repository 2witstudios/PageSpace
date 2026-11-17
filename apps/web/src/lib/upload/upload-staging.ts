import { randomUUID } from 'crypto';

/**
 * Where a client's presigned PUT lands: a per-job staging key, never the
 * content-addressed `files/<hash>/original` that pages are served from.
 *
 * A presigned PUT binds a key and a length, not the bytes, and stays valid for
 * its whole TTL. Signing it for the served key would let a client overwrite
 * bytes that /complete already verified. Only the server writes the served key,
 * from a server-only holding copy it hashed (promote-staged-upload.ts).
 *
 * Reclaim: /complete and /cancel delete a job's staging object. One left by a
 * PUT that is never completed or cancelled — or by a re-PUT after completion —
 * is served by nothing and is reclaimed after a day by the sweep-expired cron
 * (upload-staging-sweep.ts).
 */
const SAFE_JOB_ID = /^[A-Za-z0-9_-]+$/;

export function buildUploadStagingKey(jobId: string): string {
  if (!SAFE_JOB_ID.test(jobId)) {
    throw new Error('Refusing to build a staging key from an unsafe job id');
  }
  return `uploads/staging/${jobId}`;
}

/**
 * Server-only copy of a job's staged bytes, hashed before publication. Never
 * signed for a client. Unique per promotion attempt: two concurrent completions
 * of one job must never share it, or one could overwrite the copy the other
 * already hashed before it is published.
 */
export function buildUploadHoldingKey(jobId: string): string {
  if (!SAFE_JOB_ID.test(jobId)) {
    throw new Error('Refusing to build a holding key from an unsafe job id');
  }
  return `uploads/verifying/${jobId}/${randomUUID()}`;
}
