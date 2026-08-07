/**
 * FROZEN-LEG GUARD for the message-table unification (epic "Agent-Session
 * Single Source of Truth", Phase 4 / D6; epic #2161's standing rule: a forced
 * copy gets BOTH a drift-guard test and a reconciler with alerting).
 *
 * ── WHAT CHANGED AT PR 14 ─────────────────────────────────────────────────
 * Through PRs 10–13 this compared two legs that were supposed to be EQUAL,
 * because both were written. As of PR 14 they are not equal and must not be:
 * `messages` is the sole write target and keeps growing, while
 * `chat_messages` is FROZEN — nothing INSERTs or UPDATEs it any more. So an
 * equality check would now fire on every healthy conversation, which is the
 * fastest way to get a real alert muted.
 *
 * The invariant that replaces equality is one-directional, and it is exactly
 * "the legacy table stopped changing":
 *
 *     every `chat_messages` row still has an identical `messages` twin
 *     under the same primary key.
 *
 * That is what a frozen table looks like from the outside, and it is checkable
 * without storing a baseline anywhere:
 *
 *   - a MISSED WRITER that INSERTs a legacy row  → the row has no twin (ids
 *     are cuid2, so a new legacy id cannot already exist in `messages`) →
 *     ERROR. This is the failure this guard exists for.
 *   - a MISSED WRITER that UPDATEs a legacy row's content/isActive/status →
 *     the twin no longer matches → ERROR.
 *   - the normal case, `messages` gaining rows the frozen table never sees →
 *     invisible, correctly. The unified leg is allowed to grow.
 *   - legitimate legacy DELETEs (retention's legacy sweep, GDPR erasure, page
 *     teardown, the 0248 FK cascade) shrink the subset → invisible, correctly.
 *     Those are the only statements still aimed at that table, and they must
 *     keep running until PR 15 drops it.
 *
 * The fingerprint is `content`, `isActive` and `status` — the columns a
 * resurrected writer would change and that the dual-write guaranteed
 * byte-identical. `toolCalls`/`toolResults` are deliberately NOT compared: a
 * jsonb equality test across two write paths and a backfill is a
 * false-positive generator, and an update-only-toolResults writer is caught by
 * the STRUCTURAL half of this guard
 * (`__tests__/unified-message-freeze-guard.test.ts`), which fails the suite on
 * any INSERT or UPDATE statement aimed at the legacy table anywhere in the
 * tree. The two halves cover each other: the test knows about writers, this
 * knows about rows.
 *
 * SCOPE — deliberately narrow, in both directions:
 *   - `type = 'page'` only. A GLOBAL conversation never had a legacy leg;
 *     including it would compare `chat_messages` against rows it never held.
 *   - Recently active only (`lastMessageAt` inside the window) — the set where
 *     a resurrected writer would show up first, and the only set cheap enough
 *     to check on a cron tick.
 *   - Bounded by `maxConversations`, and it never scans either message table
 *     whole: an unbounded `count(*)` over `chat_messages` is the kind of query
 *     that turns a monitoring job into an incident.
 *
 * IT ONLY LOOKS. No repair: a reconciler that silently "fixed" drift would
 * destroy the evidence of the writer that caused it.
 */

import { db } from '@pagespace/db/db';
import { sql } from '@pagespace/db/operators';
import { loggers } from '@pagespace/lib/logging/logger-config';

/** One conversation whose frozen legacy rows are NOT all mirrored. */
export interface LegDivergence {
  conversationId: string;
  /** Legacy rows that have no identical `messages` twin — the freeze violation. */
  unmirroredLegacy: number;
  legacyCount: number;
  unifiedCount: number;
  /** Newest legacy row in this conversation — when the missed write landed. */
  legacyMaxCreatedAt: string | null;
  unifiedMaxCreatedAt: string | null;
}

export interface MessageUnificationReconcileRun {
  /** Conversations compared. */
  checked: number;
  /** Conversations holding at least one unmirrored legacy row. */
  diverged: number;
  /** Total unmirrored legacy rows across all diverged conversations. */
  unmirroredRows: number;
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

  // One statement: the candidate window drives every aggregate, so both tables
  // are read at the same snapshot and an in-flight write cannot be counted in
  // one subquery but not another. `to_char` rather than a Date so the two
  // watermarks are rendered by the server as identical-format strings — no
  // client TZ, no millisecond rounding, in or out.
  const { rows } = await db.execute<{
    conversationId: string;
    legacyCount: string;
    unifiedCount: string;
    unmirroredLegacy: string;
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
      (SELECT count(*)
         FROM chat_messages l
        WHERE l."conversationId" = r."id"
          AND NOT EXISTS (
            SELECT 1 FROM messages u
             WHERE u."id" = l."id"
               AND u."conversationId" = l."conversationId"
               AND u."content" = l."content"
               AND u."isActive" = l."isActive"
               AND u."status" = l."status"
          )) AS "unmirroredLegacy",
      (SELECT to_char(max(l."createdAt"), 'YYYY-MM-DD HH24:MI:SS.US')
         FROM chat_messages l WHERE l."conversationId" = r."id") AS "legacyMaxCreatedAt",
      (SELECT to_char(max(u."createdAt"), 'YYYY-MM-DD HH24:MI:SS.US')
         FROM messages u WHERE u."conversationId" = r."id") AS "unifiedMaxCreatedAt"
    FROM recent r
  `);

  const divergences: LegDivergence[] = [];
  let unmirroredRows = 0;

  for (const row of rows) {
    const unmirroredLegacy = Number(row.unmirroredLegacy);
    if (unmirroredLegacy === 0) continue;
    unmirroredRows += unmirroredLegacy;
    divergences.push({
      conversationId: row.conversationId,
      unmirroredLegacy,
      legacyCount: Number(row.legacyCount),
      unifiedCount: Number(row.unifiedCount),
      legacyMaxCreatedAt: row.legacyMaxCreatedAt,
      unifiedMaxCreatedAt: row.unifiedMaxCreatedAt,
    });
  }

  // Worst first, so a truncated sample still shows the biggest gaps.
  divergences.sort((a, b) => b.unmirroredLegacy - a.unmirroredLegacy);

  const run: MessageUnificationReconcileRun = {
    checked: rows.length,
    diverged: divergences.length,
    unmirroredRows,
    samples: divergences.slice(0, SAMPLE_LIMIT),
    windowHours,
    capped: rows.length >= maxConversations,
  };

  if (run.diverged > 0) {
    // ERROR level, and it should page. `chat_messages` is frozen: a row there
    // that `messages` does not mirror means SOMETHING WROTE THE LEGACY TABLE
    // after the freeze — a writer PR 14 missed, or one added since. Those rows
    // are invisible to every reader (nothing has read that table since PR 12),
    // so this is silent data loss from the user's point of view, and it also
    // blocks PR 15: the table cannot be dropped while anything still writes it.
    loggers.ai.error(
      'reconcileMessageUnification: chat_messages is FROZEN but has rows the unified table does not mirror — a legacy writer is still live',
      new Error('legacy message leg is not frozen'),
      {
        checked: run.checked,
        diverged: run.diverged,
        unmirroredRows: run.unmirroredRows,
        windowHours: run.windowHours,
        capped: run.capped,
        samples: run.samples,
      },
    );
  } else {
    loggers.ai.info('reconcileMessageUnification: legacy leg still frozen', {
      checked: run.checked,
      windowHours: run.windowHours,
      capped: run.capped,
    });
  }

  return run;
}
