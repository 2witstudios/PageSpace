// @vitest-environment node
/**
 * `loadImagoAgentContext` against a REAL Postgres (IMG-4.7): which agents
 * count as the user's Imago agents, and which drive grants their summary may
 * name. Every case is a trust-boundary case — the summary must never name a
 * drive the agent is not granted, nor one the caller could not already list.
 *
 * Requires DATABASE_URL → a migrated Postgres. Fails loudly without one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveAgentMembers, driveMembers } from '@pagespace/db/schema/members';
import { factories } from '@pagespace/db/test/factories';
import { provisionImagoAgents } from '@pagespace/lib/agents/provision-imago-agents';
import { ensureTestDb } from '@/test/ensure-test-db';
import {
  buildGrantedDrivesPrompt,
  loadImagoAgentContext,
  resolveImagoIntegrationDriveId,
  resolveImagoLocationAccess,
} from '../imago-agent-context';

const seededUserIds: string[] = [];

async function imagoUser() {
  const user = await factories.createUser();
  seededUserIds.push(user.id);
  const home = await factories.createDrive(user.id, { kind: 'HOME', name: 'Home', slug: 'home' });
  return { user, home };
}

const grant = (driveId: string, agentPageId: string, role: 'MEMBER' | 'ADMIN' = 'MEMBER') =>
  db.insert(driveAgentMembers).values({ driveId, agentPageId, role });

beforeAll(async () => {
  await ensureTestDb();
});

afterAll(async () => {
  if (seededUserIds.length === 0) return;
  await db.delete(drives).where(inArray(drives.ownerId, seededUserIds));
  await db.delete(users).where(inArray(users.id, seededUserIds));
});

describe('loadImagoAgentContext (integration)', () => {
  it("given one of the user's Imago agents, should return its Home drive and its grants sorted by name", async () => {
    const { user, home } = await imagoUser();
    const zeta = await factories.createDrive(user.id, { name: 'Zeta', slug: `z-${createId()}` });
    const alpha = await factories.createDrive(user.id, { name: 'Alpha', slug: `a-${createId()}` });
    const { agents } = await provisionImagoAgents(user.id);
    await db
      .update(driveAgentMembers)
      .set({ role: 'ADMIN' })
      .where(and(eq(driveAgentMembers.agentPageId, agents.imago), eq(driveAgentMembers.driveId, zeta.id)));

    const context = await loadImagoAgentContext({ userId: user.id, agentPageId: agents.imago, allowedDriveIds: [] });

    expect(context).toEqual({
      homeDriveId: home.id,
      grants: [
        { driveId: alpha.id, name: 'Alpha', role: 'MEMBER' },
        { driveId: zeta.id, name: 'Zeta', role: 'ADMIN' },
      ],
    });
  });

  it('given an ordinary agent, even one with drive memberships, should return null', async () => {
    const { user } = await imagoUser();
    const work = await factories.createDrive(user.id, { name: 'Work', slug: `w-${createId()}` });
    const agent = await factories.createPage(work.id, { type: 'AI_CHAT', title: 'Helper' });
    const other = await factories.createDrive(user.id, { name: 'Other', slug: `o-${createId()}` });
    await grant(other.id, agent.id);

    expect(await loadImagoAgentContext({ userId: user.id, agentPageId: agent.id, allowedDriveIds: [] })).toBeNull();
  });

  it("given another user's Imago agent, should return null", async () => {
    const { user } = await imagoUser();
    const { user: owner } = await imagoUser();
    const { agents } = await provisionImagoAgents(owner.id);

    expect(await loadImagoAgentContext({ userId: user.id, agentPageId: agents.imago, allowedDriveIds: [] })).toBeNull();
  });

  it('given an Imago agent page in the trash, should return null', async () => {
    const { user } = await imagoUser();
    const { agents } = await provisionImagoAgents(user.id);
    await db.update(pages).set({ isTrashed: true }).where(eq(pages.id, agents['imago-planner']));

    expect(
      await loadImagoAgentContext({ userId: user.id, agentPageId: agents['imago-planner'], allowedDriveIds: [] }),
    ).toBeNull();
  });

  it('given no grants, should return an empty list and say so in the summary', async () => {
    const { user } = await imagoUser();
    const { agents } = await provisionImagoAgents(user.id);

    const context = await loadImagoAgentContext({ userId: user.id, agentPageId: agents.imago, allowedDriveIds: [] });

    expect(context?.grants).toEqual([]);
    expect(buildGrantedDrivesPrompt(context!)).toContain('No workspaces are granted to you yet');
  });

  it('given a granted drive in the trash, should leave it out', async () => {
    const { user } = await imagoUser();
    const gone = await factories.createDrive(user.id, { name: 'Gone', slug: `g-${createId()}` });
    const { agents } = await provisionImagoAgents(user.id);
    await db.update(drives).set({ isTrashed: true }).where(eq(drives.id, gone.id));

    const context = await loadImagoAgentContext({ userId: user.id, agentPageId: agents.imago, allowedDriveIds: [] });

    expect(context?.grants).toEqual([]);
  });

  it('given a grant on a drive the user can no longer reach, should not name that drive', async () => {
    const { user } = await imagoUser();
    const { user: other } = await imagoUser();
    const { agents } = await provisionImagoAgents(user.id);
    const shared = await factories.createDrive(other.id, { name: 'Formerly Shared', slug: `f-${createId()}` });
    // Granted while the user was a member; the membership has since been removed.
    await grant(shared.id, agents.imago);

    const context = await loadImagoAgentContext({ userId: user.id, agentPageId: agents.imago, allowedDriveIds: [] });

    expect(context?.grants).toEqual([]);

    // Control: while the membership exists, the same grant is listed.
    await factories.createDriveMember(shared.id, user.id, { role: 'MEMBER', acceptedAt: new Date() });
    const again = await loadImagoAgentContext({ userId: user.id, agentPageId: agents.imago, allowedDriveIds: [] });
    expect(again?.grants.map((g) => g.name)).toEqual(['Formerly Shared']);
    await db.delete(driveMembers).where(eq(driveMembers.driveId, shared.id));
  });

  it("given a drive-scoped token, should name only grants inside the token's scope", async () => {
    const { user, home } = await imagoUser();
    const inScope = await factories.createDrive(user.id, { name: 'In Scope', slug: `i-${createId()}` });
    await factories.createDrive(user.id, { name: 'Out Of Scope', slug: `x-${createId()}` });
    const { agents } = await provisionImagoAgents(user.id);

    const context = await loadImagoAgentContext({
      userId: user.id,
      agentPageId: agents.imago,
      allowedDriveIds: [home.id, inScope.id],
    });

    expect(context?.grants.map((g) => g.name)).toEqual(['In Scope']);
  });
});

describe('buildGrantedDrivesPrompt', () => {
  it('should list names and roles only, never ids', () => {
    const prompt = buildGrantedDrivesPrompt({
      homeDriveId: 'home_1',
      grants: [
        { driveId: 'drive_a', name: 'Acme', role: 'MEMBER' },
        { driveId: 'drive_b', name: 'Beta', role: 'ADMIN' },
      ],
    });

    expect(prompt).toContain('## GRANTED WORKSPACES');
    expect(prompt).toContain('• "Acme" — MEMBER\n• "Beta" — ADMIN');
    expect(prompt).not.toMatch(/drive_a|drive_b|home_1/);
  });
});

describe('resolveImagoLocationAccess', () => {
  const context = {
    homeDriveId: 'home_1',
    grants: [{ driveId: 'drive_a', name: 'Acme', role: 'ADMIN' as const }],
  };
  const at = (id: string) => ({ currentDrive: { id, name: 'X', slug: 'x' }, currentPage: null, breadcrumbs: [] });

  it('should classify the drive in view against Home and the grants', () => {
    expect(resolveImagoLocationAccess(at('home_1'), context)).toEqual({ kind: 'home' });
    expect(resolveImagoLocationAccess(at('drive_a'), context)).toEqual({ kind: 'granted', role: 'ADMIN' });
    expect(resolveImagoLocationAccess(at('drive_z'), context)).toEqual({ kind: 'not-granted' });
  });

  it('given no drive in view, should say nothing', () => {
    expect(resolveImagoLocationAccess(null, context)).toBeUndefined();
    expect(resolveImagoLocationAccess({ currentPage: null, currentDrive: null }, context)).toBeUndefined();
  });
});

describe('resolveImagoIntegrationDriveId', () => {
  const context = {
    homeDriveId: 'home_1',
    grants: [{ driveId: 'drive_a', name: 'Acme', role: 'MEMBER' as const }],
  };
  const at = (id: string) => ({ currentDrive: { id, name: 'X', slug: 'x' }, currentPage: null, breadcrumbs: [] });

  it('given the Home drive or a granted drive in view, should use it for drive integrations', () => {
    expect(resolveImagoIntegrationDriveId(at('home_1'), context)).toBe('home_1');
    expect(resolveImagoIntegrationDriveId(at('drive_a'), context)).toBe('drive_a');
  });

  it('given an ungranted drive or no drive in view, should use no drive', () => {
    expect(resolveImagoIntegrationDriveId(at('drive_z'), context)).toBeNull();
    expect(resolveImagoIntegrationDriveId(null, context)).toBeNull();
  });
});
