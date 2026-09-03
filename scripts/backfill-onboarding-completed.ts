import 'dotenv/config';
import { getMigrationDb } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { and, asc, count, gt, inArray, isNull } from '@pagespace/db/operators';

/**
 * One-shot backfill: stamp every EXISTING user as having completed first-run
 * onboarding, so the new flow is only ever shown to genuinely new signups.
 *
 * Why this is required, not cosmetic: the gate shows onboarding whenever
 * `users.onboardingCompletedAt IS NULL`, deliberately rather than keying off the
 * `?welcome=true` redirect, so that a refresh part-way through the flow resumes
 * instead of stranding the user. The cost of that choice is that every user who
 * predates the feature also has NULL. Without this script, the entire existing
 * user base is shown a first-run flow on their next login.
 *
 * It must therefore run in the SAME release as the feature. Running the
 * migration without running this is the regression.
 *
 * Safe to re-run: it only ever writes rows that are still NULL, so a partial run
 * can simply be run again. A user who signs up mid-run gets NULL and correctly
 * sees the flow — that is not drift, it is the intended behaviour.
 *
 * Usage:
 *   bun scripts/backfill-onboarding-completed.ts --dry-run
 *   bun scripts/backfill-onboarding-completed.ts
 */

const BATCH_SIZE = 500;

export interface BackfillSummary {
  scanned: number;
  stamped: number;
  /** Users still NULL after the walk — expected to be only those created mid-run. */
  unstampedRemaining: number;
}

export async function runBackfill(
  { dryRun = false }: { dryRun?: boolean } = {},
): Promise<BackfillSummary> {
  const db = getMigrationDb();
  const summary: BackfillSummary = { scanned: 0, stamped: 0, unstampedRemaining: 0 };

  // A single fixed timestamp for the whole run: every pre-existing user is
  // stamped as of one moment, so the data says "backfilled at release" rather
  // than smearing across however long the walk takes.
  const stampedAt = new Date();

  let cursor = '';
  for (;;) {
    const batch = await db
      .select({ id: users.id })
      .from(users)
      .where(and(isNull(users.onboardingCompletedAt), gt(users.id, cursor)))
      .orderBy(asc(users.id))
      .limit(BATCH_SIZE);

    if (batch.length === 0) break;

    summary.scanned += batch.length;
    cursor = batch[batch.length - 1].id;

    if (!dryRun) {
      const ids = batch.map((row) => row.id);
      // Re-check IS NULL in the UPDATE so a concurrent completion during the
      // walk is never overwritten with the backfill timestamp.
      const updated = await db
        .update(users)
        .set({ onboardingCompletedAt: stampedAt })
        .where(and(inArray(users.id, ids), isNull(users.onboardingCompletedAt)))
        .returning({ id: users.id });
      summary.stamped += updated.length;
    } else {
      summary.stamped += batch.length;
    }
  }

  if (!dryRun) {
    const [remaining] = await db
      .select({ total: count() })
      .from(users)
      .where(isNull(users.onboardingCompletedAt));
    summary.unstampedRemaining = remaining?.total ?? 0;
  }

  console.log(
    `\nDone${dryRun ? ' (dry run — nothing written)' : ''}. ` +
      `${summary.scanned} user(s) scanned, ${summary.stamped} stamped, ` +
      `${summary.unstampedRemaining} still unstamped (created mid-run — these correctly see onboarding).`,
  );
  return summary;
}

// Only run when invoked directly (not when imported by tests).
if (import.meta.main) {
  runBackfill({ dryRun: process.argv.includes('--dry-run') })
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Backfill failed:', error);
      process.exit(1);
    });
}
