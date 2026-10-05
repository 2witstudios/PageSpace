/**
 * The org's Open-drive role floor — REAL Postgres (Spec POL-6, D-OW-11; Review 3+4: the floor was stored and never
 * read, and a damaged value failed open to `edit`).
 *
 * The default role org members hold in an Open drive is the DRIVE's setting (its default custom role, or with none
 * the plain MEMBER role: view); the org policy sets only the floor under it. Enforced at every WRITE that can leave
 * an Open org drive's default below the floor (point-guard ruling): role create, update and delete; raising the
 * floor; a drive created Open, moved in Open or switched to Open. Each is tested both ways; a damaged stored floor
 * reads as view; a personal drive and a Restricted org drive have no floor.
 *
 * Locally:
 *     DATABASE_URL=... bun run --filter '@pagespace/lib' test:integration -- src/services/__tests__/open-role-floor.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { factories } from '@pagespace/db/test/factories';
import { db, pool } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers, driveRoles } from '@pagespace/db/schema/members';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';

vi.mock('../../organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));
vi.mock('../../audit/org-audit', () => ({ recordOrgAuditEvent: vi.fn(async () => {}), recordOrgAuditEventAfterCommit: vi.fn(async () => true) }));

import { updateOrgPolicies } from '../../organizations/policies';
import { OpenRoleFloorError, createDriveRole, deleteDriveRole, updateDriveRole } from '../drive-role-service';
import { guardOpenRoleFloor } from '../../organizations/open-role-floor';
import { changeDriveVisibility, createOrgDrive, moveDriveToOrg, type OrgDriveServiceDeps } from '../org-drive-service';
import { orgDriveServiceDeps } from '../org-drive-service-deps';

const deps: OrgDriveServiceDeps = { ...orgDriveServiceDeps, syncOrgMembership: async () => async () => {} };

const created = { userIds: [] as string[], driveIds: [] as string[], orgIds: [] as string[] };
let w: { orgId: string; owner: string; orgDrive: string; personalDrive: string };

async function cleanup() {
  // Roles go with their drive; then org rows; users last.
  if (created.driveIds.length) await db.delete(drives).where(inArray(drives.id, created.driveIds));
  if (created.orgIds.length) {
    await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, created.orgIds));
    await db.delete(orgMembers).where(inArray(orgMembers.orgId, created.orgIds));
    await db.delete(organizations).where(inArray(organizations.id, created.orgIds));
  }
  if (created.userIds.length) await db.delete(users).where(inArray(users.id, created.userIds));
  created.userIds = [];
  created.driveIds = [];
  created.orgIds = [];
}

beforeEach(async () => {
  const owner = (await factories.createUser()).id;
  const outsider = (await factories.createUser()).id;
  created.userIds.push(owner, outsider);
  const orgId = createId();
  created.orgIds.push(orgId);
  await db.insert(organizations).values({ id: orgId, name: 'Northwind', slug: `nw-${createId()}`, ownerId: owner });
  await db.insert(orgMembers).values({ orgId, userId: owner, role: 'OWNER' });
  // [D-OW-30] an org with no subscription row is lapsed and refuses moves and new drives: this org is active.
  await factories.createOrgSubscription(orgId);
  const orgDrive = (await factories.createDrive(owner)).id;
  const personalDrive = (await factories.createDrive(outsider)).id;
  created.driveIds.push(orgDrive, personalDrive);
  await db.update(drives).set({ orgId, orgVisibility: 'OPEN' }).where(eq(drives.id, orgDrive));
  w = { orgId, owner, orgDrive, personalDrive };
});

afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

const VIEW = { canView: true, canEdit: false, canShare: false };
const EDIT = { canView: true, canEdit: true, canShare: false };
const setFloor = (openDriveRoleFloor: 'view' | 'edit') => updateOrgPolicies({ orgId: w.orgId, actorId: w.owner, patch: { openDriveRoleFloor } });
const role = (driveId: string, name: string, isDefault: boolean, driveWidePermissions: typeof VIEW | null) =>
  createDriveRole(driveId, { name, isDefault, permissions: {}, driveWidePermissions });
const defaults = (driveId: string) => db.select().from(driveRoles).where(eq(driveRoles.driveId, driveId)).then((rs) => rs.filter((r) => r.isDefault).map((r) => r.name));

const setFloorOk = async (floor: 'view' | 'edit') => {
  const r = await setFloor(floor);
  if (!r.ok) throw new Error(`floor ${floor} refused: ${JSON.stringify(r)}`);
};

describe('the org floor under an Open drive default role', () => {
  it('POL-6 (partial) X-6 (partial) a VIEW floor refuses a default that takes view away (drive-wide or on a page) and keeps one that grants view or edit, or no drive-wide grant (member view)', async () => {
    await expect(role(w.orgDrive, 'No view', true, { canView: false, canEdit: false, canShare: false })).rejects.toBeInstanceOf(OpenRoleFloorError);
    const page = (await factories.createPage(w.orgDrive)).id;
    await expect(createDriveRole(w.orgDrive, { name: 'Hides a page', isDefault: true, permissions: { [page]: { canView: false, canEdit: false, canShare: false } }, driveWidePermissions: VIEW }))
      .rejects.toBeInstanceOf(OpenRoleFloorError);
    expect(await defaults(w.orgDrive)).toEqual([]);
    await role(w.orgDrive, 'Member view', true, null);
    expect(await defaults(w.orgDrive)).toEqual(['Member view']);
    await role(w.orgDrive, 'Viewer', true, VIEW);
    expect(await defaults(w.orgDrive)).toEqual(['Viewer']);
    await role(w.orgDrive, 'Editor', true, EDIT);
    expect(await defaults(w.orgDrive)).toEqual(['Editor']);
  });

  it('POL-6 (partial) X-6 (partial) under an EDIT floor a view-only default is refused, naming the policy, and nothing is written; an edit default is kept', async () => {
    await role(w.orgDrive, 'Editor', true, EDIT);
    await setFloorOk('edit');
    const refused = await role(w.orgDrive, 'Viewer', true, VIEW).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(OpenRoleFloorError);
    expect(refused).toMatchObject({ code: 'org_policy', policy: 'openDriveRoleFloor', status: 403, floor: 'edit' });
    expect(await defaults(w.orgDrive)).toEqual(['Editor']);
    await role(w.orgDrive, 'Editor 2', true, EDIT);
    expect(await defaults(w.orgDrive)).toEqual(['Editor 2']);
  });

  it('POL-6 (partial) an update cannot make a below-floor role the default, lower the default, unset it or delete it; renaming the default is not re-judged', async () => {
    const editor = await role(w.orgDrive, 'Editor', true, EDIT);
    const viewer = await role(w.orgDrive, 'Viewer', false, VIEW);
    await setFloorOk('edit');

    await expect(updateDriveRole(w.orgDrive, viewer.id, { isDefault: true })).rejects.toBeInstanceOf(OpenRoleFloorError);
    await expect(updateDriveRole(w.orgDrive, editor.id, { driveWidePermissions: VIEW })).rejects.toBeInstanceOf(OpenRoleFloorError);
    // Unsetting or deleting the default leaves members on the plain MEMBER role (view): below an edit floor.
    await expect(updateDriveRole(w.orgDrive, editor.id, { isDefault: false })).rejects.toBeInstanceOf(OpenRoleFloorError);
    await expect(deleteDriveRole(w.orgDrive, editor.id)).rejects.toBeInstanceOf(OpenRoleFloorError);
    expect(await defaults(w.orgDrive)).toEqual(['Editor']);

    await updateDriveRole(w.orgDrive, editor.id, { name: 'Editors' });
    expect(await defaults(w.orgDrive)).toEqual(['Editors']);
    // Under a view floor the same writes are allowed.
    await setFloorOk('view');
    await updateDriveRole(w.orgDrive, viewer.id, { isDefault: true });
    expect(await defaults(w.orgDrive)).toEqual(['Viewer']);
    await deleteDriveRole(w.orgDrive, viewer.id);
    expect(await defaults(w.orgDrive)).toEqual([]);
  });

  it('POL-6 (partial) raising the floor is refused while an Open drive is below it, naming the drives; it succeeds once they are fixed', async () => {
    const result = await setFloor('edit');
    expect(result).toMatchObject({ ok: false, reason: 'open_role_floor', floor: 'edit', drives: [{ id: w.orgDrive }] });
    await expect((await import('../../organizations/policies')).getOrgPolicies(w.orgId)).resolves.toMatchObject({ openDriveRoleFloor: 'view' });
    await role(w.orgDrive, 'Editor', true, EDIT);
    await setFloorOk('edit');
  });

  it('POL-6 (partial) X-6 (partial) a drive cannot BECOME an Open org drive below the floor: created Open, moved in Open, or switched to Open', async () => {
    await role(w.orgDrive, 'Editor', true, EDIT);
    await setFloorOk('edit');

    // Created: a new drive has no default role, so Open is refused and Restricted is not.
    expect(await createOrgDrive(w.owner, { name: 'Product', orgId: w.orgId }, deps)).toMatchObject({ ok: false, status: 403, code: 'POLICY_OPEN_ROLE_FLOOR' });
    const restricted = await createOrgDrive(w.owner, { name: 'Product', orgId: w.orgId, orgVisibility: 'RESTRICTED' }, deps);
    if (!restricted.ok) throw new Error('restricted create');
    created.driveIds.push(restricted.drive.id);

    // Switched to Open: refused until its default meets the floor.
    expect(await changeDriveVisibility(w.owner, restricted.drive.id, { orgVisibility: 'OPEN' }, deps)).toMatchObject({ ok: false, code: 'POLICY_OPEN_ROLE_FLOOR' });
    await role(restricted.drive.id, 'Editor', true, EDIT);
    expect(await changeDriveVisibility(w.owner, restricted.drive.id, { orgVisibility: 'OPEN' }, deps)).toMatchObject({ ok: true, changed: true });

    // Moved in: a personal drive with a view-only default is refused Open and admitted Restricted.
    const mine = (await factories.createDrive(w.owner)).id;
    created.driveIds.push(mine);
    await role(mine, 'Viewer', true, VIEW);
    expect(await moveDriveToOrg(w.owner, mine, { orgId: w.orgId }, deps)).toMatchObject({ ok: false, code: 'POLICY_OPEN_ROLE_FLOOR' });
    expect(await moveDriveToOrg(w.owner, mine, { orgId: w.orgId, orgVisibility: 'RESTRICTED' }, deps)).toMatchObject({ ok: true });
  });

  it('POL-6 (partial) a damaged stored floor fails CLOSED: it reads as view, so it never forces more than a drive chose', async () => {
    await db.update(organizations).set({ policies: { openDriveRoleFloor: 'EDIT!' } }).where(eq(organizations.id, w.orgId));
    await role(w.orgDrive, 'Viewer', true, VIEW);
    expect(await defaults(w.orgDrive)).toEqual(['Viewer']);
    expect(await createOrgDrive(w.owner, { name: 'Open one', orgId: w.orgId }, deps)).toMatchObject({ ok: true });
    const [made] = await db.select({ id: drives.id }).from(drives).where(eq(drives.orgId, w.orgId));
    if (made) created.driveIds.push(...(await db.select({ id: drives.id }).from(drives).where(eq(drives.orgId, w.orgId))).map((d) => d.id));
  });

  it('POL-6 (partial) a personal drive and a Restricted org drive have no floor; a role that is not the default is never judged', async () => {
    await role(w.personalDrive, 'Pages only', true, null);
    expect(await defaults(w.personalDrive)).toEqual(['Pages only']);
    await db.update(drives).set({ orgVisibility: 'RESTRICTED' }).where(eq(drives.id, w.orgDrive));
    await role(w.orgDrive, 'Pages only', true, null);
    expect(await defaults(w.orgDrive)).toEqual(['Pages only']);
    await role(w.orgDrive, 'Another', false, null);
  });

  it('POL-6 (partial) a per-page entry on the default below the floor is refused on the page-permission path too (the AI set_role_page_permissions tool and the Share dialog)', async () => {
    const editor = await role(w.orgDrive, 'Editor', true, EDIT);
    await setFloorOk('edit');
    const page = (await factories.createPage(w.orgDrive)).id;
    await expect(updateDriveRole(w.orgDrive, editor.id, { permissionsPatch: { [page]: { canView: true, canEdit: false, canShare: false } } })).rejects.toBeInstanceOf(OpenRoleFloorError);
    await updateDriveRole(w.orgDrive, editor.id, { permissionsPatch: { [page]: { canView: true, canEdit: true, canShare: true } } });
  });

  it('POL-6 (partial) a drive ALREADY below the floor: a write that touches its default and leaves it below is refused; editing another role there is not', async () => {
    const viewer = await role(w.orgDrive, 'Viewer', true, VIEW);
    const other = await role(w.orgDrive, 'Other', false, VIEW);
    // The floor is raised past the drive without the raise check (as an org that set it before this was enforced).
    await db.update(organizations).set({ policies: { openDriveRoleFloor: 'edit' } }).where(eq(organizations.id, w.orgId));

    await expect(updateDriveRole(w.orgDrive, viewer.id, { description: 'still view only', driveWidePermissions: { canView: true, canEdit: false, canShare: true } }))
      .rejects.toBeInstanceOf(OpenRoleFloorError);
    await updateDriveRole(w.orgDrive, other.id, { name: 'Other renamed' });
    await updateDriveRole(w.orgDrive, viewer.id, { driveWidePermissions: EDIT });
    expect(await defaults(w.orgDrive)).toEqual(['Viewer']);
  });

  it('POL-6 (partial) org members follow the drive\'s CURRENT default: changing which role is the default, or deleting it, moves their rows in the same write', async () => {
    const member = (await factories.createUser()).id;
    created.userIds.push(member);
    await db.insert(orgMembers).values({ orgId: w.orgId, userId: member, role: 'MEMBER' });
    const r1 = await role(w.orgDrive, 'R1', true, EDIT);
    await db.insert(driveMembers).values({ driveId: w.orgDrive, userId: member, role: 'MEMBER', customRoleId: r1.id, source: 'org', acceptedAt: new Date() });
    await setFloorOk('edit');
    const rowRole = async () => (await db.select({ c: driveMembers.customRoleId }).from(driveMembers).where(eq(driveMembers.userId, member)))[0]?.c;

    const r2 = await role(w.orgDrive, 'R2', true, EDIT);
    expect(await rowRole()).toBe(r2.id);
    // R1 is no longer anyone's default, so lowering it reaches nobody.
    await updateDriveRole(w.orgDrive, r1.id, { driveWidePermissions: VIEW });
    expect(await rowRole()).toBe(r2.id);

    await setFloorOk('view');
    await deleteDriveRole(w.orgDrive, r2.id);
    expect(await rowRole()).toBeNull();
  });

  it('POL-6 (partial) a role write waits for a visibility change holding the drive, then judges the drive it left: lowering the default of a drive that just went Open is refused', async () => {
    await db.update(drives).set({ orgVisibility: 'RESTRICTED' }).where(eq(drives.id, w.orgDrive));
    const editor = await role(w.orgDrive, 'Editor', true, EDIT);
    await setFloorOk('edit');

    const other = await pool.connect();
    try {
      // What changeDriveVisibility holds after its floor check passed on the EDIT default: org FOR SHARE, drive FOR UPDATE.
      await other.query('begin');
      await other.query('select id from organizations where id = $1 for share', [w.orgId]);
      await other.query('select id from drives where id = $1 for update', [w.orgDrive]);
      await other.query(`update drives set "orgVisibility" = 'OPEN' where id = $1`, [w.orgDrive]);

      let settled = false;
      const lowering = updateDriveRole(w.orgDrive, editor.id, { driveWidePermissions: VIEW }).finally(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);
      await other.query('commit');

      await expect(lowering).rejects.toBeInstanceOf(OpenRoleFloorError);
    } finally {
      other.release();
    }
    const [def] = await db.select({ driveWide: driveRoles.driveWidePermissions }).from(driveRoles).where(eq(driveRoles.id, editor.id));
    expect(def.driveWide).toEqual(EDIT);
  });

  it('POL-6 (partial) two concurrent writes that each make a default leave exactly one default', async () => {
    await Promise.all([role(w.orgDrive, 'A', true, EDIT), role(w.orgDrive, 'B', true, EDIT)]);
    expect(await defaults(w.orgDrive)).toHaveLength(1);
  });

  it('POL-6 (partial) a custom role an admin assigned by hand to an org member is left alone when the default changes; only rows on the previous default follow', async () => {
    const [m1, m2] = [(await factories.createUser()).id, (await factories.createUser()).id];
    created.userIds.push(m1, m2);
    await db.insert(orgMembers).values([{ orgId: w.orgId, userId: m1, role: 'MEMBER' }, { orgId: w.orgId, userId: m2, role: 'MEMBER' }]);
    const r1 = await role(w.orgDrive, 'R1', true, EDIT);
    const special = await role(w.orgDrive, 'Special', false, EDIT);
    await db.insert(driveMembers).values([
      { driveId: w.orgDrive, userId: m1, role: 'MEMBER', customRoleId: r1.id, source: 'org', acceptedAt: new Date() },
      { driveId: w.orgDrive, userId: m2, role: 'MEMBER', customRoleId: special.id, source: 'org', acceptedAt: new Date() },
    ]);
    const r2 = await role(w.orgDrive, 'R2', true, EDIT);
    const rowRole = async (u: string) => (await db.select({ c: driveMembers.customRoleId }).from(driveMembers).where(eq(driveMembers.userId, u)))[0]?.c;
    expect(await rowRole(m1)).toBe(r2.id);
    expect(await rowRole(m2)).toBe(special.id);
  });

  it('POL-6 (partial) a role write on a drive moved into an org at that moment holds the ORG row too: the org is re-read under the drive lock', async () => {
    const personal = (await factories.createDrive(w.owner)).id;
    created.driveIds.push(personal);
    const mover = await pool.connect();
    const probe = await pool.connect();
    try {
      // T2 moves the drive into the org: the drive row is locked and its orgId changed, not yet committed.
      await mover.query('begin');
      await mover.query('select id from drives where id = $1 for update', [personal]);
      await mover.query(`update drives set "orgId" = $1, "orgVisibility" = 'RESTRICTED' where id = $2`, [w.orgId, personal]);

      let orgHeldDuringWrite: boolean | null = null;
      const guarded = db.transaction((tx) => guardOpenRoleFloor(tx, personal, async () => {
        // A policy writer trying the org row now must find it held by this role write.
        orgHeldDuringWrite = await probe.query('select id from organizations where id = $1 for update nowait', [w.orgId])
          .then(() => false, (error: { code?: string }) => error.code === '55P03');
      }));
      await new Promise((r) => setTimeout(r, 200));
      await mover.query('commit');
      await guarded;
      expect(orgHeldDuringWrite).toBe(true);
    } finally {
      await probe.query('rollback').catch(() => {});
      mover.release();
      probe.release();
    }
  });
});
