/**
 * [D-OW-33] against a real Postgres: a lapsed org may only RESTRICT. The three writes that could still loosen access
 * after #2817 are refused with the lapse refusal (SEAT-9) inside their own transaction, and their restricting
 * direction still goes through:
 *   (a) a drive's visibility: toward Open is refused, toward Private applies;
 *   (b) a member's role: a promotion is refused, a demotion applies;
 *   (c) an outside guest under guests=on: refused at the one admission every path asks (decideOrgDriveAdmission),
 *       so a share-link redemption writes nothing; an org member is still admitted.
 * Paid again, each loosening change goes through.
 *
 * Northwind Labs (Sequence Spec Part 2): Jono Owner, Priya Admin, Dana member and Product's lead, Marcus member,
 * Gita an outsider. ORGS_ENABLED on, billing on (cloud). Deletes every row it creates, children before parents,
 * users last, and ends the pool.
 *
 * Locally:
 *     DATABASE_URL=... bun run --filter '@pagespace/lib' test:integration -- src/organizations/__tests__/lapsed-loosen.integration.test.ts
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { and, eq, inArray, or } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, type OrgDriveVisibility } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import { activityLogs } from '@pagespace/db/schema/monitoring';
import { orgGuestHolds } from '@pagespace/db/schema/org-guest-holds';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { driveShareLinks } from '@pagespace/db/schema/share-links';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';

vi.mock('../orgs-enabled', () => ({ ORGS_ENABLED: true }));
// The org audit chain is a separate store this suite does not assert; nothing may be left in it.
vi.mock('../../audit/org-audit', () => ({
  recordOrgAuditEvent: vi.fn(async () => {}),
  recordOrgAuditEventAfterCommit: vi.fn(async () => true),
}));

import { ORG_LAPSED_REFUSAL, isOrgActive } from '../status';
import { changeMemberRole } from '../membership';
import { changeDriveVisibility } from '../../services/org-drive-service';
import { orgDriveServiceDeps } from '../../services/org-drive-service-deps';
import { decideOrgDriveAdmission } from '../../permissions/guest-admission';
import { redeemDriveShareLink } from '../../permissions/share-link-service';
import { EnforcedAuthContext } from '../../permissions/enforced-context';
import type { SessionClaims } from '../../auth/session-service';

interface World {
  orgId: string;
  productId: string;
  linkToken: string;
  ids: Record<'jono' | 'priya' | 'dana' | 'marcus' | 'gita', string>;
  userIds: string[];
}

let dbAvailable = false;
let world: World | null = null;
const originalMode = process.env.DEPLOYMENT_MODE;

const ctxFor = (userId: string): EnforcedAuthContext => {
  const claims: SessionClaims = {
    sessionId: 'sess', userId, userRole: 'user', tokenVersion: 1, adminRoleVersion: 0, type: 'user', scopes: ['*'],
    expiresAt: new Date(Date.now() + 3_600_000), driveId: undefined,
  };
  return EnforcedAuthContext.fromSession(claims);
};

/** The webhook's mirror, written directly: the org's subscription as Stripe last reported it. */
async function setSubscription(orgId: string, status: string): Promise<void> {
  await factories.createOrgSubscription(orgId, { status }).catch(async () => {
    await db.update(orgSubscriptions).set({ status }).where(eq(orgSubscriptions.orgId, orgId));
  });
}

async function build(): Promise<World> {
  const make = (name: string) => factories.createUser({ name, subscriptionTier: 'free', email: `${name.split(' ')[0].toLowerCase()}-${createId()}@northwind.test` });
  const [jono, priya, dana, marcus, gita] = await Promise.all(['Jono', 'Priya Nair', 'Dana Kim', 'Marcus Oyelaran', 'Gita Outside'].map(make));
  const [org] = await db
    .insert(organizations)
    .values({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: jono.id, policies: { guests: 'on' } })
    .returning();
  await db.insert(orgMembers).values([
    { orgId: org.id, userId: jono.id, role: 'OWNER' },
    { orgId: org.id, userId: priya.id, role: 'ADMIN' },
    { orgId: org.id, userId: dana.id, role: 'MEMBER' },
    { orgId: org.id, userId: marcus.id, role: 'MEMBER' },
  ]);
  const product = await factories.createDrive(dana.id, { name: 'Product', slug: `product-${createId()}`, orgId: org.id, orgVisibility: 'PRIVATE' });
  const token = createId();
  await db.insert(driveShareLinks).values({ driveId: product.id, token, createdBy: dana.id });
  // Northwind paid (D-OW-30); each test lapses it.
  await setSubscription(org.id, 'active');
  const ids = { jono: jono.id, priya: priya.id, dana: dana.id, marcus: marcus.id, gita: gita.id };
  return { orgId: org.id, productId: product.id, linkToken: token, ids, userIds: Object.values(ids) };
}

async function teardown(w: World): Promise<void> {
  await db.delete(orgGuestHolds).where(eq(orgGuestHolds.orgId, w.orgId));
  await db.delete(orgSubscriptions).where(eq(orgSubscriptions.orgId, w.orgId));
  const ours = (await db.select({ id: drives.id }).from(drives).where(or(eq(drives.orgId, w.orgId), inArray(drives.ownerId, w.userIds)))).map((d) => d.id);
  if (ours.length > 0) {
    await db.delete(activityLogs).where(inArray(activityLogs.resourceId, ours));
    await db.delete(driveShareLinks).where(inArray(driveShareLinks.driveId, ours));
    await db.delete(driveMembers).where(inArray(driveMembers.driveId, ours));
    await db.delete(drives).where(inArray(drives.id, ours));
  }
  await db.delete(orgMembers).where(eq(orgMembers.orgId, w.orgId));
  await db.delete(organizations).where(eq(organizations.id, w.orgId));
  await db.delete(users).where(inArray(users.id, w.userIds));
}

const visibilityOf = async (driveId: string): Promise<OrgDriveVisibility> =>
  (await db.select({ v: drives.orgVisibility }).from(drives).where(eq(drives.id, driveId)))[0].v;
const roleOf = async (orgId: string, userId: string) =>
  (await db.select({ role: orgMembers.role }).from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId))))[0]?.role ?? null;
const rowsFor = async (driveId: string, userId: string) =>
  db.select({ id: driveMembers.id }).from(driveMembers).where(and(eq(driveMembers.driveId, driveId), eq(driveMembers.userId, userId)));

describe('a lapsed org cannot loosen access (orgs on, real Postgres)', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: orgSubscriptions.id }).from(orgSubscriptions).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('lapsed-loosen.integration.test.ts', error);
    }
  });

  beforeEach(async () => {
    process.env.DEPLOYMENT_MODE = 'cloud';
    if (dbAvailable) world = await build();
  });

  afterEach(async () => {
    if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = originalMode;
    if (world) await teardown(world);
    world = null;
  });

  afterAll(async () => { await pool.end(); });

  it('SEAT-9 (partial) DRV-4 (partial) [D-OW-33] while lapsed a drive cannot be made more open (Private→Restricted, Private→Open, Restricted→Open) and nothing is stored; it can be made less open; paid again, it can be opened', async () => {
    if (!world) return;
    const w = world;
    await setSubscription(w.orgId, 'canceled');
    expect(await isOrgActive(w.orgId)).toBe(false);

    for (const to of ['RESTRICTED', 'OPEN'] as const) {
      expect(await changeDriveVisibility(w.ids.priya, w.productId, { orgVisibility: to }, orgDriveServiceDeps)).toEqual(ORG_LAPSED_REFUSAL);
      expect(await visibilityOf(w.productId)).toBe('PRIVATE');
    }
    // Opening a drive would materialize a row for every org member: none appeared.
    expect(await rowsFor(w.productId, w.ids.marcus)).toHaveLength(0);

    await db.update(drives).set({ orgVisibility: 'OPEN' }).where(eq(drives.id, w.productId));
    expect(await changeDriveVisibility(w.ids.dana, w.productId, { orgVisibility: 'RESTRICTED' }, orgDriveServiceDeps))
      .toMatchObject({ ok: true, changed: true, from: 'OPEN', to: 'RESTRICTED' });
    expect(await changeDriveVisibility(w.ids.priya, w.productId, { orgVisibility: 'OPEN' }, orgDriveServiceDeps)).toEqual(ORG_LAPSED_REFUSAL);
    expect(await visibilityOf(w.productId)).toBe('RESTRICTED');
    expect(await changeDriveVisibility(w.ids.priya, w.productId, { orgVisibility: 'PRIVATE' }, orgDriveServiceDeps))
      .toMatchObject({ ok: true, changed: true, from: 'RESTRICTED', to: 'PRIVATE' });

    await setSubscription(w.orgId, 'active');
    expect(await changeDriveVisibility(w.ids.priya, w.productId, { orgVisibility: 'OPEN' }, orgDriveServiceDeps))
      .toMatchObject({ ok: true, changed: true, from: 'PRIVATE', to: 'OPEN' });
    expect(await visibilityOf(w.productId)).toBe('OPEN');
  });

  it('SEAT-9 (partial) ORG-2 (partial) [D-OW-33] while lapsed a Member cannot be promoted to Admin (402 org_lapsed, the row is unchanged); an Admin can be demoted; paid again, the promotion goes through', async () => {
    if (!world) return;
    const w = world;
    await setSubscription(w.orgId, 'unpaid');
    expect(await isOrgActive(w.orgId)).toBe(false);

    expect(await changeMemberRole({ orgId: w.orgId, actorId: w.ids.priya, targetId: w.ids.marcus, newRole: 'ADMIN' }))
      .toEqual({ ok: false, status: 402, reason: 'org_lapsed' });
    expect(await roleOf(w.orgId, w.ids.marcus)).toBe('MEMBER');

    expect(await changeMemberRole({ orgId: w.orgId, actorId: w.ids.jono, targetId: w.ids.priya, newRole: 'MEMBER' })).toEqual({ ok: true });
    expect(await roleOf(w.orgId, w.ids.priya)).toBe('MEMBER');

    await setSubscription(w.orgId, 'active');
    expect(await changeMemberRole({ orgId: w.orgId, actorId: w.ids.jono, targetId: w.ids.marcus, newRole: 'ADMIN' })).toEqual({ ok: true });
    expect(await roleOf(w.orgId, w.ids.marcus)).toBe('ADMIN');
  });

  it('SEAT-9 (partial) POL-2 (partial) [D-OW-33] with guests on, a lapsed org admits no outsider: the admission refuses org_lapsed, inside a transaction too, and a share-link redemption writes no row; an org member is still admitted; paid again, the outsider is', async () => {
    if (!world) return;
    const w = world;
    await db.update(drives).set({ orgVisibility: 'RESTRICTED' }).where(eq(drives.id, w.productId));
    expect(await decideOrgDriveAdmission({ driveId: w.productId, userId: w.ids.gita })).toEqual({ decision: 'allow', orgId: w.orgId });

    await setSubscription(w.orgId, 'canceled');
    const lapsed = { decision: 'refuse', refusal: 'org_lapsed', orgId: w.orgId };
    expect(await decideOrgDriveAdmission({ driveId: w.productId, userId: w.ids.gita })).toEqual(lapsed);
    expect(await decideOrgDriveAdmission({ driveId: w.productId, userId: null })).toEqual(lapsed);
    expect(await db.transaction((tx) => decideOrgDriveAdmission({ driveId: w.productId, userId: w.ids.gita }, tx))).toEqual(lapsed);
    expect(await decideOrgDriveAdmission({ driveId: w.productId, userId: w.ids.marcus })).toEqual({ decision: 'allow', orgId: w.orgId });

    expect(await redeemDriveShareLink(ctxFor(w.ids.gita), w.linkToken)).toEqual({ ok: false, error: 'NOT_FOUND' });
    expect(await rowsFor(w.productId, w.ids.gita)).toHaveLength(0);

    await setSubscription(w.orgId, 'active');
    expect(await redeemDriveShareLink(ctxFor(w.ids.gita), w.linkToken)).toMatchObject({ ok: true });
    expect(await rowsFor(w.productId, w.ids.gita)).toHaveLength(1);
  });
});
