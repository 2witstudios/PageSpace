/**
 * Integration tests for the accessible_page_ids_for_user(uid) Postgres function.
 *
 * These tests require a running Postgres database with the latest migrations
 * applied. Run via:
 *   ./scripts/test-with-db.sh
 *   pnpm --filter @pagespace/db test -- src/__tests__/accessible-page-ids.integration.test.ts
 *
 * The function is the canonical "what pages can this user view?" primitive that
 * collapses the (owner | drive-admin | explicit-grant) authorization graph into
 * one DB-side call. Trashed pages, trashed drives, and expired explicit grants
 * are all excluded by the function definition.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { factories } from '../test/factories';
import { db, sql, users, drives, pages, driveMembers, pagePermissions } from '..';

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
    await factories.createDriveMember(drive.id, admin.id, { role: 'ADMIN' });

    const accessible = await callFunction(admin.id);

    expect(accessible).toEqual(sorted([p1.id, p2.id]));
  });

  it('does NOT grant regular MEMBER access to pages without explicit grants', async () => {
    const owner = await factories.createUser();
    const member = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    await factories.createPage(drive.id);
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

    // Owns nothing, ADMIN of adminDrive (sees adminPage), explicit grant for grantedPage,
    // MEMBER of ownDrive without explicit grants (does NOT see ownPage).
    expect(accessible).toEqual(sorted([adminPage.id, grantedPage.id]));
    expect(accessible).not.toContain(ownPage.id);
    expect(accessible).not.toContain(blockedPage.id);
  });
});
