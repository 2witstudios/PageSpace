/**
 * Pure decision core for the attachment byte-verify endpoint.
 *
 * No I/O — maps storage probe results to the endpoint's HTTP contract so the
 * route stays a thin effectful shell and every status/body decision is unit
 * tested without S3.
 *
 * @module verify-core
 */

/**
 * Largest object the synchronous verify path will buffer into memory. Matches
 * the business tier's per-file limit (1 GiB) — the largest a presigned PUT can
 * legitimately store — so an object above this is rejected by a cheap HEAD
 * before any bytes are downloaded onto the request thread.
 */
export const MAX_VERIFY_BYTES = 1024 * 1024 * 1024;

/** Result of the pre-download HEAD probe: how to proceed given the object size. */
export type ObjectSizeClass = 'absent' | 'too_large' | 'ok';

/**
 * Decide whether to download and verify, given the HEAD-probed size.
 * `null` size means the object is definitively absent (HEAD returned not-found).
 */
export function classifyObjectSize(size: number | null): ObjectSizeClass {
  if (size === null) return 'absent';
  if (size > MAX_VERIFY_BYTES) return 'too_large';
  return 'ok';
}

export type VerifyOutcome =
  | { kind: 'match'; detectedMime: string; detectedLabel: string; size: number }
  | { kind: 'mismatch' }
  | { kind: 'absent' }
  | { kind: 'too_large'; size: number }
  | { kind: 'storage_error' };

export interface VerifyResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Map a verify outcome to its HTTP response. The contract the web /complete
 * caller depends on:
 *
 *   200 { ok: true,  detectedMime, detectedLabel, size }  verified — store detectedMime
 *   200 { ok: false, reason: 'hash_mismatch' }            definitive — object deleted, do NOT retry
 *   200 { ok: false, reason: 'object_not_found' }         definitive — object absent, do NOT retry
 *   413 { ok: false, reason: 'object_too_large' }         rejected before download, do NOT retry
 *   503 { ok: false, reason: 'storage_error' }            transient infra failure, caller MAY retry
 *
 * The split is intentional: 2xx/4xx are definitive verdicts (the verification
 * ran or the request was rejected), 5xx is the only retryable class. A transient
 * S3 outage must never masquerade as a definitive `object_not_found`.
 */
export function verifyResponse(outcome: VerifyOutcome): VerifyResponse {
  switch (outcome.kind) {
    case 'match':
      return {
        status: 200,
        body: { ok: true, detectedMime: outcome.detectedMime, detectedLabel: outcome.detectedLabel, size: outcome.size },
      };
    case 'mismatch':
      return { status: 200, body: { ok: false, reason: 'hash_mismatch' } };
    case 'absent':
      return { status: 200, body: { ok: false, reason: 'object_not_found' } };
    case 'too_large':
      return { status: 413, body: { ok: false, reason: 'object_too_large', size: outcome.size } };
    case 'storage_error':
      return { status: 503, body: { ok: false, reason: 'storage_error' } };
  }
}
