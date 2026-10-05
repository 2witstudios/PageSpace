/**
 * The per-drive Imago access toggle against a REAL Postgres — no fake DB, no
 * vi.mock.
 *
 * DEC-2: a user's Imago agents reach a drive only through `drive_agent_members`
 * rows. The toggle reads and sets those rows for the viewer's own Imago agents
 * in one drive, and only a drive owner or admin may set it. Turning it off must
 * be authoritative: re-provisioning — including an agent that was deleted and
 * recreated — never brings Imago back into a drive the user switched off.
 *
 * Requires DATABASE_URL → a migrated Postgres. FAILS LOUDLY when none is
 * reachable; local runs without a database opt out with ALLOW_SKIP_DB_TESTS=1.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@pagespace/db/db';
import { and, eq, inArray, sql } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { driveAgentMembers, driveMembers } from '@pagespace/db/schema/members';
import { imagoDriveAccess } from '@pagespace/db/schema/imago-drive-access';
import { userBuiltinAgents } from '@pagespace/db/schema/user-builtin-agents';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { BUILTIN_AGENT_KEYS } from '../builtin-agents';
import { provisionImagoAgents, provisionImagoAgentsInTransaction } from '../provision-imago-agents';
import { getImagoDriveAccess, setImagoDriveAccess } from '../imago-drive-access';
import { grantImagoAgents, lockImagoUser } from '../grant-imago-agents';
import { provisionHomeDriveIfNeeded } from '../../onboarding/home-drive';
import { createDrive, transferDriveOwnership } from '../../services/drive-service';
import { addAgentToDrive } from '../../services/drive-agent-service';

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

async function userWithHome() {
  const user = await factories.createUser();
  const home = await factories.createDrive(user.id, { kind: 'HOME', name: 'Home', slug: 'home' });
  return { user, home };
}

async function membersIn(driveId: string, agentIds: string[]) {
  const rows = await db
    .select({ agentPageId: driveAgentMembers.agentPageId })
    .from(driveAgentMembers)
    .where(and(eq(driveAgentMembers.driveId, driveId), inArray(driveAgentMembers.agentPageId, agentIds)));
  return rows.map((row) => row.agentPageId).sort();
}

async function allRowsOf(driveId: string) {
  return db.select().from(driveAgentMembers).where(eq(driveAgentMembers.driveId, driveId));
}

function sorted(ids: readonly string[]) {
  return [...ids].sort();
}

async function setup() {
  const { user, home } = await userWithHome();
  const on = await factories.createDrive(user.id, { name: 'Stays on' });
  const off = await factories.createDrive(user.id, { name: 'Switched off' });
  const provisioned = await provisionImagoAgents(user.id);
  return { user, home, on, off, agents: provisioned.agents, ids: Object.values(provisioned.agents) };
}

describe('getImagoDriveAccess (real Postgres)', () => {
  it("given an owned drive, should report each live Imago agent's membership there in registry order", async () => {
    if (!dbAvailable) return;
    const { user, on, agents } = await setup();

    const result = await getImagoDriveAccess(user.id, on.id);

    expect(result).toEqual({
      ok: true,
      access: {
        driveId: on.id,
        enabled: true,
        agents: BUILTIN_AGENT_KEYS.map((key) => ({ key, agentPageId: agents[key], isMember: true })),
      },
    });
  });

  it('given a drive admin whose agents are not members, should report the toggle off', async () => {
    if (!dbAvailable) return;
    const { user } = await setup();
    const owner = await factories.createUser();
    const shared = await factories.createDrive(owner.id, { name: 'Shared' });
    await factories.createDriveMember(shared.id, user.id, { role: 'ADMIN' });

    const result = await getImagoDriveAccess(user.id, shared.id);

    expect(result.ok && result.access.enabled).toBe(false);
    expect(result.ok && result.access.agents.every((agent) => !agent.isMember)).toBe(true);
  });

  it('given a plain member, a guest or a stranger, should refuse with 403', async () => {
    if (!dbAvailable) return;
    const { on } = await setup();
    const member = await factories.createUser();
    const guest = await factories.createUser();
    const stranger = await factories.createUser();
    await factories.createDriveMember(on.id, member.id, { role: 'MEMBER' });
    await factories.createDriveMember(on.id, guest.id, { role: 'GUEST' });

    for (const viewer of [member, guest, stranger]) {
      const result = await getImagoDriveAccess(viewer.id, on.id);
      expect(result).toMatchObject({ ok: false, status: 403 });
    }
  });

  it('given a pending (unaccepted) admin invite, should refuse with 403', async () => {
    if (!dbAvailable) return;
    const { on } = await setup();
    const invited = await factories.createUser();
    await factories.createDriveMember(on.id, invited.id, { role: 'ADMIN', acceptedAt: null });

    expect(await getImagoDriveAccess(invited.id, on.id)).toMatchObject({ ok: false, status: 403 });
  });
});

describe('setImagoDriveAccess (real Postgres)', () => {
  it("given enabled=false, should remove only the viewer's Imago agents from that drive", async () => {
    if (!dbAvailable) return;
    const { user, home, on, off, ids } = await setup();
    const classic = await factories.createPage(home.id, { title: 'Classic agent', type: 'AI_CHAT' });
    expect((await addAgentToDrive({ actingUserId: user.id, agentPageId: classic.id, driveId: off.id })).ok).toBe(true);

    const result = await setImagoDriveAccess(user.id, off.id, false);

    expect(result.ok && result.access.enabled).toBe(false);
    expect(await membersIn(off.id, ids)).toEqual([]);
    expect(await membersIn(off.id, [classic.id])).toEqual([classic.id]);
    expect(await membersIn(on.id, ids)).toEqual(sorted(ids));
    expect(await membersIn(home.id, ids)).toEqual(sorted(ids));
  });

  it('given enabled=true, should grant every live Imago agent MEMBER through the membership seam', async () => {
    if (!dbAvailable) return;
    const { user, off, ids } = await setup();
    await setImagoDriveAccess(user.id, off.id, false);

    const result = await setImagoDriveAccess(user.id, off.id, true);

    expect(result.ok && result.access.enabled).toBe(true);
    const rows = await allRowsOf(off.id);
    expect(sorted(rows.map((row) => row.agentPageId))).toEqual(sorted(ids));
    for (const row of rows) expect(row).toMatchObject({ role: 'MEMBER', addedBy: user.id, customRoleId: null });
  });

  it('given the same value twice, should be idempotent', async () => {
    if (!dbAvailable) return;
    const { user, on, off, ids } = await setup();

    expect((await setImagoDriveAccess(user.id, on.id, true)).ok).toBe(true);
    expect((await setImagoDriveAccess(user.id, off.id, false)).ok).toBe(true);
    expect((await setImagoDriveAccess(user.id, off.id, false)).ok).toBe(true);

    expect(await membersIn(on.id, ids)).toEqual(sorted(ids));
    expect(await membersIn(off.id, ids)).toEqual([]);
  });

  it("given a drive admin who does not own the drive, should toggle the admin's own agents and no one else's", async () => {
    if (!dbAvailable) return;
    const { user: owner, on, ids: ownerIds } = await setup();
    const { user: admin } = await userWithHome();
    const adminIds = Object.values((await provisionImagoAgents(admin.id)).agents);
    await factories.createDriveMember(on.id, admin.id, { role: 'ADMIN' });
    expect(owner.id).not.toBe(admin.id);

    expect((await setImagoDriveAccess(admin.id, on.id, true)).ok).toBe(true);
    expect(await membersIn(on.id, adminIds)).toEqual(sorted(adminIds));

    expect((await setImagoDriveAccess(admin.id, on.id, false)).ok).toBe(true);
    expect(await membersIn(on.id, adminIds)).toEqual([]);
    expect(await membersIn(on.id, ownerIds)).toEqual(sorted(ownerIds));
  });

  it('given a viewer without grant rights, should return 403 and change nothing', async () => {
    if (!dbAvailable) return;
    const { on } = await setup();
    const { user: member } = await userWithHome();
    const memberIds = Object.values((await provisionImagoAgents(member.id)).agents);
    await factories.createDriveMember(on.id, member.id, { role: 'MEMBER' });
    const before = await allRowsOf(on.id);

    expect(await setImagoDriveAccess(member.id, on.id, true)).toMatchObject({ ok: false, status: 403 });
    expect(await setImagoDriveAccess(member.id, on.id, false)).toMatchObject({ ok: false, status: 403 });

    expect(await membersIn(on.id, memberIds)).toEqual([]);
    expect(sorted((await allRowsOf(on.id)).map((row) => row.id))).toEqual(sorted(before.map((row) => row.id)));
  });

  it("given a stranger targeting someone else's drive, should return 403 and leave the owner's agents in place", async () => {
    if (!dbAvailable) return;
    const { on, ids } = await setup();
    const { user: stranger } = await userWithHome();
    await provisionImagoAgents(stranger.id);

    expect(await setImagoDriveAccess(stranger.id, on.id, false)).toMatchObject({ ok: false, status: 403 });
    expect(await membersIn(on.id, ids)).toEqual(sorted(ids));
  });

  it("given the Home drive, should refuse either way and keep the agents' native Home membership", async () => {
    if (!dbAvailable) return;
    const { user, home, ids } = await setup();

    expect(await setImagoDriveAccess(user.id, home.id, false)).toMatchObject({ ok: false, status: 403 });
    expect(await setImagoDriveAccess(user.id, home.id, true)).toMatchObject({ ok: false, status: 403 });

    expect(await membersIn(home.id, ids)).toEqual(sorted(ids));
  });

  it('given enabled=true for a viewer with no Imago agents, should return 409 and grant nothing', async () => {
    if (!dbAvailable) return;
    const user = await factories.createUser();
    const drive = await factories.createDrive(user.id, { name: 'No agents' });

    expect(await setImagoDriveAccess(user.id, drive.id, true)).toMatchObject({ ok: false, status: 409 });
    expect(await allRowsOf(drive.id)).toEqual([]);
  });
});

describe('Imago access off is authoritative across re-provisioning (real Postgres)', () => {
  it('given sign-in after switching a drive off, should not re-grant it', async () => {
    if (!dbAvailable) return;
    const { user, on, off, ids } = await setup();
    await setImagoDriveAccess(user.id, off.id, false);

    await provisionHomeDriveIfNeeded(user.id);
    await provisionImagoAgents(user.id);

    expect(await membersIn(off.id, ids)).toEqual([]);
    expect(await membersIn(on.id, ids)).toEqual(sorted(ids));
  });

  it('given an agent permanently deleted and recreated, should grant the new page where Imago is on and not where it is off', async () => {
    if (!dbAvailable) return;
    const { user, on, off, agents } = await setup();
    await setImagoDriveAccess(user.id, off.id, false);
    await db.delete(pages).where(eq(pages.id, agents['imago-planner']));

    const second = await provisionHomeDriveIfNeeded(user.id).then(() => provisionImagoAgents(user.id));
    const recreated = second.agents['imago-planner'];

    expect(recreated).not.toBe(agents['imago-planner']);
    expect(await membersIn(off.id, [recreated])).toEqual([]);
    expect(await membersIn(on.id, [recreated])).toEqual([recreated]);
  });

  it('given an agent trashed and recreated at sign-in, should follow the drives Imago is on', async () => {
    if (!dbAvailable) return;
    const { user, on, off, agents } = await setup();
    await setImagoDriveAccess(user.id, off.id, false);
    await db.update(pages).set({ isTrashed: true, trashedAt: new Date() }).where(eq(pages.id, agents.imago));

    await provisionHomeDriveIfNeeded(user.id);
    const second = await provisionImagoAgents(user.id);
    const recreated = second.agents.imago;

    expect(recreated).not.toBe(agents.imago);
    expect(await membersIn(off.id, [recreated])).toEqual([]);
    expect(await membersIn(on.id, [recreated])).toEqual([recreated]);
  });

  it('given every agent trashed and recreated, should take the trashed pages as the record of where Imago was on', async () => {
    if (!dbAvailable) return;
    const { user, on, off, ids } = await setup();
    await setImagoDriveAccess(user.id, off.id, false);
    await db.update(pages).set({ isTrashed: true, trashedAt: new Date() }).where(inArray(pages.id, ids));

    await provisionHomeDriveIfNeeded(user.id);
    const second = await provisionImagoAgents(user.id);
    const recreated = Object.values(second.agents);

    expect(recreated.some((id) => ids.includes(id))).toBe(false);
    expect(await membersIn(off.id, recreated)).toEqual([]);
    expect(await membersIn(on.id, recreated)).toEqual(sorted(recreated));
  });

  it('given a drive switched back on, should grant a recreated agent there too', async () => {
    if (!dbAvailable) return;
    const { user, off, agents } = await setup();
    await setImagoDriveAccess(user.id, off.id, false);
    await setImagoDriveAccess(user.id, off.id, true);
    await db.delete(pages).where(eq(pages.id, agents['imago-researcher']));

    const second = await provisionImagoAgents(user.id);

    expect(await membersIn(off.id, [second.agents['imago-researcher']])).toEqual([second.agents['imago-researcher']]);
  });

  it('given a drive created after switching another off, should still auto-grant the new drive', async () => {
    if (!dbAvailable) return;
    const { user, off, ids } = await setup();
    await setImagoDriveAccess(user.id, off.id, false);

    const fresh = await createDrive(user.id, { name: 'Fresh' });

    expect(await membersIn(fresh.id, ids)).toEqual(sorted(ids));
    expect(await membersIn(off.id, ids)).toEqual([]);
  });

  it('given a first provisioning with no prior agents, should still grant every owned STANDARD drive', async () => {
    if (!dbAvailable) return;
    const { user } = await userWithHome();
    const a = await factories.createDrive(user.id, { name: 'A' });
    const b = await factories.createDrive(user.id, { name: 'B' });

    const ids = Object.values((await provisionImagoAgents(user.id)).agents);

    expect(await membersIn(a.id, ids)).toEqual(sorted(ids));
    expect(await membersIn(b.id, ids)).toEqual(sorted(ids));
  });
});

async function storedChoice(userId: string, driveId: string) {
  const [row] = await db
    .select({ enabled: imagoDriveAccess.enabled })
    .from(imagoDriveAccess)
    .where(and(eq(imagoDriveAccess.userId, userId), eq(imagoDriveAccess.driveId, driveId)));
  return row?.enabled ?? null;
}

/** Every page that was ever one of the user's Imago agents and is a member of `driveId` (Home pages included). */
async function imagoPagesIn(driveId: string, pageIds: readonly string[]) {
  return membersIn(driveId, [...pageIds]);
}

describe('IMG-4.6a: the opt-out is stored and outlives the agent pages (real Postgres)', () => {
  it('given enabled=false, should store the opt-out for that user and drive only', async () => {
    if (!dbAvailable) return;
    const { user, on, off } = await setup();

    await setImagoDriveAccess(user.id, off.id, false);

    expect(await storedChoice(user.id, off.id)).toBe(false);
    expect(await storedChoice(user.id, on.id)).toBeNull();
  });

  it('given a drive switched back on, should store the choice as on', async () => {
    if (!dbAvailable) return;
    const { user, off } = await setup();
    await setImagoDriveAccess(user.id, off.id, false);

    await setImagoDriveAccess(user.id, off.id, true);

    expect(await storedChoice(user.id, off.id)).toBe(true);
  });

  it('given all three agent pages permanently deleted, should not re-grant the switched-off drive at sign-in', async () => {
    if (!dbAvailable) return;
    const { user, on, off, ids } = await setup();
    await setImagoDriveAccess(user.id, off.id, false);
    await db.delete(pages).where(inArray(pages.id, ids));

    await provisionHomeDriveIfNeeded(user.id);
    const recreated = Object.values((await provisionImagoAgents(user.id)).agents);

    expect(recreated.some((id) => ids.includes(id))).toBe(false);
    expect(await membersIn(off.id, recreated)).toEqual([]);
    expect(await membersIn(on.id, recreated)).toEqual(sorted(recreated));
    expect(await getImagoDriveAccess(user.id, off.id)).toMatchObject({ ok: true, access: { enabled: false } });
  });

  it('given all three agent pages permanently deleted, should not re-grant the switched-off drive through the backfill provisioner', async () => {
    if (!dbAvailable) return;
    const { user, on, off, ids } = await setup();
    await setImagoDriveAccess(user.id, off.id, false);
    await db.delete(pages).where(inArray(pages.id, ids));

    const recreated = Object.values((await provisionImagoAgents(user.id)).agents);

    expect(await membersIn(off.id, recreated)).toEqual([]);
    expect(await membersIn(on.id, recreated)).toEqual(sorted(recreated));
  });

  it('given the drive-creation grant aimed at a switched-off drive, should grant nothing there', async () => {
    if (!dbAvailable) return;
    const { user, off, ids } = await setup();
    await setImagoDriveAccess(user.id, off.id, false);

    const outcomes = await grantImagoAgents(user.id, { driveIds: [off.id] });

    expect(outcomes).toEqual([]);
    expect(await membersIn(off.id, ids)).toEqual([]);
  });
});

describe('IMG-4.6a: turning a drive off reaches superseded trashed agent pages (real Postgres)', () => {
  it('given a trashed agent replaced at sign-in and then the drive switched off, should leave the old page no way back in', async () => {
    if (!dbAvailable) return;
    const { user, home, off, agents } = await setup();
    const old = agents.imago;
    await db.update(pages).set({ isTrashed: true, trashedAt: new Date() }).where(eq(pages.id, old));
    await provisionHomeDriveIfNeeded(user.id);

    await setImagoDriveAccess(user.id, off.id, false);
    // The user restores the superseded page from the trash.
    await db.update(pages).set({ isTrashed: false, trashedAt: null }).where(eq(pages.id, old));

    expect(await imagoPagesIn(off.id, [old])).toEqual([]);
    // Its native Home membership is untouched.
    expect(await imagoPagesIn(home.id, [old])).toEqual([old]);
  });

  it('given a trashed agent not yet replaced, should revoke its membership when the drive is switched off', async () => {
    if (!dbAvailable) return;
    const { user, off, agents } = await setup();
    const trashed = agents['imago-planner'];
    await db.update(pages).set({ isTrashed: true, trashedAt: new Date() }).where(eq(pages.id, trashed));

    await setImagoDriveAccess(user.id, off.id, false);
    await db.update(pages).set({ isTrashed: false, trashedAt: null }).where(eq(pages.id, trashed));

    expect(await imagoPagesIn(off.id, [trashed])).toEqual([]);
  });
});

describe('IMG-4.6a: a drive the user administers but does not own (real Postgres)', () => {
  async function adminSetup() {
    const { user: owner } = await userWithHome();
    const team = await factories.createDrive(owner.id, { name: 'Team' });
    const { user: admin } = await userWithHome();
    const provisioned = await provisionImagoAgents(admin.id);
    await factories.createDriveMember(team.id, admin.id, { role: 'ADMIN' });
    return { owner, team, admin, agents: provisioned.agents, ids: Object.values(provisioned.agents) };
  }

  function fullyOn(result: Awaited<ReturnType<typeof getImagoDriveAccess>>) {
    return result.ok && result.access.enabled && result.access.agents.length === BUILTIN_AGENT_KEYS.length
      && result.access.agents.every((agent) => agent.isMember);
  }

  it('given the toggle turned on and an agent permanently deleted and recreated, should keep every agent a member (no partial state)', async () => {
    if (!dbAvailable) return;
    const { team, admin, agents } = await adminSetup();
    await setImagoDriveAccess(admin.id, team.id, true);
    await db.delete(pages).where(eq(pages.id, agents.imago));

    await provisionHomeDriveIfNeeded(admin.id);

    expect(fullyOn(await getImagoDriveAccess(admin.id, team.id))).toBe(true);
  });

  it('given the toggle turned on and all three agents trashed and recreated, should keep the drive on', async () => {
    if (!dbAvailable) return;
    const { team, admin, ids } = await adminSetup();
    await setImagoDriveAccess(admin.id, team.id, true);
    await db.update(pages).set({ isTrashed: true, trashedAt: new Date() }).where(inArray(pages.id, ids));

    await provisionHomeDriveIfNeeded(admin.id);

    expect(fullyOn(await getImagoDriveAccess(admin.id, team.id))).toBe(true);
  });

  it('given the toggle never turned on, should leave the drive off across recreation (DEC-2: only owned drives default on)', async () => {
    if (!dbAvailable) return;
    const { team, admin, ids } = await adminSetup();
    await db.delete(pages).where(inArray(pages.id, ids));

    const recreated = Object.values((await provisionImagoAgents(admin.id)).agents);

    expect(await membersIn(team.id, recreated)).toEqual([]);
    expect(await getImagoDriveAccess(admin.id, team.id)).toMatchObject({ ok: true, access: { enabled: false } });
  });

  it('given an admin demoted after turning the toggle on, should not re-grant a recreated agent', async () => {
    if (!dbAvailable) return;
    const { team, admin, ids } = await adminSetup();
    await setImagoDriveAccess(admin.id, team.id, true);
    await db.update(driveMembers).set({ role: 'MEMBER' })
      .where(and(eq(driveMembers.driveId, team.id), eq(driveMembers.userId, admin.id)));
    await db.delete(pages).where(inArray(pages.id, ids));

    const recreated = Object.values((await provisionImagoAgents(admin.id)).agents);

    expect(await membersIn(team.id, recreated)).toEqual([]);
  });

  it('given the toggle on, should report enabled exactly when every live agent is a member', async () => {
    if (!dbAvailable) return;
    const { team, admin } = await adminSetup();

    const on = await setImagoDriveAccess(admin.id, team.id, true);
    expect(fullyOn(on)).toBe(true);
    const off = await setImagoDriveAccess(admin.id, team.id, false);
    expect(off.ok && !off.access.enabled && off.access.agents.every((agent) => !agent.isMember)).toBe(true);
  });
});

describe('IMG-4.6a: a turn-off racing an agent recreation at sign-in (real concurrent Postgres)', () => {
  // Each round: the user's three agent pages are gone, so the next sign-in
  // recreates them and grants them where Imago is on — while, at the same
  // moment, the user switches the drive off. Whatever the interleaving, the
  // drive must end off: stored off, and no Imago page of the user a member.
  const ROUNDS = 12;

  it(`given ${ROUNDS} rounds of sign-in and turn-off fired together, should end opted out every time`, async () => {
    if (!dbAvailable) return;
    const failures: string[] = [];
    for (let round = 0; round < ROUNDS; round++) {
      const { user, off, ids } = await setup();
      await db.delete(pages).where(inArray(pages.id, ids));

      const [, toggled] = await Promise.all([
        provisionHomeDriveIfNeeded(user.id),
        setImagoDriveAccess(user.id, off.id, false),
      ]);
      expect(toggled.ok).toBe(true);

      const pointers = await db
        .select({ pageId: userBuiltinAgents.pageId })
        .from(userBuiltinAgents)
        .where(eq(userBuiltinAgents.userId, user.id));
      const members = await membersIn(off.id, pointers.map((row) => row.pageId));
      const stored = await storedChoice(user.id, off.id);
      if (members.length > 0 || stored !== false) failures.push(`round ${round}: members=${members.length} stored=${stored}`);
    }
    expect(failures).toEqual([]);
  });
});

describe('IMG-4.6a: a turn-off and a grant in flight serialise on the user-row lock (real Postgres)', () => {
  // The grant's last step (grantImagoAgents) is a transaction that takes the
  // user-row lock, finds the drive still on and inserts the membership. Hold
  // exactly that open and switch the drive off meanwhile: the turn-off must
  // wait for it and then remove what it inserted. A turn-off that did not wait
  // would delete before the insert commits, and the grant would land after it.
  it('given a turn-off while a grant transaction holds the lock with its insert uncommitted, should end opted out', async () => {
    if (!dbAvailable) return;
    const { user, off, agents } = await setup();
    await db.delete(driveAgentMembers)
      .where(and(eq(driveAgentMembers.driveId, off.id), eq(driveAgentMembers.agentPageId, agents.imago)));

    let release: () => void = () => undefined;
    let announceHeld: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const lockHeld = new Promise<void>((resolve) => { announceHeld = resolve; });
    const grantInFlight = db.transaction(async (tx) => {
      await lockImagoUser(tx, user.id);
      await tx.insert(driveAgentMembers).values({ driveId: off.id, agentPageId: agents.imago, role: 'MEMBER', addedBy: user.id });
      announceHeld();
      await held;
    });
    await lockHeld;

    let toggleSettled = false;
    const toggling = setImagoDriveAccess(user.id, off.id, false).finally(() => { toggleSettled = true; });
    let observedLockWait = false;
    for (let attempt = 0; attempt < 150 && !toggleSettled; attempt++) {
      const waiting = await db.execute(sql`
        SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%FOR UPDATE%'
      `);
      if (waiting.rows.length > 0) {
        observedLockWait = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    release();
    await grantInFlight;
    expect((await toggling).ok).toBe(true);

    expect(observedLockWait).toBe(true);
    expect(await membersIn(off.id, Object.values(agents))).toEqual([]);
    expect(await storedChoice(user.id, off.id)).toBe(false);
  });
});

describe('IMG-4.6a review: an agent page replaced while a grant is in flight never keeps a membership (real Postgres)', () => {
  type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

  /** Poll until some backend in this database waits on a lock: the call under test is blocked on the user row. */
  async function waitForLockWait(settled: () => boolean) {
    for (let attempt = 0; attempt < 150 && !settled(); attempt++) {
      const waiting = await db.execute(sql`
        SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%FOR UPDATE%'
      `);
      if (waiting.rows.length > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  }

  /**
   * Hold the user-row lock, start `call` (which reads and authorizes outside
   * the lock, then queues on it), and only then — while it waits — trash
   * `pageId` and let provisioning replace it inside the held transaction, as a
   * sign-in would. Returns what `call` resolved to.
   */
  async function replaceWhileQueued<T>(userId: string, homeId: string, pageId: string, call: () => Promise<T>) {
    let release: () => void = () => undefined;
    let announceHeld: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const lockHeld = new Promise<void>((resolve) => { announceHeld = resolve; });
    let replaced: Record<string, string> = {};
    const signIn = db.transaction(async (tx: Tx) => {
      await lockImagoUser(tx, userId);
      announceHeld();
      await held;
      await tx.update(pages).set({ isTrashed: true, trashedAt: new Date() }).where(eq(pages.id, pageId));
      replaced = (await provisionImagoAgentsInTransaction(tx, userId, homeId)).agents;
    });
    await lockHeld;

    let settled = false;
    const pending = call().finally(() => { settled = true; });
    const observedLockWait = await waitForLockWait(() => settled);
    release();
    await signIn;
    const result = await pending;
    return { result, observedLockWait, replaced };
  }

  it('given a turn-on whose agent page is trashed and replaced by a sign-in before it lands, should grant the replacement and never the old page', async () => {
    if (!dbAvailable) return;
    const { user, home, off, agents } = await setup();
    await setImagoDriveAccess(user.id, off.id, false);
    const old = agents.imago;

    const { result, observedLockWait, replaced } = await replaceWhileQueued(
      user.id, home.id, old, () => setImagoDriveAccess(user.id, off.id, true),
    );

    expect(observedLockWait).toBe(true);
    expect(result.ok).toBe(true);
    expect(replaced.imago).not.toBe(old);
    expect(await membersIn(off.id, [old])).toEqual([]);
    // No partial state: the replacement is in, as are its siblings.
    expect(await membersIn(off.id, Object.values(replaced))).toEqual(sorted(Object.values(replaced)));
    // Restoring the old page from the trash brings nothing back, and a turn-off leaves nothing behind.
    await db.update(pages).set({ isTrashed: false, trashedAt: null }).where(eq(pages.id, old));
    await setImagoDriveAccess(user.id, off.id, false);
    expect(await membersIn(off.id, [old, ...Object.values(replaced)])).toEqual([]);
  });

  it('given a provisioning grant whose agent page is trashed and replaced before it lands, should not grant the old page', async () => {
    if (!dbAvailable) return;
    const { user, home, on, agents } = await setup();
    const old = agents['imago-planner'];
    await db.delete(driveAgentMembers)
      .where(and(eq(driveAgentMembers.driveId, on.id), eq(driveAgentMembers.agentPageId, old)));

    const { observedLockWait } = await replaceWhileQueued(
      user.id, home.id, old, () => grantImagoAgents(user.id, { agentPageIds: [old] }),
    );

    expect(observedLockWait).toBe(true);
    expect(await membersIn(on.id, [old])).toEqual([]);
  });
});

describe('IMG-4.6a review: ownership transfer never overwrites a concurrent choice of the new owner (real Postgres)', () => {
  it("given the new owner's turn-on committing while the transfer runs, should keep the new owner's choice", async () => {
    if (!dbAvailable) return;
    const { user: from, on: drive } = await setup();
    const { user: to } = await userWithHome();
    await factories.createDriveMember(drive.id, to.id, { role: 'ADMIN' });

    // The new owner's turn-on, holding its stored row uncommitted.
    let release: () => void = () => undefined;
    let announceHeld: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const rowHeld = new Promise<void>((resolve) => { announceHeld = resolve; });
    const turnOn = db.transaction(async (tx) => {
      await tx.insert(imagoDriveAccess).values({ userId: to.id, driveId: drive.id, enabled: true });
      announceHeld();
      await held;
    });
    await rowHeld;

    let settled = false;
    const transfer = transferDriveOwnership(drive.id, from.id, to.id).finally(() => { settled = true; });
    for (let attempt = 0; attempt < 150 && !settled; attempt++) {
      const waiting = await db.execute(sql`
        SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%imago_drive_access%'
      `);
      if (waiting.rows.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    release();
    await turnOn;
    await transfer;

    expect(await storedChoice(to.id, drive.id)).toBe(true);
  });
});
