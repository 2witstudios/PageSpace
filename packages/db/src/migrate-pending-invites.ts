/**
 * One-shot data migration for the drive-invite GDPR + zero-trust cutover.
 *
 * Before this cutover, drive invites parked pending state in two places:
 *   1. A `users` row created at invite-send time (with `tosAcceptedAt = null`,
 *      `emailVerified = null`, `provider = 'email'`, name derived from the email)
 *   2. A `drive_members` row referencing that user with `acceptedAt = null`
 *
 * After the cutover, pending state lives in the new `pending_invites` table
 * and the user row is only created at affirmative signup. There is NO clean
 * way to re-issue a usable invite from the legacy data alone — the original
 * raw token was never persisted (only its hash lived in `verification_tokens`,
 * which the magic-link service has since rotated through normal expiry). So
 * the migration is a clean wipe rather than an in-place port:
 *
 *   1. Delete every `drive_members` row with `acceptedAt IS NULL`. These were
 *      orphan-pending rows; the recipient never received a usable token after
 *      the cutover and the partial unique index on `pending_invites` would
 *      otherwise block admins from re-inviting the same email to the same drive.
 *
 *   2. Delete users created exclusively by the old invite path: provider='email',
 *      no passkeys, `tosAcceptedAt IS NULL`, `emailVerified IS NULL`, and no
 *      remaining `drive_members` rows. Conservative — any auth credential or
 *      verified email or accepted membership leaves the row intact.
 *
 *   3. Emit the (driveId, email) pairs that were wiped so admins can re-invite
 *      through the normal /api/drives/[driveId]/members/invite flow, which
 *      produces a usable /invite/<token> URL via the standard delivery path.
 *
 * Run with: pnpm --filter @pagespace/db migrate-pending-invites
 *
 * The script is idempotent: re-running it against migrated data finds zero
 * pending rows and zero orphans.
 */

import { eq, and, isNull } from 'drizzle-orm';
import { db } from './db';
import { users, passkeys } from './schema/auth';
import { driveMembers } from './schema/members';

interface MigrationResult {
  pendingMembersDeleted: number;
  orphanUsersDeleted: number;
  wipedInvites: Array<{ driveId: string; email: string }>;
}

export async function migratePendingInvites(): Promise<MigrationResult> {
  const result: MigrationResult = {
    pendingMembersDeleted: 0,
    orphanUsersDeleted: 0,
    wipedInvites: [],
  };

  const pendingRows = await db
    .select({
      memberId: driveMembers.id,
      driveId: driveMembers.driveId,
      email: users.email,
    })
    .from(driveMembers)
    .innerJoin(users, eq(users.id, driveMembers.userId))
    .where(isNull(driveMembers.acceptedAt));

  for (const row of pendingRows) {
    await db.delete(driveMembers).where(eq(driveMembers.id, row.memberId));
    result.pendingMembersDeleted += 1;
    result.wipedInvites.push({ driveId: row.driveId, email: row.email });
  }

  // Find orphan users: created by the old invite path with provider='email',
  // never authenticated, never accepted ToS, no passkeys, and (after the
  // delete above) no remaining drive_members rows. Conservative — any auth
  // credential or verified email leaves the row intact.
  const orphans = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .leftJoin(passkeys, eq(passkeys.userId, users.id))
    .where(
      and(
        eq(users.provider, 'email'),
        isNull(users.tosAcceptedAt),
        isNull(users.emailVerified),
        isNull(passkeys.id)
      )
    );

  for (const orphan of orphans) {
    const remaining = await db
      .select({ id: driveMembers.id })
      .from(driveMembers)
      .where(eq(driveMembers.userId, orphan.id))
      .limit(1);
    if (remaining.length > 0) continue;

    await db.delete(users).where(eq(users.id, orphan.id));
    result.orphanUsersDeleted += 1;
  }

  return result;
}

async function main() {
  const result = await migratePendingInvites();
  console.log('drive-invite migration complete:');
  console.log(`  pending drive_members rows deleted: ${result.pendingMembersDeleted}`);
  console.log(`  orphan users deleted:               ${result.orphanUsersDeleted}`);
  if (result.wipedInvites.length > 0) {
    console.log('');
    console.log('Wiped legacy invites — admins should re-invite via the invite UI:');
    for (const { driveId, email } of result.wipedInvites) {
      console.log(`  drive=${driveId}  email=${email}`);
    }
  }
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    }
  );
}
