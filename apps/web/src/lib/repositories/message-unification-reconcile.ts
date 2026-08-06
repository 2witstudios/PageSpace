/**
 * DRIFT RECONCILER for the message-table dual-write (epic "Agent-Session
 * Single Source of Truth", Phase 4 / D6; epic #2161's standing rule: a forced
 * copy gets BOTH a drift-guard test and a reconciler with alerting).
 *
 * The drift TEST (unified-message-dual-write-drift.test.ts) proves the code
 * writes both legs. This proves the DATABASE agrees — the two failure classes
 * the test cannot see:
 *
 *   1. A writer that never went through the repository at all (a raw SQL
 *      path, a migration, a future route that reaches for the table
 *      directly). The test only knows about writers it enumerates; this
 *      knows about rows.
 *   2. A write whose unified leg was skipped at runtime — the kill switch
 *      left off, or `skipped_no_conversation` firing because a conversation
 *      row was genuinely missing.
 *
 * WHAT IT COMPARES: for each recently-active PAGE conversation, the row COUNT
 * and the `MAX("createdAt")` watermark on each leg. Counts catch missing and
 * extra rows; the watermark catches the case counts cannot — equal totals
 * that disagree about which write is newest, i.e. one leg missing the latest
 * message while an older one was double-counted.
 *
 * SCOPE — deliberately narrow, in both directions:
 *   - `type = 'page'` only. A GLOBAL conversation has ONE leg (`messages` is
 *     its own table); comparing it against `chat_messages` would report every
 *     global conversation as fully divergent, forever.
 *   - Recently active only (`lastMessageAt` inside the window). Before the
 *     backfill finishes, every OLD conversation is legitimately short on the
 *     unified leg — alerting on those would be alerting on known, scheduled
 *     work. The window is exactly the set the dual-write is responsible for.
 *   - Bounded by `maxConversations`, and it never scans either message table
 *     whole: an unbounded `count(*)` over `chat_messages` is the kind of
 *     query that turns a monitoring job into an incident.
 *
 * IT ONLY LOOKS. No repair: a reconciler that silently "fixed" drift would
 * destroy the evidence of the writer that caused it, and the repair already
 * exists as a reviewable, resumable script
 * (`scripts/backfill-unify-messages.ts`).
 */

import { db } from '@pagespace/db/db';
import { sql } from '@pagespace/db/operators';
import { loggers } from '@pagespace/lib/logging/logger-config';

/** Per-conversation comparison of the two legs. */
export interface LegDivergence {
  conversationId: string;
  legacyCount: number;
  unifiedCount: number;
  legacyMaxCreatedAt: string | null;
  unifiedMaxCreatedAt: string | null;
}

export interface MessageUnificationReconcileRun {
  /** Conversations compared. */
  checked: number;
  /** Conversations whose legs disagree. */
  diverged: number;
  /** Total unified-leg rows missing across all diverged conversations (negative = unified has extra). */
  missingRows: number;
  /** The worst offenders, capped for log volume. */
  samples: LegDivergence[];
  windowHours: number;
  /** True when the scan hit `maxConversations` — more may be diverging beyond the cap. */
  capped: boolean;
}

/** Divergent conversations included in the log/response payload. */
const SAMPLE_LIMIT = 20;

export interface ReconcileOptions {
  /** How far back `conversations.lastMessageAt` may be. Default 24h. */
  windowHours?: number;
  /** Hard cap on conversations compared in one tick. Default 500. */
  maxConversations?: number;
}

export async function reconcileMessageUnification(
  options?: ReconcileOptions,
): Promise<MessageUnificationReconcileRun> {
  const windowHours = options?.windowHours ?? 24;
  const maxConversations = options?.maxConversations ?? 500;

  // One statement: the candidate window drives both aggregates, so the two
  // legs are read at the same snapshot and an in-flight write cannot be
  // counted on one leg but not the other. `to_char` rather than a Date so
  // the two watermarks are compared as the identical server-rendered string
  // — no client TZ, no millisecond rounding, in or out.
  const { rows } = await db.execute<{
    conversationId: string;
    legacyCount: string;
    unifiedCount: string;
    legacyMaxCreatedAt: string | null;
    unifiedMaxCreatedAt: string | null;
  }>(sql`
    WITH recent AS (
      SELECT c."id"
      FROM conversations c
      WHERE c."type" = 'page'
        AND c."lastMessageAt" IS NOT NULL
        AND c."lastMessageAt" >= now() - (${windowHours} * INTERVAL '1 hour')
      ORDER BY c."lastMessageAt" DESC
      LIMIT ${maxConversations}
    )
    SELECT
      r."id" AS "conversationId",
      (SELECT count(*) FROM chat_messages l WHERE l."conversationId" = r."id") AS "legacyCount",
      (SELECT count(*) FROM messages u WHERE u."conversationId" = r."id") AS "unifiedCount",
      (SELECT to_char(max(l."createdAt"), 'YYYY-MM-DD HH24:MI:SS.US')
         FROM chat_messages l WHERE l."conversationId" = r."id") AS "legacyMaxCreatedAt",
      (SELECT to_char(max(u."createdAt"), 'YYYY-MM-DD HH24:MI:SS.US')
         FROM messages u WHERE u."conversationId" = r."id") AS "unifiedMaxCreatedAt"
    FROM recent r
  `);

  const divergences: LegDivergence[] = [];
  let missingRows = 0;

  for (const row of rows) {
    const legacyCount = Number(row.legacyCount);
    const unifiedCount = Number(row.unifiedCount);
    if (legacyCount === unifiedCount && row.legacyMaxCreatedAt === row.unifiedMaxCreatedAt) continue;
    missingRows += legacyCount - unifiedCount;
    divergences.push({
      conversationId: row.conversationId,
      legacyCount,
      unifiedCount,
      legacyMaxCreatedAt: row.legacyMaxCreatedAt,
      unifiedMaxCreatedAt: row.unifiedMaxCreatedAt,
    });
  }

  // Worst first, so a truncated sample still shows the biggest gaps.
  divergences.sort(
    (a, b) => Math.abs(b.legacyCount - b.unifiedCount) - Math.abs(a.legacyCount - a.unifiedCount),
  );

  const run: MessageUnificationReconcileRun = {
    checked: rows.length,
    diverged: divergences.length,
    missingRows,
    samples: divergences.slice(0, SAMPLE_LIMIT),
    windowHours,
    capped: rows.length >= maxConversations,
  };

  if (run.diverged > 0) {
    // ERROR level, not warn: within the active window the two legs are
    // supposed to be written by one transaction, so any disagreement means a
    // write bypassed the shared writer or the unified leg was refused. That is
    // a data-loss precursor for the reader cutover, and it should page.
    loggers.ai.error(
      'reconcileMessageUnification: chat_messages and messages disagree for recently-active conversations',
      new Error('message unification drift'),
      {
        checked: run.checked,
        diverged: run.diverged,
        missingRows: run.missingRows,
        windowHours: run.windowHours,
        capped: run.capped,
        samples: run.samples,
      },
    );
  } else {
    loggers.ai.info('reconcileMessageUnification: legs agree', {
      checked: run.checked,
      windowHours: run.windowHours,
      capped: run.capped,
    });
  }

  return run;
}
