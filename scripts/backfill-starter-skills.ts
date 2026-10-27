import 'dotenv/config';
import { getMigrationDb } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { commands } from '@pagespace/db/schema/commands';
import { and, eq, isNull, asc, gt, count, inArray } from '@pagespace/db/operators';
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
  /**
   * Users still without a stamp after the walk, EXCLUDING the ones that failed
   * in this run. Mostly users with no Home drive yet (they get theirs at
   * provisioning) plus any created mid-run.
   */
  unstampedRemaining: number;
  failed: number;
}

export async function runBackfill({ dryRun = false }: { dryRun?: boolean } = {}): Promise<BackfillSummary> {
  const db = getMigrationDb();
  const summary: BackfillSummary = {
    scanned: 0,
    installed: 0,
    skippedCollision: 0,
    alreadyStamped: 0,
    unstampedRemaining: 0,
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

    // A dry run has to account for triggers users ALREADY own, or it reports a
    // number the real run will not match — an operator sizing the rollout would
    // be told 6 installs and get 5. One query per batch, dry-run only.
    const takenByUser = new Map<string, Set<string>>();
    if (dryRun) {
      const existing = await db
        .select({ userId: commands.userId, trigger: commands.trigger })
        .from(commands)
        .where(
          and(
            inArray(commands.userId, batch.map((r) => r.userId)),
            inArray(commands.trigger, [...STARTER_SKILL_TRIGGERS]),
          ),
        );
      for (const row of existing) {
        if (!row.userId) continue;
        const set = takenByUser.get(row.userId) ?? new Set<string>();
        set.add(row.trigger);
        takenByUser.set(row.userId, set);
      }
    }

    for (const row of batch) {
      summary.scanned++;
      if (dryRun) {
        const taken = takenByUser.get(row.userId);
        const wouldSkip = STARTER_SKILL_TRIGGERS.filter((t) => taken?.has(t));
        summary.installed += STARTER_SKILL_TRIGGERS.length - wouldSkip.length;
        summary.skippedCollision += wouldSkip.length;
        if (wouldSkip.length > 0) {
          console.log(`  user ${row.userId}: would keep existing command(s) ${wouldSkip.join(', ')}`);
        }
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

  // Count what is STILL unstamped after the walk. Deliberately not labelled "no
  // Home drive": a failed transaction rolls its stamp back, and users created
  // after the walk started were never visited, so this set is
  // {no Home drive} ∪ {failed here} ∪ {created mid-run}. Reporting it as
  // "no Home drive yet" would let an operator read real failures as benign.
  // The failures we know about are subtracted and reported separately; the rest
  // is genuinely benign and clears on the next run or at provisioning.
  // Skipped on a dry run, which writes no stamps and would count everyone.
  if (!dryRun) {
    const [remaining] = await db
      .select({ total: count() })
      .from(users)
      .where(isNull(users.starterSkillsInstalledAt));
    summary.unstampedRemaining = Math.max(0, (remaining?.total ?? 0) - summary.failed);
  }

  console.log(
    `\nDone${dryRun ? ' (dry run — nothing written)' : ''}. ` +
      `${summary.scanned} user(s) scanned, ${summary.installed} skill(s) installed, ` +
      `${summary.skippedCollision} skipped (trigger already taken), ` +
      `${summary.alreadyStamped} already stamped, ${summary.failed} failed, ` +
      `${summary.unstampedRemaining} still unstamped (no Home drive yet, or created mid-run).`,
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
