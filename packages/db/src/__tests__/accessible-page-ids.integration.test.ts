/**
 * Integration tests for the accessible_page_ids_for_user(uid) Postgres function.
 *
 * These tests require a running Postgres database with the latest migrations
 * applied. Run via:
 *   ./scripts/test-with-db.sh
 *   bun run --filter '@pagespace/db' test -- src/__tests__/accessible-page-ids.integration.test.ts
 *
 * The function is the canonical "what pages can this user view?" primitive that
 * collapses the (owner | drive-admin | explicit-grant | custom-role | accepted-
 * member-on-a-non-private-page) authorization graph into one DB-side call.
 * Trashed pages, trashed drives, and expired explicit grants are all excluded by
 * the function definition. The current rule set is
 * `drizzle/0296_accessible_page_ids_denies_utc.sql`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { factories } from '../test/factories';
import { db } from '../db';
import { sql } from '../operators';
import { inArray } from 'drizzle-orm';
import { users } from '../schema/auth';
import { driveRoles } from '../schema/members';
import { createId } from '@paralleldrive/cuid2';

async function callFunction(uid: string): Promise<string[]> {
  const result = await db.execute<{ page_id: string }>(
    sql`SELECT page_id FROM accessible_page_ids_for_user(${uid})`,
  );
  return result.rows.map((r) => r.page_id).sort();
}

/**
 * Calls the function inside a transaction whose session TimeZone is `tz`.
 * `expiresAt` is a timestamp WITHOUT time zone holding UTC wall time, so a
 * comparison against bare now() is only right when the session happens to be
 * UTC — which CI's is and a developer's usually is not. Pinning a non-UTC zone
 * here makes the expiry cases independent of wherever the suite runs.
 */
async function callFunctionInTimeZone(uid: string, tz: string): Promise<string[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('TimeZone', ${tz}, true)`);
    const result = await tx.execute<{ page_id: string }>(
      sql`SELECT page_id FROM accessible_page_ids_for_user(${uid})`,
    );
    return result.rows.map((r) => r.page_id).sort();
  });
}

async function createDriveRole(
  driveId: string,
  permissions: Record<string, { canView: boolean; canEdit: boolean; canShare: boolean }>,
  driveWidePermissions: { canView: boolean; canEdit: boolean; canShare: boolean } | null = null,
) {
  const [role] = await db
    .insert(driveRoles)
    .values({ id: createId(), driveId, name: `role-${createId()}`, permissions, driveWidePermissions, updatedAt: new Date() })
    .returning();
  return role;
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

  /**
   * Row-scoped cleanup. This replaces an unqualified
   *   DELETE FROM page_permissions; DELETE FROM pages; DELETE FROM drive_members;
   *   DELETE FROM drives; DELETE FROM users;
   * in `beforeEach`, which emptied the whole app database — including rows
   * belonging to whatever else was running against the shared CI Postgres. It
   * was only ever safe because this suite was pinned to the last step of the
   * job, i.e. by sequencing luck, and it made that pinning permanent.
   *
   * Nothing here needs an empty table: every assertion is already scoped to a
   * user this test just created, so foreign rows are invisible to it. And every
   * fixture below hangs off such a user through a cascading FK
   * (drives.ownerId → pages.driveId → page_permissions.pageId /
   * drive_members.driveId), so deleting the seeded users deletes exactly this
   * file's rows and nothing else.
   */
  const seededUserIds: string[] = [];

  async function seedUser(overrides?: Parameters<typeof factories.createUser>[0]) {
    const user = await factories.createUser(overrides);
    seededUserIds.push(user.id);
    return user;
  }

  afterEach(async () => {
    if (seededUserIds.length === 0) return;
    await db.delete(users).where(inArray(users.id, seededUserIds));
    seededUserIds.length = 0;
  });

  it('grants drive owner access to every non-trashed page in their non-trashed drive', async () => {
    const owner = await seedUser();
    const drive = await factories.createDrive(owner.id);
    const p1 = await factories.createPage(drive.id);
    const p2 = await factories.createPage(drive.id);

    const accessible = await callFunction(owner.id);

    expect(accessible).toEqual(sorted([p1.id, p2.id]));
  });

  it('grants drive ADMIN member access to every non-trashed page in the drive', async () => {
    const owner = await seedUser();
    const admin = await seedUser();
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
    const owner = await seedUser();
    const pending = await seedUser();
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
    const owner = await seedUser();
    const member = await seedUser();
    const drive = await factories.createDrive(owner.id);
    const open = await factories.createPage(drive.id);
    await factories.createDriveMember(drive.id, member.id, { role: 'MEMBER' });

    const accessible = await callFunction(member.id);

    expect(accessible).toEqual([open.id]);
  });

  it('does NOT grant a regular MEMBER access to an isPrivate page without an explicit grant', async () => {
    const owner = await seedUser();
    const member = await seedUser();
    const drive = await factories.createDrive(owner.id);
    await factories.createPage(drive.id, { isPrivate: true });
    await factories.createDriveMember(drive.id, member.id, { role: 'MEMBER' });

    const accessible = await callFunction(member.id);

    expect(accessible).toEqual([]);
  });

  it('grants explicit-permission holder access only to the permitted page (canView=true)', async () => {
    const owner = await seedUser();
    const grantee = await seedUser();
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
    const owner = await seedUser();
    const grantee = await seedUser();
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
    const owner = await seedUser();
    const grantee = await seedUser();
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
    const owner = await seedUser();
    const grantee = await seedUser();
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
    const owner = await seedUser();
    const drive = await factories.createDrive(owner.id);
    const live = await factories.createPage(drive.id);
    await factories.createPage(drive.id, { isTrashed: true, trashedAt: new Date() });

    const accessible = await callFunction(owner.id);

    expect(accessible).toEqual([live.id]);
  });

  it('excludes pages in trashed drives even from the drive owner', async () => {
    const owner = await seedUser();
    const drive = await factories.createDrive(owner.id, {
      isTrashed: true,
      trashedAt: new Date(),
    });
    await factories.createPage(drive.id);

    const accessible = await callFunction(owner.id);

    expect(accessible).toEqual([]);
  });

  it('returns empty for a user with no relationships at all', async () => {
    const owner = await seedUser();
    const stranger = await seedUser();
    const drive = await factories.createDrive(owner.id);
    await factories.createPage(drive.id);

    const accessible = await callFunction(stranger.id);

    expect(accessible).toEqual([]);
  });

  it('combines drive ownership, ADMIN membership, and explicit grants for a single user', async () => {
    const owner = await seedUser();
    const second = await seedUser();
    const adminTarget = await seedUser();
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

  /**
   * Deny paths. getUserAccessLevel resolves a non-owner, non-admin user in this
   * order: an unexpired page_permissions row decides outright (canView=false is
   * a DENY, even for a member of the drive); otherwise the member's custom role
   * decides when it has an entry for the page or a drive-wide default (a
   * drive-wide default never opens a private page); only then does rule 4 let
   * an accepted member read a non-private page. The function used to OR rule 4
   * in unconditionally, so every one of these denies leaked the page id.
   */
  describe('agrees with getUserAccessLevel on denies', () => {
    const OFF = { canView: false, canEdit: false, canShare: false };
    const ON = { canView: true, canEdit: false, canShare: false };

    it('excludes a non-private page the custom role of a MEMBER denies per-page', async () => {
      const owner = await seedUser();
      const member = await seedUser();
      const drive = await factories.createDrive(owner.id);
      const denied = await factories.createPage(drive.id);
      const open = await factories.createPage(drive.id);
      const role = await createDriveRole(drive.id, { [denied.id]: OFF });
      await factories.createDriveMember(drive.id, member.id, { customRoleId: role.id });

      expect(await callFunction(member.id)).toEqual([open.id]);
    });

    it('excludes every non-private page when the custom role denies drive-wide', async () => {
      const owner = await seedUser();
      const member = await seedUser();
      const drive = await factories.createDrive(owner.id);
      const listed = await factories.createPage(drive.id);
      await factories.createPage(drive.id);
      const role = await createDriveRole(drive.id, { [listed.id]: ON }, OFF);
      await factories.createDriveMember(drive.id, member.id, { customRoleId: role.id });

      // The per-page entry still wins over the drive-wide default.
      expect(await callFunction(member.id)).toEqual([listed.id]);
    });

    it('does not let a drive-wide custom-role grant open a PRIVATE page, but a per-page entry does', async () => {
      const owner = await seedUser();
      const member = await seedUser();
      const drive = await factories.createDrive(owner.id);
      const privateUnlisted = await factories.createPage(drive.id, { isPrivate: true });
      const privateListed = await factories.createPage(drive.id, { isPrivate: true });
      const open = await factories.createPage(drive.id);
      const role = await createDriveRole(drive.id, { [privateListed.id]: ON }, ON);
      await factories.createDriveMember(drive.id, member.id, { customRoleId: role.id });

      const accessible = await callFunction(member.id);
      expect(accessible).toEqual(sorted([privateListed.id, open.id]));
      expect(accessible).not.toContain(privateUnlisted.id);
    });

    it('ignores a custom role that belongs to a different drive', async () => {
      const owner = await seedUser();
      const member = await seedUser();
      const drive = await factories.createDrive(owner.id);
      const otherDrive = await factories.createDrive(owner.id);
      const open = await factories.createPage(drive.id);
      const foreignRole = await createDriveRole(otherDrive.id, { [open.id]: OFF }, OFF);
      await factories.createDriveMember(drive.id, member.id, { customRoleId: foreignRole.id });

      expect(await callFunction(member.id)).toEqual([open.id]);
    });

    it('excludes a non-private page an accepted MEMBER holds an explicit canView=false row for', async () => {
      const owner = await seedUser();
      const member = await seedUser();
      const drive = await factories.createDrive(owner.id);
      const denied = await factories.createPage(drive.id);
      const open = await factories.createPage(drive.id);
      await factories.createDriveMember(drive.id, member.id);
      await factories.createPagePermission(denied.id, member.id, { canView: false });

      expect(await callFunction(member.id)).toEqual([open.id]);
    });

    it('lets an explicit canView=true row override a custom-role deny', async () => {
      const owner = await seedUser();
      const member = await seedUser();
      const drive = await factories.createDrive(owner.id);
      const page = await factories.createPage(drive.id);
      const role = await createDriveRole(drive.id, {}, OFF);
      await factories.createDriveMember(drive.id, member.id, { customRoleId: role.id });
      await factories.createPagePermission(page.id, member.id, { canView: true });

      expect(await callFunction(member.id)).toEqual([page.id]);
    });

    it('treats an EXPIRED explicit deny as absent, so rule 4 applies again', async () => {
      const owner = await seedUser();
      const member = await seedUser();
      const drive = await factories.createDrive(owner.id);
      const page = await factories.createPage(drive.id);
      await factories.createDriveMember(drive.id, member.id);
      await factories.createPagePermission(page.id, member.id, {
        canView: false,
        expiresAt: new Date(Date.now() - 60 * 60 * 1000),
      });

      expect(await callFunction(member.id)).toEqual([page.id]);
    });

    it('never applies a custom role or rule 4 to a PENDING member', async () => {
      const owner = await seedUser();
      const pending = await seedUser();
      const drive = await factories.createDrive(owner.id);
      const page = await factories.createPage(drive.id);
      const role = await createDriveRole(drive.id, { [page.id]: ON }, ON);
      await factories.createDriveMember(drive.id, pending.id, { customRoleId: role.id, acceptedAt: null });

      expect(await callFunction(pending.id)).toEqual([]);
    });
  });

  /**
   * expiresAt holds UTC wall time in a timestamp WITHOUT time zone. Compared
   * against bare now() it is reinterpreted in the SESSION's zone, so west of
   * UTC an expired grant stays live for hours and east of UTC a live grant is
   * already dead. getUserAccessLevel compares against a UTC Date parameter and
   * is right in every zone; the function must be too.
   */
  describe('grant expiry is evaluated in UTC, whatever the session time zone', () => {
    it.each(['America/Chicago', 'Pacific/Kiritimati', 'UTC'])(
      'in %s: excludes a grant that expired an hour ago and includes one that expires in an hour',
      async (tz) => {
        const owner = await seedUser();
        const expired = await seedUser();
        const live = await seedUser();
        const drive = await factories.createDrive(owner.id);
        const page = await factories.createPage(drive.id);
        await factories.createPagePermission(page.id, expired.id, {
          canView: true,
          expiresAt: new Date(Date.now() - 60 * 60 * 1000),
        });
        await factories.createPagePermission(page.id, live.id, {
          canView: true,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        });

        expect(await callFunctionInTimeZone(expired.id, tz)).toEqual([]);
        expect(await callFunctionInTimeZone(live.id, tz)).toEqual([page.id]);
      },
    );
  });
});
