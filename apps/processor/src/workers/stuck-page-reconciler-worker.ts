/**
 * Stuck-page reconciler — imperative shell (#2159).
 *
 * Productionizes scripts/reenqueue-unprocessed-uploads.ts (the one-shot repair
 * run after the UPLOAD_SCOPES incident left pages 'pending' with no job):
 * scheduled by pg-boss, it finds FILE pages stuck in 'pending'/'processing'
 * past the staleness threshold with no live pg-boss job, and per the pure
 * core's decision either re-enqueues the verified pull pipeline (the same
 * queue /api/ingest/pull uses — it re-hashes the stored bytes, so a duplicate
 * enqueue is harmless) or marks the page 'failed' (visible, retryable via the
 * reprocess route). Marked-failed pages fire an alert: that means uploads are
 * being dropped faster than automatic re-enqueueing can absorb.
 *
 * Serialization follows the audit-chainer pattern: scheduled with retryLimit 0
 * so runs never stack, plus a run-level advisory lock so any overlap that
 * still happens no-ops instead of double-enqueueing.
 *
 * Attempt tracking needs no schema change: each reconciler enqueue tags its
 * pull-verify job data with `reconcileAttempt: n`, and the next run reads the
 * max tag back out of pgboss.job + pgboss.archive. Archive retention (7 days)
 * comfortably outlasts the minutes-scale reconcile cadence.
 *
 * Live-job exclusion happens INSIDE the candidate query (NOT EXISTS against
 * pgboss.job), not as a separate post-filter: filtering after LIMIT would let
 * a persistent front batch of live-job pages crowd out genuinely orphaned
 * pages ordered behind them, starving them indefinitely (#2159 review).
 *
 * The 'fail' transition is a conditional UPDATE ... WHERE "processingStatus"
 * IN ('pending','processing'), not an unconditional one: the owning worker
 * can complete a page between the candidate scan and this update landing, and
 * an unconditional write would stomp that success back to 'failed' (#2159
 * review). A zero-row update means the page resolved itself — nothing to do.
 */

import { loggers } from '@pagespace/lib/logging/logger-config';
import * as Sentry from '@sentry/node';
import { isValidContentHash } from '../cache/content-store';
import {
  classifyStalePage,
  resolveReconcilerPolicy,
  type ReconcilerPolicy,
  type StalePageEvidence,
  type StuckPageStatus,
} from './stuck-page-reconciler-core';

export interface ReconcilerDbClient {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  release(): void;
}

export interface StuckPageReconcilerDeps {
  connect(): Promise<ReconcilerDbClient>;
  enqueuePullVerify(data: {
    pageId: string;
    contentHash: string;
    reconcileAttempt: number;
  }): Promise<string>;
  alert(message: string, context: Record<string, unknown>): void;
  policy?: ReconcilerPolicy;
}

export interface ReconcilerRunSummary {
  lockHeld: boolean;
  scanned: number;
  reenqueued: number;
  failed: number;
  skipped: number;
  enqueueErrors: number;
  failUpdateErrors: number;
}

// Same try-lock idiom as the audit chainer: hashtext keys the lock slot, so
// this string is a wire format — renaming it would stop serializing against
// still-running old deploys.
const ADVISORY_LOCK_KEY = 'stuck_page_reconciler';

// Only these two queues keep a page in 'pending'/'processing': every other
// worker (image-optimize, ocr, video) runs after the page already moved to
// 'visual'/'completed'.
const OWNING_QUEUES = ['pull-verify', 'ingest-file'];

export function defaultReconcilerAlert(
  message: string,
  context: Record<string, unknown>,
): void {
  loggers.processor.error(message, context);
  Sentry.captureMessage(message, { level: 'error', extra: context });
}

export async function runStuckPageReconciler(
  deps: StuckPageReconcilerDeps,
): Promise<ReconcilerRunSummary> {
  const policy = deps.policy ?? resolveReconcilerPolicy(process.env);
  const summary: ReconcilerRunSummary = {
    lockHeld: false,
    scanned: 0,
    reenqueued: 0,
    failed: 0,
    skipped: 0,
    enqueueErrors: 0,
    failUpdateErrors: 0,
  };

  const client = await deps.connect();
  try {
    const lockResult = await client.query(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
      [ADVISORY_LOCK_KEY],
    );
    if (lockResult.rows[0]?.locked !== true) {
      loggers.processor.info('stuck-page reconciler: another run holds the lock, skipping');
      return summary;
    }
    summary.lockHeld = true;

    try {
      // 'failed' is deliberately excluded: it means the processor ran and
      // rejected the file, and rejectAndFail deletes the object — re-enqueueing
      // can never succeed (same reasoning as the manual repair script). A
      // missing/invalid "filePath" is NOT excluded here — those pages must
      // reach classifyStalePage so its missing-content-hash branch can mark
      // them failed instead of leaving them stuck forever.
      const candidates = await client.query(
        `SELECT p.id,
                p."processingStatus",
                p."filePath" AS "contentHash",
                EXTRACT(EPOCH FROM (NOW() - GREATEST(p."createdAt", p."updatedAt"))) * 1000 AS "ageMs"
           FROM pages p
          WHERE p.type = 'FILE'
            AND p."isTrashed" = false
            AND p."processingStatus" IN ('pending', 'processing')
            AND GREATEST(p."createdAt", p."updatedAt") < NOW() - ($1::bigint * interval '1 millisecond')
            AND NOT EXISTS (
              SELECT 1 FROM pgboss.job j
               WHERE j.name = ANY($2::text[])
                 AND j.state IN ('created', 'retry', 'active')
                 AND COALESCE(j.data->>'pageId', j.data->>'fileId') = p.id
            )
          ORDER BY GREATEST(p."createdAt", p."updatedAt") ASC
          LIMIT $3`,
        [policy.staleThresholdMs, OWNING_QUEUES, policy.batchLimit],
      );
      summary.scanned = candidates.rows.length;
      if (candidates.rows.length === 0) {
        return summary;
      }
      if (candidates.rows.length === policy.batchLimit) {
        loggers.processor.warn(
          `stuck-page reconciler: batch limit ${policy.batchLimit} hit — more stuck pages remain for the next run`,
        );
      }

      const pageIds = candidates.rows.map((row) => String(row.id));

      const attempts = await client.query(
        `SELECT data->>'pageId' AS "pageId",
                MAX((data->>'reconcileAttempt')::int) AS attempts
           FROM (SELECT name, data FROM pgboss.job
                 UNION ALL
                 SELECT name, data FROM pgboss.archive) jobs
          WHERE name = 'pull-verify'
            AND data->>'reconcileAttempt' IS NOT NULL
            AND data->>'pageId' = ANY($1::text[])
          GROUP BY data->>'pageId'`,
        [pageIds],
      );
      const priorAttempts = new Map(
        attempts.rows.map((row) => [String(row.pageId), Number(row.attempts)]),
      );

      const failedPages: { pageId: string; reason: string }[] = [];

      for (const row of candidates.rows) {
        const pageId = String(row.id);
        const contentHash = row.contentHash == null ? '' : String(row.contentHash);
        const evidence: StalePageEvidence = {
          pageId,
          processingStatus: row.processingStatus as StuckPageStatus,
          statusAgeMs: Number(row.ageMs),
          // The candidate query's NOT EXISTS already excludes pages with a
          // live owning job — this is always false for rows reaching here.
          // classifyStalePage still branches on it (tested in isolation) as
          // a defensive check should evidence ever be sourced differently.
          hasLiveJob: false,
          priorReconcileAttempts: priorAttempts.get(pageId) ?? 0,
          hasValidContentHash: isValidContentHash(contentHash),
        };

        const decision = classifyStalePage(evidence, policy);
        switch (decision.action) {
          case 'skip':
            summary.skipped += 1;
            break;
          case 'reenqueue':
            try {
              const jobId = await deps.enqueuePullVerify({
                pageId,
                contentHash,
                reconcileAttempt: decision.attempt,
              });
              summary.reenqueued += 1;
              loggers.processor.warn(
                `stuck-page reconciler: re-enqueued page ${pageId} (status=${evidence.processingStatus}, attempt=${decision.attempt}, job=${jobId})`,
              );
            } catch (err) {
              summary.enqueueErrors += 1;
              loggers.processor.warn(
                `stuck-page reconciler: re-enqueue failed for page ${pageId}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            break;
          case 'fail':
            try {
              const result = await client.query(
                `UPDATE pages
                    SET "processingStatus" = 'failed', "processingError" = $1, "processedAt" = NOW()
                  WHERE id = $2
                    AND "processingStatus" IN ('pending', 'processing')`,
                [decision.message, pageId],
              );
              if (result.rowCount && result.rowCount > 0) {
                summary.failed += 1;
                failedPages.push({ pageId, reason: decision.reason });
              } else {
                // The owning worker completed the page between the candidate
                // scan and this update — nothing to overwrite.
                summary.skipped += 1;
              }
            } catch (err) {
              summary.failUpdateErrors += 1;
              loggers.processor.warn(
                `stuck-page reconciler: mark-failed update failed for page ${pageId}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            break;
        }
      }

      if (failedPages.length > 0) {
        deps.alert(
          `stuck-page reconciler marked ${failedPages.length} page(s) failed — enqueues are being dropped or re-enqueues cannot succeed`,
          { failedPages, summary: { ...summary } },
        );
      }
      // Persistent re-enqueue/update failures are their own signal (DB or
      // queue trouble), independent of whether any page was actually marked
      // failed this run.
      if (summary.enqueueErrors > 0 || summary.failUpdateErrors > 0) {
        deps.alert(
          `stuck-page reconciler hit ${summary.enqueueErrors} re-enqueue error(s) and ${summary.failUpdateErrors} mark-failed error(s) this run`,
          { summary: { ...summary } },
        );
      }

      loggers.processor.info(
        `stuck-page reconciler: scanned=${summary.scanned} reenqueued=${summary.reenqueued} failed=${summary.failed} skipped=${summary.skipped} enqueueErrors=${summary.enqueueErrors} failUpdateErrors=${summary.failUpdateErrors}`,
      );
      return summary;
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [ADVISORY_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
