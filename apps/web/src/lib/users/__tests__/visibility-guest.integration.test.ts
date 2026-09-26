/**
 * callerCanViewUser against a real Postgres: a GUEST row (a redeemed page share
 * link) is not a shared context. A guest cannot resolve the drive's people by
 * it, and they cannot resolve the guest — the unit test mocks every operator
 * and so cannot see the role predicate do anything.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { userProfiles } from '@pagespace/db/schema/members';
import { createId } from '@paralleldrive/cuid2';
import { factories } from '@pagespace/db/test/factories';
import { ensureTestDb } from '@/test/ensure-test-db';
import { callerCanViewUser, searchRelatedProfilesByName } from '../visibility';

const seededUserIds: string[] = [];

async function seedUser() {
  const user = await factories.createUser();
  seededUserIds.push(user.id);
  return user;
}

beforeAll(async () => {
  await ensureTestDb();
});

afterAll(async () => {
  if (seededUserIds.length === 0) return;
  await db.delete(users).where(inArray(users.id, seededUserIds));
});

describe('callerCanViewUser across a GUEST row (integration)', () => {
  it('opens no shared context between a guest and the drive owner or members, in either direction', async () => {
    const owner = await seedUser();
    const member = await seedUser();
    const guest = await seedUser();
    const drive = await factories.createDrive(owner.id);
    await factories.createDriveMember(drive.id, member.id);
    await factories.createDriveMember(drive.id, guest.id, { role: 'GUEST' });

    // Control: accepted co-members do share context.
    expect(await callerCanViewUser(member.id, owner.id)).toBe(true);

    expect(await callerCanViewUser(guest.id, owner.id)).toBe(false);
    expect(await callerCanViewUser(guest.id, member.id)).toBe(false);
    expect(await callerCanViewUser(owner.id, guest.id)).toBe(false);
    expect(await callerCanViewUser(member.id, guest.id)).toBe(false);
  });

  it('does not let two guests of one drive see each other', async () => {
    const owner = await seedUser();
    const g1 = await seedUser();
    const g2 = await seedUser();
    const drive = await factories.createDrive(owner.id);
    await factories.createDriveMember(drive.id, g1.id, { role: 'GUEST' });
    await factories.createDriveMember(drive.id, g2.id, { role: 'GUEST' });

    expect(await callerCanViewUser(g1.id, g2.id)).toBe(false);
  });
});

describe('searchRelatedProfilesByName across a GUEST row (integration)', () => {
  // The search filters candidates inside the database (memberOfAnyDriveCondition on the org-wallets
  // branch), not through callerCanViewUser: this proves that SQL predicate leaves a guest out too.
  it('finds a real co-member by name but never a guest, and a guest finds no one through the drive', async () => {
    const owner = await seedUser();
    const member = await seedUser();
    const guest = await seedUser();
    const drive = await factories.createDrive(owner.id);
    await factories.createDriveMember(drive.id, member.id);
    await factories.createDriveMember(drive.id, guest.id, { role: 'GUEST' });
    const tag = createId().slice(0, 10);
    await db.update(users).set({ emailVerified: new Date() }).where(inArray(users.id, [owner.id, member.id, guest.id]));
    await db.insert(userProfiles).values([
      { userId: member.id, username: `m-${tag}`, displayName: `Member ${tag}`, updatedAt: new Date() },
      { userId: guest.id, username: `g-${tag}`, displayName: `Guest ${tag}`, updatedAt: new Date() },
      { userId: owner.id, username: `o-${tag}`, displayName: `Owner ${tag}`, updatedAt: new Date() },
    ]);

    const byOwner = (await searchRelatedProfilesByName(owner.id, `%${tag}%`, 10)).map((p) => p.userId);
    // Control: the accepted co-member is found by the very same query.
    expect(byOwner).toContain(member.id);
    expect(byOwner).not.toContain(guest.id);
    expect((await searchRelatedProfilesByName(member.id, `%${tag}%`, 10)).map((p) => p.userId)).not.toContain(guest.id);
    expect(await searchRelatedProfilesByName(guest.id, `%${tag}%`, 10)).toEqual([]);
  });
});
