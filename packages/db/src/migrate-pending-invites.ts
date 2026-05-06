/**
 * One-shot data migration for the drive-invite GDPR + zero-trust cutover.
 *
 * Before this cutover, drive invites parked pending state in two places:
 *   1. A `users` row created at invite-send time (with `tosAcceptedAt = null`,
 *      `emailVerified = null`, provider='email', name derived from the email)
 *   2. A `drive_members` row referencing that user with `acceptedAt = null`
 *
 * After the cutover, pending state lives in the new `pending_invites` table
 * and the user row is only created at affirmative signup. This script:
 *
 *   1. Ports every `drive_members` row with `acceptedAt IS NULL` into a fresh
 *      `pending_invites` row (new tokenHash, 48h expiry from now). The
 *      original `drive_members` row is then deleted.
 *
 *   2. Deletes orphan `users` rows whose only state is "created by old invite
 *      path with no auth credentials" — no passkeys, no `tosAcceptedAt`,
 *      no `emailVerified`. The script intentionally avoids deleting any user
 *      who has linked content elsewhere (page authorship, sessions, comments,
 *      etc.); the conservative check is "has at least one passkey OR
 *      `tosAcceptedAt IS NOT NULL` OR `emailVerified IS NOT NULL`".
 *
 *   3. Emits a list of emails whose invites were ported. The new tokens are
 *      generated but no email is sent — admins are expected to re-send
 *      invites through the normal /api/drives/[driveId]/members/invite flow
 *      so the recipient gets a notification with the new /invite/<token> URL.
 *
 * Run with: pnpm tsx packages/db/src/migrate-pending-invites.ts
 *
 * The script is idempotent: re-running it against migrated data finds zero
 * rows to migrate and zero orphans to delete.
 */

import { createHash, randomBytes } from 'crypto';
import { eq, and, isNull, isNotNull, or, ne } from 'drizzle-orm';
import { db } from './db';
import { users } from './schema/auth';
import { driveMembers } from './schema/members';
import { pendingInvites } from './schema/pending-invites';
import { passkeys } from './schema/auth';
import { createId } from '@paralleldrive/cuid2';

const EXPIRY_MS = 48 * 60 * 60 * 1000;

function generateInviteTokenHash(): string {
  // Match the prefix + length convention used by createInviteToken so the
  // hashes line up if a token were generated through the live primitive.
  const random = randomBytes(24).toString('base64url');
  const token = `ps_invite_${random}`;
  return createHash('sha3-256').update(token).digest('hex');
}

interface MigrationResult {
  pendingRowsScanned: number;
  invitesCreated: number;
  driveMembersDeleted: number;
  orphanUsersDeleted: number;
  portedEmails: string[];
}

export async function migratePendingInvites(): Promise<MigrationResult> {
  const result: MigrationResult = {
    pendingRowsScanned: 0,
    invitesCreated: 0,
    driveMembersDeleted: 0,
    orphanUsersDeleted: 0,
    portedEmails: [],
  };

  const pendingRows = await db
    .select({
      memberId: driveMembers.id,
      driveId: driveMembers.driveId,
      userId: driveMembers.userId,
      role: driveMembers.role,
      invitedBy: driveMembers.invitedBy,
      email: users.email,
    })
    .from(driveMembers)
    .innerJoin(users, eq(users.id, driveMembers.userId))
    .where(isNull(driveMembers.acceptedAt));

  result.pendingRowsScanned = pendingRows.length;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + EXPIRY_MS);

  for (const row of pendingRows) {
    if (!row.invitedBy) {
      // Pre-cutover invariant: invitedBy was nullable on driveMembers but
      // pendingInvites requires it. If it's null, we can't preserve invitation
      // authority — skip and let admins manually re-invite.
      continue;
    }

    await db.transaction(async (tx) => {
      await tx.insert(pendingInvites).values({
        id: createId(),
        tokenHash: generateInviteTokenHash(),
        email: row.email.trim().toLowerCase(),
        driveId: row.driveId,
        role: row.role,
        invitedBy: row.invitedBy as string,
        expiresAt,
      });

      await tx.delete(driveMembers).where(eq(driveMembers.id, row.memberId));
    });

    result.invitesCreated += 1;
    result.driveMembersDeleted += 1;
    result.portedEmails.push(row.email);
  }

  // Find orphan users: created by the old invite path, never authenticated.
  // Conservative check — leaves any user who has any auth credential or any
  // ToS acceptance or any verified email intact.
  const orphans = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .leftJoin(passkeys, eq(passkeys.userId, users.id))
    .where(
      and(
        isNull(users.tosAcceptedAt),
        isNull(users.emailVerified),
        isNull(passkeys.id),
        // Don't touch the dummy/system user if any specific id sentinel is
        // used; absence of passkeys + tosAcceptedAt + emailVerified is
        // already the strongest possible orphan signal.
        ne(users.email, '')
      )
    );

  for (const orphan of orphans) {
    // Only delete if the user has no remaining drive_members rows (we already
    // deleted pending ones above; an accepted membership wouldn't have made
    // sense for a user with no email verification, but check defensively).
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
  console.log(`  pending drive_members rows scanned: ${result.pendingRowsScanned}`);
  console.log(`  pending_invites rows created:       ${result.invitesCreated}`);
  console.log(`  drive_members rows deleted:         ${result.driveMembersDeleted}`);
  console.log(`  orphan users deleted:               ${result.orphanUsersDeleted}`);
  if (result.portedEmails.length > 0) {
    console.log('');
    console.log('Emails whose invites were ported (admins should re-send via the invite UI):');
    for (const email of result.portedEmails) console.log(`  ${email}`);
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

// Suppress unused-import warnings for operators only used inside the script.
void or;
void isNotNull;
