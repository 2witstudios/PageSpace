/**
 * Stuck-page reconciler — pure core (#2159).
 *
 * pages.processingStatus and pg-boss job state have no invariant tying them
 * together: the post-upload enqueue is fire-and-forget, so a dropped enqueue
 * leaves a page claiming 'pending' forever with no job behind it (proven in
 * production between the direct-to-S3 cutover and the UPLOAD_SCOPES fix,
 * repaired by hand with scripts/reenqueue-unprocessed-uploads.ts). This core
 * is the decision half of the reconciler that makes that repair automatic:
 * given the evidence gathered about one stuck page, decide whether to leave
 * it alone, re-enqueue the verified pull pipeline, or mark it 'failed' so the
 * gap is visible and retryable via the reprocess route.
 */

export type StuckPageStatus = 'pending' | 'processing';

/** Everything the shell learned about one candidate page. */
export interface StalePageEvidence {
  pageId: string;
  processingStatus: StuckPageStatus;
  /** ms since the page row last moved (GREATEST(createdAt, updatedAt)). */
  statusAgeMs: number;
  /** A pull-verify/ingest-file job in created/retry/active references this page. */
  hasLiveJob: boolean;
  /** Highest reconcileAttempt tag on any pull-verify job for this page (0 = none). */
  priorReconcileAttempts: number;
  /** filePath present and shaped like a content hash — re-enqueue is possible. */
  hasValidContentHash: boolean;
}

export interface ReconcilerPolicy {
  staleThresholdMs: number;
  maxReconcileAttempts: number;
  batchLimit: number;
}

export type ReconcileDecision =
  | { action: 'skip'; reason: 'live-job' | 'not-stale' }
  | { action: 'reenqueue'; attempt: number }
  | { action: 'fail'; reason: 'attempts-exhausted' | 'missing-content-hash'; message: string };

export function classifyStalePage(
  evidence: StalePageEvidence,
  policy: ReconcilerPolicy,
): ReconcileDecision {
  // A live job means the queue still owns this page — however stale the row
  // looks, the worker will move it when the job settles.
  if (evidence.hasLiveJob) {
    return { action: 'skip', reason: 'live-job' };
  }

  if (evidence.statusAgeMs < policy.staleThresholdMs) {
    return { action: 'skip', reason: 'not-stale' };
  }

  // No hash → no bytes to pull; re-enqueueing can never succeed, so surface
  // the page as failed instead of leaving it invisibly pending forever.
  if (!evidence.hasValidContentHash) {
    return {
      action: 'fail',
      reason: 'missing-content-hash',
      message:
        'File processing never completed and the page has no valid content hash to re-enqueue. Re-upload the file.',
    };
  }

  if (evidence.priorReconcileAttempts >= policy.maxReconcileAttempts) {
    return {
      action: 'fail',
      reason: 'attempts-exhausted',
      message: `File processing did not complete after ${evidence.priorReconcileAttempts} automatic re-enqueue attempts. Use reprocess to retry.`,
    };
  }

  return { action: 'reenqueue', attempt: evidence.priorReconcileAttempts + 1 };
}

export const DEFAULT_STALE_THRESHOLD_MS = 15 * 60 * 1000;
export const DEFAULT_MAX_RECONCILE_ATTEMPTS = 3;
export const DEFAULT_BATCH_LIMIT = 50;

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveReconcilerPolicy(
  env: Record<string, string | undefined>,
): ReconcilerPolicy {
  return {
    staleThresholdMs:
      positiveInt(env.RECONCILER_STALE_MINUTES, DEFAULT_STALE_THRESHOLD_MS / (60 * 1000)) *
      60 *
      1000,
    maxReconcileAttempts: positiveInt(
      env.RECONCILER_MAX_ATTEMPTS,
      DEFAULT_MAX_RECONCILE_ATTEMPTS,
    ),
    batchLimit: positiveInt(env.RECONCILER_BATCH_LIMIT, DEFAULT_BATCH_LIMIT),
  };
}
