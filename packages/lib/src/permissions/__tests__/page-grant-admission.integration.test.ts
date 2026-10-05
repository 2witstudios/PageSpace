/**
 * A direct page grant is an admission the guests policy decides — REAL Postgres (Spec POL-2, X-6; Review 3+4 P1-3).
 *
 * Before this, `grantPagePermission` wrote a page grant for anyone, so an org with guests OFF still let an outsider
 * in through the page Share dialog, and turning guests off left such page-grant-only outsiders with their access.
 * Here: off refuses a widening grant, approve queues it and grants nothing until an Owner or Admin approves (the
 * approval replays exactly the grant that was asked), on grants; and guests off PARKS an outsider whose only access
 * is a page grant, restoring it when guests come back.
 *
 * Locally:
 *     DATABASE_URL=... bun run --filter '@pagespace/lib' test:integration -- src/permissions/__tests__/page-grant-admission.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { factories } from '@pagespace/db/test/factories';
import { db, pool } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveMembers, pagePermissions } from '@pagespace/db/schema/members';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { orgGuestHolds } from '@pagespace/db/schema/org-guest-holds';
import type { SessionClaims } from '../../auth/session-service';

vi.mock('../../organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));
vi.mock('../../audit/org-audit', () => ({ recordOrgAuditEvent: vi.fn(async () => {}), recordOrgAuditEventAfterCommit: vi.fn(async () => true) }));
vi.mock('../revocation-kick', () => ({ kickForDriveMembershipRevocation: vi.fn(async () => {}), kickForPagePermissionRevocation: vi.fn(async () => {}) }));
vi.mock('../../monitoring/activity-logger', () => ({ logPermissionActivity: vi.fn(), getActorInfo: vi.fn(async () => ({ actorEmail: 'a@x', actorDisplayName: 'A' })) }));

import { recordOrgAuditEvent } from '../../audit/org-audit';
import { updateOrgPolicies } from '../../organizations/policies';
import { EnforcedAuthContext } from '../enforced-context';
import { grantPagePermission } from '../permission-mutations';
import { getUserAccessLevel } from '../permissions';
import { claimPendingGuestApproval, listSuspendedOrgGuests } from '../guest-holds';
import { completeApprovedPageGrant } from '../page-grant-admission';

const run = createId().slice(0, 8);
const created = { userIds: [] as string[], driveIds: [] as string[], orgIds: [] as string[] };

interface World {
  orgId: string;
  owner: string;
  member: string;
  outsider: string;
  orgDrive: string;
  personalDrive: string;
  personalOwner: string;
  page: string;
  page2: string;
  personalPage: string;
}
let w: World;

async function cleanup() {
  // Children before parents: holds and grants go with their drive (cascade), org rows next, users last.
  if (created.driveIds.length) await db.delete(drives).where(inArray(drives.id, created.driveIds));
  if (created.orgIds.length) {
    await db.delete(orgGuestHolds).where(inArray(orgGuestHolds.orgId, created.orgIds));
    await db.delete(orgMembers).where(inArray(orgMembers.orgId, created.orgIds));
    await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, created.orgIds));
    await db.delete(organizations).where(inArray(organizations.id, created.orgIds));
  }
  if (created.userIds.length) await db.delete(users).where(inArray(users.id, created.userIds));
  created.userIds = [];
  created.driveIds = [];
  created.orgIds = [];
}

beforeEach(async () => {
  vi.mocked(recordOrgAuditEvent).mockClear();
  const mk = async () => {
    const u = await factories.createUser();
    created.userIds.push(u.id);
    return u.id;
  };
  const [owner, member, outsider, personalOwner] = [await mk(), await mk(), await mk(), await mk()];
  const orgId = createId();
  created.orgIds.push(orgId);
  await db.insert(organizations).values({ id: orgId, name: 'Northwind', slug: `nw-${run}-${createId().slice(0, 4)}`, ownerId: owner });
  // A paying org (D-OW-30: no subscription is lapsed, and a lapsed org may only restrict, [D-OW-33]).
  await factories.createOrgSubscription(orgId);
  await db.insert(orgMembers).values([
    { orgId, userId: owner, role: 'OWNER' },
    { orgId, userId: member, role: 'MEMBER' },
  ]);
  const orgDriveRow = await factories.createDrive(owner);
  const personalDriveRow = await factories.createDrive(personalOwner);
  created.driveIds.push(orgDriveRow.id, personalDriveRow.id);
  await db.update(drives).set({ orgId, orgVisibility: 'PRIVATE' }).where(eq(drives.id, orgDriveRow.id));
  const page = (await factories.createPage(orgDriveRow.id)).id;
  const page2 = (await factories.createPage(orgDriveRow.id)).id;
  const personalPage = (await factories.createPage(personalDriveRow.id)).id;
  w = { orgId, owner, member, outsider, orgDrive: orgDriveRow.id, personalDrive: personalDriveRow.id, personalOwner, page, page2, personalPage };
});

afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

function ctxFor(userId: string): EnforcedAuthContext {
  const claims: SessionClaims = {
    sessionId: 'sess', userId, userRole: 'user', tokenVersion: 1,
    adminRoleVersion: 0, type: 'user', scopes: ['*'],
    expiresAt: new Date(Date.now() + 3600_000),
    driveId: undefined,
  };
  return EnforcedAuthContext.fromSession(claims);
}

const setGuests = (guests: 'off' | 'approve' | 'on') => updateOrgPolicies({ orgId: w.orgId, actorId: w.owner, patch: { guests } });
const VIEW = { canView: true, canEdit: false, canShare: false, canDelete: false };
const EDIT = { canView: true, canEdit: true, canShare: false, canDelete: false };
const grant = (targetUserId: string, permissions = VIEW, pageId = w.page, actor = w.owner) =>
  grantPagePermission(ctxFor(actor), { pageId, targetUserId, permissions });
const grantsOf = (userId: string) => db.select().from(pagePermissions).where(eq(pagePermissions.userId, userId));
const holdsOf = (state: 'suspended' | 'pending_approval') => db.select().from(orgGuestHolds).where(and(eq(orgGuestHolds.orgId, w.orgId), eq(orgGuestHolds.state, state)));

describe('grantPagePermission asks the guests policy', () => {
  it('POL-2 (partial) X-6 (partial) guests OFF: a page grant to an outsider is refused naming the policy, and NO grant is written', async () => {
    await setGuests('off');
    const result = await grant(w.outsider);
    expect(result).toMatchObject({ ok: false, error: { code: 'GUEST_POLICY_OFF' } });
    expect(await grantsOf(w.outsider)).toEqual([]);
    expect(await getUserAccessLevel(w.outsider, w.page)).toBeNull();
  });

  it('POL-2 (partial) guests APPROVE: the grant is queued with exactly what was asked, NOTHING is granted, and the request is audited', async () => {
    await setGuests('approve');
    const result = await grant(w.outsider, EDIT);
    expect(result).toMatchObject({ ok: false, error: { code: 'GUEST_APPROVAL_PENDING' } });
    expect(await grantsOf(w.outsider)).toEqual([]);
    const [hold] = await holdsOf('pending_approval');
    expect(hold).toMatchObject({ driveId: w.orgDrive, userId: w.outsider, origin: 'page_grant', requestedBy: w.owner });
    expect(hold.request).toEqual({ permissions: [{ pageId: w.page, ...EDIT }], invitedBy: w.owner });
    if (result.ok || result.error.code !== 'GUEST_APPROVAL_PENDING') throw new Error('expected a queued grant');
    expect(result.error.holdId).toBe(hold.id);
    expect(recordOrgAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ orgId: w.orgId, eventType: 'org.guest.requested', details: expect.objectContaining({ origin: 'page_grant', holdId: hold.id }) }));
  });

  it('POL-2 (partial) guests ON grants the outsider at once, as before', async () => {
    await setGuests('on');
    expect(await grant(w.outsider)).toMatchObject({ ok: true, data: { isUpdate: false } });
    expect(await grantsOf(w.outsider)).toHaveLength(1);
    expect(await holdsOf('pending_approval')).toEqual([]);
  });

  it('POL-2 (partial) X-6 (partial) an org member is never a guest, and a personal drive has no guest policy', async () => {
    await setGuests('off');
    expect(await grant(w.member)).toMatchObject({ ok: true });
    expect(await grant(w.outsider, VIEW, w.personalPage, w.personalOwner)).toMatchObject({ ok: true });
  });

  it('POL-2 (partial) narrowing an existing outsider grant is never refused: a guest can always be given less', async () => {
    await db.insert(pagePermissions).values({ pageId: w.page, userId: w.outsider, ...EDIT, grantedBy: w.owner });
    await db.update(organizations).set({ policies: { guests: 'off' } }).where(eq(organizations.id, w.orgId));
    expect(await grant(w.outsider, VIEW)).toMatchObject({ ok: true, data: { isUpdate: true } });
    expect((await grantsOf(w.outsider))[0]).toMatchObject(VIEW);
    // Widening the same grant is an admission again.
    expect(await grant(w.outsider, EDIT)).toMatchObject({ ok: false, error: { code: 'GUEST_POLICY_OFF' } });
  });
});

describe('approving a queued page grant', () => {
  async function queue(permissions = EDIT) {
    await setGuests('approve');
    await grant(w.outsider, permissions);
    const [hold] = await holdsOf('pending_approval');
    const claim = await claimPendingGuestApproval({ orgId: w.orgId, holdId: hold.id });
    if (!claim) throw new Error('expected a claim');
    return claim;
  }

  it('POL-2 (partial) replays exactly the grant that was asked, granted by the original sharer', async () => {
    const claim = await queue();
    expect(await completeApprovedPageGrant(claim)).toEqual({ ok: true, driveId: w.orgDrive, userId: w.outsider, pageIds: [w.page] });
    expect(await grantsOf(w.outsider)).toEqual([expect.objectContaining({ pageId: w.page, ...EDIT, grantedBy: w.owner })]);
  });

  it('POL-2 (partial) guests turned OFF since the request: nothing is granted', async () => {
    const claim = await queue();
    await db.update(organizations).set({ policies: { guests: 'off' } }).where(eq(organizations.id, w.orgId));
    expect(await completeApprovedPageGrant(claim)).toEqual({ ok: false, error: 'POLICY_OFF' });
    expect(await grantsOf(w.outsider)).toEqual([]);
  });

  it('POL-2 (partial) a page deleted since the request grants nothing', async () => {
    const claim = await queue();
    await db.delete(pages).where(eq(pages.id, w.page));
    expect(await completeApprovedPageGrant(claim)).toEqual({ ok: false, error: 'PAGE_GONE' });
    expect(await grantsOf(w.outsider)).toEqual([]);
  });

  it('POL-2 (partial) a grant that EXPIRED while it waited for approval grants nothing; one still live keeps its expiry (review #2762 M9)', async () => {
    const claim = await queue();
    const asked = claim.request.permissions ?? [];
    const lapsed = new Date(Date.now() - 60_000).toISOString();
    const expired = { ...claim, request: { ...claim.request, permissions: asked.map((p) => ({ ...p, expiresAt: lapsed })) } };
    expect(await completeApprovedPageGrant(expired)).toEqual({ ok: false, error: 'PAGE_GONE' });
    expect(await grantsOf(w.outsider)).toEqual([]);

    const later = new Date(Date.now() + 86_400_000);
    const live = { ...claim, request: { ...claim.request, permissions: asked.map((p) => ({ ...p, expiresAt: later.toISOString() })) } };
    expect(await completeApprovedPageGrant(live)).toEqual({ ok: true, driveId: w.orgDrive, userId: w.outsider, pageIds: [w.page] });
    expect((await grantsOf(w.outsider))[0]?.expiresAt?.toISOString()).toBe(later.toISOString());
  });

  it('POL-2 (partial) a request that is not a page grant is not replayed here', async () => {
    const claim = await queue();
    expect(await completeApprovedPageGrant({ ...claim, origin: 'invite' })).toEqual({ ok: false, error: 'NOT_A_PAGE_GRANT' });
  });
});

describe('guests off parks page-grant-only outsiders', () => {
  it('POL-1 (partial) POL-2 (partial) X-6 (partial) an outsider whose ONLY access is a page grant loses it when guests turn off, and gets exactly it back when they turn on', async () => {
    await db.insert(pagePermissions).values([
      { pageId: w.page, userId: w.outsider, ...VIEW, grantedBy: w.owner },
      { pageId: w.page2, userId: w.outsider, ...EDIT, grantedBy: w.owner },
    ]);
    const before = (await grantsOf(w.outsider)).sort((a, b) => a.pageId.localeCompare(b.pageId));
    expect(await db.select().from(driveMembers).where(eq(driveMembers.userId, w.outsider))).toEqual([]);

    const off = await setGuests('off');
    if (!off.ok) throw new Error('expected ok');

    expect(await grantsOf(w.outsider)).toEqual([]);
    expect(await getUserAccessLevel(w.outsider, w.page)).toBeNull();
    const [hold] = await holdsOf('suspended');
    expect(hold).toMatchObject({ driveId: w.orgDrive, userId: w.outsider, origin: 'page_grant' });
    expect(hold.parked?.member).toBeNull();
    expect(hold.parked?.grants).toHaveLength(2);
    expect(off.suspended.map((s) => [s.kind, s.id, s.userId])).toEqual([['guests', hold.id, w.outsider]]);
    expect((await listSuspendedOrgGuests(w.orgId, 10)).total).toBe(1);

    await setGuests('on');

    expect((await grantsOf(w.outsider)).sort((a, b) => a.pageId.localeCompare(b.pageId))).toEqual(before);
    expect(await holdsOf('suspended')).toEqual([]);
  });

  it('POL-1 (partial) X-6 (partial) org members, the drive lead and grants on personal drives are never parked', async () => {
    await db.insert(pagePermissions).values([
      { pageId: w.page, userId: w.member, ...VIEW, grantedBy: w.owner },
      { pageId: w.personalPage, userId: w.outsider, ...VIEW, grantedBy: w.personalOwner },
    ]);
    await setGuests('off');
    expect(await grantsOf(w.member)).toHaveLength(1);
    expect(await grantsOf(w.outsider)).toHaveLength(1);
    expect(await holdsOf('suspended')).toEqual([]);
  });

  it('POL-1 (partial) a page-grant-only outsider is parked once: re-running the suspension adds nothing and loses nothing', async () => {
    await db.insert(pagePermissions).values({ pageId: w.page, userId: w.outsider, ...VIEW, grantedBy: w.owner });
    await setGuests('off');
    const { suspendOrgGuests } = await import('../guest-holds');
    expect(await db.transaction((tx) => suspendOrgGuests(tx, w.orgId))).toEqual([]);
    const holds = await holdsOf('suspended');
    expect(holds).toHaveLength(1);
    expect(holds[0].parked?.grants).toHaveLength(1);
  });
});

describe('a grant racing a switch to guests off', () => {
  it('POL-2 (partial) X-6 (partial) a grant asked while the policy writer holds the org row waits for it, then sees OFF and writes nothing', async () => {
    await setGuests('on');
    const writer = await pool.connect();
    try {
      await writer.query('begin');
      // What updateOrgPolicies does first: take the org row FOR UPDATE.
      await writer.query('select id from organizations where id = $1 for update', [w.orgId]);

      let settled = false;
      const racing = grant(w.outsider).finally(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);

      await writer.query(`update organizations set policies = '{"guests":"off"}'::jsonb where id = $1`, [w.orgId]);
      await writer.query('commit');

      expect(await racing).toMatchObject({ ok: false, error: { code: 'GUEST_POLICY_OFF' } });
      expect(await grantsOf(w.outsider)).toEqual([]);
    } finally {
      writer.release();
    }
  });
});
