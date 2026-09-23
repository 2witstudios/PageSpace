/**
 * Join requests for Restricted org drives — REAL Postgres (Spec DRV-6, D-OW-22).
 *
 * The decisions are unit-tested in permissions/__tests__/drive-join-requests.test.ts. This file
 * proves what only the database can: a pending request grants nothing through any resolver,
 * listing or recipient list; approval is the one path that writes a drive_members row (through the
 * org membership sync), and nothing else turns a request into membership; the partial unique index
 * keeps one pending request per (drive, user).
 *
 * Locally:
 *     DATABASE_URL=... bun run --filter '@pagespace/lib' test:integration -- src/services/__tests__/drive-join-request-service.integration.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { and, eq, inArray, or } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers, driveRoles } from '@pagespace/db/schema/members';
import { driveJoinRequests } from '@pagespace/db/schema/drive-join-requests';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { activityLogs } from '@pagespace/db/schema/monitoring';
import {
  answerDriveJoinRequest,
  listPendingDriveJoinRequests,
  requestToJoinDrive,
  withdrawDriveJoinRequest,
} from '../drive-join-request-service';
import { syncDriveOrgMembership, syncOrgMemberAccess, syncOrgMembership } from '../org-membership-sync';
import { getDriveRecipientUserIds } from '../drive-member-service';
import { listAccessibleDrives } from '../drive-service';
import { getUserDriveAccess, usersShareDrive } from '../../permissions/permissions';
import { changeDriveVisibility, changeOrgDriveLead, moveDriveOutOfOrg } from '../org-drive-service';
import { orgDriveServiceDeps } from '../org-drive-service-deps';
import { leaveOrganization } from '../../organizations/leave';
import { deleteOrganization } from '../../organizations/deletion';

vi.mock('../../organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));

// Northwind Labs fixture names (Sequence Spec Part 2), with per-run ids. Marcus leads Customer
// Research (Restricted); Jono owns the org, Priya is an Admin, Lena and Nina are members, Chris is
// outside the org.
const run = createId().slice(0, 8);
const jono = createId();
const priya = createId();
const marcus = createId();
const lena = createId();
const nina = createId();
const chris = createId();
const northwind = createId();
const userIds = [jono, priya, marcus, lena, nina, chris];
let research: string;
let defaultRoleId: string;

/** Children before parents, users last: CI shares one database across suites. */
async function cleanup() {
  // Lead changes, leaves and org deletion write activity events on the drive and by these people.
  const ours = await db.select({ id: drives.id }).from(drives).where(or(eq(drives.orgId, northwind), inArray(drives.ownerId, userIds)));
  await db.delete(activityLogs).where(or(inArray(activityLogs.userId, userIds), inArray(activityLogs.resourceId, [northwind, ...ours.map((d) => d.id)])));
  await db.delete(drives).where(or(eq(drives.orgId, northwind), inArray(drives.ownerId, userIds)));
  await db.delete(orgMembers).where(eq(orgMembers.orgId, northwind));
  await db.delete(organizations).where(eq(organizations.id, northwind));
  await db.delete(users).where(inArray(users.id, userIds));
}

beforeEach(async () => {
  await cleanup();
  await db.insert(users).values(userIds.map((id, i) => ({
    id, email: `${['jono', 'priya', 'marcus', 'lena', 'nina', 'chris'][i]}-${run}@northwind.test`, name: `User ${i}`, updatedAt: new Date(),
  })));
  await db.insert(organizations).values({ id: northwind, name: 'Northwind Labs', slug: `northwind-${run}`, ownerId: jono });
  await db.insert(orgMembers).values([
    { orgId: northwind, userId: jono, role: 'OWNER' },
    { orgId: northwind, userId: priya, role: 'ADMIN' },
    { orgId: northwind, userId: marcus, role: 'MEMBER' },
    { orgId: northwind, userId: lena, role: 'MEMBER' },
    { orgId: northwind, userId: nina, role: 'MEMBER' },
  ]);
  research = createId();
  await db.insert(drives).values({
    id: research, name: 'Customer Research', slug: `research-${run}`, ownerId: marcus, orgId: northwind, orgVisibility: 'RESTRICTED', updatedAt: new Date(),
  });
  const [role] = await db.insert(driveRoles).values({ driveId: research, name: 'Reader', isDefault: true, permissions: {} }).returning();
  defaultRoleId = role.id;
});

afterEach(cleanup);

afterAll(async () => {
  await cleanup();
  await pool.end();
});

const rowsOf = (userId: string) =>
  db.select().from(driveMembers).where(and(eq(driveMembers.driveId, research), eq(driveMembers.userId, userId)));

async function requestAs(userId: string, message?: string) {
  const result = await requestToJoinDrive(userId, research, { message });
  if (!result.ok) throw new Error(`request refused: ${result.code}`);
  return result;
}

/** Everything a membership would show up in, for one person. */
async function membershipFootprint(userId: string) {
  return {
    rows: (await rowsOf(userId)).length,
    resolves: await getUserDriveAccess(userId, research),
    listed: (await listAccessibleDrives(userId)).some((d) => d.id === research),
    recipient: (await getDriveRecipientUserIds(research)).includes(userId),
    sharesDriveWithLead: await usersShareDrive(userId, marcus),
  };
}

const NOTHING = { rows: 0, resolves: false, listed: false, recipient: false, sharesDriveWithLead: false };

describe('requestToJoinDrive', () => {
  it('DRV-6 (partial) a pending request grants nothing: no row, no access, not listed, not a recipient, not a co-member', async () => {
    const { request, created } = await requestAs(lena, 'I run the interview program');

    expect(created).toBe(true);
    expect(request).toMatchObject({ driveId: research, userId: lena, status: 'pending', message: 'I run the interview program', decidedAt: null, decidedBy: null });
    expect(await membershipFootprint(lena)).toEqual(NOTHING);
  });

  it('DRV-6 (partial) a second request while one is open returns the same request, and the database refuses a second pending row', async () => {
    const first = await requestAs(lena);
    const second = await requestAs(lena);

    expect(second.created).toBe(false);
    expect(second.request.id).toBe(first.request.id);
    await expect(db.insert(driveJoinRequests).values({ driveId: research, userId: lena })).rejects.toMatchObject({
      cause: { code: '23505', constraint: 'drive_join_requests_one_pending_key' },
    });
    expect(await db.select().from(driveJoinRequests).where(eq(driveJoinRequests.driveId, research))).toHaveLength(1);
  });

  it('DRV-6 (partial) someone outside the org, and a plain member asking about a Private drive, are told the drive is not found', async () => {
    expect(await requestToJoinDrive(chris, research)).toMatchObject({ ok: false, code: 'DRIVE_NOT_FOUND', status: 404 });
    await db.update(drives).set({ orgVisibility: 'PRIVATE' }).where(eq(drives.id, research));
    expect(await requestToJoinDrive(lena, research)).toMatchObject({ ok: false, code: 'DRIVE_NOT_FOUND', status: 404 });
    expect(await db.select().from(driveJoinRequests).where(eq(driveJoinRequests.driveId, research))).toHaveLength(0);
  });
});

describe('answerDriveJoinRequest', () => {
  it('DRV-6 (partial) the lead approves: the requester gets an accepted direct row with the drive default role, resolves, is listed and is a recipient', async () => {
    const { request } = await requestAs(lena);

    const result = await answerDriveJoinRequest(marcus, research, request.id, 'approve');

    expect(result).toMatchObject({ ok: true, action: 'approve', admitted: true, request: { status: 'approved', decidedBy: marcus } });
    const [row] = await rowsOf(lena);
    expect(row).toMatchObject({ role: 'MEMBER', source: 'invite', customRoleId: defaultRoleId, invitedBy: marcus });
    expect(row.acceptedAt).not.toBeNull();
    expect(await membershipFootprint(lena)).toEqual({ rows: 1, resolves: true, listed: true, recipient: true, sharesDriveWithLead: true });
  });

  it('DRV-6 (partial) an org Admin approves; a plain member cannot, and their attempt writes nothing', async () => {
    const { request } = await requestAs(lena);

    expect(await answerDriveJoinRequest(nina, research, request.id, 'approve')).toMatchObject({ ok: false, code: 'NOT_APPROVER', status: 403 });
    expect(await membershipFootprint(lena)).toEqual(NOTHING);
    const [stillPending] = await db.select().from(driveJoinRequests).where(eq(driveJoinRequests.id, request.id));
    expect(stillPending.status).toBe('pending');

    expect(await answerDriveJoinRequest(priya, research, request.id, 'approve')).toMatchObject({ ok: true, admitted: true });
    expect((await membershipFootprint(lena)).resolves).toBe(true);
  });

  it('DRV-6 (partial) a member cannot approve their own request, even as an org Admin', async () => {
    const { request } = await requestAs(priya);

    expect(await answerDriveJoinRequest(priya, research, request.id, 'approve')).toMatchObject({ ok: false, code: 'SELF_DECISION', status: 403 });
    expect(await rowsOf(priya)).toHaveLength(0);
  });

  it('DRV-6 (partial) a refused request writes no row and can be asked again', async () => {
    const { request } = await requestAs(lena);

    expect(await answerDriveJoinRequest(marcus, research, request.id, 'deny')).toMatchObject({ ok: true, action: 'deny', admitted: false, request: { status: 'denied' } });
    expect(await membershipFootprint(lena)).toEqual(NOTHING);
    expect(await answerDriveJoinRequest(marcus, research, request.id, 'approve')).toMatchObject({ ok: false, code: 'NOT_PENDING' });
    expect(await rowsOf(lena)).toHaveLength(0);

    const again = await requestAs(lena);
    expect(again.created).toBe(true);
    expect(again.request.id).not.toBe(request.id);
  });

  it('DRV-6 (partial) a withdrawn request writes no row, cannot be approved, and can be asked again', async () => {
    const { request } = await requestAs(lena);

    expect(await withdrawDriveJoinRequest(nina, research, request.id)).toMatchObject({ ok: false, code: 'REQUEST_NOT_FOUND' });
    expect(await withdrawDriveJoinRequest(lena, research, request.id)).toMatchObject({ ok: true, request: { status: 'withdrawn' } });
    expect(await answerDriveJoinRequest(marcus, research, request.id, 'approve')).toMatchObject({ ok: false, code: 'NOT_PENDING' });
    expect(await rowsOf(lena)).toHaveLength(0);
    expect((await requestAs(lena)).created).toBe(true);
  });

  it('DRV-7 (partial) approval admits nobody once the drive turned Private, and the request stays pending', async () => {
    const { request } = await requestAs(lena);
    await db.update(drives).set({ orgVisibility: 'PRIVATE' }).where(eq(drives.id, research));

    expect(await answerDriveJoinRequest(priya, research, request.id, 'approve')).toMatchObject({ ok: false, code: 'NOT_RESTRICTED' });
    expect(await rowsOf(lena)).toHaveLength(0);
    const [row] = await db.select().from(driveJoinRequests).where(eq(driveJoinRequests.id, request.id));
    expect(row.status).toBe('pending');
  });

  it('DRV-6 (partial) a requester who left the org is not admitted', async () => {
    const { request } = await requestAs(lena);
    await db.delete(orgMembers).where(and(eq(orgMembers.orgId, northwind), eq(orgMembers.userId, lena)));

    expect(await answerDriveJoinRequest(marcus, research, request.id, 'approve')).toMatchObject({ ok: false, code: 'REQUESTER_NOT_ORG_MEMBER' });
    expect(await rowsOf(lena)).toHaveLength(0);
  });

  it('DRV-6 (partial) approval never accepts a pending invitation on the requester\'s behalf', async () => {
    const { request } = await requestAs(lena);
    await db.insert(driveMembers).values({ driveId: research, userId: lena, role: 'ADMIN', invitedBy: marcus });

    expect(await answerDriveJoinRequest(marcus, research, request.id, 'approve')).toMatchObject({ ok: false, code: 'PENDING_INVITE' });
    const [row] = await rowsOf(lena);
    expect(row).toMatchObject({ role: 'ADMIN', acceptedAt: null });
  });

  it('DRV-6 (partial) a request answered for another drive\'s id is not found', async () => {
    const { request } = await requestAs(lena);
    const other = createId();
    await db.insert(drives).values({ id: other, name: 'Other', slug: `other-${run}`, ownerId: priya, orgId: northwind, orgVisibility: 'RESTRICTED', updatedAt: new Date() });

    expect(await answerDriveJoinRequest(priya, other, request.id, 'approve')).toMatchObject({ ok: false, code: 'REQUEST_NOT_FOUND' });
    expect(await rowsOf(lena)).toHaveLength(0);
  });
});

describe('approval is the only path from a request to membership', () => {
  it('DRV-6 (partial) every org membership sync entry point, run with a request pending, leaves the requester without a row', async () => {
    await requestAs(lena);

    await syncDriveOrgMembership(research);
    await syncOrgMembership(northwind);
    await syncOrgMemberAccess(northwind, lena);

    expect(await membershipFootprint(lena)).toEqual(NOTHING);
    const [request] = await db.select().from(driveJoinRequests).where(eq(driveJoinRequests.userId, lena));
    expect(request.status).toBe('pending');
  });

  it('DRV-6 (partial) a denial, a withdrawal and a refused approval write no drive_members row for anyone', async () => {
    const lenaRequest = (await requestAs(lena)).request;
    const ninaRequest = (await requestAs(nina)).request;
    const before = await db.select().from(driveMembers).where(eq(driveMembers.driveId, research));

    await answerDriveJoinRequest(marcus, research, lenaRequest.id, 'deny');
    await withdrawDriveJoinRequest(nina, research, ninaRequest.id);
    await answerDriveJoinRequest(nina, research, lenaRequest.id, 'approve');

    expect(await db.select().from(driveMembers).where(eq(driveMembers.driveId, research))).toEqual(before);
  });
});

describe('listPendingDriveJoinRequests', () => {
  it('DRV-6 (partial) the lead and org Admins see pending requests with who asked; a plain member and an outsider do not', async () => {
    await requestAs(lena, 'please');
    const denied = (await requestAs(nina)).request;
    await answerDriveJoinRequest(marcus, research, denied.id, 'deny');

    const forLead = await listPendingDriveJoinRequests(marcus, research);
    expect(forLead).toMatchObject({ ok: true, requests: [{ userId: lena, message: 'please', email: `lena-${run}@northwind.test` }] });
    expect(forLead.ok && forLead.requests).toHaveLength(1);
    expect(await listPendingDriveJoinRequests(priya, research)).toMatchObject({ ok: true });
    expect(await listPendingDriveJoinRequests(nina, research)).toMatchObject({ ok: false, code: 'NOT_APPROVER' });
    expect(await listPendingDriveJoinRequests(chris, research)).toMatchObject({ ok: false, code: 'REQUEST_NOT_FOUND' });
  });
});

describe('a pending request closes when what it asked for is gone', () => {
  const statusOf = async (requestId: string) => {
    const [row] = await db.select().from(driveJoinRequests).where(eq(driveJoinRequests.id, requestId));
    return row;
  };
  const pendingFor = async (approverId: string) => {
    const listed = await listPendingDriveJoinRequests(approverId, research);
    return listed.ok ? listed.requests.map((r) => r.userId) : listed.code;
  };
  const expectClosed = async (requestId: string) => {
    const row = await statusOf(requestId);
    expect(row).toMatchObject({ status: 'withdrawn', decidedBy: null });
    expect(row.decidedAt).not.toBeNull();
  };

  it('DRV-6 (partial) the drive leaving Restricted for Open closes it, off the approver list', async () => {
    const { request } = await requestAs(lena);

    expect(await changeDriveVisibility(priya, research, { orgVisibility: 'OPEN' }, orgDriveServiceDeps)).toMatchObject({ ok: true, changed: true });

    await expectClosed(request.id);
    expect(await pendingFor(marcus)).toEqual([]);
  });

  it('DRV-6 (partial) the drive leaving Restricted for Private closes it, and a return to Restricted does not revive it', async () => {
    const { request } = await requestAs(lena);

    await changeDriveVisibility(priya, research, { orgVisibility: 'PRIVATE' }, orgDriveServiceDeps);
    await expectClosed(request.id);
    await changeDriveVisibility(priya, research, { orgVisibility: 'RESTRICTED' }, orgDriveServiceDeps);

    await expectClosed(request.id);
    expect(await answerDriveJoinRequest(marcus, research, request.id, 'approve')).toMatchObject({ ok: false, code: 'NOT_PENDING' });
    expect(await rowsOf(lena)).toHaveLength(0);
  });

  it('DRV-6 (partial) the requester leaving the org closes their request, and the lead no longer sees their name or email; another request stays', async () => {
    const lenaRequest = (await requestAs(lena)).request;
    const ninaRequest = (await requestAs(nina)).request;

    expect(await leaveOrganization(lena, northwind)).toMatchObject({ ok: true });

    await expectClosed(lenaRequest.id);
    expect((await statusOf(ninaRequest.id)).status).toBe('pending');
    expect(await pendingFor(marcus)).toEqual([nina]);
  });

  it('DRV-6 (partial) the drive moving out of the org closes every request on it', async () => {
    const { request } = await requestAs(lena);

    expect(await moveDriveOutOfOrg(priya, research, { implicitMembers: 'remove' }, orgDriveServiceDeps)).toMatchObject({ ok: true });

    await expectClosed(request.id);
  });

  it('DRV-6 (partial) the requester becoming the lead closes their request; another requester\'s stays with the new lead', async () => {
    const lenaRequest = (await requestAs(lena)).request;
    const ninaRequest = (await requestAs(nina)).request;

    expect(await changeOrgDriveLead(priya, research, { newLeadId: lena }, orgDriveServiceDeps)).toMatchObject({ ok: true, changed: true });

    await expectClosed(lenaRequest.id);
    expect((await statusOf(ninaRequest.id)).status).toBe('pending');
    const forNewLead = await listPendingDriveJoinRequests(lena, research);
    expect(forNewLead.ok && forNewLead.requests.map((r) => r.userId)).toEqual([nina]);
  });

  it('DRV-6 (partial) a requester who became a member another way drops off the approver list at once, and the next transition closes the request', async () => {
    const lenaRequest = (await requestAs(lena)).request;
    const ninaRequest = (await requestAs(nina)).request;
    // The lead invited Lena directly and she accepted (a path that never looks at join requests).
    await db.insert(driveMembers).values({ driveId: research, userId: lena, role: 'MEMBER', invitedBy: marcus, acceptedAt: new Date() });

    expect(await pendingFor(marcus)).toEqual([nina]);
    expect((await statusOf(lenaRequest.id)).status).toBe('pending');

    await changeOrgDriveLead(priya, research, { newLeadId: jono }, orgDriveServiceDeps);
    await expectClosed(lenaRequest.id);
    expect((await statusOf(ninaRequest.id)).status).toBe('pending');
  });

  it('DRV-6 (partial) deleting the org closes the requests on its drives', async () => {
    const { request } = await requestAs(lena);

    expect(await deleteOrganization({ actorId: jono, orgId: northwind, choices: [{ driveId: research, action: 'trash' }], now: new Date() }))
      .toMatchObject({ ok: true });

    await expectClosed(request.id);
  });
});

describe('the join-request approver list is no existence oracle for a Private drive', () => {
  it('DRV-7 (partial) a plain org member gets the same answer for a Private drive of their org as for a drive that does not exist', async () => {
    await db.update(drives).set({ orgVisibility: 'PRIVATE' }).where(eq(drives.id, research));

    const forPrivate = await listPendingDriveJoinRequests(nina, research);
    const forMissing = await listPendingDriveJoinRequests(nina, createId());

    expect(forPrivate).toEqual(forMissing);
    expect(forPrivate).toMatchObject({ ok: false, code: 'REQUEST_NOT_FOUND', status: 404 });
    expect(await listPendingDriveJoinRequests(marcus, research)).toMatchObject({ ok: true });
  });
});
