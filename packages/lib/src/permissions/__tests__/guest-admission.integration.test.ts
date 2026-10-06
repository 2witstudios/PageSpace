/**
 * The guests-policy admission decision against REAL Postgres (Spec POL-2, X-6): the facts it reads (the drive's org,
 * the live policy, org membership, who leads the drive) and the answer for each kind of person.
 *
 * Locally:
 *     DATABASE_URL=... bun run --filter '@pagespace/lib' test:integration -- src/permissions/__tests__/guest-admission.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { factories } from '@pagespace/db/test/factories';
import { db, pool } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';

vi.mock('../../organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));

import { decideOrgDriveAdmission } from '../guest-admission';

const run = createId().slice(0, 8);
const created = { userIds: [] as string[], driveIds: [] as string[], orgIds: [] as string[] };
let w: { orgId: string; owner: string; member: string; outsider: string; legacyLead: string; orgDrive: string; legacyDrive: string; personalDrive: string };

async function cleanup() {
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
  const mk = async () => {
    const u = await factories.createUser();
    created.userIds.push(u.id);
    return u.id;
  };
  const [owner, member, outsider, legacyLead] = [await mk(), await mk(), await mk(), await mk()];
  const orgId = createId();
  created.orgIds.push(orgId);
  await db.insert(organizations).values({ id: orgId, name: 'Northwind', slug: `nw-${run}-${createId().slice(0, 4)}`, ownerId: owner });
  await db.insert(orgMembers).values([{ orgId, userId: owner, role: 'OWNER' }, { orgId, userId: member, role: 'MEMBER' }]);
  // Northwind is paid: a lapsed org admits no outsider ([D-OW-33], lapsed-loosen.integration.test.ts).
  await factories.createOrgSubscription(orgId, { status: 'active' });
  const mkDrive = async (ownerId: string, org: string | null) => {
    const d = await factories.createDrive(ownerId);
    created.driveIds.push(d.id);
    if (org) await db.update(drives).set({ orgId: org, orgVisibility: 'OPEN' }).where(eq(drives.id, d.id));
    return d.id;
  };
  w = { orgId, owner, member, outsider, legacyLead, orgDrive: await mkDrive(owner, orgId), legacyDrive: await mkDrive(legacyLead, orgId), personalDrive: await mkDrive(outsider, null) };
});

afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

const setGuests = (guests: string) => db.update(organizations).set({ policies: { guests } }).where(eq(organizations.id, w.orgId));

describe('decideOrgDriveAdmission', () => {
  it('POL-2 (partial) an outsider is refused under off, held under approve, allowed under on; the answer follows the policy the next time it is asked', async () => {
    const ask = () => decideOrgDriveAdmission({ driveId: w.orgDrive, userId: w.outsider });
    await setGuests('off');
    expect(await ask()).toEqual({ decision: 'refuse', refusal: 'guests_off', orgId: w.orgId });
    await setGuests('approve');
    expect(await ask()).toEqual({ decision: 'hold', orgId: w.orgId });
    await setGuests('on');
    expect(await ask()).toEqual({ decision: 'allow', orgId: w.orgId });
  });

  it('POL-2 (partial) an org member and the drive\'s own lead (even one outside the org) are never guests, whatever the policy', async () => {
    await setGuests('off');
    expect((await decideOrgDriveAdmission({ driveId: w.orgDrive, userId: w.member })).decision).toBe('allow');
    expect((await decideOrgDriveAdmission({ driveId: w.legacyDrive, userId: w.legacyLead })).decision).toBe('allow');
    // The same outside person is a guest on a drive they do not lead.
    expect((await decideOrgDriveAdmission({ driveId: w.orgDrive, userId: w.legacyLead })).decision).toBe('refuse');
  });

  it('POL-2 (partial) a person with no account yet (an address) can only be an outsider', async () => {
    await setGuests('approve');
    expect((await decideOrgDriveAdmission({ driveId: w.orgDrive })).decision).toBe('hold');
    expect((await decideOrgDriveAdmission({ driveId: w.orgDrive, userId: null })).decision).toBe('hold');
  });

  it('POL-2 (partial) X-6 (partial) a personal drive and an unknown drive have no guest policy: allowed, no org named', async () => {
    await setGuests('off');
    expect(await decideOrgDriveAdmission({ driveId: w.personalDrive, userId: w.member })).toEqual({ decision: 'allow', orgId: null });
    expect(await decideOrgDriveAdmission({ driveId: 'no-such-drive', userId: w.outsider })).toEqual({ decision: 'allow', orgId: null });
  });

  it('POL-2 (partial) a damaged stored policy fails closed to OFF, never to allow', async () => {
    await db.update(organizations).set({ policies: { guests: 'banana' } }).where(eq(organizations.id, w.orgId));
    expect((await decideOrgDriveAdmission({ driveId: w.orgDrive, userId: w.outsider })).decision).toBe('refuse');
  });
});
