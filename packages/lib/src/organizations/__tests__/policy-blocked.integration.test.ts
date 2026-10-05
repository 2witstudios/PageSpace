/**
 * What a policy change BLOCKS without suspending — REAL Postgres (Spec POL-1; Review 3+4 P2-7).
 *
 * Five kinds have no suspension: published apps, persistent environments, agents from other drives, autonomous
 * runs and models. Turning one off stops them where they are used, and until now the audit log listed nothing, so
 * an Owner or Admin could not see what the change reached. Here: the change lists exactly the existing items of
 * the org's drives it newly forbids (never another org's, never a personal drive's, never an item it still
 * allows), counted in full, in an org.policy.blocked audit row; a change that forbids nothing new lists nothing.
 *
 * Locally:
 *     DATABASE_URL=... bun run --filter '@pagespace/lib' test:integration -- src/organizations/__tests__/policy-blocked.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { factories } from '@pagespace/db/test/factories';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveAgentMembers } from '@pagespace/db/schema/members';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { publishedApps } from '@pagespace/db/schema/published-apps';
import { workflows } from '@pagespace/db/schema/workflows';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';

const audit = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));
vi.mock('../../audit/org-audit', () => ({
  recordOrgAuditEvent: vi.fn(async (event: Record<string, unknown>) => {
    audit.events.push(event);
  }),
  recordOrgAuditEventAfterCommit: vi.fn(async () => true),
}));

import { updateOrgPolicies } from '../policies';

const created = { userIds: [] as string[], driveIds: [] as string[], orgIds: [] as string[] };

interface World {
  orgId: string;
  owner: string;
  orgDrive: string;
  otherOrgDrive: string;
  personalDrive: string;
  envId: string;
  appId: string;
  crossMembershipId: string;
  workflowId: string;
  oldModelAgent: string;
  allowedModelAgent: string;
}
let w: World;

async function cleanup() {
  // Envs, apps, workflows, agent memberships and pages go with their drive; then org rows; users last.
  if (created.driveIds.length) await db.delete(drives).where(inArray(drives.id, created.driveIds));
  if (created.orgIds.length) {
    await db.delete(orgMembers).where(inArray(orgMembers.orgId, created.orgIds));
    await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, created.orgIds));
    await db.delete(organizations).where(inArray(organizations.id, created.orgIds));
  }
  if (created.userIds.length) await db.delete(users).where(inArray(users.id, created.userIds));
  created.userIds = [];
  created.driveIds = [];
  created.orgIds = [];
}

async function env(driveId: string, creator: string) {
  const id = createId();
  await db.insert(driveEnvs).values({ id, driveId, name: `env-${id}`, createdBy: creator, costOwnerId: creator, sandboxId: `sbx-${id}` });
  return id;
}

async function app(envId: string, driveId: string, owner: string) {
  const id = createId();
  await db.insert(publishedApps).values({
    id, envId, driveId, ownerId: owner, costOwnerId: owner, flyAppName: `pgs-${id}`, networkName: 'published-apps',
    subdomain: `blk-${id}`.toLowerCase(), status: 'stopped', tier: 'metered',
  });
  return id;
}

beforeEach(async () => {
  audit.events.length = 0;
  const mkUser = async () => {
    const u = await factories.createUser();
    created.userIds.push(u.id);
    return u.id;
  };
  const [owner, otherOwner, outsider] = [await mkUser(), await mkUser(), await mkUser()];
  const [orgId, otherOrgId] = [createId(), createId()];
  created.orgIds.push(orgId, otherOrgId);
  await db.insert(organizations).values([
    { id: orgId, name: 'Northwind', slug: `nw-${createId()}`, ownerId: owner },
    { id: otherOrgId, name: 'Other', slug: `ot-${createId()}`, ownerId: otherOwner },
  ]);
  // A paying org (D-OW-30: no subscription is lapsed, and a lapsed org may only restrict, [D-OW-33]).
  await factories.createOrgSubscription(orgId);
  await db.insert(orgMembers).values([{ orgId, userId: owner, role: 'OWNER' }, { orgId: otherOrgId, userId: otherOwner, role: 'OWNER' }]);
  const mkDrive = async (by: string, org: string | null) => {
    const d = await factories.createDrive(by);
    created.driveIds.push(d.id);
    if (org) await db.update(drives).set({ orgId: org, orgVisibility: 'OPEN' }).where(eq(drives.id, d.id));
    return d.id;
  };
  const orgDrive = await mkDrive(owner, orgId);
  const otherOrgDrive = await mkDrive(otherOwner, otherOrgId);
  const personalDrive = await mkDrive(outsider, null);

  const envId = await env(orgDrive, owner);
  const appId = await app(envId, orgDrive, owner);
  const otherEnv = await env(otherOrgDrive, otherOwner);
  await app(otherEnv, otherOrgDrive, otherOwner);
  await env(personalDrive, outsider);

  // An agent from a personal drive attached to the org drive (cross-drive), and one living in the org drive (home).
  const visitor = (await factories.createPage(personalDrive, { type: 'AI_CHAT' })).id;
  const homeAgent = (await factories.createPage(orgDrive, { type: 'AI_CHAT' })).id;
  const [cross] = await db.insert(driveAgentMembers).values({ driveId: orgDrive, agentPageId: visitor }).returning({ id: driveAgentMembers.id });
  await db.insert(driveAgentMembers).values({ driveId: orgDrive, agentPageId: homeAgent });

  const [wf] = await db.insert(workflows).values({ driveId: orgDrive, createdBy: owner, name: 'nightly', prompt: 'go', isEnabled: true, updatedAt: new Date() }).returning({ id: workflows.id });
  await db.insert(workflows).values({ driveId: orgDrive, createdBy: owner, name: 'off', prompt: 'go', isEnabled: false, updatedAt: new Date() });

  const oldModelAgent = (await factories.createPage(orgDrive, { type: 'AI_CHAT', aiProvider: 'openai', aiModel: 'm-old' })).id;
  const allowedModelAgent = (await factories.createPage(orgDrive, { type: 'AI_CHAT', aiProvider: 'openai', aiModel: 'm-new' })).id;
  await factories.createPage(otherOrgDrive, { type: 'AI_CHAT', aiProvider: 'openai', aiModel: 'm-old' });

  w = { orgId, owner, orgDrive, otherOrgDrive, personalDrive, envId, appId, crossMembershipId: cross.id, workflowId: wf.id, oldModelAgent, allowedModelAgent };
});

afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  const { pool } = await import('@pagespace/db/db');
  await pool.end();
});

const change = (patch: Parameters<typeof updateOrgPolicies>[0]['patch']) => updateOrgPolicies({ orgId: w.orgId, actorId: w.owner, patch });
const blockedEvent = () => audit.events.find((e) => e.eventType === 'org.policy.blocked');
type Listed = { kind: string; type: string; id: string; driveId: string };

describe('a change that forbids what cannot be suspended lists what it reached', () => {
  it('POL-1 (partial) X-6 (partial) turning off apps, envs, cross-drive agents and autonomy lists exactly the org\'s affected items, and the audit row carries them', async () => {
    const result = await change({ publishedApps: false, persistentEnvironments: false, crossDriveAgents: false, agentsAutonomous: false });
    if (!result.ok) throw new Error('expected ok');

    expect(result.blocked.counts).toEqual({ publishedApps: 1, persistentEnvironments: 1, crossDriveAgents: 1, agentsAutonomous: 1 });
    expect(result.blocked.items.map((i) => [i.kind, i.resourceType, i.id, i.driveId])).toEqual([
      ['publishedApps', 'published_app', w.appId, w.orgDrive],
      ['persistentEnvironments', 'drive_env', w.envId, w.orgDrive],
      ['crossDriveAgents', 'agent_membership', w.crossMembershipId, w.orgDrive],
      ['agentsAutonomous', 'workflow', w.workflowId, w.orgDrive],
    ]);

    const event = blockedEvent();
    expect(event).toMatchObject({ orgId: w.orgId, actorId: w.owner, resourceType: 'organization', resourceId: w.orgId });
    const details = event?.details as { counts: Record<string, number>; total: number; listed: Listed[]; truncated: boolean };
    expect(details.total).toBe(4);
    expect(details.truncated).toBe(false);
    expect(details.listed.map((l) => l.id).sort()).toEqual([w.appId, w.envId, w.crossMembershipId, w.workflowId].sort());
  });

  it('POL-1 (partial) narrowing the model allowlist lists the page agents whose own model it no longer allows, and only those', async () => {
    const result = await change({ modelAllowlist: ['m-new'] });
    if (!result.ok) throw new Error('expected ok');
    expect(result.blocked.counts).toEqual({ models: 1 });
    expect(result.blocked.items).toEqual([{ kind: 'models', resourceType: 'agent_page', id: w.oldModelAgent, driveId: w.orgDrive }]);
  });

  it('POL-1 (partial) a change that forbids nothing new (turning things back on, widening a list) lists nothing and writes no blocked row', async () => {
    await change({ publishedApps: false, modelAllowlist: ['m-new'] });
    audit.events.length = 0;
    const result = await change({ publishedApps: true, modelAllowlist: ['m-new', 'm-old'] });
    if (!result.ok) throw new Error('expected ok');
    expect(result.blocked).toEqual({ counts: {}, total: 0, items: [] });
    expect(blockedEvent()).toBeUndefined();
  });

  it('POL-1 (partial) the list is bounded but the count is not: a capped list says it is truncated', async () => {
    for (let i = 0; i < 3; i += 1) await db.insert(workflows).values({ driveId: w.orgDrive, createdBy: w.owner, name: `wf-${i}`, prompt: 'go', isEnabled: true, updatedAt: new Date() });
    const { listPolicyBlockedItems } = await import('../policy-blocked-items');
    const { DEFAULT_ORG_POLICIES } = await import('../policies-core');
    const listed = await listPolicyBlockedItems(db, w.orgId, { ...DEFAULT_ORG_POLICIES, agentsAutonomous: false }, ['agentsAutonomous'], 2);
    expect(listed.counts).toEqual({ agentsAutonomous: 4 });
    expect(listed.items).toHaveLength(2);
  });
});
