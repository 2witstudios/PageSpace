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
import { and, eq, inArray } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { driveAgentMembers } from '@pagespace/db/schema/members';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { BUILTIN_AGENT_KEYS } from '../builtin-agents';
import { provisionImagoAgents } from '../provision-imago-agents';
import { getImagoDriveAccess, setImagoDriveAccess } from '../imago-drive-access';
import { provisionHomeDriveIfNeeded } from '../../onboarding/home-drive';
import { createDrive } from '../../services/drive-service';
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
