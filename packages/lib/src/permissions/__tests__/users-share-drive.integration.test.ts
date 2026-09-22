/**
 * Integration test: `usersShareDrive` (DM eligibility between drive co-members)
 * against a real Postgres.
 *
 * Requires a running Postgres database with the latest migrations applied.
 * Run via:
 *   ./scripts/test-with-db.sh
 *   bun run --filter '@pagespace/lib' test -- src/permissions/__tests__/users-share-drive.integration.test.ts
 *
 * A pending, unaccepted invitation is not an established shared context
 * (apps/web/src/lib/users/visibility.ts): it must not let the invitee open a
 * DM with the drive's owner or members, nor let them open one with the
 * invitee. The unit test mocks the query builder and so cannot see the
 * acceptedAt predicate do anything; this is the round trip that can.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { factories } from '@pagespace/db/test/factories';
import { db } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { usersShareDrive } from '../permissions';

const seededUserIds: string[] = [];

async function seedUser() {
  const user = await factories.createUser();
  seededUserIds.push(user.id);
  return user;
}

afterAll(async () => {
  if (seededUserIds.length === 0) return;
  await db.delete(users).where(inArray(users.id, seededUserIds));
});

describe('usersShareDrive (integration)', () => {
  it('lets accepted co-members, and a member and the owner, DM each other', async () => {
    const owner = await seedUser();
    const a = await seedUser();
    const b = await seedUser();
    const drive = await factories.createDrive(owner.id);
    await factories.createDriveMember(drive.id, a.id);
    await factories.createDriveMember(drive.id, b.id);

    expect(await usersShareDrive(a.id, b.id)).toBe(true);
    expect(await usersShareDrive(b.id, a.id)).toBe(true);
    expect(await usersShareDrive(a.id, owner.id)).toBe(true);
    expect(await usersShareDrive(owner.id, a.id)).toBe(true);
  });

  it('does not let a pending invitee DM the owner or an accepted member, in either direction', async () => {
    const owner = await seedUser();
    const member = await seedUser();
    const pending = await seedUser();
    const drive = await factories.createDrive(owner.id);
    await factories.createDriveMember(drive.id, member.id);
    await factories.createDriveMember(drive.id, pending.id, { acceptedAt: null });

    expect(await usersShareDrive(pending.id, member.id)).toBe(false);
    expect(await usersShareDrive(member.id, pending.id)).toBe(false);
    expect(await usersShareDrive(pending.id, owner.id)).toBe(false);
    expect(await usersShareDrive(owner.id, pending.id)).toBe(false);
  });

  it('does not let two pending invitees of the same drive DM each other', async () => {
    const owner = await seedUser();
    const p1 = await seedUser();
    const p2 = await seedUser();
    const drive = await factories.createDrive(owner.id);
    await factories.createDriveMember(drive.id, p1.id, { acceptedAt: null });
    await factories.createDriveMember(drive.id, p2.id, { acceptedAt: null });

    expect(await usersShareDrive(p1.id, p2.id)).toBe(false);
  });
});
