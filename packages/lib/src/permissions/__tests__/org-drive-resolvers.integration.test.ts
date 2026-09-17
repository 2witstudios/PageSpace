/**
 * Integration tests for org access in the four human drive resolvers (Wave B7): getUserAccessLevel,
 * getDriveAccess, getDriveAccessWithDrive and listAccessibleDrives, against real Postgres.
 *
 * Requires a running Postgres database with the latest migrations applied.
 * Run via:
 *   bun run --filter '@pagespace/lib' test:integration -- src/permissions/__tests__/org-drive-resolvers.integration.test.ts
 *
 * The decision itself is pinned without a database (org-drive-resolution.test.ts). What only a
 * database proves is that the resolvers read the right rows: the org role, the drive's default
 * role, the source of the membership row, and the audit row they write.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { factories } from '@pagespace/db/test/factories';
import { db, pool } from '@pagespace/db/db';
import { inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveRoles } from '@pagespace/db/schema/members';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { resetAuditDbBindingForTests } from '../../audit/audit-db-binding';
import { resetDefaultSecurityAuditForTests, securityAudit } from '../../audit/security-audit';
import { getUserAccessLevel } from '../permissions';
import {
  getDriveAccess,
  getDriveAccessWithDrive,
  listAccessibleDrives,
  type ListDrivesOptions,
} from '../../services/drive-service';
import {
  legacyGetDriveAccess,
  legacyGetDriveAccessWithDrive,
  legacyGetUserAccessLevel,
  legacyListAccessibleDrives,
} from './fixtures/pre-org-drive-resolvers';

const flags = vi.hoisted(() => ({ orgsEnabled: false }));
vi.mock('../../organizations/orgs-enabled', () => ({
  get ORGS_ENABLED() {
    return flags.orgsEnabled;
  },
}));

const createdOrgIds: string[] = [];
const createdUserIds: string[] = [];

async function createUser(name: string) {
  const user = await factories.createUser({ name });
  createdUserIds.push(user.id);
  return user;
}

async function createOrg(name: string, ownerId: string) {
  const [org] = await db.insert(organizations).values({ name, slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${createId()}`, ownerId }).returning();
  createdOrgIds.push(org.id);
  return org;
}

/**
 * Northwind Labs (Sequence Spec fixture), with every membership shape the resolvers must tell apart.
 * Lena leads every Northwind drive, so the org Owner (Jono) and Admin (Priya) reach them only
 * through org power, never through drives.ownerId.
 */
async function northwind() {
  const jono = await createUser('Jono');
  const priya = await createUser('Priya Nair');
  const omar = await createUser('Omar Haddad');
  const lena = await createUser('Lena Park');
  const marcus = await createUser('Marcus Oyelaran');
  const nina = await createUser('Nina Brandt');
  const eve = await createUser('Eve Santos');
  const chris = await createUser('Chris Rowe');
  const dana = await createUser('Dana Whit');

  const org = await createOrg('Northwind Labs', jono.id);
  await db.insert(orgMembers).values([
    { orgId: org.id, userId: jono.id, role: 'OWNER' },
    { orgId: org.id, userId: priya.id, role: 'ADMIN' },
    { orgId: org.id, userId: omar.id, role: 'ADMIN' },
    { orgId: org.id, userId: lena.id, role: 'MEMBER' },
    { orgId: org.id, userId: marcus.id, role: 'MEMBER' },
    { orgId: org.id, userId: nina.id, role: 'MEMBER' },
    { orgId: org.id, userId: eve.id, role: 'MEMBER' },
  ]);

  const product = await factories.createDrive(lena.id, { name: 'Product', slug: `product-${createId()}`, orgId: org.id, orgVisibility: 'OPEN' });
  const research = await factories.createDrive(lena.id, { name: 'Customer Research', slug: `research-${createId()}`, orgId: org.id, orgVisibility: 'RESTRICTED' });
  const finance = await factories.createDrive(lena.id, { name: 'Finance', slug: `finance-${createId()}`, orgId: org.id, orgVisibility: 'PRIVATE' });

  const productPage = await factories.createPage(product.id, { title: 'Roadmap' });
  const productPrivatePage = await factories.createPage(product.id, { title: 'Hiring', isPrivate: true });
  const researchPage = await factories.createPage(research.id, { title: 'Interviews' });
  const financePage = await factories.createPage(finance.id, { title: 'Runway' });
  const financePrivatePage = await factories.createPage(finance.id, { title: 'Salaries', isPrivate: true });

  // Product's default role lets implicit members edit (DRV-5, POL-6); a plain row could not.
  const [defaultRole] = await db
    .insert(driveRoles)
    .values({
      driveId: product.id,
      name: 'Contributor',
      isDefault: true,
      permissions: {},
      driveWidePermissions: { canView: true, canEdit: true, canShare: false },
    })
    .returning();

  // Marcus: synced org row on Product; STALE org rows on Research and Finance (the #2661 P1 shape).
  await factories.createDriveMember(product.id, marcus.id, { source: 'org', customRoleId: defaultRole.id });
  await factories.createDriveMember(research.id, marcus.id, { source: 'org' });
  await factories.createDriveMember(finance.id, marcus.id, { source: 'org' });
  // Nina joined the org after the last sync: no row anywhere.
  // Eve joined Research (an approved join is an invite row).
  await factories.createDriveMember(research.id, eve.id, { source: 'invite' });
  // Omar is an org Admin who was also invited to Finance as ADMIN: his row, not org power, opens it.
  await factories.createDriveMember(finance.id, omar.id, { source: 'invite', role: 'ADMIN' });
  // Chris is a guest on Product (DRV-8), and holds a page share inside Finance.
  await factories.createDriveMember(product.id, chris.id, { source: 'invite' });
  await factories.createPagePermission(financePage.id, chris.id);

  // Dana is not in Northwind. She left it (a stale org row on Product the sync has not removed),
  // belongs to Acme, and is invited to Marcus's personal drive.
  await factories.createDriveMember(product.id, dana.id, { source: 'org' });
  const acme = await createOrg('Acme', dana.id);
  await db.insert(orgMembers).values({ orgId: acme.id, userId: dana.id, role: 'OWNER' });
  const acmeWiki = await factories.createDrive(dana.id, { name: 'Acme Wiki', slug: `acme-wiki-${createId()}`, orgId: acme.id, orgVisibility: 'OPEN' });

  const personal = await factories.createDrive(marcus.id, { name: 'Marcus Notes', slug: `notes-${createId()}` });
  const personalPage = await factories.createPage(personal.id, { title: 'Scratch' });
  const personalPrivatePage = await factories.createPage(personal.id, { title: 'Diary', isPrivate: true });
  await factories.createDriveMember(personal.id, dana.id, { source: 'invite' });
  await factories.createDriveMember(personal.id, nina.id, { source: 'invite', role: 'ADMIN' });

  return {
    people: { jono, priya, omar, lena, marcus, nina, eve, chris, dana },
    org, acme,
    drives: { product, research, finance, acmeWiki, personal },
    pages: { productPage, productPrivatePage, researchPage, financePage, financePrivatePage, personalPage, personalPrivatePage },
  };
}

type Fixture = Awaited<ReturnType<typeof northwind>>;

const LIST_OPTIONS: ListDrivesOptions[] = [{}, { includeTrash: true }, { tokenScopable: true }];

/** Read through the audit service, so the query follows the same binding (main DB or Admin PG) as the write. */
async function auditRowsFor(resourceIds: string[]) {
  const rows = await Promise.all(
    resourceIds.map((resourceId) => securityAudit.queryEvents({ eventType: 'authz.access.granted', resourceId })),
  );
  return rows.flat().map((r) => ({ userId: r.userId, resourceId: r.resourceId, details: r.details }));
}

const listedIds = async (userId: string, options?: ListDrivesOptions) =>
  (await listAccessibleDrives(userId, options)).map((d) => d.id).sort();

/** Every resolver, every user, every target: the live answer must equal the frozen pre-org answer. */
async function expectResolversMatchLegacy(userIds: string[], driveIds: string[], pageIds: string[]) {
  let compared = 0;
  for (const userId of userIds) {
    for (const target of [...driveIds, ...pageIds]) {
      expect(await getUserAccessLevel(userId, target), `getUserAccessLevel ${userId} ${target}`)
        .toEqual(await legacyGetUserAccessLevel(userId, target));
      compared += 1;
    }
    for (const driveId of driveIds) {
      expect(await getDriveAccess(driveId, userId)).toEqual(await legacyGetDriveAccess(driveId, userId));
      expect(await getDriveAccessWithDrive(driveId, userId)).toEqual(await legacyGetDriveAccessWithDrive(driveId, userId));
      compared += 2;
    }
    for (const options of LIST_OPTIONS) {
      // toStrictEqual: same drives, same order, same keys and values (JSON byte-identical).
      expect(await listAccessibleDrives(userId, options)).toStrictEqual(await legacyListAccessibleDrives(userId, options));
      compared += 1;
    }
  }
  return compared;
}

describe('org access in the human drive resolvers (integration)', () => {
  // Same teardown discipline as org-membership-sync.integration.test.ts: org drives, then orgs
  // (drives.orgId and organizations.ownerId RESTRICT), then users (cascading the rest).
  afterEach(async () => {
    flags.orgsEnabled = false;
    const orgIds = createdOrgIds.splice(0);
    if (orgIds.length > 0) {
      await db.delete(drives).where(inArray(drives.orgId, orgIds));
      await db.delete(organizations).where(inArray(organizations.id, orgIds));
    }
    const userIds = createdUserIds.splice(0);
    if (userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
  }, 120_000);

  // CI points ADMIN_DATABASE_URL at a scratch Admin PG that other suites drop and recreate. Pin the
  // audit binding to the main database for this suite so the ORG-4 audit row is read back from the
  // same store it was written to, then restore the process env for the suites after it.
  const AUDIT_ENV = ['ADMIN_DATABASE_URL', 'ADMIN_DB_BREAK_GLASS', 'AUDIT_TRUST_PLANE_REQUIRED'] as const;
  const savedAuditEnv = new Map<string, string | undefined>();
  const resetAuditBinding = () => {
    resetAuditDbBindingForTests();
    resetDefaultSecurityAuditForTests();
  };

  beforeAll(() => {
    for (const key of AUDIT_ENV) {
      savedAuditEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    resetAuditBinding();
  });

  afterAll(async () => {
    for (const [key, value] of savedAuditEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetAuditBinding();
    await pool.end();
  });

  const everyone = (f: Fixture) => Object.values(f.people).map((u) => u.id);

  it('while ORGS_ENABLED is false every resolver returns exactly the pre-org result, for personal and org drives, and writes no audit row', async () => {
    const f = await northwind();
    flags.orgsEnabled = false;

    const compared = await expectResolversMatchLegacy(everyone(f), Object.values(f.drives).map((d) => d.id), Object.values(f.pages).map((p) => p.id));
    expect(compared).toBe(9 * (5 + 7) + 9 * 5 * 2 + 9 * LIST_OPTIONS.length);

    // Not vacuous: the fixture holds rows that org rules treat differently once enabled.
    expect(await getUserAccessLevel(f.people.marcus.id, f.drives.finance.id)).not.toBeNull();
    expect(await getUserAccessLevel(f.people.priya.id, f.drives.finance.id)).toBeNull();
    expect(await listedIds(f.people.nina.id)).toEqual([f.drives.personal.id]);

    expect(await auditRowsFor([f.drives.product.id, f.drives.research.id, f.drives.finance.id])).toEqual([]);
  });

  it('while ORGS_ENABLED is true personal drives still resolve exactly as before', async () => {
    const f = await northwind();
    flags.orgsEnabled = true;

    const personalTargets = [f.pages.personalPage.id, f.pages.personalPrivatePage.id];
    for (const userId of everyone(f)) {
      for (const target of [f.drives.personal.id, ...personalTargets]) {
        expect(await getUserAccessLevel(userId, target)).toEqual(await legacyGetUserAccessLevel(userId, target));
      }
      expect(await getDriveAccess(f.drives.personal.id, userId)).toEqual(await legacyGetDriveAccess(f.drives.personal.id, userId));
      expect(await getDriveAccessWithDrive(f.drives.personal.id, userId)).toEqual(await legacyGetDriveAccessWithDrive(f.drives.personal.id, userId));
      const personalListing = async (list: typeof listAccessibleDrives) =>
        (await list(userId)).filter((d) => d.orgId === null);
      expect(await personalListing(listAccessibleDrives)).toStrictEqual(await personalListing(legacyListAccessibleDrives));
    }
  });

  it('ORG-4 (partial) the org Owner and an org Admin resolve full access on every Northwind drive with no membership row, and only org power used on the PRIVATE drive writes an audit row', async () => {
    const f = await northwind();
    flags.orgsEnabled = true;
    const full = { canView: true, canEdit: true, canShare: true, canDelete: true };
    const admin = { isOwner: false, isAdmin: true, isMember: true, role: 'ADMIN' };

    // Omar's own ADMIN row opens Finance: org power is not used, no audit owed.
    expect(await getUserAccessLevel(f.people.omar.id, f.pages.financePrivatePage.id)).toEqual(full);
    expect(await getDriveAccess(f.drives.finance.id, f.people.omar.id)).toEqual(admin);

    for (const person of [f.people.jono, f.people.priya]) {
      for (const drive of [f.drives.product, f.drives.research]) {
        expect(await getUserAccessLevel(person.id, drive.id)).toEqual(full);
        expect(await getDriveAccess(drive.id, person.id)).toEqual(admin);
      }
      expect(await getUserAccessLevel(person.id, f.pages.productPrivatePage.id)).toEqual(full);
      expect(await getUserAccessLevel(person.id, f.pages.researchPage.id)).toEqual(full);
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await auditRowsFor([f.drives.product.id, f.drives.research.id, f.drives.finance.id])).toEqual([]);

    expect(await getUserAccessLevel(f.people.priya.id, f.pages.financePrivatePage.id)).toEqual(full);
    expect((await getDriveAccessWithDrive(f.drives.finance.id, f.people.jono.id))?.access).toEqual(admin);

    await vi.waitFor(async () => {
      const rows = await auditRowsFor([f.drives.finance.id]);
      expect(rows.map((r) => r.userId).sort()).toEqual([f.people.priya.id, f.people.jono.id].sort());
    }, { timeout: 10_000, interval: 200 });
    const rows = await auditRowsFor([f.drives.finance.id]);
    expect(rows.find((r) => r.userId === f.people.priya.id)?.details).toEqual({
      via: 'org_admin', orgId: f.org.id, orgRole: 'ADMIN', orgVisibility: 'PRIVATE',
    });
    expect(rows.some((r) => r.userId === f.people.omar.id)).toBe(false);
  });

  it('DRV-5 (partial) an org member with no row resolves an OPEN drive with its default role and sees it listed; a private page stays closed', async () => {
    const f = await northwind();
    flags.orgsEnabled = true;
    const { nina } = f.people;

    // The default role's drive-wide canEdit is what grants edit: a plain member would read only.
    expect(await getUserAccessLevel(nina.id, f.pages.productPage.id)).toEqual({ canView: true, canEdit: true, canShare: false, canDelete: false });
    expect(await getUserAccessLevel(nina.id, f.pages.productPrivatePage.id)).toBeNull();
    expect(await getUserAccessLevel(nina.id, f.drives.product.id)).toEqual({ canView: true, canEdit: true, canShare: false, canDelete: false });
    expect(await getDriveAccess(f.drives.product.id, nina.id)).toEqual({ isOwner: false, isAdmin: false, isMember: true, role: 'MEMBER' });

    const listed = await listAccessibleDrives(nina.id);
    const product = listed.find((d) => d.id === f.drives.product.id);
    expect(product).toMatchObject({ isOwned: false, role: 'MEMBER', orgId: f.org.id, orgVisibility: 'OPEN' });
    expect(listed.find((d) => d.id === f.drives.personal.id)).toMatchObject({ role: 'ADMIN', orgId: null });
    expect(await listedIds(nina.id, { tokenScopable: true })).toEqual([f.drives.product.id, f.drives.personal.id].sort());
  });

  it('DRV-6 (partial) an org member sees no RESTRICTED or PRIVATE drive without a joined row, and a stale source org row opens and lists nothing', async () => {
    const f = await northwind();
    flags.orgsEnabled = true;
    const none = { isOwner: false, isAdmin: false, isMember: false, role: null };

    for (const member of [f.people.marcus, f.people.nina]) {
      for (const target of [f.drives.research.id, f.pages.researchPage.id, f.drives.finance.id, f.pages.financePage.id, f.pages.financePrivatePage.id]) {
        expect(await getUserAccessLevel(member.id, target), `${member.name} ${target}`).toBeNull();
      }
      for (const drive of [f.drives.research, f.drives.finance]) {
        expect(await getDriveAccess(drive.id, member.id)).toEqual(none);
        expect((await getDriveAccessWithDrive(drive.id, member.id))?.access).toEqual(none);
      }
    }
    expect(await listedIds(f.people.marcus.id)).toEqual([f.drives.product.id, f.drives.personal.id].sort());

    // Joined: Eve's invite row opens and lists Research.
    expect(await getUserAccessLevel(f.people.eve.id, f.pages.researchPage.id)).toMatchObject({ canView: true });
    expect(await listedIds(f.people.eve.id)).toEqual([f.drives.product.id, f.drives.research.id].sort());

    // An org Admin who can open them still does not get RESTRICTED or PRIVATE drives listed until joined.
    const priyaListing = await listAccessibleDrives(f.people.priya.id);
    expect(priyaListing.map((d) => [d.id, d.role])).toEqual([[f.drives.product.id, 'ADMIN']]);
    expect(await listedIds(f.people.omar.id)).toEqual([f.drives.product.id, f.drives.finance.id].sort());
  });

  it('X-6 (partial) a non-member sees no Northwind drive, not even the OPEN one through a stale org row, and a guest sees exactly the one drive they were invited to', async () => {
    const f = await northwind();
    flags.orgsEnabled = true;
    const { dana, chris } = f.people;

    for (const target of [f.drives.product.id, f.pages.productPage.id, f.drives.research.id, f.drives.finance.id]) {
      expect(await getUserAccessLevel(dana.id, target)).toBeNull();
    }
    expect((await getDriveAccess(f.drives.product.id, dana.id)).isMember).toBe(false);
    expect(await listedIds(dana.id)).toEqual([f.drives.acmeWiki.id, f.drives.personal.id].sort());

    // The guest: Product only, even though a Finance page is shared with them.
    for (const options of LIST_OPTIONS) {
      expect(await listedIds(chris.id, options)).toEqual([f.drives.product.id]);
    }
    expect(await getUserAccessLevel(chris.id, f.drives.research.id)).toBeNull();
    expect(await getUserAccessLevel(chris.id, f.drives.finance.id)).toBeNull();
    expect(await getUserAccessLevel(chris.id, f.pages.productPrivatePage.id)).toBeNull();
    expect(await getDriveAccess(f.drives.product.id, chris.id)).toEqual({ isOwner: false, isAdmin: false, isMember: true, role: 'MEMBER' });
  });
});
