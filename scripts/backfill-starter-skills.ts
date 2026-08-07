import 'dotenv/config';
import { getMigrationDb } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { and, eq, isNull, asc, gt, count } from '@pagespace/db/operators';
import { installStarterSkills } from '@pagespace/lib/commands/starter-skill-installer';
import { STARTER_SKILL_TRIGGERS } from '@pagespace/lib/commands/starter-skills';

/**
 * One-shot backfill: install the starter skills into every existing user's Home
 * drive.
 *
 * New signups get these during `provisionHomeDriveIfNeeded`, but that path only
 * runs when a Home drive is CREATED — a user who already has one never passes
 * through it again. This script covers them, deliberately instead of a
 * per-login hook, so the hot auth path stays untouched.
 *
 * Safe to re-run: `installStarterSkills` no-ops on any user already stamped with
 * `users.starterSkillsInstalledAt`, so a partial run can simply be run again and
 * a starter the user deleted in the meantime is never resurrected.
 *
 * Usage:
 *   bun scripts/backfill-starter-skills.ts --dry-run
 *   bun scripts/backfill-starter-skills.ts
 */

const BATCH_SIZE = 200;

export interface BackfillSummary {
  scanned: number;
  installed: number;
  skippedCollision: number;
  alreadyStamped: number;
  noHomeDrive: number;
  failed: number;
}

export async function runBackfill({ dryRun = false }: { dryRun?: boolean } = {}): Promise<BackfillSummary> {
  const db = getMigrationDb();
  const summary: BackfillSummary = {
    scanned: 0,
    installed: 0,
    skippedCollision: 0,
    alreadyStamped: 0,
    noHomeDrive: 0,
    failed: 0,
  };

  console.log(
    `${dryRun ? '[DRY RUN] ' : ''}Backfilling starter skills (${STARTER_SKILL_TRIGGERS.join(', ')})\n`,
  );

  // Keyset pagination on the user id: the loop MUTATES the same predicate it
  // filters on (starterSkillsInstalledAt goes non-null), so an OFFSET-based
  // walk would skip users as the result set shrinks underneath it.
  let cursor = '';
  for (;;) {
    const batch = await db
      .select({ userId: users.id, driveId: drives.id })
      .from(users)
      .innerJoin(drives, and(eq(drives.ownerId, users.id), eq(drives.kind, 'HOME')))
      .where(and(isNull(users.starterSkillsInstalledAt), gt(users.id, cursor)))
      .orderBy(asc(users.id))
      .limit(BATCH_SIZE);

    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].userId;

    for (const row of batch) {
      summary.scanned++;
      if (dryRun) {
        summary.installed += STARTER_SKILL_TRIGGERS.length;
        continue;
      }

      try {
        // One transaction per user: a failure isolates to that user rather than
        // rolling back a whole batch of unrelated installs.
        const result = await db.transaction((tx) => installStarterSkills(row.userId, row.driveId, tx));
        if (result.alreadyInstalled) summary.alreadyStamped++;
        summary.installed += result.installed.length;
        summary.skippedCollision += result.skipped.length;
        if (result.skipped.length > 0) {
          console.log(`  user ${row.userId}: kept existing command(s) ${result.skipped.join(', ')}`);
        }
      } catch (error) {
        summary.failed++;
        console.error(`  user ${row.userId}: FAILED`, error);
      }
    }

    console.log(`  …${summary.scanned} users scanned`);
  }

  // Whatever still has a null stamp after the walk has no HOME drive, since the
  // loop covered every user that does. Not an error — they get theirs when
  // provisioning next creates their Home — but report it so a surprising number
  // is visible rather than silent. Skipped on a dry run, which writes no stamps.
  if (!dryRun) {
    const [remaining] = await db
      .select({ total: count() })
      .from(users)
      .where(isNull(users.starterSkillsInstalledAt));
    summary.noHomeDrive = remaining?.total ?? 0;
  }

  console.log(
    `\nDone${dryRun ? ' (dry run — nothing written)' : ''}. ` +
      `${summary.scanned} user(s) scanned, ${summary.installed} skill(s) installed, ` +
      `${summary.skippedCollision} skipped (trigger already taken), ` +
      `${summary.alreadyStamped} already stamped, ${summary.failed} failed, ` +
      `${summary.noHomeDrive} left unstamped (no Home drive yet).`,
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
