/**
 * Integration tests for the accessible_page_ids_for_user(uid) Postgres function.
 *
 * These tests require a running Postgres database with the latest migrations
 * applied. Run via:
 *   ./scripts/test-with-db.sh
 *   bun run --filter '@pagespace/db' test -- src/__tests__/accessible-page-ids.integration.test.ts
 *
 * The function is the canonical "what pages can this user view?" primitive that
 * collapses the (owner | drive-admin | explicit-grant | accepted-member-on-a-
 * non-private-page) authorization graph into one DB-side call. Trashed pages,
 * trashed drives, and expired explicit grants are all excluded by the function
 * definition. The current rule set is `drizzle/0133_default_member_read.sql`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { factories } from '../test/factories';
import { db } from '../db';
import { sql } from '../operators';
import { users } from '../schema/auth';
import { drives, pages } from '../schema/core';
import { driveMembers, pagePermissions } from '../schema/members';

async function callFunction(uid: string): Promise<string[]> {
  const result = await db.execute<{ page_id: string }>(
    sql`SELECT page_id FROM accessible_page_ids_for_user(${uid})`,
  );
  return result.rows.map((r) => r.page_id).sort();
}

function sorted(ids: string[]): string[] {
  return [...ids].sort();
}

describe('accessible_page_ids_for_user (Postgres function)', () => {
  it('pins search_path on the SECURITY DEFINER function to prevent search-path hijacking', async () => {
    const result = await db.execute<{ proconfig: string[] | null }>(
      sql`SELECT proconfig FROM pg_proc WHERE proname = 'accessible_page_ids_for_user'`,
    );
    const proconfig = result.rows[0]?.proconfig ?? null;
    expect(proconfig, 'function should have a proconfig (search_path etc.) set').not.toBeNull();
    const hasSearchPath = (proconfig ?? []).some((entry) => entry.startsWith('search_path='));
    expect(hasSearchPath, 'search_path should be pinned on the function').toBe(true);
  });

  beforeEach(async () => {
    // Delete in FK order to avoid cascade contention.
    await db.delete(pagePermissions);
    await db.delete(pages);
    await db.delete(driveMembers);
    await db.delete(drives);
    await db.delete(users);
  });

  it('grants drive owner access to every non-trashed page in their non-trashed drive', async () => {
    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const p1 = await factories.createPage(drive.id);
    const p2 = await factories.createPage(drive.id);

    const accessible = await callFunction(owner.id);

    expect(accessible).toEqual(sorted([p1.id, p2.id]));
  });

  it('grants drive ADMIN member access to every non-trashed page in the drive', async () => {
    const owner = await factories.createUser();
    const admin = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const p1 = await factories.createPage(drive.id);
    const p2 = await factories.createPage(drive.id);
    await factories.createDriveMember(drive.id, admin.id, {
      role: 'ADMIN',
      acceptedAt: new Date(),
    });

    const accessible = await callFunction(admin.id);

    expect(accessible).toEqual(sorted([p1.id, p2.id]));
  });

  it('does NOT grant access to an ADMIN member whose invitation has not been accepted', async () => {
    const owner = await factories.createUser();
    const pending = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    await factories.createPage(drive.id);
    await factories.createDriveMember(drive.id, pending.id, {
      role: 'ADMIN',
      acceptedAt: null,
    });

    const accessible = await callFunction(pending.id);

    expect(accessible).toEqual([]);
  });

  /**
   * Migration 0133 (`0133_default_member_read.sql`) added rule 4 — "Discord-style
   * open-by-default": an ACCEPTED drive member of any role reads every page in the
   * drive that is not explicitly `isPrivate`. This file asserted the pre-0133
   * closed-by-default rule and kept asserting it for 120+ migrations, because the
   * suite ran in no job. `packages/lib/src/permissions/permissions.ts` (the TS leg
   * of the same decision) has agreed with 0133 the whole time; only these two
   * assertions were stale.
   */
  it('grants an accepted regular MEMBER read on NON-private pages (0133 rule 4)', async () => {
    const owner = await factories.createUser();
    const member = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const open = await factories.createPage(drive.id);
    await factories.createDriveMember(drive.id, member.id, { role: 'MEMBER' });

    const accessible = await callFunction(member.id);

    expect(accessible).toEqual([open.id]);
  });

  it('does NOT grant a regular MEMBER access to an isPrivate page without an explicit grant', async () => {
    const owner = await factories.createUser();
    const member = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    await factories.createPage(drive.id, { isPrivate: true });
    await factories.createDriveMember(drive.id, member.id, { role: 'MEMBER' });

    const accessible = await callFunction(member.id);

    expect(accessible).toEqual([]);
  });

  it('grants explicit-permission holder access only to the permitted page (canView=true)', async () => {
    const owner = await factories.createUser();
    const grantee = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const grantedPage = await factories.createPage(drive.id);
    const otherPage = await factories.createPage(drive.id);
    await factories.createPagePermission(grantedPage.id, grantee.id, {
      canView: true,
      canEdit: false,
      canShare: false,
      canDelete: false,
    });

    const accessible = await callFunction(grantee.id);

    expect(accessible).toEqual([grantedPage.id]);
    expect(accessible).not.toContain(otherPage.id);
  });

  it('excludes pages whose explicit grant has canView=false', async () => {
    const owner = await factories.createUser();
    const grantee = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const page = await factories.createPage(drive.id);
    await factories.createPagePermission(page.id, grantee.id, {
      canView: false,
      canEdit: false,
      canShare: false,
      canDelete: false,
    });

    const accessible = await callFunction(grantee.id);

    expect(accessible).toEqual([]);
  });

  it('excludes pages whose explicit grant has expired', async () => {
    const owner = await factories.createUser();
    const grantee = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const page = await factories.createPage(drive.id);
    await factories.createPagePermission(page.id, grantee.id, {
      canView: true,
      canEdit: false,
      canShare: false,
      canDelete: false,
      expiresAt: new Date(Date.now() - 60_000),
    });

    const accessible = await callFunction(grantee.id);

    expect(accessible).toEqual([]);
  });

  it('includes pages whose explicit grant expires in the future', async () => {
    const owner = await factories.createUser();
    const grantee = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const page = await factories.createPage(drive.id);
    await factories.createPagePermission(page.id, grantee.id, {
      canView: true,
      canEdit: false,
      canShare: false,
      canDelete: false,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const accessible = await callFunction(grantee.id);

    expect(accessible).toEqual([page.id]);
  });

  it('excludes trashed pages even from the drive owner', async () => {
    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const live = await factories.createPage(drive.id);
    await factories.createPage(drive.id, { isTrashed: true, trashedAt: new Date() });

    const accessible = await callFunction(owner.id);

    expect(accessible).toEqual([live.id]);
  });

  it('excludes pages in trashed drives even from the drive owner', async () => {
    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id, {
      isTrashed: true,
      trashedAt: new Date(),
    });
    await factories.createPage(drive.id);

    const accessible = await callFunction(owner.id);

    expect(accessible).toEqual([]);
  });

  it('returns empty for a user with no relationships at all', async () => {
    const owner = await factories.createUser();
    const stranger = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    await factories.createPage(drive.id);

    const accessible = await callFunction(stranger.id);

    expect(accessible).toEqual([]);
  });

  it('combines drive ownership, ADMIN membership, and explicit grants for a single user', async () => {
    const owner = await factories.createUser();
    const second = await factories.createUser();
    const adminTarget = await factories.createUser();
    const ownDrive = await factories.createDrive(owner.id);
    const adminDrive = await factories.createDrive(adminTarget.id);
    const grantDrive = await factories.createDrive(adminTarget.id);

    const ownPage = await factories.createPage(ownDrive.id);
    const ownPrivatePage = await factories.createPage(ownDrive.id, { isPrivate: true });
    const adminPage = await factories.createPage(adminDrive.id);
    const grantedPage = await factories.createPage(grantDrive.id);
    const blockedPage = await factories.createPage(grantDrive.id);

    await factories.createDriveMember(adminDrive.id, second.id, { role: 'ADMIN' });
    await factories.createDriveMember(ownDrive.id, second.id, { role: 'MEMBER' });
    await factories.createPagePermission(grantedPage.id, second.id, {
      canView: true,
      canEdit: false,
      canShare: false,
      canDelete: false,
    });

    const accessible = await callFunction(second.id);

    // Owns nothing, ADMIN of adminDrive (sees adminPage), explicit grant for
    // grantedPage, and — since 0133 rule 4 — accepted MEMBER of ownDrive, so the
    // NON-private ownPage is readable while the isPrivate one is not.
    expect(accessible).toEqual(sorted([adminPage.id, grantedPage.id, ownPage.id]));
    expect(accessible).not.toContain(ownPrivatePage.id);
    // blockedPage lives in a drive where `second` is neither owner, admin, nor
    // member — no membership, so rule 4 cannot reach it.
    expect(accessible).not.toContain(blockedPage.id);
  });
});
