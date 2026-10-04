/**
 * The org policy store and suspension — REAL Postgres (Spec POL-1, X-6).
 *
 * A policy set the strict way SUSPENDS what already exists (a marker, never a delete, never an edit of
 * the row's own state), lists it, and turning the policy back on restores exactly that and nothing else.
 *
 * Locally:
 *     DATABASE_URL=... bun run --filter '@pagespace/lib' test:integration -- src/organizations/__tests__/policies.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { factories } from '@pagespace/db/test/factories';
import { db } from '@pagespace/db/db';
import { eq, inArray, or } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { customDomains } from '@pagespace/db/schema/custom-domains';
import { integrationConnections, integrationProviders } from '@pagespace/db/schema/integrations';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { publishedPages } from '@pagespace/db/schema/published-pages';
import { driveShareLinks, pageShareLinks } from '@pagespace/db/schema/share-links';

const audit = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>>, failNext: false }));
vi.mock('../../audit/org-audit', () => ({
  recordOrgAuditEvent: vi.fn(async (event: Record<string, unknown>) => {
    if (audit.failNext) throw new Error('audit chain unavailable');
    audit.events.push(event);
  }),
  // Other mutations' org events (membership, drives) are not what this suite asserts.
  recordOrgAuditEventAfterCommit: vi.fn(async () => true),
}));

import { getOrgPolicies, updateOrgPolicies } from '../policies';
import { DEFAULT_ORG_POLICIES } from '../policies-core';
import { listPolicySuspensions } from '../policy-suspension';

const run = createId().slice(0, 8);
const orgId = createId();
const otherOrgId = createId();
const created = { userIds: [] as string[], driveIds: [] as string[], providerIds: [] as string[] };

async function user() {
  const u = await factories.createUser();
  created.userIds.push(u.id);
  return u;
}

interface World {
  owner: string;
  member: string;
  guest: string;
  outsider: string;
  orgDrive: string;
  privateDrive: string;
  personalDrive: string;
  otherOrgDrive: string;
  orgPage: string;
}
let w: World;

async function cleanup() {
  const driveIds = created.driveIds;
  if (driveIds.length) await db.delete(drives).where(inArray(drives.id, driveIds));
  await db.delete(integrationProviders).where(inArray(integrationProviders.id, created.providerIds.length ? created.providerIds : ['-']));
  await db.delete(orgMembers).where(or(eq(orgMembers.orgId, orgId), eq(orgMembers.orgId, otherOrgId)));
  await db.delete(organizations).where(or(eq(organizations.id, orgId), eq(organizations.id, otherOrgId)));
  if (created.userIds.length) await db.delete(users).where(inArray(users.id, created.userIds));
  created.userIds = [];
  created.driveIds = [];
  created.providerIds = [];
}

beforeEach(async () => {
  audit.events.length = 0;
  audit.failNext = false;
  const [owner, member, guest, outsider, otherOwner] = [await user(), await user(), await user(), await user(), await user()];
  await db.insert(organizations).values([
    { id: orgId, name: 'Northwind', slug: `nw-${run}`, ownerId: owner.id },
    { id: otherOrgId, name: 'Other', slug: `ot-${run}`, ownerId: otherOwner.id },
  ]);
  await db.insert(orgMembers).values([
    { orgId, userId: owner.id, role: 'OWNER' },
    { orgId, userId: member.id, role: 'MEMBER' },
    { orgId: otherOrgId, userId: otherOwner.id, role: 'OWNER' },
  ]);
  const mk = async (ownerId: string, org: string | null, visibility: 'OPEN' | 'PRIVATE' = 'OPEN') => {
    const d = await factories.createDrive(ownerId);
    created.driveIds.push(d.id);
    if (org) await db.update(drives).set({ orgId: org, orgVisibility: visibility }).where(eq(drives.id, d.id));
    return d.id;
  };
  const orgDrive = await mk(owner.id, orgId);
  const privateDrive = await mk(owner.id, orgId, 'PRIVATE');
  const personalDrive = await mk(outsider.id, null);
  const otherOrgDrive = await mk(otherOwner.id, otherOrgId);
  const orgPage = (await factories.createPage(orgDrive, { isPrivate: false })).id;
  w = { owner: owner.id, member: member.id, guest: guest.id, outsider: outsider.id, orgDrive, privateDrive, personalDrive, otherOrgDrive, orgPage };
});

afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  const { pool } = await import('@pagespace/db/db');
  await pool.end();
});

const link = (driveId: string, over: Partial<typeof driveShareLinks.$inferInsert> = {}) =>
  db.insert(driveShareLinks).values({ driveId, token: createId(), createdBy: w.owner, ...over }).returning({ id: driveShareLinks.id }).then((r) => r[0].id);
const pageLink = (pageId: string, over: Partial<typeof pageShareLinks.$inferInsert> = {}) =>
  db.insert(pageShareLinks).values({ pageId, token: createId(), permissions: ['VIEW'], createdBy: w.owner, ...over }).returning({ id: pageShareLinks.id }).then((r) => r[0].id);

const marker = async (table: typeof driveShareLinks | typeof pageShareLinks, id: string) => {
  const [r] = await db.select({ m: table.suspendedByPolicy, active: table.isActive }).from(table).where(eq(table.id, id));
  return r;
};

describe('the policy reader', () => {
  it('POL-1 (partial) an org that never set a policy reads the default for every one', async () => {
    expect(await getOrgPolicies(orgId)).toEqual(DEFAULT_ORG_POLICIES);
  });

  it('POL-1 (partial) a change is read back on the very next call with no restart or cache to expire', async () => {
    await updateOrgPolicies({ orgId, actorId: w.owner, patch: { guests: 'off' } });
    expect((await getOrgPolicies(orgId)).guests).toBe('off');
    await updateOrgPolicies({ orgId, actorId: w.owner, patch: { guests: 'approve' } });
    expect((await getOrgPolicies(orgId)).guests).toBe('approve');
  });

  it('POL-1 (partial) one org\'s policy change never shows in another org', async () => {
    await updateOrgPolicies({ orgId, actorId: w.owner, patch: { publicShareLinks: false } });
    expect((await getOrgPolicies(otherOrgId)).publicShareLinks).toBe(true);
  });

  it('POL-1 (partial) an unknown org reads as defaults and cannot be updated', async () => {
    expect(await getOrgPolicies('nope')).toEqual(DEFAULT_ORG_POLICIES);
    expect(await updateOrgPolicies({ orgId: 'nope', actorId: w.owner, patch: { guests: 'off' } })).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('suspend, never delete', () => {
  it('POL-1 (partial) POL-3 public share links off suspends every live link in the org, lists them, and deletes nothing', async () => {
    const live = await link(w.orgDrive);
    const livePage = await pageLink(w.orgPage);
    const inactive = await link(w.orgDrive, { isActive: false });
    const expired = await link(w.orgDrive, { expiresAt: new Date(Date.now() - 60_000) });
    const personal = await link(w.personalDrive, { createdBy: w.outsider });
    const otherOrg = await link(w.otherOrgDrive, { createdBy: w.owner });

    const res = await updateOrgPolicies({ orgId, actorId: w.owner, patch: { publicShareLinks: false } });
    if (!res.ok) throw new Error('expected ok');
    expect(res.suspended.map((s) => s.id).sort()).toEqual([live, livePage].sort());

    expect((await marker(driveShareLinks, live)).m).toBe('publicShareLinks');
    expect((await marker(pageShareLinks, livePage)).m).toBe('publicShareLinks');
    // Rows that were already refused are not marked, so restore can never revive them.
    expect((await marker(driveShareLinks, inactive)).m).toBeNull();
    expect((await marker(driveShareLinks, expired)).m).toBeNull();
    // Other owners' links are outside this org's policy.
    expect((await marker(driveShareLinks, personal)).m).toBeNull();
    expect((await marker(driveShareLinks, otherOrg)).m).toBeNull();
    // Nothing was deleted or edited: the links are still there and still active.
    expect((await marker(driveShareLinks, live)).active).toBe(true);
    expect(await db.$count(driveShareLinks, eq(driveShareLinks.driveId, w.orgDrive))).toBe(3);

    const listing = await listPolicySuspensions(orgId);
    const listed = listing.flatMap((l) => l.items.map((i) => i.id));
    expect(listed.sort()).toEqual([live, livePage].sort());
    expect(listing.find((l) => l.resourceType === 'drive_share_link')?.total).toBe(1);
  });

  it('POL-1 (partial) turning public share links back on restores exactly the suspended links and leaves the inactive one inactive', async () => {
    const live = await link(w.orgDrive);
    const inactive = await link(w.orgDrive, { isActive: false });
    await updateOrgPolicies({ orgId, actorId: w.owner, patch: { publicShareLinks: false } });
    const back = await updateOrgPolicies({ orgId, actorId: w.owner, patch: { publicShareLinks: true } });
    if (!back.ok) throw new Error('expected ok');
    expect(back.restored.map((r) => r.id)).toEqual([live]);
    expect(await marker(driveShareLinks, live)).toEqual({ m: null, active: true });
    expect(await marker(driveShareLinks, inactive)).toEqual({ m: null, active: false });
    expect((await listPolicySuspensions(orgId)).every((l) => l.total === 0)).toBe(true);
  });

  it('POL-1 (partial) a link an admin deactivates WHILE it is suspended stays inactive after the policy is turned back on', async () => {
    const live = await link(w.orgDrive);
    await updateOrgPolicies({ orgId, actorId: w.owner, patch: { publicShareLinks: false } });
    await db.update(driveShareLinks).set({ isActive: false }).where(eq(driveShareLinks.id, live));

    await updateOrgPolicies({ orgId, actorId: w.owner, patch: { publicShareLinks: true } });

    expect(await marker(driveShareLinks, live)).toEqual({ m: null, active: false });
  });

  it('POL-1 (partial) re-applying the same policy changes nothing and writes no audit row', async () => {
    await link(w.orgDrive);
    await updateOrgPolicies({ orgId, actorId: w.owner, patch: { publicShareLinks: false } });
    audit.events.length = 0;
    const again = await updateOrgPolicies({ orgId, actorId: w.owner, patch: { publicShareLinks: false } });
    if (!again.ok) throw new Error('expected ok');
    expect(again.changes).toEqual([]);
    expect(again.suspended).toEqual([]);
    expect(audit.events).toEqual([]);
  });

  it('POL-1 (partial) publishing off marks published pages, custom domains (not platform-owned) and keeps the rows', async () => {
    const page = (await factories.createPage(w.orgDrive, { isPrivate: false })).id;
    const [pub] = await db.insert(publishedPages).values({ driveId: w.orgDrive, pageId: page, path: `p-${run}`, artifactKey: 'k', updatedAt: new Date() }).returning({ id: publishedPages.id });
    const [dom] = await db.insert(customDomains).values({ driveId: w.orgDrive, hostname: `a-${run}.example.test` }).returning({ id: customDomains.id });
    const [plat] = await db.insert(customDomains).values({ driveId: w.orgDrive, hostname: `b-${run}.example.test`, platformOwned: true }).returning({ id: customDomains.id });

    await updateOrgPolicies({ orgId, actorId: w.owner, patch: { publishWeb: false } });
    expect((await db.select().from(publishedPages).where(eq(publishedPages.id, pub.id)))[0].suspendedByPolicy).toBe('publishedPages');
    expect((await db.select().from(customDomains).where(eq(customDomains.id, dom.id)))[0].suspendedByPolicy).toBeNull();

    await updateOrgPolicies({ orgId, actorId: w.owner, patch: { customDomains: false } });
    expect((await db.select().from(customDomains).where(eq(customDomains.id, dom.id)))[0].suspendedByPolicy).toBe('customDomains');
    expect((await db.select().from(customDomains).where(eq(customDomains.id, plat.id)))[0].suspendedByPolicy).toBeNull();

    await updateOrgPolicies({ orgId, actorId: w.owner, patch: { publishWeb: true, customDomains: true } });
    expect((await db.select().from(publishedPages).where(eq(publishedPages.id, pub.id)))[0].suspendedByPolicy).toBeNull();
    expect((await db.select().from(customDomains).where(eq(customDomains.id, dom.id)))[0].suspendedByPolicy).toBeNull();
  });

  it('POL-1 (partial) an integrations allowlist suspends drive connections to other providers and widening it restores them', async () => {
    const mkProvider = async (slug: string) => {
      const [p] = await db.insert(integrationProviders).values({ slug: `${slug}-${run}`, name: slug, providerType: 'builtin', config: {} }).returning({ id: integrationProviders.id });
      created.providerIds.push(p.id);
      return p.id;
    };
    const gh = await mkProvider('github');
    const sl = await mkProvider('slack');
    const conn = async (providerId: string, driveId: string) =>
      (await db.insert(integrationConnections).values({ providerId, driveId, name: 'c' }).returning({ id: integrationConnections.id }))[0].id;
    const ghConn = await conn(gh, w.orgDrive);
    const slConn = await conn(sl, w.orgDrive);
    const personalConn = await conn(sl, w.personalDrive);
    const m = async (id: string) => (await db.select({ m: integrationConnections.suspendedByPolicy }).from(integrationConnections).where(eq(integrationConnections.id, id)))[0].m;

    await updateOrgPolicies({ orgId, actorId: w.owner, patch: { integrationsAllowlist: [`github-${run}`] } });
    expect(await m(ghConn)).toBeNull();
    expect(await m(slConn)).toBe('integrations');
    expect(await m(personalConn)).toBeNull();

    await updateOrgPolicies({ orgId, actorId: w.owner, patch: { integrationsAllowlist: [`github-${run}`, `slack-${run}`] } });
    expect(await m(slConn)).toBeNull();

    await updateOrgPolicies({ orgId, actorId: w.owner, patch: { integrationsAllowlist: [] } });
    expect(await m(ghConn)).toBe('integrations');
    await updateOrgPolicies({ orgId, actorId: w.owner, patch: { integrationsAllowlist: null } });
    expect(await m(ghConn)).toBeNull();
    expect(await m(slConn)).toBeNull();
  });
});

describe('the audit trail of a change', () => {
  it('POL-1 (partial) a change writes a policy event naming the key, old and new value, and one suspended event listing what was suspended', async () => {
    const live = await link(w.orgDrive);
    await updateOrgPolicies({ orgId, actorId: w.owner, patch: { publicShareLinks: false } });
    const types = audit.events.map((e) => e.eventType);
    expect(types).toEqual(['org.policy.changed', 'org.policy.suspended']);
    expect(audit.events[0]).toMatchObject({ orgId, actorId: w.owner, details: { changes: [{ key: 'publicShareLinks', from: true, to: false }] } });
    const suspended = audit.events[1].details as { total: number; listed: Array<{ id: string }> };
    expect(suspended.total).toBe(1);
    expect(suspended.listed.map((l) => l.id)).toEqual([live]);

    audit.events.length = 0;
    await updateOrgPolicies({ orgId, actorId: w.owner, patch: { publicShareLinks: true } });
    expect(audit.events.map((e) => e.eventType)).toEqual(['org.policy.changed', 'org.policy.restored']);
  });

  it('POL-1 (partial) a rejected audit append does not undo the committed change but is reported to the caller', async () => {
    const live = await link(w.orgDrive);
    audit.failNext = true;
    const res = await updateOrgPolicies({ orgId, actorId: w.owner, patch: { publicShareLinks: false } });
    if (!res.ok) throw new Error('expected ok');
    expect(res.auditRecorded).toBe(false);
    expect((await getOrgPolicies(orgId)).publicShareLinks).toBe(false);
    expect((await marker(driveShareLinks, live)).m).toBe('publicShareLinks');
  });
});

describe('cleanliness', () => {
  it('leaves the page fixture drive usable by page ids', async () => {
    const rows = await db.select({ id: pages.id }).from(pages).where(eq(pages.driveId, w.orgDrive));
    expect(rows.map((r) => r.id)).toContain(w.orgPage);
  });
});
