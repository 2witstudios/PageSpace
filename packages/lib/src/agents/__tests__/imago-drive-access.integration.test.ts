/**
 * The per-drive Imago setting against a REAL Postgres — no fake DB, no vi.mock.
 *
 * IMG-10.10: Imago acts with its owner's own reach, so the setting is the
 * user's EXCLUSION from that reach: on by default in every drive the user can
 * access, off keeps Imago out of that drive for that user. Any user who can
 * access a drive sets only their own choice there; it never creates a drive
 * grant, and an off survives everything that recreates the agent.
 *
 * Requires DATABASE_URL → a migrated Postgres. FAILS LOUDLY when none is
 * reachable; local runs without a database opt out with ALLOW_SKIP_DB_TESTS=1.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@pagespace/db/db';
import { and, eq, inArray, ne } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { driveAgentMembers } from '@pagespace/db/schema/members';
import { imagoDriveAccess } from '@pagespace/db/schema/imago-drive-access';
import { userBuiltinAgents } from '@pagespace/db/schema/user-builtin-agents';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { provisionImagoAgents } from '../provision-imago-agents';
import { getImagoDriveAccess, setImagoDriveAccess } from '../imago-drive-access';
import { imagoExcludedDriveIds } from '../imago-reach';
import { provisionHomeDriveIfNeeded } from '../../onboarding/home-drive';
import { createDrive, transferDriveOwnership } from '../../services/drive-service';

let dbAvailable = false;

beforeAll(async () => {
  try {
    await db.select().from(pages).limit(1);
    dbAvailable = true;
  } catch (error) {
    requireDb('imago-drive-access.integration.test.ts', error);
    dbAvailable = false;
  }
});

async function storedChoice(userId: string, driveId: string) {
  const [row] = await db
    .select({ enabled: imagoDriveAccess.enabled })
    .from(imagoDriveAccess)
    .where(and(eq(imagoDriveAccess.userId, userId), eq(imagoDriveAccess.driveId, driveId)));
  return row?.enabled ?? null;
}

/** Every membership of the user's Imago pages outside their own Home drive. */
async function imagoGrantsOf(userId: string) {
  const pointers = await db
    .select({ pageId: userBuiltinAgents.pageId })
    .from(userBuiltinAgents)
    .where(eq(userBuiltinAgents.userId, userId));
  if (pointers.length === 0) return [];
  return db
    .select({ driveId: driveAgentMembers.driveId })
    .from(driveAgentMembers)
    .innerJoin(pages, eq(pages.id, driveAgentMembers.agentPageId))
    .where(and(
      inArray(driveAgentMembers.agentPageId, pointers.map((row) => row.pageId)),
      ne(pages.driveId, driveAgentMembers.driveId),
    ));
}

/**
 * A user with Home and Imago, and every way to reach someone else's drive:
 * an owned drive, ADMIN, MEMBER and GUEST memberships, a page share only, a
 * pending invite, and a drive they have nothing to do with.
 */
async function world() {
  const user = await factories.createUser();
  const other = await factories.createUser();
  await provisionHomeDriveIfNeeded(user.id);
  const [home] = await db.select().from(userBuiltinAgents).where(eq(userBuiltinAgents.userId, user.id));
  const [homePage] = await db.select({ driveId: pages.driveId }).from(pages).where(eq(pages.id, home.pageId));
  const owned = await factories.createDrive(user.id, { name: 'Owned' });
  const admin = await factories.createDrive(other.id, { name: 'Admin of' });
  await factories.createDriveMember(admin.id, user.id, { role: 'ADMIN', acceptedAt: new Date() });
  const member = await factories.createDrive(other.id, { name: 'Member of' });
  await factories.createDriveMember(member.id, user.id, { role: 'MEMBER', acceptedAt: new Date() });
  const shared = await factories.createDrive(other.id, { name: 'Page share only' });
  const sharedPage = await factories.createPage(shared.id, { title: 'Shared', type: 'DOCUMENT' });
  await factories.createPagePermission(sharedPage.id, user.id);
  const pending = await factories.createDrive(other.id, { name: 'Pending invite' });
  await factories.createDriveMember(pending.id, user.id, { role: 'ADMIN', acceptedAt: null });
  const stranger = await factories.createDrive(other.id, { name: 'Stranger' });
  return { user, other, homeDriveId: homePage.driveId, owned, admin, member, shared, pending, stranger };
}

describe('getImagoDriveAccess (real Postgres)', () => {
  it('given any drive the user can access and no stored choice, should report Imago on (the default)', async () => {
    if (!dbAvailable) return;
    const w = await world();

    for (const drive of [w.owned, w.admin, w.member, w.shared]) {
      expect(await getImagoDriveAccess(w.user.id, drive.id)).toEqual({ ok: true, access: { driveId: drive.id, enabled: true } });
    }
  });

  it('given a drive the user cannot access (a stranger, or a pending invite), should refuse with 403', async () => {
    if (!dbAvailable) return;
    const w = await world();

    expect(await getImagoDriveAccess(w.user.id, w.stranger.id)).toMatchObject({ ok: false, status: 403 });
    expect(await getImagoDriveAccess(w.user.id, w.pending.id)).toMatchObject({ ok: false, status: 403 });
  });

  it('given an opt-out stored by the earlier model, should keep its meaning: off stays off', async () => {
    if (!dbAvailable) return;
    const w = await world();
    await db.insert(imagoDriveAccess).values({ userId: w.user.id, driveId: w.member.id, enabled: false });

    expect(await getImagoDriveAccess(w.user.id, w.member.id)).toMatchObject({ ok: true, access: { enabled: false } });
    expect(await imagoExcludedDriveIds(w.user.id)).toEqual(new Set([w.member.id]));
  });
});

describe('setImagoDriveAccess (real Postgres)', () => {
  it('given any user who can access the drive — owner, admin, member, page share — should store their own exclusion', async () => {
    if (!dbAvailable) return;
    const w = await world();

    for (const drive of [w.owned, w.admin, w.member, w.shared]) {
      expect(await setImagoDriveAccess(w.user.id, drive.id, false)).toEqual({ ok: true, access: { driveId: drive.id, enabled: false } });
      expect(await storedChoice(w.user.id, drive.id)).toBe(false);
    }
    expect(await imagoExcludedDriveIds(w.user.id)).toEqual(new Set([w.owned.id, w.admin.id, w.member.id, w.shared.id]));
  });

  it('given a drive turned off and back on, should let Imago back in', async () => {
    if (!dbAvailable) return;
    const w = await world();
    await setImagoDriveAccess(w.user.id, w.member.id, false);

    expect(await setImagoDriveAccess(w.user.id, w.member.id, true)).toMatchObject({ ok: true, access: { enabled: true } });
    expect(await imagoExcludedDriveIds(w.user.id)).toEqual(new Set());
  });

  it('given one user keeping Imago out of a shared drive, should leave every other user\'s Imago there untouched', async () => {
    if (!dbAvailable) return;
    const w = await world();
    await provisionHomeDriveIfNeeded(w.other.id);

    await setImagoDriveAccess(w.user.id, w.member.id, false);

    expect(await storedChoice(w.other.id, w.member.id)).toBeNull();
    expect(await getImagoDriveAccess(w.other.id, w.member.id)).toMatchObject({ ok: true, access: { enabled: true } });
  });

  it('given a drive the user cannot access, should return 403 and store nothing', async () => {
    if (!dbAvailable) return;
    const w = await world();

    for (const drive of [w.stranger, w.pending]) {
      expect(await setImagoDriveAccess(w.user.id, drive.id, false)).toMatchObject({ ok: false, status: 403 });
      expect(await storedChoice(w.user.id, drive.id)).toBeNull();
    }
  });

  it('given the user\'s own Home drive, should refuse either way: Imago lives there', async () => {
    if (!dbAvailable) return;
    const w = await world();

    expect(await setImagoDriveAccess(w.user.id, w.homeDriveId, false)).toMatchObject({ ok: false, status: 403 });
    expect(await setImagoDriveAccess(w.user.id, w.homeDriveId, true)).toMatchObject({ ok: false, status: 403 });
    expect(await storedChoice(w.user.id, w.homeDriveId)).toBeNull();
  });

  it('given the setting either way, should never create a drive grant for Imago', async () => {
    if (!dbAvailable) return;
    const w = await world();

    for (const drive of [w.owned, w.admin, w.member]) {
      await setImagoDriveAccess(w.user.id, drive.id, false);
      await setImagoDriveAccess(w.user.id, drive.id, true);
    }

    expect(await imagoGrantsOf(w.user.id)).toEqual([]);
  });
});

describe('the exclusion outlives the agent page (real Postgres)', () => {
  it('given Imago deleted and recreated at sign-in, should keep the drive off', async () => {
    if (!dbAvailable) return;
    const w = await world();
    await setImagoDriveAccess(w.user.id, w.member.id, false);
    const [pointer] = await db.select().from(userBuiltinAgents).where(eq(userBuiltinAgents.userId, w.user.id));
    await db.delete(pages).where(eq(pages.id, pointer.pageId));

    await provisionHomeDriveIfNeeded(w.user.id);

    expect(await getImagoDriveAccess(w.user.id, w.member.id)).toMatchObject({ ok: true, access: { enabled: false } });
    expect(await imagoGrantsOf(w.user.id)).toEqual([]);
  });

  it('given a drive the user creates, should grant Imago nothing there: it is on by default through the user', async () => {
    if (!dbAvailable) return;
    const w = await world();

    const created = await createDrive(w.user.id, { name: 'Brand new' });

    expect(await getImagoDriveAccess(w.user.id, created.id)).toMatchObject({ ok: true, access: { enabled: true } });
    expect(await imagoGrantsOf(w.user.id)).toEqual([]);
  });

  it('given ownership transferred, should keep each user\'s own choice for the drive', async () => {
    if (!dbAvailable) return;
    const w = await world();
    await provisionHomeDriveIfNeeded(w.other.id);
    await factories.createDriveMember(w.owned.id, w.other.id, { role: 'ADMIN', acceptedAt: new Date() });
    await setImagoDriveAccess(w.user.id, w.owned.id, false);

    await transferDriveOwnership(w.owned.id, w.user.id, w.other.id);

    expect(await storedChoice(w.user.id, w.owned.id)).toBe(false);
    expect(await storedChoice(w.other.id, w.owned.id)).toBeNull();
    expect(await getImagoDriveAccess(w.other.id, w.owned.id)).toMatchObject({ ok: true, access: { enabled: true } });
  });
});

describe('a turn-off racing a sign-in that recreates Imago (real concurrent Postgres)', () => {
  const ROUNDS = 12;
  // Twelve sequential rounds of real setup, provisioning and toggling; the
  // work is real, not a hang, so it gets an explicit budget.
  const RACE_ROUNDS_TIMEOUT_MS = 30_000;

  it(`given ${ROUNDS} rounds of sign-in and turn-off fired together, should end off with no grant every time`, async () => {
    if (!dbAvailable) return;
    const failures: string[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      const user = await factories.createUser();
      await factories.createDrive(user.id, { kind: 'HOME', name: 'Home', slug: 'home' });
      const off = await factories.createDrive(user.id, { name: 'Switched off' });
      const { agents } = await provisionImagoAgents(user.id);
      await db.delete(pages).where(eq(pages.id, agents.imago));

      const [, toggled] = await Promise.all([
        provisionHomeDriveIfNeeded(user.id),
        setImagoDriveAccess(user.id, off.id, false),
      ]);
      expect(toggled.ok).toBe(true);

      const stored = await storedChoice(user.id, off.id);
      const grants = await imagoGrantsOf(user.id);
      if (grants.length > 0 || stored !== false) failures.push(`round ${round}: grants=${grants.length} stored=${stored}`);
    }
    expect(failures).toEqual([]);
  }, RACE_ROUNDS_TIMEOUT_MS);
});
