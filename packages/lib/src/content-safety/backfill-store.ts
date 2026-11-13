/**
 * The backfill cursor — the database edge of backfill.ts. One row per walker
 * in `content_scan_backfill`. A tick takes a lease on the row with a
 * conditional UPDATE, so two cron containers (or a manual run) never walk at
 * the same time; a tick that dies leaves the lease to expire.
 */

import { db } from '@pagespace/db/db';
import { and, eq, isNull, lt, or } from '@pagespace/db/operators';
import { contentScanBackfill, type ContentScanBackfillRow } from '@pagespace/db/schema/content-safety';
import { BACKFILL_ID, emptyBackfillCounts, type BackfillCursor } from './backfill';

function toCursor(row: ContentScanBackfillRow): BackfillCursor {
  return {
    phase: row.phase,
    startAfter: row.startAfter,
    pass: row.pass,
    counts: { ...emptyBackfillCounts(), ...row.counts },
    lastPassCounts: row.lastPassCounts ? { ...emptyBackfillCounts(), ...row.lastPassCounts } : null,
    passStartedAt: row.passStartedAt,
    lastCompletedAt: row.lastCompletedAt,
  };
}

/** Take the lease on the walker's cursor, creating it at the start of pass 1. Null when another run holds it. */
export async function claimBackfillCursor(now: Date, leaseMs: number, id: string = BACKFILL_ID): Promise<BackfillCursor | null> {
  await db
    .insert(contentScanBackfill)
    .values({ id, phase: 'assets', startAfter: null, pass: 1, counts: emptyBackfillCounts(), passStartedAt: now, updatedAt: now })
    .onConflictDoNothing({ target: contentScanBackfill.id });
  const [row] = await db
    .update(contentScanBackfill)
    .set({ leaseUntil: new Date(now.getTime() + leaseMs), updatedAt: now })
    .where(and(eq(contentScanBackfill.id, id), or(isNull(contentScanBackfill.leaseUntil), lt(contentScanBackfill.leaseUntil, now))))
    .returning();
  return row ? toCursor(row) : null;
}

export async function saveBackfillCursor(cursor: BackfillCursor, { release }: { release: boolean }, id: string = BACKFILL_ID, now: Date = new Date()): Promise<void> {
  await db
    .update(contentScanBackfill)
    .set({
      phase: cursor.phase,
      startAfter: cursor.startAfter,
      pass: cursor.pass,
      counts: cursor.counts,
      lastPassCounts: cursor.lastPassCounts,
      passStartedAt: cursor.passStartedAt,
      lastCompletedAt: cursor.lastCompletedAt,
      updatedAt: now,
      ...(release ? { leaseUntil: null } : {}),
    })
    .where(eq(contentScanBackfill.id, id));
}

/** The walker's state for the admin console, or null before the first tick. */
export async function readBackfillCursor(id: string = BACKFILL_ID): Promise<(BackfillCursor & { updatedAt: Date; leased: boolean }) | null> {
  const [row] = await db.select().from(contentScanBackfill).where(eq(contentScanBackfill.id, id)).limit(1);
  if (!row) return null;
  return { ...toCursor(row), updatedAt: row.updatedAt, leased: row.leaseUntil !== null && row.leaseUntil.getTime() > Date.now() };
}
