/**
 * consumeInviteAndCreateMembership against a real Postgres: accepting a drive
 * invite upgrades a GUEST row (a redeemed page share link) in place, and still
 * refuses — without consuming the invite — when a real membership exists.
 *
 * The unit test pins the shape of the guarded upsert; only a real database can
 * say that `setWhere role = 'GUEST'` really leaves a MEMBER row untouched and
 * returns nothing for it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { driveMembers } from '@pagespace/db/schema/members';
import { pendingInvites } from '@pagespace/db/schema/pending-invites';
import { factories } from '@pagespace/db/test/factories';
import { createId } from '@paralleldrive/cuid2';
import { ensureTestDb } from '@/test/ensure-test-db';
import { driveInviteRepository } from '../drive-invite-repository';

const seededUserIds: string[] = [];

async function seedUser() {
  const user = await factories.createUser();
  seededUserIds.push(user.id);
  return user;
}

async function seedInvite(driveId: string, invitedBy: string, role: 'ADMIN' | 'MEMBER') {
  const [invite] = await db
    .insert(pendingInvites)
    .values({ tokenHash: createId(), email: `${createId()}@example.com`, driveId, role, invitedBy })
    .returning();
  return invite;
}

async function rowOf(driveId: string, userId: string) {
  const [row] = await db
    .select({ id: driveMembers.id, role: driveMembers.role, invitedBy: driveMembers.invitedBy })
    .from(driveMembers)
    .where(and(eq(driveMembers.driveId, driveId), eq(driveMembers.userId, userId)));
  return row;
}

beforeAll(async () => {
  await ensureTestDb();
});

afterAll(async () => {
  if (seededUserIds.length === 0) return;
  await db.delete(users).where(inArray(users.id, seededUserIds));
});

describe('consumeInviteAndCreateMembership over a GUEST row (integration)', () => {
  it('upgrades the guest to the invited role and consumes the invite', async () => {
    const owner = await seedUser();
    const guest = await seedUser();
    const drive = await factories.createDrive(owner.id);
    const guestRow = await factories.createDriveMember(drive.id, guest.id, { role: 'GUEST' });
    const invite = await seedInvite(drive.id, owner.id, 'ADMIN');

    const result = await driveInviteRepository.consumeInviteAndCreateMembership({
      inviteId: invite.id,
      driveId: drive.id,
      userId: guest.id,
      role: 'ADMIN',
      customRoleId: null,
      invitedBy: owner.id,
      acceptedAt: new Date(),
    });

    expect(result).toEqual({ ok: true, memberId: guestRow.id });
    expect(await rowOf(drive.id, guest.id)).toEqual({ id: guestRow.id, role: 'ADMIN', invitedBy: owner.id });
    const [consumed] = await db.select().from(pendingInvites).where(eq(pendingInvites.id, invite.id));
    expect(consumed.consumedAt).not.toBeNull();
  });

  it('leaves a real membership untouched, answers ALREADY_MEMBER and does not burn the invite', async () => {
    const owner = await seedUser();
    const member = await seedUser();
    const drive = await factories.createDrive(owner.id);
    const memberRow = await factories.createDriveMember(drive.id, member.id, { role: 'MEMBER' });
    const invite = await seedInvite(drive.id, owner.id, 'ADMIN');

    const result = await driveInviteRepository.consumeInviteAndCreateMembership({
      inviteId: invite.id,
      driveId: drive.id,
      userId: member.id,
      role: 'ADMIN',
      customRoleId: null,
      invitedBy: owner.id,
      acceptedAt: new Date(),
    });

    expect(result).toEqual({ ok: false, reason: 'ALREADY_MEMBER' });
    expect((await rowOf(drive.id, member.id))?.role).toBe('MEMBER');
    expect((await rowOf(drive.id, member.id))?.id).toBe(memberRow.id);
    const [kept] = await db.select().from(pendingInvites).where(eq(pendingInvites.id, invite.id));
    expect(kept.consumedAt).toBeNull();
  });
});
