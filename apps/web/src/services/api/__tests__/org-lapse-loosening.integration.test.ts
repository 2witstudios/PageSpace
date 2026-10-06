/**
 * [D-OW-33] completeness, the apps/web writes, against a REAL Postgres: while an org is lapsed its drives may only
 * RESTRICT. Each write here that would give an ORG MEMBER more (outsiders were already closed by #2844's admission
 * guard) is refused with the SEAT-9 lapse refusal and writes nothing; its restricting direction still applies while
 * lapsed; and paid again the loosening write goes through:
 *   - drive invites: a direct add, a re-invite that raises, an emailed invitation (issued and accepted);
 *   - page invites: a direct grant, an emailed invitation (issued and accepted);
 *   - rollback and redo (inventory #24-#25), composed as executeRollback composes them (deps.guardDriveAccess);
 *   - a backup restore's permissions (inventory #26), composed as the restore route composes them.
 *
 * Every org, drive and user row is deleted, children before parents, users last; the pool is ended.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, eq, inArray, isNull } from '@pagespace/db/operators';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveMembers, pagePermissions } from '@pagespace/db/schema/members';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { orgGuestHolds } from '@pagespace/db/schema/org-guest-holds';
import { pendingInvites } from '@pagespace/db/schema/pending-invites';
import { pendingPageInvites } from '@pagespace/db/schema/pending-page-invites';
// Page writes snapshot content to object storage (no credentials here): only those two storage calls are stubbed; the
// page rows, their revisions and every access table stay real.
vi.mock('@pagespace/lib/services/page-version-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/services/page-version-service')>()),
  createPageVersion: vi.fn(async () => ({ id: 'test-version', contentRef: 'test-ref', contentSize: 0, compressed: false, storedSize: 0, compressionRatio: 1 })),
}));
vi.mock('@pagespace/lib/services/page-content-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/services/page-content-store')>()),
  writePageContent: vi.fn(async (content: string, format: string) => ({ ref: `${format}:test-${content.length}`, size: content.length, compressed: false, storedSize: content.length, compressionRatio: 1 })),
}));
vi.mock('@pagespace/lib/monitoring/activity-logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/monitoring/activity-logger')>()),
  getActorInfo: vi.fn(async () => ({ actorEmail: 'a@x', actorDisplayName: 'A' })),
}));

import { OrgLapsedError, guardDriveAccess } from '@pagespace/lib/permissions/org-lapse-guard';
import { admitReentry } from '@pagespace/lib/permissions/guest-holds';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';
import { pageInviteRepository } from '@/lib/repositories/page-invite-repository';
import { applyPermRestoreOps, type RestoreAdmission } from '../restore-permissions-service';
import { defaultRollbackDeps, withTx, type RollbackDeps } from '../rollback/deps';
import { rollbackMemberChange, rollbackPermissionChange } from '../rollback/rollback-executors';
import { redoPageChange, redoPermissionChange } from '../rollback/redo-executors';
import { rollbackPageChange } from '../rollback/rollback-executors';
import { pageService } from '../page-service';
import { movePagesToDrive } from '../page-cross-drive-move-service';
import type { ActivityLogForRollback } from '../rollback/types';

const created = { userIds: [] as string[], driveIds: [] as string[], orgIds: [] as string[] };
let dbAvailable = false;
const originalMode = process.env.DEPLOYMENT_MODE;

interface World {
  orgId: string;
  owner: string;
  member: string;
  memberEmail: string;
  orgDrive: string;
  orgPage: string;
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
    requireDb('org-lapse-loosening.integration.test.ts', error);
  }
});

beforeEach(async () => {
  process.env.DEPLOYMENT_MODE = 'cloud';
  if (!dbAvailable) return;
  const owner = await factories.createUser();
  const member = await factories.createUser();
  created.userIds.push(owner.id, member.id);
  const orgId = createId();
  created.orgIds.push(orgId);
  await db.insert(organizations).values({ id: orgId, name: 'Northwind', slug: `nw-${createId()}`, ownerId: owner.id, policies: { guests: 'on' } });
  await factories.createOrgSubscription(orgId, { status: 'active' });
  await db.insert(orgMembers).values([{ orgId, userId: owner.id, role: 'OWNER' }, { orgId, userId: member.id, role: 'MEMBER' }]);
  const orgDrive = (await factories.createDrive(owner.id, { orgId, orgVisibility: 'RESTRICTED' })).id;
  created.driveIds.push(orgDrive);
  const orgPage = (await factories.createPage(orgDrive)).id;
  w = { orgId, owner: owner.id, member: member.id, memberEmail: member.email, orgDrive, orgPage };
});

afterEach(async () => {
  if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
  else process.env.DEPLOYMENT_MODE = originalMode;
  if (dbAvailable) await cleanup();
});
afterAll(async () => {
  if (!dbAvailable) return;
  await cleanup();
  const { pool } = await import('@pagespace/db/db');
  await pool.end();
});

const setStatus = (status: string) => db.update(orgSubscriptions).set({ status }).where(eq(orgSubscriptions.orgId, w.orgId));
const lapse = () => setStatus('canceled');
const pay = () => setStatus('active');
const memberRowOf = async (userId: string) =>
  (await db.select({ role: driveMembers.role, acceptedAt: driveMembers.acceptedAt }).from(driveMembers)
    .where(and(eq(driveMembers.driveId, w.orgDrive), eq(driveMembers.userId, userId))))[0] ?? null;
const grantOf = async (userId: string) =>
  (await db.select({ canView: pagePermissions.canView, canEdit: pagePermissions.canEdit }).from(pagePermissions)
    .where(and(eq(pagePermissions.pageId, w.orgPage), eq(pagePermissions.userId, userId))))[0] ?? null;
const VIEW = { canView: true, canEdit: false, canShare: false };
const EDIT = { canView: true, canEdit: true, canShare: false };

describe('drive invites', () => {
  const addMember = () => driveInviteRepository.createAcceptedMemberWithPermissions({
    driveId: w.orgDrive, userId: w.member, role: 'MEMBER', customRoleId: null, invitedBy: w.owner,
    permissions: [{ pageId: w.orgPage, ...VIEW }], grantedBy: w.owner, validPageIds: new Set([w.orgPage]),
  });

  it('SEAT-9 (partial) [D-OW-33] inventory #4 a direct add of an org member is refused while lapsed (no row, no grant); paid, it is added', async () => {
    await lapse();
    expect(await addMember()).toEqual({ refused: 'ORG_LAPSED' });
    expect(await memberRowOf(w.member)).toBeNull();
    expect(await grantOf(w.member)).toBeNull();
    await pay();
    expect(await addMember()).toMatchObject({ permissionsGranted: 1 });
  });

  it('SEAT-9 (partial) [D-OW-33] inventory #5 a re-invite that raises the role or a grant is refused while lapsed and nothing changes; one that lowers applies; paid, the raise applies', async () => {
    await addMember();
    const [row] = await db.select({ id: driveMembers.id }).from(driveMembers).where(and(eq(driveMembers.driveId, w.orgDrive), eq(driveMembers.userId, w.member)));
    const reinvite = (role: 'ADMIN' | 'MEMBER', flags: typeof VIEW) => driveInviteRepository.upgradeMemberWithPermissions({
      memberId: row.id, driveId: w.orgDrive, userId: w.member, role, customRoleId: null,
      permissions: [{ pageId: w.orgPage, ...flags }], grantedBy: w.owner, validPageIds: new Set([w.orgPage]),
    });
    await lapse();
    await expect(reinvite('ADMIN', VIEW)).rejects.toBeInstanceOf(OrgLapsedError);
    await expect(reinvite('MEMBER', EDIT)).rejects.toBeInstanceOf(OrgLapsedError);
    expect((await memberRowOf(w.member))?.role).toBe('MEMBER');
    expect(await grantOf(w.member)).toEqual({ canView: true, canEdit: false });
    // Lowering the grant restricts.
    expect(await reinvite('MEMBER', { canView: false, canEdit: false, canShare: false })).toMatchObject({ permissionsGranted: 1 });
    expect(await grantOf(w.member)).toEqual({ canView: false, canEdit: false });
    await pay();
    await reinvite('ADMIN', EDIT);
    expect((await memberRowOf(w.member))?.role).toBe('ADMIN');
  });

  it('SEAT-9 (partial) [D-OW-33] inventory #6-#7 no emailed invitation is issued while lapsed; one issued before the lapse cannot be accepted (ORG_LAPSED, the token NOT consumed, no row); paid, it is accepted', async () => {
    await lapse();
    await expect(driveInviteRepository.createPendingInvite({
      tokenHash: `h_${createId()}`, email: 'new@northwind.test', driveId: w.orgDrive, role: 'MEMBER', customRoleId: null,
      invitedBy: w.owner, expiresAt: null, now: new Date(),
    })).rejects.toBeInstanceOf(OrgLapsedError);
    expect(await db.select().from(pendingInvites).where(eq(pendingInvites.driveId, w.orgDrive))).toHaveLength(0);

    const [invite] = await db.insert(pendingInvites).values({ tokenHash: `h_${createId()}`, email: w.memberEmail, driveId: w.orgDrive, role: 'MEMBER', invitedBy: w.owner }).returning();
    const accept = () => driveInviteRepository.consumeInviteAndCreateMembership({
      inviteId: invite.id, driveId: w.orgDrive, userId: w.member, role: 'MEMBER', customRoleId: null, invitedBy: w.owner, acceptedAt: new Date(),
    });
    expect(await accept()).toEqual({ ok: false, reason: 'ORG_LAPSED' });
    expect(await db.select().from(pendingInvites).where(and(eq(pendingInvites.id, invite.id), isNull(pendingInvites.consumedAt)))).toHaveLength(1);
    expect(await memberRowOf(w.member)).toBeNull();
    await pay();
    expect(await accept()).toMatchObject({ ok: true });
    expect(await memberRowOf(w.member)).not.toBeNull();
  });
});

describe('page invites', () => {
  it('SEAT-9 (partial) [D-OW-33] inventory #9 a direct page grant to an org member is refused while lapsed (nothing written); paid, it is written', async () => {
    const grant = () => pageInviteRepository.createDirectPagePermission({ pageId: w.orgPage, driveId: w.orgDrive, userId: w.member, ...VIEW, grantedBy: w.owner });
    await lapse();
    await expect(grant()).rejects.toBeInstanceOf(OrgLapsedError);
    expect(await grantOf(w.member)).toBeNull();
    await pay();
    expect(await grant()).toMatchObject({ id: expect.any(String) });
  });

  it('SEAT-9 (partial) [D-OW-33] inventory #8 & #10 no page invitation is issued while lapsed; one issued before cannot be accepted (ORG_LAPSED, NOT consumed); paid, it is accepted', async () => {
    await lapse();
    await expect(pageInviteRepository.createPendingInvite({
      tokenHash: `h_${createId()}`, email: 'new@northwind.test', pageId: w.orgPage, permissions: ['VIEW'], invitedBy: w.owner, expiresAt: null, now: new Date(),
    })).rejects.toBeInstanceOf(OrgLapsedError);

    const [invite] = await db.insert(pendingPageInvites).values({ tokenHash: `h_${createId()}`, email: w.memberEmail, pageId: w.orgPage, permissions: ['VIEW'], invitedBy: w.owner }).returning();
    const accept = () => pageInviteRepository.consumeInviteAndGrantPage({
      inviteId: invite.id, pageId: w.orgPage, driveId: w.orgDrive, userId: w.member, permissions: ['VIEW'], invitedBy: w.owner, grantedAt: new Date(),
    });
    expect(await accept()).toEqual({ ok: false, reason: 'ORG_LAPSED' });
    expect(await db.select().from(pendingPageInvites).where(and(eq(pendingPageInvites.id, invite.id), isNull(pendingPageInvites.consumedAt)))).toHaveLength(1);
    expect(await grantOf(w.member)).toBeNull();
    await pay();
    expect(await accept()).toMatchObject({ ok: true });
  });
});

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

/** As executeRollback runs an access write: deps.guardDriveAccess on the drive, the executor handed the savepoint. */
function guardedRollback<T>(run: (d: RollbackDeps) => Promise<T>): Promise<T> {
  const deps = defaultRollbackDeps();
  return deps.guardDriveAccess(deps.db, w.orgDrive, {}, (t) => run(withTx(deps, t)));
}

describe('rollback and redo (inventory #24-#25)', () => {
  const revoke = () => activity({ operation: 'permission_revoke', resourceType: 'permission', pageId: w.orgPage, driveId: w.orgDrive, metadata: { targetUserId: w.member }, previousValues: { ...EDIT, canDelete: false, grantedBy: w.owner } });
  const grant = () => activity({ operation: 'permission_grant', resourceType: 'permission', pageId: w.orgPage, driveId: w.orgDrive, metadata: { targetUserId: w.member } });
  const removal = () => activity({ operation: 'member_remove', resourceType: 'member', driveId: w.orgDrive, metadata: { targetUserId: w.member }, previousValues: { role: 'MEMBER', userId: w.member, acceptedAt: new Date().toISOString() } });

  it('SEAT-9 (partial) [D-OW-33] undoing a revoke or a member removal is refused while lapsed (the lapse refusal, nothing written); undoing a GRANT (it removes) applies; paid, the undo puts the access back', async () => {
    await factories.createDriveMember(w.orgDrive, w.member, { role: 'MEMBER', acceptedAt: new Date() });
    await lapse();
    await expect(guardedRollback((d) => rollbackPermissionChange(d, revoke()))).rejects.toBeInstanceOf(OrgLapsedError);
    expect(await grantOf(w.member)).toBeNull();

    await db.insert(pagePermissions).values({ pageId: w.orgPage, userId: w.member, ...EDIT, canDelete: false, grantedBy: w.owner });
    expect(await guardedRollback((d) => rollbackPermissionChange(d, grant()))).toMatchObject({ deleted: true });
    expect(await grantOf(w.member)).toBeNull();

    await db.delete(driveMembers).where(and(eq(driveMembers.driveId, w.orgDrive), eq(driveMembers.userId, w.member)));
    await expect(guardedRollback((d) => rollbackMemberChange(d, removal()))).rejects.toBeInstanceOf(OrgLapsedError);
    expect(await memberRowOf(w.member)).toBeNull();

    await pay();
    await guardedRollback((d) => rollbackMemberChange(d, removal()));
    expect(await memberRowOf(w.member)).not.toBeNull();
    await guardedRollback((d) => rollbackPermissionChange(d, revoke()));
    expect(await grantOf(w.member)).toEqual({ canView: true, canEdit: true });
  });

  it('SEAT-9 (partial) [D-OW-33] redoing a grant is refused while lapsed; paid, it is redone', async () => {
    await factories.createDriveMember(w.orgDrive, w.member, { role: 'MEMBER', acceptedAt: new Date() });
    const redo = activity({ operation: 'rollback', rollbackSourceOperation: 'permission_grant', resourceType: 'permission', pageId: w.orgPage, driveId: w.orgDrive, metadata: { targetUserId: w.member } });
    await lapse();
    await expect(guardedRollback((d) => redoPermissionChange(d, redo, { ...EDIT, canDelete: false, userId: w.member, pageId: w.orgPage }, 'permission_grant'))).rejects.toBeInstanceOf(OrgLapsedError);
    expect(await grantOf(w.member)).toBeNull();
    await pay();
    await guardedRollback((d) => redoPermissionChange(d, redo, { ...EDIT, canDelete: false, userId: w.member, pageId: w.orgPage }, 'permission_grant'));
    expect(await grantOf(w.member)).toEqual({ canView: true, canEdit: true });
  });
});

describe('a backup restore (inventory #26)', () => {
  /** As the restore route composes it: guardDriveAccess around applyPermRestoreOps, in the restore's transaction. */
  const restore = (members: Array<{ userId: string; role: 'MEMBER' | 'ADMIN' }>, deleteCurrent: string[]) => db.transaction(async (tx) => {
    const admit: RestoreAdmission = async ({ userId, member, grants }) => (await admitReentry(tx, { driveId: w.orgDrive, userId, member, grants, requestedBy: w.owner })).outcome;
    return guardDriveAccess(tx, w.orgDrive, {}, (sp) => applyPermRestoreOps(
      { toDelete: [], toInsert: [] },
      { toDelete: deleteCurrent, toInsert: members.map((m) => ({ ...m, acceptedAt: new Date() })) },
      { toDelete: [], toInsert: [] },
      w.orgDrive,
      sp as never,
      admit,
    ));
  });

  it('SEAT-9 (partial) [D-OW-33] while lapsed a restore that puts an org member back (or raises one) is refused and rolls back; one that only removes applies; paid, the restore puts them back', async () => {
    await lapse();
    await expect(restore([{ userId: w.member, role: 'MEMBER' }], [])).rejects.toBeInstanceOf(OrgLapsedError);
    expect(await memberRowOf(w.member)).toBeNull();

    await pay();
    await restore([{ userId: w.member, role: 'MEMBER' }], []);
    expect((await memberRowOf(w.member))?.role).toBe('MEMBER');

    await lapse();
    await expect(restore([{ userId: w.member, role: 'ADMIN' }], [w.member])).rejects.toBeInstanceOf(OrgLapsedError);
    expect((await memberRowOf(w.member))?.role).toBe('MEMBER');
    // A restore whose backup no longer has them removes them: restricting, applied while lapsed.
    await restore([], [w.member]);
    expect(await memberRowOf(w.member)).toBeNull();
  });
});

const isPrivateOf = async (pageId: string) => (await db.select({ isPrivate: pages.isPrivate }).from(pages).where(eq(pages.id, pageId)))[0].isPrivate;
const PAGE_CTX = () => ({ userId: w.owner, changeGroupId: createId(), changeGroupType: 'user' as const, source: 'restore' as const, metadata: {} });

/** As executeRollback runs a page undo/redo: deps.guardDriveAccess scoped to the page's privacy. */
function guardedPageRollback<T>(pageId: string, run: (d: RollbackDeps) => Promise<T>): Promise<T> {
  const deps = defaultRollbackDeps();
  return deps.guardDriveAccess(deps.db, w.orgDrive, { members: false, grants: false, agents: false, tokens: false, pages: [pageId] }, (t) => run(withTx(deps, t)));
}

describe('page privacy (review P1-2, P2-2)', () => {
  const madePrivate = () => activity({ operation: 'update', resourceType: 'page', resourceId: w.orgPage, pageId: w.orgPage, driveId: w.orgDrive, updatedFields: ['isPrivate'], previousValues: { isPrivate: false }, newValues: { isPrivate: true } });
  const madePublic = () => activity({ operation: 'rollback', rollbackSourceOperation: 'update', resourceType: 'page', resourceId: w.orgPage, pageId: w.orgPage, driveId: w.orgDrive, updatedFields: ['isPrivate'], previousValues: { isPrivate: true }, newValues: { isPrivate: false } });

  it('SEAT-9 (partial) [D-OW-33] review P1-2: undoing "made private" and redoing "made public" are refused while lapsed (the page stays private); paid, the undo makes it public again', async () => {
    await db.update(pages).set({ isPrivate: true }).where(eq(pages.id, w.orgPage));
    await lapse();
    await expect(guardedPageRollback(w.orgPage, (d) => rollbackPageChange(d, madePrivate(), null, PAGE_CTX()))).rejects.toBeInstanceOf(OrgLapsedError);
    expect(await isPrivateOf(w.orgPage)).toBe(true);
    await expect(guardedPageRollback(w.orgPage, (d) => redoPageChange(d, madePublic(), { isPrivate: false }, 'update', PAGE_CTX()))).rejects.toBeInstanceOf(OrgLapsedError);
    expect(await isPrivateOf(w.orgPage)).toBe(true);
    await pay();
    await guardedPageRollback(w.orgPage, (d) => rollbackPageChange(d, madePrivate(), null, PAGE_CTX()));
    expect(await isPrivateOf(w.orgPage)).toBe(false);
  });

  it('SEAT-9 (partial) [D-OW-33] review P2-2: pageService.updatePage refuses isPrivate:false INSIDE its transaction while lapsed (the page stays private); making a page private still works; paid, it can be made public', async () => {
    await db.update(pages).set({ isPrivate: true }).where(eq(pages.id, w.orgPage));
    await lapse();
    await expect(pageService.updatePage(w.orgPage, w.owner, { isPrivate: false }, { skipPermissionCheck: true })).rejects.toBeInstanceOf(OrgLapsedError);
    expect(await isPrivateOf(w.orgPage)).toBe(true);
    const other = (await factories.createPage(w.orgDrive)).id;
    expect(await pageService.updatePage(other, w.owner, { isPrivate: true }, { skipPermissionCheck: true })).toMatchObject({ success: true });
    expect(await isPrivateOf(other)).toBe(true);
    await pay();
    expect(await pageService.updatePage(w.orgPage, w.owner, { isPrivate: false }, { skipPermissionCheck: true })).toMatchObject({ success: true });
    expect(await isPrivateOf(w.orgPage)).toBe(false);
  });
});

describe('pages leaving a lapsed org drive (review P2-4 ruling)', () => {
  it('SEAT-9 (partial) [D-OW-33] moving a page OUT of a lapsed org drive into another drive is refused (402 ORG_LAPSED, nothing moved); a move within the drive works; paid, the move goes through', async () => {
    const personal = (await factories.createDrive(w.owner)).id;
    created.driveIds.push(personal);
    const allow = { isDriveInScope: () => true, canAdministerDrive: async () => true, canEditPage: async () => true };
    const move = (targetDriveId: string) => movePagesToDrive({ pageIds: [w.orgPage], targetDriveId, targetParentId: null, userId: w.owner, authorize: allow });
    const driveOf = async () => (await db.select({ driveId: pages.driveId }).from(pages).where(eq(pages.id, w.orgPage)))[0].driveId;
    await lapse();
    expect(await move(personal)).toMatchObject({ success: false, code: 'ORG_LAPSED', status: 402 });
    expect(await driveOf()).toBe(w.orgDrive);
    expect(await move(w.orgDrive)).toMatchObject({ success: true });
    await pay();
    expect(await move(personal)).toMatchObject({ success: true });
    expect(await driveOf()).toBe(personal);
  });
});
