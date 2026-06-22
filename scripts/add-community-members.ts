#!/usr/bin/env bun
/**
 * One-off script: bulk-add recent signups to a community drive.
 *
 * Finds users who signed up since --since and are not yet members of
 * --drive-id, then inserts them as MEMBER-role drive members.
 *
 * Usage:
 *   bun scripts/add-community-members.ts --drive-id <id> --since <ISO-date> [--dry-run]
 *
 * Example:
 *   bun scripts/add-community-members.ts \
 *     --drive-id clxxxxxxxxxxxxx \
 *     --since 2026-06-17T00:00:00Z \
 *     --dry-run
 */

import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { driveMembers } from '@pagespace/db/schema/members';
import { eq, gt, notInArray, sql } from '@pagespace/db/operators';

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };
  const driveId = get('--drive-id');
  const since = get('--since');
  const dryRun = args.includes('--dry-run');

  if (!driveId || !since) {
    console.error('Usage: bun scripts/add-community-members.ts --drive-id <id> --since <ISO-date> [--dry-run]');
    process.exit(1);
  }

  const sinceDate = new Date(since);
  if (isNaN(sinceDate.getTime())) {
    console.error(`Invalid date: ${since}`);
    process.exit(1);
  }

  return { driveId, sinceDate, dryRun };
}

async function run() {
  const { driveId, sinceDate, dryRun } = parseArgs();

  console.log(`🔍 Finding users who signed up after ${sinceDate.toISOString()} and are not members of drive ${driveId}${dryRun ? ' (DRY RUN)' : ''}...`);

  // Subquery: userId values already in the target drive
  const existingMemberSubquery = db
    .select({ userId: driveMembers.userId })
    .from(driveMembers)
    .where(eq(driveMembers.driveId, driveId));

  // All users who signed up after sinceDate and aren't already members
  const candidates = await db
    .select({ id: users.id, email: users.email, name: users.name, createdAt: users.createdAt })
    .from(users)
    .where(
      sql`${users.createdAt} > ${sinceDate.toISOString()} AND ${users.id} NOT IN (${existingMemberSubquery})`
    )
    .orderBy(users.createdAt);

  if (candidates.length === 0) {
    console.log('✅ No users to add — all recent signups are already members.');
    return;
  }

  console.log(`\nFound ${candidates.length} user(s) to add:`);
  for (const u of candidates) {
    console.log(`  ${u.createdAt.toISOString()}  ${u.email}  (${u.name})`);
  }

  if (dryRun) {
    console.log(`\n✅ Dry run complete. Would add ${candidates.length} user(s). Re-run without --dry-run to apply.`);
    return;
  }

  const now = new Date();
  const rows = candidates.map((u) => ({
    id: createId(),
    driveId,
    userId: u.id,
    role: 'MEMBER' as const,
    invitedAt: now,
    acceptedAt: now,
  }));

  // onConflictDoNothing on the (driveId, userId) unique key — safe to run twice
  const written = await db
    .insert(driveMembers)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: driveMembers.id, userId: driveMembers.userId });

  console.log(`\n✅ Added ${written.length} member(s) to drive ${driveId}.`);
  if (written.length < candidates.length) {
    console.log(`   (${candidates.length - written.length} skipped — already joined between query and insert)`);
  }
}

run().then(() => process.exit(0)).catch((err) => {
  console.error('💥 Script failed:', err);
  process.exit(1);
});
