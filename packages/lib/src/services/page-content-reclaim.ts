/**
 * Whether a content-addressed blob is old enough to reclaim.
 *
 * This is the second of the two questions reclaim asks. The first — is anything
 * still referencing it — is settled in `page-content-store.ts`, because a
 * referenced blob is kept whatever its age and there is no reason to go ask
 * storage about it. What is left here is the age judgement.
 *
 * The floor exists because a writer whose content already exists skips the
 * upload, so the object it hands back can be older than the reference about to
 * be written for it. Both sides take a per-ref lock (see page-content-lock.ts)
 * and the writer touches the object it reuses, which together make "recently
 * written" a property the reclaimer can actually observe. The floor then covers
 * the remaining gap: the writer's caller committing its `contentRef` row.
 *
 * Unknown age fails closed: not being able to date an object is not evidence
 * that it is old.
 */
export interface BlobReclaimEvidence {
  /** Age of the stored object in ms, or null when it could not be determined. */
  blobAgeMs: number | null;
  /** Blobs younger than this are never reclaimed. */
  minAgeMs: number;
}

export type BlobRetainReason =
  | 'still-referenced'
  | 'age-unknown'
  | 'too-young'
  /** Nothing is stored under this ref — already reclaimed, or never written. */
  | 'not-stored';

export type BlobReclaimDecision =
  | { action: 'delete' }
  | { action: 'retain'; reason: BlobRetainReason };

export function decideBlobReclaim(evidence: BlobReclaimEvidence): BlobReclaimDecision {
  if (evidence.blobAgeMs === null) {
    return { action: 'retain', reason: 'age-unknown' };
  }
  if (evidence.blobAgeMs < evidence.minAgeMs) {
    return { action: 'retain', reason: 'too-young' };
  }
  return { action: 'delete' };
}
