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
  markPageFailed(pageId: string, message: string): Promise<void>;
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
      // can never succeed (same reasoning as the manual repair script).
      const candidates = await client.query(
        `SELECT id,
                "processingStatus",
                "filePath" AS "contentHash",
                EXTRACT(EPOCH FROM (NOW() - GREATEST("createdAt", "updatedAt"))) * 1000 AS "ageMs"
           FROM pages
          WHERE type = 'FILE'
            AND "isTrashed" = false
            AND "processingStatus" IN ('pending', 'processing')
            AND "filePath" IS NOT NULL
            AND GREATEST("createdAt", "updatedAt") < NOW() - ($1::bigint * interval '1 millisecond')
          ORDER BY GREATEST("createdAt", "updatedAt") ASC
          LIMIT $2`,
        [policy.staleThresholdMs, policy.batchLimit],
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

      const liveJobs = await client.query(
        `SELECT DISTINCT COALESCE(data->>'pageId', data->>'fileId') AS "pageId"
           FROM pgboss.job
          WHERE name = ANY($1::text[])
            AND state IN ('created', 'retry', 'active')
            AND COALESCE(data->>'pageId', data->>'fileId') = ANY($2::text[])`,
        [OWNING_QUEUES, pageIds],
      );
      const livePageIds = new Set(liveJobs.rows.map((row) => String(row.pageId)));

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
          hasLiveJob: livePageIds.has(pageId),
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
            await deps.markPageFailed(pageId, decision.message);
            summary.failed += 1;
            failedPages.push({ pageId, reason: decision.reason });
            break;
        }
      }

      if (failedPages.length > 0) {
        deps.alert(
          `stuck-page reconciler marked ${failedPages.length} page(s) failed — enqueues are being dropped or re-enqueues cannot succeed`,
          { failedPages, summary: { ...summary } },
        );
      }

      loggers.processor.info(
        `stuck-page reconciler: scanned=${summary.scanned} reenqueued=${summary.reenqueued} failed=${summary.failed} skipped=${summary.skipped} enqueueErrors=${summary.enqueueErrors}`,
      );
      return summary;
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [ADVISORY_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
