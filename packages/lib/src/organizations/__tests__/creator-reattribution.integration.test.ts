/**
 * [D-OW-28] review #2760 P3-4: a creator removed from a drive (but still in the org) stops being
 * its envs' and apps' cost owner — the drive lead's cap carries them from the next sweep, audited.
 *
 * REAL: the sweep, the org-aware membership answer, the updates, all against Postgres. Faked: the
 * audit chain (captured) and ORGS_ENABLED (on, as the org suites run).
 *
 * Requires DATABASE_URL → a migrated Postgres. Every row it creates is deleted.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { appHostingReclaims, publishedApps } from '@pagespace/db/schema/published-apps';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { reattributeRemovedCreators } from '../creator-reattribution';

vi.mock('../orgs-enabled', () => ({ ORGS_ENABLED: true }));
const audit = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));
vi.mock('../../audit/org-audit', () => ({
  recordOrgAuditEvent: vi.fn(async (event: Record<string, unknown>) => {
    audit.events.push(event);
  }),
  recordOrgAuditEventAfterCommit: vi.fn(async (event: Record<string, unknown>) => {
    audit.events.push(event);
    return true;
  }),
}));

let dbAvailable = false;

interface World {
  orgId: string;
  driveId: string;
  leadId: string;
  marcusId: string;
  adaId: string;
  envIds: { marcus: string; ada: string; lead: string };
  appId: string;
  userIds: string[];
}
let world: World | null = null;

async function env(driveId: string, creator: string): Promise<string> {
  const id = createId();
  await db.insert(driveEnvs).values({ id, driveId, name: `env-${id}`, createdBy: creator, costOwnerId: creator, sandboxId: `sbx-${id}` });
  return id;
}

/** A RESTRICTED Product drive: Marcus and Ada are explicit members and each created an env; Marcus published one. */
async function build(): Promise<World> {
  const lead = await factories.createUser({ name: 'Jono (lead)' });
  const marcus = await factories.createUser({ name: 'Marcus' });
  const ada = await factories.createUser({ name: 'Ada' });
  const [org] = await db.insert(organizations).values({ name: 'Northwind', slug: `nw-${createId()}`, ownerId: lead.id }).returning();
  await db.insert(orgMembers).values([
    { orgId: org.id, userId: lead.id, role: 'OWNER' },
    { orgId: org.id, userId: marcus.id, role: 'MEMBER' },
    { orgId: org.id, userId: ada.id, role: 'MEMBER' },
  ]);
  const drive = await factories.createDrive(lead.id, { name: 'Product', slug: `product-${createId()}`, orgId: org.id, orgVisibility: 'RESTRICTED' });
  await factories.createDriveMembers(drive.id, [marcus.id, ada.id]);
  const envIds = { marcus: await env(drive.id, marcus.id), ada: await env(drive.id, ada.id), lead: await env(drive.id, lead.id) };
  const appId = createId();
  await db.insert(publishedApps).values({
    id: appId,
    envId: envIds.marcus,
    driveId: drive.id,
    ownerId: marcus.id,
    costOwnerId: marcus.id,
    flyAppName: `pgs-${appId}`,
    networkName: 'published-apps',
    subdomain: `reattr-${appId}`.toLowerCase(),
    status: 'provisioning',
    tier: 'metered',
  });
  return { orgId: org.id, driveId: drive.id, leadId: lead.id, marcusId: marcus.id, adaId: ada.id, envIds, appId, userIds: [lead.id, marcus.id, ada.id] };
}

async function teardown(w: World): Promise<void> {
  await db.delete(publishedApps).where(eq(publishedApps.id, w.appId));
  await db.delete(appHostingReclaims).where(eq(appHostingReclaims.publishedAppId, w.appId));
  await db.delete(driveEnvs).where(inArray(driveEnvs.id, Object.values(w.envIds)));
  await db.delete(driveMembers).where(eq(driveMembers.driveId, w.driveId));
  await db.delete(drives).where(eq(drives.id, w.driveId));
  await db.delete(orgMembers).where(eq(orgMembers.orgId, w.orgId));
  await db.delete(organizations).where(eq(organizations.id, w.orgId));
  await db.delete(users).where(inArray(users.id, w.userIds));
}

const envOwner = async (id: string) => (await db.select().from(driveEnvs).where(eq(driveEnvs.id, id)))[0].costOwnerId;
const appOwner = async (w: World) => (await db.select().from(publishedApps).where(eq(publishedApps.id, w.appId)))[0].costOwnerId;
/** The sweep is fleet-wide; these tests read only their own world's events. */
const ownEvents = (w: World) => audit.events.filter((e) => e.orgId === w.orgId);

describe('a creator removed from a drive stops carrying its compute', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: drives.id }).from(drives).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('creator-reattribution.integration.test.ts', error);
      dbAvailable = false;
    }
  });
  beforeEach(() => {
    audit.events.length = 0;
  });
  afterEach(async () => {
    if (world) await teardown(world);
    world = null;
  });
  afterAll(async () => {
    await pool.end();
  });

  it('WAL-2 (partial) while every creator is still a member, nothing moves and nothing is audited', async () => {
    if (!dbAvailable) return;
    const w = (world = await build());

    await reattributeRemovedCreators();

    expect([await envOwner(w.envIds.marcus), await envOwner(w.envIds.ada), await appOwner(w)]).toEqual([w.marcusId, w.adaId, w.marcusId]);
    expect(ownEvents(w)).toEqual([]);
  });

  it('WAL-2 (partial) Marcus removed from the drive (still in the org): his env and app go to the lead, audited removed_from_drive; Ada\'s and the lead\'s are untouched', async () => {
    if (!dbAvailable) return;
    const w = (world = await build());
    await db.delete(driveMembers).where(and(eq(driveMembers.driveId, w.driveId), eq(driveMembers.userId, w.marcusId)));

    const result = await reattributeRemovedCreators();

    expect(result.outcome).toBe('swept');
    expect([await envOwner(w.envIds.marcus), await appOwner(w)]).toEqual([null, null]);
    expect([await envOwner(w.envIds.ada), await envOwner(w.envIds.lead)]).toEqual([w.adaId, w.leadId]);
    expect(ownEvents(w)).toEqual([
      expect.objectContaining({ eventType: 'org.compute.reattributed', resourceType: 'drive_env', resourceId: w.envIds.marcus, driveId: w.driveId, details: { formerCostOwnerId: w.marcusId, costOwner: 'drive_lead', reason: 'removed_from_drive' } }),
      expect.objectContaining({ eventType: 'org.compute.reattributed', resourceType: 'published_app', resourceId: w.appId }),
    ]);

    // Idempotent: the next sweep finds nothing of Marcus's to move.
    audit.events.length = 0;
    await reattributeRemovedCreators();
    expect(ownEvents(w)).toEqual([]);
  });
});
