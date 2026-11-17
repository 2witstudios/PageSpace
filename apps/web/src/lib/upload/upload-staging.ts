/**
 * Where a client's presigned PUT lands: a per-job staging key, never the
 * content-addressed `files/<hash>/original` that pages are served from.
 *
 * A presigned PUT binds a key and a length, not the bytes, and stays valid for
 * its whole TTL. Signing it for the served key would let a client overwrite
 * bytes that /complete already verified. Only /complete writes the served key,
 * by a server-side copy of the exact staging version it hashed.
 */
const SAFE_JOB_ID = /^[A-Za-z0-9_-]+$/;

export function buildUploadStagingKey(jobId: string): string {
  if (!SAFE_JOB_ID.test(jobId)) {
    throw new Error('Refusing to build a staging key from an unsafe job id');
  }
  return `uploads/staging/${jobId}`;
}
