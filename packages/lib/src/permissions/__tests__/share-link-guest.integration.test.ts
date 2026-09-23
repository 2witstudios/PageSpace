/**
 * Integration test: redeeming a PAGE share link makes the redeemer a GUEST of
 * the drive — a row that carries the one page they were given and nothing else.
 *
 * Requires a running Postgres database with the latest migrations applied.
 * Run via:
 *   bun run --filter '@pagespace/lib' test:integration -- src/permissions/__tests__/share-link-guest.integration.test.ts
 *
 * Before GUEST existed the redeem inserted a MEMBER row, and rule 4 turned that
 * row into canView on every non-private page of the drive and canEdit on every
 * channel: a link to one page was a key to the whole drive. The unit tests mock
 * the query builder and cannot see a membership row change what other pages
 * mean, so this is the round trip that can.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { factories } from '@pagespace/db/test/factories';
import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers, driveRoles, pagePermissions } from '@pagespace/db/schema/members';
import { createId } from '@paralleldrive/cuid2';
import type { SessionClaims } from '../../auth/session-service';
import { EnforcedAuthContext } from '../enforced-context';
import { accessiblePageIds } from '../accessible-page-ids';
import { grantPagePermission } from '../permission-mutations';
import { createDriveShareLink, createPageShareLink, redeemDriveShareLink, redeemPageShareLink } from '../share-link-service';
import {
  getUserAccessLevel,
  getBatchPagePermissions,
  getUsersWhoCanViewPage,
  getUserAccessiblePagesInDrive,
  getUserAccessiblePagesInDriveWithDetails,
  isUserDriveMember,
  getUserDrivePermissions,
  usersShareDrive,
  getUserDriveAccess,
  getDriveIdsForUser,
} from '../permissions';
import { getMemberCustomRoleId } from '../membership-queries';
import {
  checkDriveAccess,
  getDriveMemberUserIds,
  getDriveRecipientUserIds,
  getDriveMemberUserIdsByCustomRole,
  listDriveMembers,
  isMemberOfDrive,
  getDriveMemberDetails,
} from '../../services/drive-member-service';
import { getDriveAccess, getDriveAccessWithDrive, getDriveWithAccess, listAccessibleDrives } from '../../services/drive-service';
import { isUserMemberOfAnyEventDrive, getAllMemberUserIdsForEvent } from '../../services/calendar-event-drive-service';
import { calendarEvents, calendarEventDrives } from '@pagespace/db/schema/calendar';
import { checkDriveAccessForRoles } from '../../services/drive-role-service';
import { addAgentToDrive } from '../../services/drive-agent-service';
import { resolveDriveMembership } from '../../services/agent-workspaces/agent-workspace-tenant';
import { loadAppShell } from '../../services/app-shell-service';
import { accountRepository } from '../../repositories/account-repository';
import { collectUserDrives } from '../../compliance/export/gdpr-export';

const seededUserIds: string[] = [];

async function seedUser() {
  const user = await factories.createUser();
  seededUserIds.push(user.id);
  return user;
}

function ctxFor(userId: string): EnforcedAuthContext {
  const claims: SessionClaims = {
    sessionId: 'sess', userId, userRole: 'user', tokenVersion: 1,
    adminRoleVersion: 0, type: 'user', scopes: ['*'],
    expiresAt: new Date(Date.now() + 3600_000),
    driveId: undefined,
  };
  return EnforcedAuthContext.fromSession(claims);
}

afterAll(async () => {
  if (seededUserIds.length === 0) return;
  await db.delete(users).where(inArray(users.id, seededUserIds));
});

/** A drive with a shared document, an unshared document and a channel. */
async function seedDrive() {
  const owner = await seedUser();
  const redeemer = await seedUser();
  const drive = await factories.createDrive(owner.id);
  const shared = await factories.createPage(drive.id, { isPrivate: false });
  const other = await factories.createPage(drive.id, { isPrivate: false });
  const channel = await factories.createPage(drive.id, { type: 'CHANNEL', isPrivate: false });

  const link = await createPageShareLink(ctxFor(owner.id), shared.id, { permissions: ['VIEW'] });
  if (!link.ok) throw new Error(`could not create share link: ${link.error}`);

  return { owner, redeemer, drive, shared, other, channel, token: link.data.rawToken };
}

async function membershipOf(driveId: string, userId: string) {
  const [row] = await db
    .select({ role: driveMembers.role, acceptedAt: driveMembers.acceptedAt, customRoleId: driveMembers.customRoleId })
    .from(driveMembers)
    .where(and(eq(driveMembers.driveId, driveId), eq(driveMembers.userId, userId)));
  return row ?? null;
}

describe('redeemPageShareLink → GUEST (integration)', () => {
  it('gives the redeemer the shared page and nothing else in the drive', async () => {
    const { drive, redeemer, shared, other, channel, token } = await seedDrive();

    const result = await redeemPageShareLink(ctxFor(redeemer.id), token);
    expect(result.ok).toBe(true);

    const row = await membershipOf(drive.id, redeemer.id);
    expect(row?.role).toBe('GUEST');
    expect(row?.acceptedAt).not.toBeNull();

    // The shared page: readable.
    expect((await getUserAccessLevel(redeemer.id, shared.id))?.canView).toBe(true);
    // A different non-private page: not readable (rule 4 must not apply).
    expect(await getUserAccessLevel(redeemer.id, other.id)).toBeNull();
    // A channel: cannot read it, cannot post in it.
    expect(await getUserAccessLevel(redeemer.id, channel.id)).toBeNull();

    // The batch path (sidebar, search, tree) agrees.
    const batch = await getBatchPagePermissions(redeemer.id, [shared.id, other.id, channel.id]);
    expect(batch.get(shared.id)?.canView).toBe(true);
    expect(batch.get(other.id)?.canView).toBe(false);
    expect(batch.get(channel.id)?.canView).toBe(false);
    expect(batch.get(channel.id)?.canEdit).toBe(false);

    // The inverse fan-out path agrees.
    expect((await getUsersWhoCanViewPage(shared.id, [redeemer.id])).has(redeemer.id)).toBe(true);
    expect((await getUsersWhoCanViewPage(other.id, [redeemer.id])).has(redeemer.id)).toBe(false);
    expect((await getUsersWhoCanViewPage(channel.id, [redeemer.id])).has(redeemer.id)).toBe(false);

    // The SQL twin (pulse, page payloads) agrees.
    const fromSql = new Set(await accessiblePageIds(redeemer.id));
    expect([shared.id, other.id, channel.id].filter((id) => fromSql.has(id))).toEqual([shared.id]);

    // The drive tree lists only the shared page.
    expect(await getUserAccessiblePagesInDrive(redeemer.id, drive.id)).toEqual([shared.id]);
    const detailed = await getUserAccessiblePagesInDriveWithDetails(redeemer.id, drive.id);
    expect(detailed.map((p) => p.id)).toEqual([shared.id]);
  });

  it('does not count a guest as a drive member anywhere', async () => {
    const { drive, owner, redeemer, shared, token } = await seedDrive();
    const member = await seedUser();
    await factories.createDriveMember(drive.id, member.id);

    expect((await redeemPageShareLink(ctxFor(redeemer.id), token)).ok).toBe(true);

    // Permission helpers.
    expect(await isUserDriveMember(redeemer.id, drive.id)).toBe(false);
    expect(await getUserDrivePermissions(redeemer.id, drive.id)).toBeNull();
    expect(await getMemberCustomRoleId(drive.id, redeemer.id)).toBeNull();
    // Drive-root access (drive-as-root-node): none.
    expect(await getUserAccessLevel(redeemer.id, drive.id)).toBeNull();
    // A guest is not an established shared context for DMs, in either direction.
    expect(await usersShareDrive(redeemer.id, owner.id)).toBe(false);
    expect(await usersShareDrive(owner.id, redeemer.id)).toBe(false);
    expect(await usersShareDrive(redeemer.id, member.id)).toBe(false);
    expect(await usersShareDrive(member.id, redeemer.id)).toBe(false);

    // Member service: access, id lists, broadcast recipients, the Members page.
    expect((await checkDriveAccess(drive.id, redeemer.id)).isMember).toBe(false);
    expect(await getDriveMemberUserIds(drive.id)).toEqual([member.id]);
    expect((await getDriveRecipientUserIds(drive.id)).sort()).toEqual([owner.id, member.id].sort());
    expect((await listDriveMembers(drive.id)).map((m) => m.userId)).toEqual([member.id]);
    expect(await isMemberOfDrive(drive.id, redeemer.id)).toBe(false);
    expect(await getDriveMemberDetails(drive.id, redeemer.id)).toBeNull();

    // Drive service: not a member, no drive-wide create, not token-scopable.
    expect((await getDriveAccess(drive.id, redeemer.id)).isMember).toBe(false);
    expect(await getDriveWithAccess(drive.id, redeemer.id)).toBeNull();
    expect((await getDriveAccessWithDrive(drive.id, redeemer.id))?.access.isMember).toBe(false);
    const listed = (await listAccessibleDrives(redeemer.id)).find((d) => d.id === drive.id);
    expect(listed?.canCreatePages).toBe(false);
    expect((await listAccessibleDrives(redeemer.id, { tokenScopable: true })).some((d) => d.id === drive.id)).toBe(false);

    // Roles pages, agent workspaces, app shell.
    expect((await checkDriveAccessForRoles(drive.id, redeemer.id)).isMember).toBe(false);
    expect(await resolveDriveMembership({ userId: redeemer.id, driveId: drive.id })).toBe('none');
    const guestShell = await loadAppShell(redeemer.id, { activeDriveId: drive.id });
    expect(guestShell.drives.some((d) => d.id === drive.id)).toBe(false);
    expect(guestShell.activeDrive).toBeUndefined();
    const memberShell = await loadAppShell(member.id, { activeDriveId: drive.id });
    expect(memberShell.driveMembers.some((m) => m.userId === redeemer.id)).toBe(false);

    // Calendar: an event shared INTO the guest's drive does not make the guest an attendee candidate.
    const [event] = await db.insert(calendarEvents).values({
      driveId: (await factories.createDrive(owner.id)).id, createdById: owner.id, title: 'e',
      startAt: new Date(), endAt: new Date(Date.now() + 3600_000),
    }).returning();
    await db.insert(calendarEventDrives).values({ eventId: event.id, driveId: drive.id, sharedBy: owner.id });
    expect(await isUserMemberOfAnyEventDrive(redeemer.id, { id: event.id, driveId: event.driveId })).toBe(false);
    expect(await isUserMemberOfAnyEventDrive(member.id, { id: event.id, driveId: event.driveId })).toBe(true);
    const attendees = await getAllMemberUserIdsForEvent(event.id, event.driveId);
    expect(attendees.has(member.id)).toBe(true);
    expect(attendees.has(redeemer.id)).toBe(false);

    // Account deletion counts and the GDPR export.
    expect(await accountRepository.getDriveMemberCount(drive.id)).toBe(1);
    expect((await collectUserDrives(db, redeemer.id)).some((d) => d.id === drive.id)).toBe(false);

    // Drive reach follows the page grant, not the guest row.
    expect(await getUserDriveAccess(redeemer.id, drive.id)).toBe(true);
    expect(await getDriveIdsForUser(redeemer.id)).toContain(drive.id);
    await db.delete(pagePermissions).where(and(eq(pagePermissions.pageId, shared.id), eq(pagePermissions.userId, redeemer.id)));
    expect(await getUserDriveAccess(redeemer.id, drive.id)).toBe(false);
    expect(await getDriveIdsForUser(redeemer.id)).not.toContain(drive.id);
  });

  it('does not let a guest block its drive owner from deleting their account', async () => {
    const { drive, owner, redeemer, token } = await seedDrive();
    expect((await redeemPageShareLink(ctxFor(redeemer.id), token)).ok).toBe(true);
    // Owners get an OWNER row of their own once they open the drive
    // (updateDriveLastAccessed), so the guest is the drive's second row.
    await factories.createDriveMember(drive.id, owner.id, { role: 'OWNER' });

    expect(await accountRepository.checkAndDeleteSoloDrives(owner.id)).toEqual({ multiMemberDriveNames: [] });
    expect(await db.select({ id: drives.id }).from(drives).where(eq(drives.id, drive.id))).toEqual([]);
  });

  it('gives a guest nothing from a custom role its row happens to carry', async () => {
    const { drive, redeemer, shared, other, token } = await seedDrive();
    const hidden = await factories.createPage(drive.id, { isPrivate: true });
    expect((await redeemPageShareLink(ctxFor(redeemer.id), token)).ok).toBe(true);

    const on = { canView: true, canEdit: true, canShare: false };
    const [role] = await db
      .insert(driveRoles)
      .values({ id: createId(), driveId: drive.id, name: `r-${createId()}`, permissions: { [hidden.id]: on }, driveWidePermissions: on, updatedAt: new Date() })
      .returning();
    await db.update(driveMembers).set({ customRoleId: role.id })
      .where(and(eq(driveMembers.driveId, drive.id), eq(driveMembers.userId, redeemer.id)));

    expect(await getUserAccessLevel(redeemer.id, hidden.id)).toBeNull();
    expect(await getUserAccessLevel(redeemer.id, other.id)).toBeNull();
    const batch = await getBatchPagePermissions(redeemer.id, [shared.id, other.id, hidden.id]);
    expect(batch.get(shared.id)?.canView).toBe(true);
    expect(batch.get(other.id)?.canView).toBe(false);
    expect(batch.get(hidden.id)?.canView).toBe(false);
    expect((await getUsersWhoCanViewPage(hidden.id, [redeemer.id])).size).toBe(0);
    expect(await getUserAccessiblePagesInDrive(redeemer.id, drive.id)).toEqual([shared.id]);
    expect((await getUserAccessiblePagesInDriveWithDetails(redeemer.id, drive.id)).map((p) => p.id)).toEqual([shared.id]);
    expect(await getDriveMemberUserIdsByCustomRole(drive.id, role.id)).toEqual([]);
    expect(await getMemberCustomRoleId(drive.id, redeemer.id)).toBeNull();
    const fromSql = new Set(await accessiblePageIds(redeemer.id));
    expect([shared.id, other.id, hidden.id].filter((id) => fromSql.has(id))).toEqual([shared.id]);
  });

  it('does not let a guest share a page by virtue of having created it', async () => {
    const { drive, redeemer, token } = await seedDrive();
    const stranger = await seedUser();
    expect((await redeemPageShareLink(ctxFor(redeemer.id), token)).ok).toBe(true);
    const created = await factories.createPage(drive.id, { createdBy: redeemer.id });

    const result = await grantPagePermission(ctxFor(redeemer.id), {
      pageId: created.id,
      targetUserId: stranger.id,
      permissions: { canView: true, canEdit: false, canShare: false, canDelete: false },
    });

    expect(result.ok).toBe(false);
  });

  it('does not let a guest bind an agent it controls to the drive', async () => {
    const { drive, redeemer, token } = await seedDrive();
    expect((await redeemPageShareLink(ctxFor(redeemer.id), token)).ok).toBe(true);
    const ownDrive = await factories.createDrive(redeemer.id);
    const agent = await factories.createPage(ownDrive.id, { type: 'AI_CHAT' });

    const result = await addAgentToDrive({ actingUserId: redeemer.id, agentPageId: agent.id, driveId: drive.id });

    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('leaves a pending ADMIN invite pending and ADMIN', async () => {
    const { drive, redeemer, token } = await seedDrive();
    await factories.createDriveMember(drive.id, redeemer.id, { role: 'ADMIN', acceptedAt: null });

    expect((await redeemPageShareLink(ctxFor(redeemer.id), token)).ok).toBe(true);

    const row = await membershipOf(drive.id, redeemer.id);
    expect(row?.role).toBe('ADMIN');
    expect(row?.acceptedAt).toBeNull();
  });

  it.each(['ADMIN', 'MEMBER'] as const)(
    'leaves an accepted %s membership exactly as it was',
    async (role) => {
      const { drive, redeemer, token } = await seedDrive();
      const acceptedAt = new Date('2026-01-02T03:04:05.000Z');
      await factories.createDriveMember(drive.id, redeemer.id, { role, acceptedAt });

      expect((await redeemPageShareLink(ctxFor(redeemer.id), token)).ok).toBe(true);

      const row = await membershipOf(drive.id, redeemer.id);
      expect(row?.role).toBe(role);
      expect(row?.acceptedAt?.toISOString()).toBe(acceptedAt.toISOString());
    },
  );

  it('keeps a guest a guest when they redeem a second link in the same drive', async () => {
    const { owner, drive, redeemer, other, token } = await seedDrive();
    const second = await createPageShareLink(ctxFor(owner.id), other.id, { permissions: ['VIEW'] });
    if (!second.ok) throw new Error(second.error);

    expect((await redeemPageShareLink(ctxFor(redeemer.id), token)).ok).toBe(true);
    expect((await redeemPageShareLink(ctxFor(redeemer.id), second.data.rawToken)).ok).toBe(true);

    expect((await membershipOf(drive.id, redeemer.id))?.role).toBe('GUEST');
    expect((await getUserAccessLevel(redeemer.id, other.id))?.canView).toBe(true);
  });

  it('lets a drive link turn a guest into a real member', async () => {
    const { owner, drive, redeemer, other, token } = await seedDrive();
    expect((await redeemPageShareLink(ctxFor(redeemer.id), token)).ok).toBe(true);

    const driveLink = await createDriveShareLink(ctxFor(owner.id), drive.id, {});
    if (!driveLink.ok) throw new Error(driveLink.error);
    const upgraded = await redeemDriveShareLink(ctxFor(redeemer.id), driveLink.data.rawToken);
    expect(upgraded.ok).toBe(true);

    expect((await membershipOf(drive.id, redeemer.id))?.role).toBe('MEMBER');
    expect(await isUserDriveMember(redeemer.id, drive.id)).toBe(true);
    expect((await getUserAccessLevel(redeemer.id, other.id))?.canView).toBe(true);
  });
});
