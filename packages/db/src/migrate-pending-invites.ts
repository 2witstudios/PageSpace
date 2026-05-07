/**
 * One-shot data migration for the GDPR + zero-trust drive-invite rebuild.
 *
 * **Run BEFORE deploying the new code.** The new invite endpoint depends on
 * the legacy `drive_members.acceptedAt IS NULL` rows being absent — leaving
 * them in place would let the old pending state coexist with the new
 * `pending_invites` table and confuse the active-invite pre-check.
 *
 * The original raw invite token was never persisted (the legacy magic-link
 * flow stored only the SHA hash on `verification_tokens`), so legacy pending
 * rows cannot be ported into `pending_invites` with a usable token. This
 * script wipes them and emits `(drive_id, email)` pairs to stdout so admins
 * can re-invite via the new flow.
 *
 * Idempotent: running it twice produces the same end state on the second run
 * (zero additional deletions, exit 0). All deletes run inside one transaction
 * so a partial failure leaves the DB in a consistent state.
 *
 * Usage:
 *   pnpm --filter @pagespace/db migrate-pending-invites
 *   pnpm --filter @pagespace/db migrate-pending-invites -- --dry-run
 */

import { db } from './db';
import { driveMembers } from './schema/members';
import { users, passkeys } from './schema/auth';
import { and, eq, inArray, isNull, sql } from './operators';

const dryRun = process.argv.includes('--dry-run');

async function main() {
  const wiped: Array<{ driveId: string; email: string }> = [];
  let usersDeleted = 0;

  try {
    await db.transaction(async (tx) => {
      // Step 1 — collect (driveId, email) pairs for legacy pending rows so we
      // can emit them to stdout for admin re-invite. We need the email which
      // lives on the joined users row.
      const pendingPairs = await tx
        .select({
          driveId: driveMembers.driveId,
          userId: driveMembers.userId,
          email: users.email,
        })
        .from(driveMembers)
        .innerJoin(users, eq(users.id, driveMembers.userId))
        .where(isNull(driveMembers.acceptedAt));

      for (const row of pendingPairs) {
        wiped.push({ driveId: row.driveId, email: row.email });
      }

      const pendingUserIds = Array.from(new Set(pendingPairs.map((p) => p.userId)));

      if (dryRun) {
        return;
      }

      // Step 2 — delete the legacy pending drive_members rows.
      await tx.delete(driveMembers).where(isNull(driveMembers.acceptedAt));

      // Step 3 — delete the orphan users created solely by the old invite
      // path. Criteria: email-provider user with no ToS acceptance, no email
      // verification, no passkeys, and no remaining drive_members rows. Any
      // user with linked content beyond the just-deleted pending row is left
      // intact.
      if (pendingUserIds.length === 0) {
        return;
      }

      // Drizzle expressions: scope to the pending-userId list, then negated
      // EXISTS() for passkeys and remaining drive_members. The driveMembers
      // pending rows have just been deleted in this same transaction, so the
      // NOT EXISTS check correctly returns true for users whose only linkage
      // was the pending row.
      const deleted = await tx
        .delete(users)
        .where(
          and(
            inArray(users.id, pendingUserIds),
            eq(users.provider, 'email'),
            isNull(users.tosAcceptedAt),
            isNull(users.emailVerified),
            sql`NOT EXISTS (SELECT 1 FROM ${passkeys} WHERE ${passkeys.userId} = ${users.id})`,
            sql`NOT EXISTS (SELECT 1 FROM ${driveMembers} WHERE ${driveMembers.userId} = ${users.id})`,
          ),
        )
        .returning({ id: users.id });
      usersDeleted = deleted.length;
    });
  } catch (error) {
    console.error('migrate-pending-invites failed:', error);
    process.exit(1);
  }

  if (dryRun) {
    console.log(`[dry-run] Would delete ${wiped.length} pending drive_members rows.`);
  } else {
    console.log(`Deleted ${wiped.length} pending drive_members rows.`);
    console.log(`Deleted ${usersDeleted} orphan email-provider users.`);
  }

  if (wiped.length > 0) {
    console.log('\nThe following (driveId, email) pairs need to be re-invited via the new flow:');
    for (const { driveId, email } of wiped) {
      console.log(`  ${driveId}\t${email}`);
    }
  }

  process.exit(0);
}

// Guard against silently swallowing the script when imported. Always run on
// invocation.
main();
