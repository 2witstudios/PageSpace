/**
 * Integration test: `accessiblePageIds` (the `accessible_page_ids_for_user`
 * Postgres function) must agree with `getUserAccessLevel` for every page.
 *
 * Requires a running Postgres database with the latest migrations applied.
 * Run via:
 *   ./scripts/test-with-db.sh
 *   bun run --filter '@pagespace/lib' test -- src/permissions/__tests__/accessible-page-ids-agreement.integration.test.ts
 *
 * The two are the same decision written twice — once in SQL for the pulse
 * routes and page payloads, once in TypeScript for every per-page check — and
 * they had drifted: the SQL OR-ed "accepted member reads a non-private page" in
 * unconditionally, so a custom-role deny and an explicit canView=false row both
 * left the page in the set, while a custom-role grant on a private page was
 * missing from it. The per-rule cases live beside the function in
 * packages/db/src/__tests__/accessible-page-ids.integration.test.ts; this file
 * holds the invariant, over one drive seeded with every kind of relationship.
 *
 * The one intended difference: the SQL excludes trashed pages outright, so
 * trashed pages are left out of the comparison.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { factories } from '@pagespace/db/test/factories';
import { db } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { driveRoles } from '@pagespace/db/schema/members';
import { createId } from '@paralleldrive/cuid2';
import { accessiblePageIds } from '../accessible-page-ids';
import { getUserAccessLevel } from '../permissions';

const seededUserIds: string[] = [];

async function seedUser() {
  const user = await factories.createUser();
  seededUserIds.push(user.id);
  return user;
}

afterAll(async () => {
  if (seededUserIds.length === 0) return;
  // drives.ownerId, drive_members, page_permissions and drive_roles all cascade
  // from the seeded users, so this removes exactly this file's rows.
  await db.delete(users).where(inArray(users.id, seededUserIds));
});

const ON = { canView: true, canEdit: false, canShare: false };
const OFF = { canView: false, canEdit: false, canShare: false };

describe('accessible_page_ids_for_user agrees with getUserAccessLevel (integration)', () => {
  it('returns exactly the pages getUserAccessLevel lets each user view', async () => {
    const owner = await seedUser();
    const drive = await factories.createDrive(owner.id);
    const open = await factories.createPage(drive.id);
    const open2 = await factories.createPage(drive.id);
    const privatePage = await factories.createPage(drive.id, { isPrivate: true });
    const privatePage2 = await factories.createPage(drive.id, { isPrivate: true });
    const channel = await factories.createPage(drive.id, { type: 'CHANNEL' });
    const pageIds = [open.id, open2.id, privatePage.id, privatePage2.id, channel.id];

    const role = async (
      permissions: Record<string, typeof ON>,
      driveWidePermissions: typeof ON | null,
    ) => {
      const [row] = await db
        .insert(driveRoles)
        .values({ id: createId(), driveId: drive.id, name: `r-${createId()}`, permissions, driveWidePermissions, updatedAt: new Date() })
        .returning();
      return row.id;
    };
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const future = new Date(Date.now() + 60 * 60 * 1000);

    const cases: Array<{ label: string; setup: (userId: string) => Promise<void> }> = [
      { label: 'owner', setup: async () => {} },
      { label: 'stranger', setup: async () => {} },
      { label: 'plain member', setup: async (u) => { await factories.createDriveMember(drive.id, u); } },
      { label: 'admin', setup: async (u) => { await factories.createDriveMember(drive.id, u, { role: 'ADMIN' }); } },
      { label: 'pending member', setup: async (u) => { await factories.createDriveMember(drive.id, u, { acceptedAt: null }); } },
      { label: 'pending admin', setup: async (u) => { await factories.createDriveMember(drive.id, u, { role: 'ADMIN', acceptedAt: null }); } },
      {
        label: 'member, per-page role deny',
        setup: async (u) => { await factories.createDriveMember(drive.id, u, { customRoleId: await role({ [open.id]: OFF, [channel.id]: OFF }, null) }); },
      },
      {
        label: 'member, drive-wide role deny with one per-page grant',
        setup: async (u) => { await factories.createDriveMember(drive.id, u, { customRoleId: await role({ [open2.id]: ON }, OFF) }); },
      },
      {
        label: 'member, drive-wide role grant plus per-page grant on a private page',
        setup: async (u) => { await factories.createDriveMember(drive.id, u, { customRoleId: await role({ [privatePage.id]: ON }, ON) }); },
      },
      {
        label: 'member, empty role',
        setup: async (u) => { await factories.createDriveMember(drive.id, u, { customRoleId: await role({}, null) }); },
      },
      {
        label: 'member, explicit deny',
        setup: async (u) => {
          await factories.createDriveMember(drive.id, u);
          await factories.createPagePermission(open.id, u, { canView: false });
        },
      },
      {
        label: 'member, expired explicit deny',
        setup: async (u) => {
          await factories.createDriveMember(drive.id, u);
          await factories.createPagePermission(open.id, u, { canView: false, expiresAt: past });
        },
      },
      {
        label: 'member, role deny overridden by explicit grant',
        setup: async (u) => {
          await factories.createDriveMember(drive.id, u, { customRoleId: await role({}, OFF) });
          await factories.createPagePermission(open.id, u, { canView: true });
        },
      },
      {
        label: 'non-member, live and expired grants',
        setup: async (u) => {
          await factories.createPagePermission(privatePage.id, u, { canView: true, expiresAt: future });
          await factories.createPagePermission(open.id, u, { canView: true, expiresAt: past });
        },
      },
      {
        label: 'pending member with a role and an explicit grant',
        setup: async (u) => {
          await factories.createDriveMember(drive.id, u, { acceptedAt: null, customRoleId: await role({ [open.id]: ON }, ON) });
          await factories.createPagePermission(privatePage2.id, u, { canView: true });
        },
      },
    ];

    for (const c of cases) {
      const userId = c.label === 'owner' ? owner.id : (await seedUser()).id;
      await c.setup(userId);

      const fromSql = new Set(await accessiblePageIds(userId));
      const sqlInDrive = pageIds.filter((id) => fromSql.has(id)).sort();

      const fromTs: string[] = [];
      for (const pageId of pageIds) {
        if ((await getUserAccessLevel(userId, pageId))?.canView) fromTs.push(pageId);
      }

      expect(sqlInDrive, c.label).toEqual(fromTs.sort());
    }
  });
});
