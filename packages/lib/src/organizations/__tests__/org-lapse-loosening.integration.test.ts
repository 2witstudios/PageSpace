/**
 * [D-OW-33] completeness against a real Postgres: every lib write that can LOOSEN access in an org drive is refused
 * while the org is lapsed (the SEAT-9 refusal, 402 org_lapsed, nothing written), its RESTRICTING direction still goes
 * through while lapsed, and paid again the loosening change goes through. Each path is the one the seam ledger
 * (org-lapse-loosening.seam.test.ts) marks guarded.
 *
 * Northwind Labs (Sequence Spec Part 2): Jono Owner, Priya Admin, Dana member and lead of Product (Restricted),
 * Marcus and Lena members, Gita outside the org. ORGS_ENABLED on, billing on (cloud). Deletes every row it creates,
 * children before parents, users last, and ends the pool.
 *
 * Locally:
 *     DATABASE_URL=... bun run --filter '@pagespace/lib' test:integration -- src/organizations/__tests__/org-lapse-loosening.integration.test.ts
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { and, eq, inArray, or } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveAgentMembers, driveMembers, driveRoles, pagePermissions } from '@pagespace/db/schema/members';
import { activityLogs } from '@pagespace/db/schema/monitoring';
import { orgGuestHolds } from '@pagespace/db/schema/org-guest-holds';
import { organizations, orgInvitations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { driveShareLinks, pageShareLinks } from '@pagespace/db/schema/share-links';
import { driveJoinRequests } from '@pagespace/db/schema/drive-join-requests';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';

vi.mock('../orgs-enabled', () => ({ ORGS_ENABLED: true }));
// The org audit chain is a separate store this suite does not assert; nothing may be left in it.
vi.mock('../../audit/org-audit', () => ({
  recordOrgAuditEvent: vi.fn(async () => {}),
  recordOrgAuditEventAfterCommit: vi.fn(async () => true),
}));

import { ORG_LAPSED_MESSAGE, ORG_LAPSED_REFUSAL } from '../status';
import { acceptInvitation } from '../invitations';
import { transferOwnership } from '../membership';
import { hashToken } from '../../auth/token-utils';
import { OrgLapsedError, checkDriveMayLoosen, checkPageMayLoosen, guardDriveAccess } from '../../permissions/org-lapse-guard';
import { updateMemberAccess } from '../../services/drive-member-service';
import { createDriveShareLink, createPageShareLink, redeemDriveShareLink, revokeDriveShareLink } from '../../permissions/share-link-service';
import { grantPagePermission } from '../../permissions/permission-mutations';
import { answerDriveJoinRequest, requestToJoinDrive } from '../../services/drive-join-request-service';
import { changeOrgDriveLead } from '../../services/org-drive-service';
import { orgDriveServiceDeps } from '../../services/org-drive-service-deps';
import { createDriveRole, deleteDriveRole, updateDriveRole } from '../../services/drive-role-service';
import { addAgentToDrive, setAgentDriveIncludeContext } from '../../services/drive-agent-service';
import { EnforcedAuthContext } from '../../permissions/enforced-context';
import type { SessionClaims } from '../../auth/session-service';

type Name = 'jono' | 'priya' | 'dana' | 'marcus' | 'lena' | 'gita';

interface World {
  orgId: string;
  product: string;
  ops: string;
  personal: string;
  doc: string;
  personalDoc: string;
  agent: string;
  readerRole: string;
  ids: Record<Name, string>;
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
  const [row] = await db.select({ id: orgSubscriptions.id }).from(orgSubscriptions).where(eq(orgSubscriptions.orgId, orgId));
  if (row) await db.update(orgSubscriptions).set({ status }).where(eq(orgSubscriptions.orgId, orgId));
  else await factories.createOrgSubscription(orgId, { status });
}
const lapse = (w: World) => setSubscription(w.orgId, 'canceled');
const pay = (w: World) => setSubscription(w.orgId, 'active');

const READ = { canView: true, canEdit: false, canShare: false };
const EDIT = { canView: true, canEdit: true, canShare: false };

async function build(): Promise<World> {
  const run = createId().slice(0, 8);
  const make = (name: string) => factories.createUser({ name, subscriptionTier: 'free', email: `${name.split(' ')[0].toLowerCase()}-${run}@northwind.test` });
  const [jono, priya, dana, marcus, lena, gita] = await Promise.all(['Jono', 'Priya Nair', 'Dana Kim', 'Marcus Oyelaran', 'Lena Park', 'Gita Outside'].map(make));
  const [org] = await db
    .insert(organizations)
    .values({ name: 'Northwind Labs', slug: `northwind-${run}`, ownerId: jono.id, policies: { guests: 'on' } })
    .returning();
  await db.insert(orgMembers).values([
    { orgId: org.id, userId: jono.id, role: 'OWNER' },
    { orgId: org.id, userId: priya.id, role: 'ADMIN' },
    { orgId: org.id, userId: dana.id, role: 'MEMBER' },
    { orgId: org.id, userId: marcus.id, role: 'MEMBER' },
    { orgId: org.id, userId: lena.id, role: 'MEMBER' },
  ]);
  const product = await factories.createDrive(dana.id, { name: 'Product', slug: `product-${run}`, orgId: org.id, orgVisibility: 'RESTRICTED' });
  const ops = await factories.createDrive(dana.id, { name: 'Ops', slug: `ops-${run}`, orgId: org.id, orgVisibility: 'RESTRICTED' });
  const personal = await factories.createDrive(dana.id, { name: 'Dana personal', slug: `dana-${run}` });
  const doc = await factories.createPage(product.id, { title: 'Roadmap' });
  const personalDoc = await factories.createPage(personal.id, { title: 'Notes' });
  const agent = await factories.createPage(ops.id, { title: 'Ops agent', type: 'AI_CHAT' });
  const [reader] = await db.insert(driveRoles).values({ driveId: product.id, name: 'Reader', permissions: {}, driveWidePermissions: READ }).returning();
  // Marcus is an accepted MEMBER of Product holding the Reader role, with a view grant on the roadmap.
  await factories.createDriveMember(product.id, marcus.id, { role: 'MEMBER', customRoleId: reader.id, acceptedAt: new Date() });
  await factories.createPagePermission(doc.id, marcus.id, { canView: true });
  // Priya administers Product.
  await factories.createDriveMember(product.id, priya.id, { role: 'ADMIN', acceptedAt: new Date() });
  await setSubscription(org.id, 'active');
  const ids = { jono: jono.id, priya: priya.id, dana: dana.id, marcus: marcus.id, lena: lena.id, gita: gita.id };
  return {
    orgId: org.id, product: product.id, ops: ops.id, personal: personal.id, doc: doc.id, personalDoc: personalDoc.id,
    agent: agent.id, readerRole: reader.id, ids, userIds: Object.values(ids),
  };
}

async function teardown(w: World): Promise<void> {
  await db.delete(orgGuestHolds).where(eq(orgGuestHolds.orgId, w.orgId));
  const ours = (await db.select({ id: drives.id }).from(drives).where(or(eq(drives.orgId, w.orgId), inArray(drives.ownerId, w.userIds)))).map((d) => d.id);
  if (ours.length > 0) {
    await db.delete(activityLogs).where(or(inArray(activityLogs.resourceId, ours), inArray(activityLogs.driveId, ours)));
    await db.delete(driveJoinRequests).where(inArray(driveJoinRequests.driveId, ours));
    await db.delete(driveShareLinks).where(inArray(driveShareLinks.driveId, ours));
    const ourPages = (await db.select({ id: pages.id }).from(pages).where(inArray(pages.driveId, ours))).map((p) => p.id);
    if (ourPages.length > 0) {
      await db.delete(pageShareLinks).where(inArray(pageShareLinks.pageId, ourPages));
      await db.delete(pagePermissions).where(inArray(pagePermissions.pageId, ourPages));
    }
    await db.delete(driveAgentMembers).where(inArray(driveAgentMembers.driveId, ours));
    await db.delete(driveMembers).where(inArray(driveMembers.driveId, ours));
    await db.delete(driveRoles).where(inArray(driveRoles.driveId, ours));
    await db.delete(pages).where(inArray(pages.driveId, ours));
    await db.delete(drives).where(inArray(drives.id, ours));
  }
  await db.delete(activityLogs).where(inArray(activityLogs.userId, w.userIds));
  await db.delete(orgInvitations).where(eq(orgInvitations.orgId, w.orgId));
  await db.delete(orgSubscriptions).where(eq(orgSubscriptions.orgId, w.orgId));
  await db.delete(orgMembers).where(eq(orgMembers.orgId, w.orgId));
  await db.delete(organizations).where(eq(organizations.id, w.orgId));
  await db.delete(users).where(inArray(users.id, w.userIds));
}

const memberRow = async (driveId: string, userId: string) =>
  (await db.select({ role: driveMembers.role, customRoleId: driveMembers.customRoleId }).from(driveMembers)
    .where(and(eq(driveMembers.driveId, driveId), eq(driveMembers.userId, userId))))[0] ?? null;
const grantOf = async (pageId: string, userId: string) =>
  (await db.select({ canView: pagePermissions.canView, canEdit: pagePermissions.canEdit }).from(pagePermissions)
    .where(and(eq(pagePermissions.pageId, pageId), eq(pagePermissions.userId, userId))))[0] ?? null;
const roleGrant = async (roleId: string) =>
  (await db.select({ driveWide: driveRoles.driveWidePermissions, isDefault: driveRoles.isDefault }).from(driveRoles).where(eq(driveRoles.id, roleId)))[0] ?? null;
const linkCount = async (driveId: string) => (await db.select({ id: driveShareLinks.id }).from(driveShareLinks).where(eq(driveShareLinks.driveId, driveId))).length;

describe('[D-OW-33] a lapsed org may only restrict, on every guarded write (orgs on, real Postgres)', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: orgSubscriptions.id }).from(orgSubscriptions).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('org-lapse-loosening.integration.test.ts', error);
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

  it('SEAT-9 (partial) [D-OW-33] checkDriveMayLoosen / checkPageMayLoosen end in the one guard: lapsed and loosening refuses; restricting, a personal drive, or paid never does', async () => {
    if (!world) return;
    const w = world;
    expect(await checkDriveMayLoosen(db, w.product, true)).toBeNull();
    await lapse(w);
    expect(await db.transaction((tx) => checkDriveMayLoosen(tx, w.product, true))).toEqual(ORG_LAPSED_REFUSAL);
    expect(await checkPageMayLoosen(db, w.doc, true)).toEqual(ORG_LAPSED_REFUSAL);
    expect(await checkDriveMayLoosen(db, w.product, false)).toBeNull();
    expect(await checkDriveMayLoosen(db, w.personal, true)).toBeNull();
    expect(await checkPageMayLoosen(db, w.personalDoc, true)).toBeNull();
    await pay(w);
    expect(await checkPageMayLoosen(db, w.doc, true)).toBeNull();
  });

  it('SEAT-9 (partial) [D-OW-33] guardDriveAccess keeps a restricting write and undoes a loosening one while lapsed, only inside its own savepoint; paid, it keeps both', async () => {
    if (!world) return;
    const w = world;
    await lapse(w);
    // A new member loosens: refused, and nothing it wrote is kept.
    await expect(guardDriveAccess(db, w.product, {}, (tx) =>
      tx.insert(driveMembers).values({ driveId: w.product, userId: w.ids.lena, role: 'MEMBER', acceptedAt: new Date() }))).rejects.toBeInstanceOf(OrgLapsedError);
    expect(await memberRow(w.product, w.ids.lena)).toBeNull();
    // Inside a caller's transaction the refusal undoes ONLY the guarded write: the caller's own write survives.
    await db.transaction(async (outer) => {
      await outer.update(pages).set({ title: 'Roadmap v2' }).where(eq(pages.id, w.doc));
      await guardDriveAccess(outer, w.product, {}, (tx) =>
        tx.insert(driveMembers).values({ driveId: w.product, userId: w.ids.lena, role: 'MEMBER', acceptedAt: new Date() })).catch(() => undefined);
    });
    expect((await db.select({ title: pages.title }).from(pages).where(eq(pages.id, w.doc)))[0].title).toBe('Roadmap v2');
    expect(await memberRow(w.product, w.ids.lena)).toBeNull();
    // Removing a member restricts: kept.
    await guardDriveAccess(db, w.product, {}, (tx) => tx.delete(driveMembers).where(and(eq(driveMembers.driveId, w.product), eq(driveMembers.userId, w.ids.marcus))));
    expect(await memberRow(w.product, w.ids.marcus)).toBeNull();
    // A personal drive has no lapse.
    await guardDriveAccess(db, w.personal, {}, (tx) => tx.insert(driveMembers).values({ driveId: w.personal, userId: w.ids.lena, role: 'MEMBER', acceptedAt: new Date() }));
    expect(await memberRow(w.personal, w.ids.lena)).not.toBeNull();
    await pay(w);
    await guardDriveAccess(db, w.product, {}, (tx) => tx.insert(driveMembers).values({ driveId: w.product, userId: w.ids.lena, role: 'MEMBER', acceptedAt: new Date() }));
    expect(await memberRow(w.product, w.ids.lena)).not.toBeNull();
  });

  it('SEAT-9 (partial) [D-OW-33] inventory #1-#2 drive member PATCH (updateMemberAccess): a promotion or a wider grant is refused while lapsed and nothing changes; a demotion and a narrower grant apply; paid, the promotion applies', async () => {
    if (!world) return;
    const w = world;
    await lapse(w);
    await expect(updateMemberAccess(w.product, w.ids.marcus, w.ids.priya, { role: 'ADMIN', permissions: [{ pageId: w.doc, ...READ }] })).rejects.toBeInstanceOf(OrgLapsedError);
    expect(await memberRow(w.product, w.ids.marcus)).toEqual({ role: 'MEMBER', customRoleId: w.readerRole });
    await expect(updateMemberAccess(w.product, w.ids.marcus, w.ids.priya, { role: 'MEMBER', permissions: [{ pageId: w.doc, ...EDIT }] })).rejects.toBeInstanceOf(OrgLapsedError);
    expect(await grantOf(w.doc, w.ids.marcus)).toEqual({ canView: true, canEdit: false });

    // Restricting: Priya demoted, Marcus's grant dropped.
    await updateMemberAccess(w.product, w.ids.priya, w.ids.dana, { role: 'MEMBER', permissions: [] });
    expect((await memberRow(w.product, w.ids.priya))?.role).toBe('MEMBER');
    await updateMemberAccess(w.product, w.ids.marcus, w.ids.dana, { role: 'MEMBER', permissions: [] });
    expect(await grantOf(w.doc, w.ids.marcus)).toBeNull();

    await pay(w);
    await updateMemberAccess(w.product, w.ids.marcus, w.ids.dana, { role: 'ADMIN', permissions: [] });
    expect((await memberRow(w.product, w.ids.marcus))?.role).toBe('ADMIN');
  });

  it('SEAT-9 (partial) [D-OW-33] inventory #11 a direct page grant: wider is refused (ORG_LAPSED, the SEAT-9 copy) for an org member; narrower applies; paid, wider applies', async () => {
    if (!world) return;
    const w = world;
    await lapse(w);
    expect(await grantPagePermission(ctxFor(w.ids.dana), { pageId: w.doc, targetUserId: w.ids.marcus, permissions: { ...EDIT, canDelete: false } }))
      .toEqual({ ok: false, error: { code: 'ORG_LAPSED', message: ORG_LAPSED_MESSAGE } });
    expect(await grantOf(w.doc, w.ids.marcus)).toEqual({ canView: true, canEdit: false });
    expect(await grantPagePermission(ctxFor(w.ids.dana), { pageId: w.doc, targetUserId: w.ids.lena, permissions: { ...READ, canDelete: false } }))
      .toEqual({ ok: false, error: { code: 'ORG_LAPSED', message: ORG_LAPSED_MESSAGE } });
    expect(await grantOf(w.doc, w.ids.lena)).toBeNull();
    // An outsider under guests=on is refused with the lapse copy too, not the guests-off copy (#2844 "Left").
    expect(await grantPagePermission(ctxFor(w.ids.dana), { pageId: w.doc, targetUserId: w.ids.gita, permissions: { ...READ, canDelete: false } }))
      .toEqual({ ok: false, error: { code: 'ORG_LAPSED', message: ORG_LAPSED_MESSAGE } });

    await pay(w);
    expect(await grantPagePermission(ctxFor(w.ids.dana), { pageId: w.doc, targetUserId: w.ids.marcus, permissions: { ...EDIT, canDelete: false } })).toMatchObject({ ok: true });
    await lapse(w);
    // Narrowing back to view only restricts.
    expect(await grantPagePermission(ctxFor(w.ids.dana), { pageId: w.doc, targetUserId: w.ids.marcus, permissions: { ...READ, canDelete: false } })).toMatchObject({ ok: true });
    expect(await grantOf(w.doc, w.ids.marcus)).toEqual({ canView: true, canEdit: false });
  });

  it('SEAT-9 (partial) [D-OW-33] inventory #13-#15 share links: no drive or page link is created while lapsed (ORG_LAPSED, no row); an org member redeeming a pre-lapse link is refused like a missing link and gets no row; revoking works; paid, both go through', async () => {
    if (!world) return;
    const w = world;
    const made = await createDriveShareLink(ctxFor(w.ids.dana), w.product, { role: 'MEMBER' });
    if (!made.ok) throw new Error('setup: link not created');
    await lapse(w);

    expect(await createDriveShareLink(ctxFor(w.ids.dana), w.product, { role: 'MEMBER' })).toEqual({ ok: false, error: 'ORG_LAPSED', message: ORG_LAPSED_MESSAGE });
    expect(await linkCount(w.product)).toBe(1);
    expect(await createPageShareLink(ctxFor(w.ids.dana), w.doc, { permissions: ['VIEW'] })).toEqual({ ok: false, error: 'ORG_LAPSED', message: ORG_LAPSED_MESSAGE });

    expect(await redeemDriveShareLink(ctxFor(w.ids.lena), made.data.rawToken)).toEqual({ ok: false, error: 'NOT_FOUND' });
    expect(await memberRow(w.product, w.ids.lena)).toBeNull();

    await pay(w);
    expect(await redeemDriveShareLink(ctxFor(w.ids.lena), made.data.rawToken)).toMatchObject({ ok: true });
    expect(await memberRow(w.product, w.ids.lena)).not.toBeNull();
    expect(await createPageShareLink(ctxFor(w.ids.dana), w.doc, { permissions: ['VIEW'] })).toMatchObject({ ok: true });

    await lapse(w);
    expect(await revokeDriveShareLink(ctxFor(w.ids.dana), made.data.id)).toEqual({ ok: true, data: undefined });
  });

  it('SEAT-9 (partial) [D-OW-33] inventory #17 a join request: approving is refused while lapsed (402 org_lapsed, the request stays pending, no row); denying works; paid, approving admits', async () => {
    if (!world) return;
    const w = world;
    const asked = await requestToJoinDrive(w.ids.lena, w.product);
    if (!asked.ok) throw new Error(`setup: request refused ${asked.code}`);
    await lapse(w);
    expect(await answerDriveJoinRequest(w.ids.dana, w.product, asked.request.id, 'approve')).toEqual(ORG_LAPSED_REFUSAL);
    expect(await memberRow(w.product, w.ids.lena)).toBeNull();
    expect((await db.select({ status: driveJoinRequests.status }).from(driveJoinRequests).where(eq(driveJoinRequests.id, asked.request.id)))[0].status).toBe('pending');

    await pay(w);
    expect(await answerDriveJoinRequest(w.ids.dana, w.product, asked.request.id, 'approve')).toMatchObject({ ok: true, admitted: true });
    expect(await memberRow(w.product, w.ids.lena)).not.toBeNull();

    // Denying another request restricts nothing and still works while lapsed.
    await db.delete(driveMembers).where(and(eq(driveMembers.driveId, w.ops), eq(driveMembers.userId, w.ids.marcus)));
    const second = await requestToJoinDrive(w.ids.marcus, w.ops);
    if (!second.ok) throw new Error(`setup: request refused ${second.code}`);
    await lapse(w);
    expect(await answerDriveJoinRequest(w.ids.dana, w.ops, second.request.id, 'deny')).toMatchObject({ ok: true, action: 'deny' });
  });

  it('SEAT-9 (partial) [D-OW-33] inventory #18 a lead change is refused while lapsed (the lead is unchanged); paid, it goes through', async () => {
    if (!world) return;
    const w = world;
    await lapse(w);
    expect(await changeOrgDriveLead(w.ids.jono, w.product, { newLeadId: w.ids.marcus }, orgDriveServiceDeps)).toEqual(ORG_LAPSED_REFUSAL);
    expect((await db.select({ ownerId: drives.ownerId }).from(drives).where(eq(drives.id, w.product)))[0].ownerId).toBe(w.ids.dana);
    await pay(w);
    expect(await changeOrgDriveLead(w.ids.jono, w.product, { newLeadId: w.ids.marcus }, orgDriveServiceDeps)).toMatchObject({ ok: true, changed: true });
  });

  it('SEAT-9 (partial) [D-OW-33] inventory #20 an org invitation sent before the lapse cannot be accepted while lapsed (402, no member, the invitation stays open); paid, it joins', async () => {
    if (!world) return;
    const w = world;
    const token = `ps_orginv_${createId()}`;
    const email = (await db.select({ email: users.email }).from(users).where(eq(users.id, w.ids.gita)))[0].email;
    await db.insert(orgInvitations).values({ orgId: w.orgId, email, role: 'MEMBER', tokenHash: hashToken(token), invitedBy: w.ids.jono, expiresAt: new Date(Date.now() + 86_400_000) });
    await lapse(w);
    expect(await acceptInvitation({ token, userId: w.ids.gita, now: new Date() })).toEqual({ ok: false, status: 402, reason: 'org_lapsed' });
    expect(await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, w.orgId), eq(orgMembers.userId, w.ids.gita)))).toHaveLength(0);
    expect((await db.select({ acceptedAt: orgInvitations.acceptedAt }).from(orgInvitations).where(eq(orgInvitations.orgId, w.orgId)))[0].acceptedAt).toBeNull();
    await pay(w);
    expect(await acceptInvitation({ token, userId: w.ids.gita, now: new Date() })).toMatchObject({ ok: true, joined: true });
  });

  it('SEAT-9 (partial) [D-OW-33] inventory #21-#22 drive roles: widening a role someone holds, or deleting it to leave them on the wider plain role, is refused while lapsed; narrowing applies; widening an unused role and creating a non-default one loosen nobody; paid, the widening applies', async () => {
    if (!world) return;
    const w = world;
    await lapse(w);
    await expect(updateDriveRole(w.product, w.readerRole, { driveWidePermissions: EDIT })).rejects.toBeInstanceOf(OrgLapsedError);
    expect((await roleGrant(w.readerRole))?.driveWide).toEqual(READ);
    // A role nobody holds: creating it and widening it give nobody anything.
    const unused = await createDriveRole(w.product, { name: 'Spare', permissions: {}, driveWidePermissions: null });
    await updateDriveRole(w.product, unused.id, { driveWidePermissions: EDIT });
    expect((await roleGrant(unused.id))?.driveWide).toEqual(EDIT);
    // Narrowing Reader restricts.
    await updateDriveRole(w.product, w.readerRole, { driveWidePermissions: { canView: false, canEdit: false, canShare: false } });
    // Now plain MEMBER (view of non-private pages) is wider than Reader: deleting Reader would loosen Marcus.
    await expect(deleteDriveRole(w.product, w.readerRole)).rejects.toBeInstanceOf(OrgLapsedError);
    expect(await roleGrant(w.readerRole)).not.toBeNull();

    await pay(w);
    await updateDriveRole(w.product, w.readerRole, { driveWidePermissions: EDIT });
    expect((await roleGrant(w.readerRole))?.driveWide).toEqual(EDIT);
  });

  it('SEAT-9 (partial) [D-OW-33] inventory #27 drive agents: adding an agent to a lapsed org\'s drive and turning its context on are refused (402 org_lapsed); turning context off applies; paid, adding goes through', async () => {
    if (!world) return;
    const w = world;
    await lapse(w);
    expect(await addAgentToDrive({ actingUserId: w.ids.dana, agentPageId: w.agent, driveId: w.product }))
      .toEqual({ ok: false, status: 402, error: ORG_LAPSED_MESSAGE, code: 'org_lapsed' });
    expect(await db.select().from(driveAgentMembers).where(eq(driveAgentMembers.driveId, w.product))).toHaveLength(0);

    await pay(w);
    expect(await addAgentToDrive({ actingUserId: w.ids.dana, agentPageId: w.agent, driveId: w.product })).toMatchObject({ ok: true });
    await lapse(w);
    expect(await setAgentDriveIncludeContext({ actingUserId: w.ids.dana, agentPageId: w.agent, driveId: w.product, includeContext: true }))
      .toEqual({ ok: false, status: 402, error: ORG_LAPSED_MESSAGE, code: 'org_lapsed' });
    await pay(w);
    expect(await setAgentDriveIncludeContext({ actingUserId: w.ids.dana, agentPageId: w.agent, driveId: w.product, includeContext: true })).toMatchObject({ ok: true });
    await lapse(w);
    expect(await setAgentDriveIncludeContext({ actingUserId: w.ids.dana, agentPageId: w.agent, driveId: w.product, includeContext: false })).toMatchObject({ ok: true });
  });

  it('SEAT-9 (partial) [D-OW-33] inventory #19 ruling: while lapsed, ownership moves to an existing Admin (who already reaches every org drive); a transfer that would grant new access (a plain Member) is refused 402 and nothing moves; an outsider is refused as always; paid, a Member can take it', async () => {
    if (!world) return;
    const w = world;
    const ownerOf = async () => (await db.select({ ownerId: organizations.ownerId }).from(organizations).where(eq(organizations.id, w.orgId)))[0].ownerId;
    const roleOf = async (userId: string) => (await db.select({ role: orgMembers.role }).from(orgMembers).where(and(eq(orgMembers.orgId, w.orgId), eq(orgMembers.userId, userId))))[0]?.role ?? null;
    await lapse(w);

    expect(await transferOwnership({ orgId: w.orgId, actorId: w.ids.jono, targetId: w.ids.marcus })).toEqual({ ok: false, status: 402, reason: 'org_lapsed' });
    expect(await ownerOf()).toBe(w.ids.jono);
    expect(await roleOf(w.ids.marcus)).toBe('MEMBER');
    expect(await roleOf(w.ids.jono)).toBe('OWNER');
    expect(await transferOwnership({ orgId: w.orgId, actorId: w.ids.jono, targetId: w.ids.gita })).toMatchObject({ ok: false, reason: 'target_not_member' });

    expect(await transferOwnership({ orgId: w.orgId, actorId: w.ids.jono, targetId: w.ids.priya })).toEqual({ ok: true });
    expect(await ownerOf()).toBe(w.ids.priya);
    expect(await roleOf(w.ids.jono)).toBe('ADMIN');

    await pay(w);
    expect(await transferOwnership({ orgId: w.orgId, actorId: w.ids.priya, targetId: w.ids.lena })).toEqual({ ok: true });
    expect(await ownerOf()).toBe(w.ids.lena);
  });
});
