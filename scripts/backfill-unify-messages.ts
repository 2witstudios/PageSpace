#!/usr/bin/env bun
/**
 * Backfill Script: copy `chat_messages` into the unified `messages` table.
 *
 * The historical half of the message-table merge (epic "Agent-Session Single
 * Source of Truth", Phase 4 / D6). Migration 0248 added the target columns
 * (`pageId`, `sourceAgentId`, nullable `userId`) and synthesised a
 * `conversations` row for every orphan `chat_messages.conversationId`; PR 10's
 * dual-write keeps NEW page-chat writes in both tables from the moment it
 * deploys. This script carries everything written BEFORE that across, so the
 * reader cutover (PRs 11/12) finds a complete corpus in one table.
 *
 * Usage:
 *   bun scripts/backfill-unify-messages.ts                  # live run
 *   bun scripts/backfill-unify-messages.ts --dry-run        # count only, no writes
 *   bun scripts/backfill-unify-messages.ts --batch-size=1000
 *
 * NO `--apply` confirmation gate, unlike the PII re-encrypt backfills. Those
 * REWRITE live columns into a format old readers cannot parse; this one only
 * INSERTs rows into a table no reader reads yet, under `ON CONFLICT (id) DO
 * NOTHING`. The dangerous direction does not exist here, so a confirmation
 * flag would be ceremony rather than safety — and the run needs to be
 * repeatable on demand while the dual-write soaks.
 *
 * ── Idempotent ────────────────────────────────────────────────────────────
 * Two independent layers: candidates are selected by ANTI-JOIN (only legacy
 * rows with no unified twin are considered at all), and the INSERT itself is
 * `ON CONFLICT (id) DO NOTHING`. The second covers the race the first cannot:
 * the dual-write landing the same id between this batch's SELECT and its
 * INSERT. A re-run over a fully-copied corpus does zero work and reports
 * `copied: 0`.
 *
 * A copied row is NEVER updated. If a row already exists in `messages` it is
 * left exactly as the dual-write (or a previous run) wrote it — this script
 * only ever fills gaps, so it can never clobber a live write with a stale
 * snapshot of the legacy leg.
 *
 * ── Resumable ─────────────────────────────────────────────────────────────
 * There is no cursor file and no state of its own: the resume point is
 * DERIVED FROM THE TARGET TABLE at startup as "the oldest legacy row that has
 * no unified twin yet", in the same `("createdAt", id)` order the copy walks.
 * An interrupted run therefore restarts from the first genuine gap.
 *
 * Deriving it that way rather than as `MAX("createdAt")` of the target is
 * deliberate and load-bearing: the dual-write is concurrently inserting rows
 * with a `createdAt` of NOW, so the target's maximum is always "a moment ago"
 * and a MAX-based cursor would fast-forward past the entire uncopied
 * backlog on the first run. The first-gap cursor is immune to that.
 *
 * ── Ordering ──────────────────────────────────────────────────────────────
 * `ORDER BY "createdAt", id` with a row-comparison cursor `("createdAt", id)
 * > (:createdAt, :id)`. The id tiebreak matters: `createdAt` is not unique
 * (a user message and its assistant reply can share a millisecond), so a
 * `createdAt`-only cursor either loops forever on a tie or skips rows.
 *
 * ── Rows this script deliberately does not copy ───────────────────────────
 * A legacy row whose `conversationId` names no `conversations` row is SKIPPED,
 * not copied: `messages.conversationId` carries a real, validated FK, so
 * including such a row would abort its whole batch. 0248's orphan synthesis
 * should have left none, so any skip is reported in the summary and is worth
 * investigating rather than re-running past. They do not block progress —
 * the cursor moves past them — but they will be re-reported by every
 * subsequent run, which is the intended nag.
 *
 * Exit codes: 0 = run completed (including a completed run that skipped rows;
 * the summary says so); 1 = the run crashed.
 */

import 'dotenv/config';
import { getMigrationDb } from '@pagespace/db/db';
import { sql } from '@pagespace/db/operators';

type MigrationDb = ReturnType<typeof getMigrationDb>;

const DEFAULT_BATCH_SIZE = 5000;

export interface BackfillSummary {
  /** Rows inserted into `messages` by this run. */
  copied: number;
  /**
   * Candidate rows this run walked past without copying: either their
   * `conversations` row is missing (counted in `skippedNoConversation`) or
   * the dual-write inserted the same id first (`ON CONFLICT DO NOTHING`).
   */
  skipped: number;
  /** Subset of `skipped` whose conversation row does not exist. */
  skippedNoConversation: number;
  /** Candidates examined = copied + skipped. */
  total: number;
  /** Number of batches executed (0 when there was nothing to do). */
  batches: number;
  dryRun: boolean;
}

interface Cursor {
  /**
   * `createdAt` as a Postgres literal string, NOT a JS `Date` — deliberately.
   * These queries are raw `sql`, so they bypass drizzle's column-aware
   * `mapToDriverValue`, and node-postgres serialises a `Date` with the
   * CLIENT's UTC offset. Cast to `timestamp` (which `chat_messages."createdAt"`
   * is — no time zone), Postgres then parses the wall-clock part and discards
   * the offset, shifting the cursor by the runner's local offset and skipping
   * or re-scanning rows. Carrying the value as text produced by `to_char` on
   * the server side round-trips it exactly, whatever TZ the runner is in.
   */
  createdAtText: string;
  id: string;
  /** True only for the resume cursor: it IS the first row to copy, not the row before it. */
  inclusive: boolean;
}

const CREATED_AT_TEXT = sql`to_char(c."createdAt", 'YYYY-MM-DD HH24:MI:SS.US')`;

/** The `(createdAt, id) > cursor` (or `>=`) bound, shared by the select and the insert. */
function cursorBound(cursor: Cursor) {
  const position = sql`(c."createdAt", c."id")`;
  const value = sql`(${cursor.createdAtText}::timestamp, ${cursor.id})`;
  return cursor.inclusive ? sql`${position} >= ${value}` : sql`${position} > ${value}`;
}

/**
 * The resume point: the oldest legacy row with no unified twin. `null` means
 * the tables are already reconciled and there is nothing to do.
 *
 * Returned INCLUSIVE — it names the first row to copy, not a position before
 * it — so no arithmetic on timestamps is needed to avoid skipping it.
 */
export async function deriveResumeCursor(db: MigrationDb): Promise<Cursor | null> {
  const { rows } = await db.execute<{ createdAtText: string; id: string }>(sql`
    SELECT ${CREATED_AT_TEXT} AS "createdAtText", c."id"
    FROM chat_messages c
    WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m."id" = c."id")
    ORDER BY c."createdAt", c."id"
    LIMIT 1
  `);
  const first = rows[0];
  if (!first) return null;
  return { createdAtText: first.createdAtText, id: first.id, inclusive: true };
}

/**
 * Copy one batch. Returns the rows examined, the rows actually inserted, and
 * the new cursor (`null` when the batch was empty — the loop is done).
 *
 * Candidate selection and the INSERT are ONE statement (a CTE): reading the
 * ids in one round trip and inserting them in another would widen the window
 * in which the dual-write can touch the same rows, and would need the id list
 * shipped back and forth for no gain.
 */
async function copyBatch(
  db: MigrationDb,
  cursor: Cursor,
  batchSize: number,
  dryRun: boolean,
): Promise<{ examined: number; copied: number; noConversation: number; next: Cursor | null }> {
  const { rows: candidates } = await db.execute<{
    id: string;
    createdAtText: string;
    hasConversation: boolean;
  }>(sql`
    SELECT
      c."id",
      ${CREATED_AT_TEXT} AS "createdAtText",
      EXISTS (SELECT 1 FROM conversations cv WHERE cv."id" = c."conversationId") AS "hasConversation"
    FROM chat_messages c
    WHERE ${cursorBound(cursor)}
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE m."id" = c."id")
    ORDER BY c."createdAt", c."id"
    LIMIT ${batchSize}
  `);

  if (candidates.length === 0) {
    return { examined: 0, copied: 0, noConversation: 0, next: null };
  }

  const last = candidates[candidates.length - 1];
  const next: Cursor = { createdAtText: last.createdAtText, id: last.id, inclusive: false };
  const noConversation = candidates.filter((row) => !row.hasConversation).length;

  if (dryRun) {
    return {
      examined: candidates.length,
      copied: candidates.length - noConversation,
      noConversation,
      next,
    };
  }

  // Re-derives its own candidate set rather than taking the ids read above:
  // the same predicates, evaluated at write time, so nothing copied in the
  // gap is copied twice and nothing deleted in the gap is resurrected.
  const { rows: inserted } = await db.execute<{ id: string }>(sql`
    INSERT INTO messages (
      "id", "conversationId", "userId", "role", "messageType", "content",
      "toolCalls", "toolResults", "createdAt", "isActive", "editedAt",
      "status", "pageId", "sourceAgentId"
    )
    SELECT
      c."id", c."conversationId", c."userId", c."role", c."messageType", c."content",
      c."toolCalls", c."toolResults", c."createdAt", c."isActive", c."editedAt",
      c."status", c."pageId", c."sourceAgentId"
    FROM chat_messages c
    WHERE ${cursorBound(cursor)}
      AND (c."createdAt", c."id") <= (${next.createdAtText}::timestamp, ${next.id})
      AND EXISTS (SELECT 1 FROM conversations cv WHERE cv."id" = c."conversationId")
    ON CONFLICT ("id") DO NOTHING
    RETURNING "id"
  `);

  return { examined: candidates.length, copied: inserted.length, noConversation, next };
}

export async function runBackfill(options?: {
  dryRun?: boolean;
  batchSize?: number;
  dbInstance?: MigrationDb;
}): Promise<BackfillSummary> {
  const dryRun = options?.dryRun ?? false;
  const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;
  const db = options?.dbInstance ?? getMigrationDb();

  console.log(
    `📨 Unifying chat_messages → messages${dryRun ? ' (dry run — no writes)' : ''}, batch size ${batchSize}...`,
  );

  let cursor = await deriveResumeCursor(db);
  if (!cursor) {
    console.log('✅ Nothing to do — every chat_messages row already has a unified twin.');
    return { copied: 0, skipped: 0, skippedNoConversation: 0, total: 0, batches: 0, dryRun };
  }
  console.log(`   resuming from the first gap at ${cursor.createdAtText} / ${cursor.id}`);

  let copied = 0;
  let total = 0;
  let skippedNoConversation = 0;
  let batches = 0;

  for (;;) {
    const batch = await copyBatch(db, cursor, batchSize, dryRun);
    if (batch.next === null) break;

    batches++;
    total += batch.examined;
    copied += batch.copied;
    skippedNoConversation += batch.noConversation;
    cursor = batch.next;

    console.log(
      `   batch ${batches}: examined ${batch.examined}, ${dryRun ? 'would copy' : 'copied'} ${batch.copied}` +
        `${batch.noConversation > 0 ? `, skipped ${batch.noConversation} with no conversations row` : ''}` +
        ` (through ${cursor.createdAtText})`,
    );

    // A short batch means the candidate set is exhausted; one more round trip
    // would only confirm it.
    if (batch.examined < batchSize) break;
  }

  const skipped = total - copied;
  console.log(
    `\n✅ ${dryRun ? 'Dry run' : 'Backfill'} complete. ` +
      `${dryRun ? 'would copy' : 'copied'}: ${copied}, skipped: ${skipped} ` +
      `(${skippedNoConversation} missing a conversations row), total examined: ${total}, batches: ${batches}.`,
  );
  if (skippedNoConversation > 0) {
    console.log(
      `⚠️  ${skippedNoConversation} row(s) name a conversationId with no conversations row — migration 0248 ` +
        `should have synthesised one for every orphan. Investigate before the reader cutover; re-running ` +
        `this script will report them again.`,
    );
  }

  return { copied, skipped, skippedNoConversation, total, batches, dryRun };
}

// Only run when invoked directly (not when imported by tests).
if (import.meta.main) {
  const batchSizeArg = process.argv.find((arg) => arg.startsWith('--batch-size='));
  runBackfill({
    dryRun: process.argv.includes('--dry-run'),
    batchSize: batchSizeArg ? Number(batchSizeArg.split('=')[1]) : undefined,
  })
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Backfill failed:', error);
      process.exit(1);
    });
}
