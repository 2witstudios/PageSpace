/**
 * Whether a content-addressed blob may be reclaimed.
 *
 * `getS3Key` shards by hash prefix and carries no tenant scoping, so one stored
 * object is shared by every page — in every drive, of every tenant — whose
 * content hashes to the same value. Deleting on "my page went away" would take
 * somebody else's content with it. Reclaim is therefore refcounted: the object
 * goes only when the last row referencing it is gone.
 *
 * The age floor closes the other half of the problem. `writePageContent` is a
 * HEAD-then-PUT: a concurrent writer that finds the object already present
 * skips the upload and stores the ref. If a reclaim ran between that HEAD and
 * the writer's row insert, the new ref would point at nothing. A blob younger
 * than the floor is never reclaimed, which bounds that window to something no
 * request comes close to.
 *
 * Unknown age fails closed: not being able to date an object is not evidence
 * that it is old.
 */

export interface BlobReclaimEvidence {
  /**
   * Rows still referencing the blob at decision time. The caller deletes its
   * own rows first, so its own reference is already gone from this count.
   */
  remainingReferences: number;
  /** Age of the stored object in ms, or null when it could not be determined. */
  blobAgeMs: number | null;
  /** Blobs younger than this are never reclaimed. */
  minAgeMs: number;
}

export type BlobRetainReason = 'still-referenced' | 'age-unknown' | 'too-young';

export type BlobReclaimDecision =
  | { action: 'delete' }
  | { action: 'retain'; reason: BlobRetainReason };

export function decideBlobReclaim(evidence: BlobReclaimEvidence): BlobReclaimDecision {
  if (evidence.remainingReferences > 0) {
    return { action: 'retain', reason: 'still-referenced' };
  }
  if (evidence.blobAgeMs === null) {
    return { action: 'retain', reason: 'age-unknown' };
  }
  if (evidence.blobAgeMs < evidence.minAgeMs) {
    return { action: 'retain', reason: 'too-young' };
  }
  return { action: 'delete' };
}
