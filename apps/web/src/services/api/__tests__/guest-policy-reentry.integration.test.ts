/**
 * Writes that put an outsider's access BACK into an org drive obey the guests policy — REAL Postgres (Spec POL-2,
 * X-6; independent review of #2762: P1-2 page move, P1-3 backup restore, P1-4 rollback and redo, P1-5 a departed
 * lead restored by undoing an ownership transfer).
 *
 * The org's guests policy is set directly on the row (as the policy writer stores it); every decision here is the
 * real lib code reading it under the org row's share lock, in the write's own transaction.
 *
 * Every org, drive and user row is deleted, children before parents, users last.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers, pagePermissions } from '@pagespace/db/schema/members';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { orgGuestHolds } from '@pagespace/db/schema/org-guest-holds';
// The move logs its activity fire-and-forget after it returns; that write would race this file's cleanup (a
// deadlock on the drive row). The log is not what these tests assert.
vi.mock('@pagespace/lib/monitoring/activity-logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/monitoring/activity-logger')>()),
  logPageActivity: vi.fn(),
  getActorInfo: vi.fn(async () => ({ actorEmail: 'a@x', actorDisplayName: 'A' })),
}));

import { getUserAccessLevel } from '@pagespace/lib/permissions/permissions';
import { admitReentry } from '@pagespace/lib/permissions/guest-holds';
import { movePagesToDrive } from '../page-cross-drive-move-service';
import { applyPermRestoreOps, type RestoreAdmission } from '../restore-permissions-service';
import { defaultRollbackDeps, withTx } from '../rollback/deps';
import { rollbackDriveChange, rollbackMemberChange, rollbackPermissionChange } from '../rollback/rollback-executors';
import { redoMemberChange, redoPermissionChange } from '../rollback/redo-executors';
import type { ActivityLogForRollback } from '../rollback/types';

const created = { userIds: [] as string[], driveIds: [] as string[], orgIds: [] as string[] };
let dbAvailable = false;

interface World {
  orgId: string;
  owner: string;
  member: string;
  outsider: string;
  orgDrive: string;
  orgPage: string;
  personalDrive: string;
  personalPage: string;
}
let w: World;

async function cleanup() {
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

beforeAll(async () => {
  try {
    await db.select({ id: organizations.id }).from(organizations).limit(1);
    dbAvailable = true;
  } catch (error) {
    requireDb('guest-policy-reentry.integration.test.ts', error);
  }
});

beforeEach(async () => {
  if (!dbAvailable) return;
  const mk = async () => {
    const u = await factories.createUser();
    created.userIds.push(u.id);
    return u.id;
  };
  const [owner, member, outsider] = [await mk(), await mk(), await mk()];
  const orgId = createId();
  created.orgIds.push(orgId);
  await db.insert(organizations).values({ id: orgId, name: 'Northwind', slug: `nw-${createId()}`, ownerId: owner });
  // Northwind is paid: a lapsed org admits no outsider even with guests on ([D-OW-33]).
  await factories.createOrgSubscription(orgId, { status: 'active' });
  await db.insert(orgMembers).values([{ orgId, userId: owner, role: 'OWNER' }, { orgId, userId: member, role: 'MEMBER' }]);
  const orgDrive = (await factories.createDrive(owner)).id;
  const personalDrive = (await factories.createDrive(owner)).id;
  created.driveIds.push(orgDrive, personalDrive);
  await db.update(drives).set({ orgId, orgVisibility: 'RESTRICTED' }).where(eq(drives.id, orgDrive));
  const orgPage = (await factories.createPage(orgDrive)).id;
  const personalPage = (await factories.createPage(personalDrive)).id;
  w = { orgId, owner, member, outsider, orgDrive, orgPage, personalDrive, personalPage };
});

afterEach(async () => {
  if (dbAvailable) await cleanup();
});
afterAll(async () => {
  if (!dbAvailable) return;
  await cleanup();
  const { pool } = await import('@pagespace/db/db');
  await pool.end();
});

const setGuests = (guests: 'off' | 'approve' | 'on') => db.update(organizations).set({ policies: { guests } }).where(eq(organizations.id, w.orgId));
const EDIT = { canView: true, canEdit: true, canShare: false, canDelete: false };
const grantsOf = (userId: string) => db.select().from(pagePermissions).where(eq(pagePermissions.userId, userId));
const memberRowOf = (userId: string, driveId = w.orgDrive) => db.select().from(driveMembers).where(and(eq(driveMembers.driveId, driveId), eq(driveMembers.userId, userId)));
const pendingFor = (userId: string) => db.select().from(orgGuestHolds).where(and(eq(orgGuestHolds.userId, userId), eq(orgGuestHolds.state, 'pending_approval')));

function activity(over: Partial<ActivityLogForRollback>): ActivityLogForRollback {
  return {
    id: createId(), timestamp: new Date(), userId: w.owner, actorEmail: 'a@x', actorDisplayName: null, operation: 'update',
    resourceType: 'permission', resourceId: createId(), resourceTitle: null, driveId: null, pageId: null, isAiGenerated: false,
    aiProvider: null, aiModel: null, contentSnapshot: null, contentRef: null, contentFormat: null, contentSize: null,
    updatedFields: null, previousValues: null, newValues: null, metadata: null, streamId: null, streamSeq: null,
    changeGroupId: null, changeGroupType: null, stateHashBefore: null, stateHashAfter: null, rollbackFromActivityId: null,
    rollbackSourceOperation: null, rollbackSourceTimestamp: null, rollbackSourceTitle: null,
    ...over,
  };
}
const inTx = <T>(run: (deps: ReturnType<typeof defaultRollbackDeps>) => Promise<T>) =>
  db.transaction((t) => run(withTx(defaultRollbackDeps(), t as unknown as typeof db)));

describe('pages moved into an org drive', () => {
  const allow = { isDriveInScope: () => true, canAdministerDrive: async () => true, canEditPage: async () => true };
  const move = () => movePagesToDrive({ pageIds: [w.personalPage], targetDriveId: w.orgDrive, targetParentId: null, userId: w.owner, authorize: allow });

  it('POL-2 (partial) X-6 (partial) guests OFF: a page shared with an outsider loses that share when it moves into the org drive (parked, not deleted), and so do its child and grandchild', async () => {
    const child = (await factories.createPage(w.personalDrive, { parentId: w.personalPage })).id;
    const grandchild = (await factories.createPage(w.personalDrive, { parentId: child })).id;
    await db.insert(pagePermissions).values([
      { pageId: w.personalPage, userId: w.outsider, ...EDIT, grantedBy: w.owner },
      { pageId: child, userId: w.outsider, ...EDIT, grantedBy: w.owner },
      { pageId: grandchild, userId: w.outsider, ...EDIT, grantedBy: w.owner },
    ]);
    await setGuests('off');
    expect(await move()).toMatchObject({ success: true, descendantCount: 2 });
    expect(await getUserAccessLevel(w.outsider, w.personalPage)).toBeNull();
    expect(await getUserAccessLevel(w.outsider, child)).toBeNull();
    expect(await getUserAccessLevel(w.outsider, grandchild)).toBeNull();
    const [hold] = await db.select().from(orgGuestHolds).where(and(eq(orgGuestHolds.userId, w.outsider), eq(orgGuestHolds.state, 'suspended')));
    expect(hold.parked?.grants).toHaveLength(3);
  });

  it('POL-2 (partial) guests APPROVE: the moved share is queued for an Owner or Admin; ON: it stays', async () => {
    await db.insert(pagePermissions).values({ pageId: w.personalPage, userId: w.outsider, ...EDIT, grantedBy: w.owner });
    await setGuests('approve');
    await move();
    expect(await grantsOf(w.outsider)).toEqual([]);
    expect((await pendingFor(w.outsider))[0]?.request.permissions).toEqual([{ pageId: w.personalPage, ...EDIT, expiresAt: null }]);
  });

  it('POL-2 (partial) guests ON keeps the moved share, and an org member\'s share is never touched', async () => {
    await db.insert(pagePermissions).values([
      { pageId: w.personalPage, userId: w.outsider, ...EDIT, grantedBy: w.owner },
      { pageId: w.personalPage, userId: w.member, ...EDIT, grantedBy: w.owner },
    ]);
    await setGuests('on');
    await move();
    expect(await grantsOf(w.outsider)).toHaveLength(1);
    await setGuests('off');
    expect(await grantsOf(w.member)).toHaveLength(1);
  });
});

describe('a backup restore', () => {
  const restore = () => db.transaction(async (tx) => {
    const admit: RestoreAdmission = async ({ userId, member, grants }) => (await admitReentry(tx, { driveId: w.orgDrive, userId, member, grants, requestedBy: w.owner })).outcome;
    return applyPermRestoreOps(
      { toDelete: [], toInsert: [{ pageId: w.orgPage, userId: w.outsider, ...EDIT }, { pageId: w.orgPage, userId: w.member, ...EDIT }] },
      { toDelete: [], toInsert: [{ userId: w.outsider, role: 'MEMBER', acceptedAt: new Date() }] },
      { toDelete: [], toInsert: [] },
      w.orgDrive,
      tx as never,
      admit,
    );
  });

  it('POL-2 (partial) X-6 (partial) guests OFF: an outsider in the backup is not restored and is reported; an org member is', async () => {
    await setGuests('off');
    expect(await restore()).toMatchObject({ refusedByGuestPolicy: [w.outsider], queuedForApproval: [] });
    expect(await grantsOf(w.outsider)).toEqual([]);
    expect(await memberRowOf(w.outsider)).toEqual([]);
    expect(await grantsOf(w.member)).toHaveLength(1);
  });

  it('POL-2 (partial) guests APPROVE: the outsider is queued with their member row and grant; nothing is written for them', async () => {
    await setGuests('approve');
    expect(await restore()).toMatchObject({ refusedByGuestPolicy: [], queuedForApproval: [w.outsider] });
    expect(await grantsOf(w.outsider)).toEqual([]);
    const [pending] = await pendingFor(w.outsider);
    expect(pending.request.member).toMatchObject({ userId: w.outsider, role: 'MEMBER' });
  });

  it('POL-2 (partial) guests ON restores the outsider as before', async () => {
    // [D-OW-41] ON is a choice now: the default is approve.
    await setGuests('on');
    expect(await restore()).toMatchObject({ refusedByGuestPolicy: [], queuedForApproval: [] });
    expect(await grantsOf(w.outsider)).toHaveLength(1);
    expect(await memberRowOf(w.outsider)).toHaveLength(1);
  });
});

describe('rollback and redo of grants and members', () => {
  const revokeActivity = () => activity({ operation: 'permission_revoke', resourceType: 'permission', pageId: w.orgPage, driveId: w.orgDrive, metadata: { targetUserId: w.outsider }, previousValues: { ...EDIT, grantedBy: w.owner } });
  const removeActivity = () => activity({ operation: 'member_remove', resourceType: 'member', driveId: w.orgDrive, metadata: { targetUserId: w.outsider }, previousValues: { role: 'MEMBER', userId: w.outsider } });

  it('POL-2 (partial) X-6 (partial) guests OFF: undoing a revoke or a removal does not put an outsider back, and says so', async () => {
    await setGuests('off');
    expect(await inTx((d) => rollbackPermissionChange(d, revokeActivity()))).toMatchObject({ skipped: true, reason: 'guest_policy_off' });
    expect(await inTx((d) => rollbackMemberChange(d, removeActivity()))).toMatchObject({ skipped: true, reason: 'guest_policy_off' });
    expect(await grantsOf(w.outsider)).toEqual([]);
    expect(await memberRowOf(w.outsider)).toEqual([]);
  });

  it('POL-2 (partial) guests OFF: redoing a grant or a member add does not put an outsider back either', async () => {
    await setGuests('off');
    const grantRedo = activity({ operation: 'rollback', rollbackSourceOperation: 'permission_grant', resourceType: 'permission', pageId: w.orgPage, driveId: w.orgDrive, metadata: { targetUserId: w.outsider } });
    expect(await inTx((d) => redoPermissionChange(d, grantRedo, { ...EDIT, userId: w.outsider, pageId: w.orgPage }, 'permission_grant'))).toMatchObject({ skipped: true });
    const memberRedo = activity({ operation: 'rollback', rollbackSourceOperation: 'member_add', resourceType: 'member', driveId: w.orgDrive, metadata: { targetUserId: w.outsider } });
    expect(await inTx((d) => redoMemberChange(d, memberRedo, { role: 'MEMBER', userId: w.outsider, driveId: w.orgDrive }, 'member_add'))).toMatchObject({ skipped: true });
    expect(await grantsOf(w.outsider)).toEqual([]);
    expect(await memberRowOf(w.outsider)).toEqual([]);
  });

  it('POL-2 (partial) guests APPROVE queues the undone revoke; ON puts it back as before', async () => {
    await setGuests('approve');
    expect(await inTx((d) => rollbackPermissionChange(d, revokeActivity()))).toMatchObject({ skipped: true, reason: 'guest_approval_pending' });
    expect(await pendingFor(w.outsider)).toHaveLength(1);
    await setGuests('on');
    await inTx((d) => rollbackPermissionChange(d, revokeActivity()));
    expect(await grantsOf(w.outsider)).toHaveLength(1);
  });
});

describe('undoing a lead change made when someone left', () => {
  const transfer = (fromUserId: string) => activity({
    operation: 'ownership_transfer', resourceType: 'drive', resourceId: w.orgDrive, driveId: w.orgDrive,
    previousValues: { ownerId: fromUserId }, newValues: { ownerId: w.owner },
  });
  const ctx = { userId: w?.owner ?? 'x', changeGroupId: 'g', changeGroupType: 'user' as const, source: 'restore' as const, metadata: {} };

  it('POL-2 (partial) X-6 (partial) a former member is never restored as an org drive\'s lead: the rollback is refused and nothing changes', async () => {
    await expect(inTx((d) => rollbackDriveChange(d, transfer(w.outsider), ctx as never))).rejects.toThrow(/no longer a member/);
    const [drive] = await db.select({ ownerId: drives.ownerId }).from(drives).where(eq(drives.id, w.orgDrive));
    expect(drive.ownerId).toBe(w.owner);
  });

  it('POL-2 (partial) a lead who is still an org member can be restored', async () => {
    await inTx((d) => rollbackDriveChange(d, transfer(w.member), ctx as never));
    const [drive] = await db.select({ ownerId: drives.ownerId }).from(drives).where(eq(drives.id, w.orgDrive));
    expect(drive.ownerId).toBe(w.member);
  });
});
