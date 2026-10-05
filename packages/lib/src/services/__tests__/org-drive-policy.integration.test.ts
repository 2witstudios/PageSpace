/**
 * Who can create org drives (Spec POL-5) against REAL Postgres, through the PRODUCTION policy wiring
 * (orgDriveServiceDeps): creating a drive in the org and moving a personal drive in are both "creating an org drive", so
 * both are judged by the org's policy, read inside the transaction, every time.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { factories } from '@pagespace/db/test/factories';
import { db, pool } from '@pagespace/db/db';
import { eq, inArray, or } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';

vi.mock('../../organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));
vi.mock('../../audit/org-audit', () => ({ recordOrgAuditEvent: vi.fn(async () => {}), recordOrgAuditEventAfterCommit: vi.fn(async () => true) }));

import { createOrgDrive, moveDriveToOrg, type OrgDriveServiceDeps } from '../org-drive-service';
import { orgDriveServiceDeps } from '../org-drive-service-deps';

// The policy lookup and the role lookup are production; only the realtime publish is stubbed.
const deps: OrgDriveServiceDeps = { ...orgDriveServiceDeps, syncOrgMembership: async () => async () => {} };

const created = { userIds: [] as string[], orgId: '' };
let w: { orgId: string; owner: string; admin: string; member: string; outsider: string };

async function cleanup() {
  if (created.orgId) {
    await db.delete(drives).where(or(eq(drives.orgId, created.orgId), inArray(drives.ownerId, created.userIds)));
    await db.delete(orgMembers).where(eq(orgMembers.orgId, created.orgId));
    await db.delete(orgSubscriptions).where(eq(orgSubscriptions.orgId, created.orgId));
    await db.delete(organizations).where(eq(organizations.id, created.orgId));
  }
  if (created.userIds.length) await db.delete(users).where(inArray(users.id, created.userIds));
  created.userIds = [];
  created.orgId = '';
}

beforeEach(async () => {
  const people = await factories.createUsers(4, { subscriptionTier: 'free' });
  created.userIds.push(...people.map((p) => p.id));
  const [owner, admin, member, outsider] = people.map((p) => p.id);
  const orgId = createId();
  created.orgId = orgId;
  await db.insert(organizations).values({ id: orgId, name: 'Northwind', slug: `nw-${createId()}`, ownerId: owner });
  // Paid: there is no org trial, and an unpaid org is lapsed from creation (D-OW-30).
  await factories.createOrgSubscription(orgId);
  await db.insert(orgMembers).values([{ orgId, userId: owner, role: 'OWNER' }, { orgId, userId: admin, role: 'ADMIN' }, { orgId, userId: member, role: 'MEMBER' }]);
  w = { orgId, owner, admin, member, outsider };
});

afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

const setWho = (whoCanCreateDrives: string | undefined) => db.update(organizations).set({ policies: whoCanCreateDrives === undefined ? {} : { whoCanCreateDrives } }).where(eq(organizations.id, w.orgId));
const personalDrive = async (ownerId: string) => (await factories.createDrive(ownerId)).id;
const orgDriveCount = () => db.$count(drives, eq(drives.orgId, w.orgId));

describe('creating an org drive', () => {
  it('POL-5 with no policy stored every member may create (today\'s behaviour); an outsider may not', async () => {
    expect((await createOrgDrive(w.member, { name: 'Product', orgId: w.orgId }, deps)).ok).toBe(true);
    expect(await createOrgDrive(w.outsider, { name: 'X', orgId: w.orgId }, deps)).toMatchObject({ ok: false, status: 403, code: 'NOT_ORG_MEMBER' });
  });

  it('POL-5 with admins only, a Member is refused and nothing is created; Owner and Admin still create', async () => {
    await setWho('admins');
    expect(await createOrgDrive(w.member, { name: 'Nope', orgId: w.orgId }, deps)).toMatchObject({ ok: false, status: 403, code: 'POLICY_FORBIDS_CREATE' });
    expect(await orgDriveCount()).toBe(0);
    expect((await createOrgDrive(w.admin, { name: 'A', orgId: w.orgId }, deps)).ok).toBe(true);
    expect((await createOrgDrive(w.owner, { name: 'B', orgId: w.orgId }, deps)).ok).toBe(true);
  });

  it('POL-5 the policy is read at each call: flipping it applies to the very next create, no restart', async () => {
    await setWho('admins');
    expect((await createOrgDrive(w.member, { name: 'One', orgId: w.orgId }, deps)).ok).toBe(false);
    await setWho('members');
    expect((await createOrgDrive(w.member, { name: 'Two', orgId: w.orgId }, deps)).ok).toBe(true);
    await setWho('admins');
    expect((await createOrgDrive(w.member, { name: 'Three', orgId: w.orgId }, deps)).ok).toBe(false);
  });

  it('POL-5 (partial) a damaged stored value fails closed to admins only', async () => {
    await setWho('banana');
    expect((await createOrgDrive(w.member, { name: 'X', orgId: w.orgId }, deps)).ok).toBe(false);
    expect((await createOrgDrive(w.admin, { name: 'Y', orgId: w.orgId }, deps)).ok).toBe(true);
  });
});

describe('moving a personal drive in', () => {
  it('POL-5 with admins only a Member cannot move their own drive in (same policy as creating); an Admin can; with members allowed the Member can', async () => {
    await setWho('admins');
    const memberDrive = await personalDrive(w.member);
    expect(await moveDriveToOrg(w.member, memberDrive, { orgId: w.orgId }, deps)).toMatchObject({ ok: false, status: 403, code: 'POLICY_FORBIDS_CREATE' });
    expect((await db.select({ orgId: drives.orgId }).from(drives).where(eq(drives.id, memberDrive)))[0].orgId).toBeNull();

    const adminDrive = await personalDrive(w.admin);
    expect((await moveDriveToOrg(w.admin, adminDrive, { orgId: w.orgId }, deps)).ok).toBe(true);

    await setWho('members');
    expect((await moveDriveToOrg(w.member, memberDrive, { orgId: w.orgId }, deps)).ok).toBe(true);
  });
});
