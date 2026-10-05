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
import { driveRoles } from '@pagespace/db/schema/members';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';

vi.mock('../../organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));
vi.mock('../../audit/org-audit', () => ({ recordOrgAuditEvent: vi.fn(async () => {}), recordOrgAuditEventAfterCommit: vi.fn(async () => true) }));

import { updateOrgPolicies } from '../../organizations/policies';
import { OpenRoleFloorError, createDriveRole, deleteDriveRole, updateDriveRole } from '../drive-role-service';
import { changeDriveVisibility, createOrgDrive, moveDriveToOrg, type OrgDriveServiceDeps } from '../org-drive-service';
import { orgDriveServiceDeps } from '../org-drive-service-deps';

const deps: OrgDriveServiceDeps = { ...orgDriveServiceDeps, syncOrgMembership: async () => async () => {} };

const created = { userIds: [] as string[], driveIds: [] as string[], orgIds: [] as string[] };
let w: { orgId: string; owner: string; orgDrive: string; personalDrive: string };

async function cleanup() {
  // Roles go with their drive; then org rows; users last.
  if (created.driveIds.length) await db.delete(drives).where(inArray(drives.id, created.driveIds));
  if (created.orgIds.length) {
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
  it('POL-6 (partial) X-6 (partial) a VIEW floor refuses a default that grants nothing drive-wide and keeps one that grants view or edit', async () => {
    await expect(role(w.orgDrive, 'Pages only', true, null)).rejects.toBeInstanceOf(OpenRoleFloorError);
    expect(await defaults(w.orgDrive)).toEqual([]);
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
});
