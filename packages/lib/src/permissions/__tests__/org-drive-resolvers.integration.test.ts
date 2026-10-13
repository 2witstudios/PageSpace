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
import { db, pool } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { orgMembers } from '@pagespace/db/schema/organizations';
import { resetAuditDbBindingForTests } from '../../audit/audit-db-binding';
import { resetDefaultSecurityAuditForTests, securityAudit } from '../../audit/security-audit';
import { getUserAccessLevel } from '../permissions';
import { getScopedDriveAccessLevel } from '../app-permissions';
import {
  getDriveAccess,
  getDriveAccessWithDrive,
  getExplicitScopeAuthority,
  listAccessibleDrives,
  validateDriveScopeAccess,
  type ListDrivesOptions,
} from '../../services/drive-service';
import { checkGrantAuthority, parseScopeList, scopeSetToDriveScopes, type GrantAuthority } from '../../auth/oauth/scopes';
import { cleanupNorthwind, createUser, northwind, type Fixture } from './fixtures/northwind-org-drives';
import { factories } from '@pagespace/db/test/factories';
import {
  legacyGetDriveAccess,
  legacyGetDriveAccessWithDrive,
  legacyGetUserAccessLevel,
  legacyListAccessibleDrives,
} from './fixtures/pre-org-drive-resolvers';
import { credentialActor } from '../access-actor';

const flags = vi.hoisted(() => ({ orgsEnabled: false }));
vi.mock('../../organizations/orgs-enabled', () => ({
  get ORGS_ENABLED() {
    return flags.orgsEnabled;
  },
}));

const LIST_OPTIONS: ListDrivesOptions[] = [{}, { includeTrash: true }, { tokenScopable: true }];

/** Read through the audit service, so the query follows the same binding (main DB or Admin PG) as the write. */
async function auditRowsFor(resourceIds: string[]) {
  const rows = await Promise.all(
    resourceIds.map((resourceId) => securityAudit.queryEvents({ eventType: 'authz.access.granted', resourceId })),
  );
  return rows.flat().map((r) => ({ userId: r.userId, resourceId: r.resourceId, details: r.details }));
}

const listedIds = async (userId: string, options?: ListDrivesOptions) =>
  (await listAccessibleDrives(credentialActor(userId, null), options)).map((d) => d.id).sort();

/** Every resolver, every user, every target: the live answer must equal the frozen pre-org answer. */
async function expectResolversMatchLegacy(userIds: string[], driveIds: string[], pageIds: string[]) {
  let compared = 0;
  for (const userId of userIds) {
    for (const target of [...driveIds, ...pageIds]) {
      expect(await getUserAccessLevel(credentialActor(userId, null), target), `getUserAccessLevel ${userId} ${target}`)
        .toEqual(await legacyGetUserAccessLevel(userId, target));
      compared += 1;
    }
    for (const driveId of driveIds) {
      expect(await getDriveAccess(driveId, credentialActor(userId, null))).toEqual(await legacyGetDriveAccess(driveId, userId));
      expect(await getDriveAccessWithDrive(driveId, credentialActor(userId, null))).toEqual(await legacyGetDriveAccessWithDrive(driveId, userId));
      compared += 2;
    }
    for (const options of LIST_OPTIONS) {
      // toStrictEqual: same drives, same order, same keys and values (JSON byte-identical).
      expect(await listAccessibleDrives(credentialActor(userId, null), options)).toStrictEqual(await legacyListAccessibleDrives(userId, options));
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
    await cleanupNorthwind();
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
    expect(compared).toBe(12 * (6 + 8) + 12 * 6 * 2 + 12 * LIST_OPTIONS.length);

    // Not vacuous: the fixture holds rows that org rules treat differently once enabled.
    expect(await getUserAccessLevel(credentialActor(f.people.marcus.id, null), f.drives.finance.id)).not.toBeNull();
    expect(await getUserAccessLevel(credentialActor(f.people.eve.id, null), f.drives.finance.id)).toBeNull();
    expect(await listedIds(f.people.nina.id)).toEqual([f.drives.personal.id]);
    expect(await listedIds(f.people.fred.id)).toEqual([f.drives.research.id]);

    expect(await auditRowsFor([f.drives.product.id, f.drives.research.id, f.drives.finance.id])).toEqual([]);
  });

  it('D-OW-24 a GUEST row (a redeemed page share link) resolves exactly as master\'s frozen resolvers do, dark and on a personal drive once orgs are on: it opens its granted page and nothing drive-wide', async () => {
    const f = await northwind();
    // Gus redeemed page links: a GUEST row plus a page grant on Marcus's personal drive and on
    // Product (OPEN), and a bare GUEST row on Research (RESTRICTED), whose page he was never given.
    const gus = await createUser('Gus Guest');
    await factories.createDriveMember(f.drives.personal.id, gus.id, { source: 'invite', role: 'GUEST' });
    await factories.createPagePermission(f.pages.personalPage.id, gus.id);
    await factories.createDriveMember(f.drives.product.id, gus.id, { source: 'invite', role: 'GUEST' });
    await factories.createPagePermission(f.pages.productPage.id, gus.id);
    await factories.createDriveMember(f.drives.research.id, gus.id, { source: 'invite', role: 'GUEST' });

    const driveIds = Object.values(f.drives).map((d) => d.id);
    const pageIds = Object.values(f.pages).map((p) => p.id);
    flags.orgsEnabled = false;
    expect(await expectResolversMatchLegacy([gus.id], driveIds, pageIds)).toBe((6 + 8) + 6 * 2 + LIST_OPTIONS.length);

    // Not vacuous: the GUEST row is really there, and it is no membership anywhere.
    const noMembership = { isOwner: false, isAdmin: false, isMember: false, role: null, customRoleId: null };
    for (const drive of [f.drives.personal, f.drives.product, f.drives.research]) {
      expect(await getDriveAccess(drive.id, credentialActor(gus.id, null)), drive.name).toEqual(noMembership);
      expect(await getUserAccessLevel(credentialActor(gus.id, null), drive.id), `${drive.name} root`).toBeNull();
    }
    // The granted pages open; a non-private page of the same drives that a MEMBER reads by rule 4 does not.
    expect(await getUserAccessLevel(credentialActor(gus.id, null), f.pages.personalPage.id)).toMatchObject({ canView: true });
    expect(await getUserAccessLevel(credentialActor(gus.id, null), f.pages.productPage.id)).toMatchObject({ canView: true });
    expect(await getUserAccessLevel(credentialActor(gus.id, null), f.pages.researchPage.id)).toBeNull();
    expect(await getUserAccessLevel(credentialActor(f.people.eve.id, null), f.pages.researchPage.id)).toMatchObject({ canView: true });

    // Orgs on: Gus is in no org, so the org drives stay closed beyond his grants, and the personal
    // drive still resolves exactly as master's resolvers do.
    flags.orgsEnabled = true;
    for (const target of [f.drives.personal.id, f.pages.personalPage.id, f.pages.personalPrivatePage.id]) {
      expect(await getUserAccessLevel(credentialActor(gus.id, null), target)).toEqual(await legacyGetUserAccessLevel(gus.id, target));
    }
    expect(await getDriveAccess(f.drives.personal.id, credentialActor(gus.id, null))).toEqual(await legacyGetDriveAccess(f.drives.personal.id, gus.id));
    expect(await getDriveAccess(f.drives.product.id, credentialActor(gus.id, null))).toEqual(noMembership);
    expect(await getUserAccessLevel(credentialActor(gus.id, null), f.pages.researchPage.id)).toBeNull();
    expect(await listedIds(gus.id)).not.toContain(f.drives.research.id);
  });

  it('while ORGS_ENABLED is true personal drives still resolve exactly as before', async () => {
    const f = await northwind();
    flags.orgsEnabled = true;

    const personalTargets = [f.pages.personalPage.id, f.pages.personalPrivatePage.id];
    for (const userId of everyone(f)) {
      for (const target of [f.drives.personal.id, ...personalTargets]) {
        expect(await getUserAccessLevel(credentialActor(userId, null), target)).toEqual(await legacyGetUserAccessLevel(userId, target));
      }
      expect(await getDriveAccess(f.drives.personal.id, credentialActor(userId, null))).toEqual(await legacyGetDriveAccess(f.drives.personal.id, userId));
      expect(await getDriveAccessWithDrive(f.drives.personal.id, credentialActor(userId, null))).toEqual(await legacyGetDriveAccessWithDrive(f.drives.personal.id, userId));
      const personal = (drives: Awaited<ReturnType<typeof listAccessibleDrives>>) => drives.filter((d) => d.orgId === null);
      expect(personal(await listAccessibleDrives(credentialActor(userId, null)))).toStrictEqual(personal(await legacyListAccessibleDrives(userId)));
    }
  });

  it('ORG-4 (partial) the org Owner and an org Admin resolve full access on every Northwind drive with no membership row, and only org power used on the PRIVATE drive writes an audit row', async () => {
    const f = await northwind();
    flags.orgsEnabled = true;
    const full = { canView: true, canEdit: true, canShare: true, canDelete: true };
    const admin = { isOwner: false, isAdmin: true, isMember: true, role: 'ADMIN', customRoleId: null };

    // Omar's own ADMIN row opens Finance: org power is not used, no audit owed.
    expect(await getUserAccessLevel(credentialActor(f.people.omar.id, null), f.pages.financePrivatePage.id)).toEqual(full);
    expect(await getDriveAccess(f.drives.finance.id, credentialActor(f.people.omar.id, null))).toEqual(admin);

    for (const person of [f.people.jono, f.people.priya]) {
      for (const drive of [f.drives.product, f.drives.research]) {
        expect(await getUserAccessLevel(credentialActor(person.id, null), drive.id)).toEqual(full);
        expect(await getDriveAccess(drive.id, credentialActor(person.id, null))).toEqual(admin);
      }
      expect(await getUserAccessLevel(credentialActor(person.id, null), f.pages.productPrivatePage.id)).toEqual(full);
      expect(await getUserAccessLevel(credentialActor(person.id, null), f.pages.researchPage.id)).toEqual(full);
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await auditRowsFor([f.drives.product.id, f.drives.research.id, f.drives.finance.id])).toEqual([]);

    expect(await getUserAccessLevel(credentialActor(f.people.priya.id, null), f.pages.financePrivatePage.id)).toEqual(full);
    expect((await getDriveAccessWithDrive(f.drives.finance.id, credentialActor(f.people.jono.id, null)))?.access).toEqual(admin);

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

  it('DRV-5 (partial) POL-6 (partial) an org member with no row resolves an OPEN drive with its default role and sees it listed; a private page stays closed', async () => {
    const f = await northwind();
    flags.orgsEnabled = true;
    const { nina } = f.people;

    // The default role's drive-wide canEdit is what grants edit on a page: a plain member would read only.
    expect(await getUserAccessLevel(credentialActor(nina.id, null), f.pages.productPage.id)).toEqual({ canView: true, canEdit: true, canShare: false, canDelete: false });
    expect(await getUserAccessLevel(credentialActor(nina.id, null), f.pages.productPrivatePage.id)).toBeNull();
    // The drive root grants any member view; edit there follows the drive-wide canEdit rule (#2627), so the
    // default role's drive-wide canEdit is what lets Nina edit it and create root pages.
    expect(await getUserAccessLevel(credentialActor(nina.id, null), f.drives.product.id)).toEqual({ canView: true, canEdit: true, canShare: false, canDelete: false });
    expect(await getDriveAccess(f.drives.product.id, credentialActor(nina.id, null))).toEqual({ isOwner: false, isAdmin: false, isMember: true, role: 'MEMBER', customRoleId: f.roles.productDefault.id });

    const listed = await listAccessibleDrives(credentialActor(nina.id, null));
    const product = listed.find((d) => d.id === f.drives.product.id);
    expect(product).toMatchObject({ isOwned: false, role: 'MEMBER', orgId: f.org.id, orgVisibility: 'OPEN', canCreatePages: true });
    expect(listed.find((d) => d.id === f.drives.personal.id)).toMatchObject({ role: 'ADMIN', orgId: null });
    expect(await listedIds(nina.id, { tokenScopable: true })).toEqual([f.drives.product.id, f.drives.personal.id].sort());

    // Through the real loader: a default role that denies viewing would close an OPEN drive's pages to a
    // row-less member, but that default is below Southwind's Open-drive floor (POL-6, the default view),
    // which the resolver reads: both members view the page, and edit nothing. A former lead's leftover OWNER
    // row adds nothing on top.
    for (const member of [f.people.lu, f.people.kai]) {
      expect(await getUserAccessLevel(credentialActor(member.id, null), f.pages.handbookPage.id), member.name).toEqual({ canView: true, canEdit: false, canShare: false, canDelete: false });
    }

    // #2627 through the org path: the drive root still opens for view, but a default role without
    // drive-wide edit grants no edit there, and the listing's canCreatePages agrees with that answer.
    for (const member of [f.people.lu, f.people.kai]) {
      expect(await getUserAccessLevel(credentialActor(member.id, null), f.drives.handbook.id)).toEqual({ canView: true, canEdit: false, canShare: false, canDelete: false });
      expect((await listAccessibleDrives(credentialActor(member.id, null))).find((d) => d.id === f.drives.handbook.id)).toMatchObject({ role: 'MEMBER', canCreatePages: false });
    }

    // A leftover OWNER row is stale: Kai resolves through the default role exactly like Nina.
    expect(await getUserAccessLevel(credentialActor(f.people.kai.id, null), f.pages.productPage.id)).toEqual({ canView: true, canEdit: true, canShare: false, canDelete: false });
    expect(await getDriveAccess(f.drives.product.id, credentialActor(f.people.kai.id, null))).toEqual({ isOwner: false, isAdmin: false, isMember: true, role: 'MEMBER', customRoleId: f.roles.productDefault.id });
  });

  it('DRV-6 (partial) an org member sees no RESTRICTED or PRIVATE drive without a joined row, and a stale source org row opens and lists nothing', async () => {
    const f = await northwind();
    flags.orgsEnabled = true;
    const none = { isOwner: false, isAdmin: false, isMember: false, role: null, customRoleId: null };

    for (const member of [f.people.marcus, f.people.nina]) {
      for (const target of [f.drives.research.id, f.pages.researchPage.id, f.drives.finance.id, f.pages.financePage.id, f.pages.financePrivatePage.id]) {
        expect(await getUserAccessLevel(credentialActor(member.id, null), target), `${member.name} ${target}`).toBeNull();
      }
      for (const drive of [f.drives.research, f.drives.finance]) {
        expect(await getDriveAccess(drive.id, credentialActor(member.id, null))).toEqual(none);
        expect((await getDriveAccessWithDrive(drive.id, credentialActor(member.id, null)))?.access).toEqual(none);
      }
    }
    expect(await listedIds(f.people.marcus.id)).toEqual([f.drives.product.id, f.drives.personal.id].sort());

    // Joined: Eve's invite row opens and lists Research.
    expect(await getUserAccessLevel(credentialActor(f.people.eve.id, null), f.pages.researchPage.id)).toMatchObject({ canView: true });
    expect(await listedIds(f.people.eve.id)).toEqual([f.drives.product.id, f.drives.research.id].sort());

    // An org Admin who can open them still does not get RESTRICTED or PRIVATE drives listed until joined.
    const priyaListing = await listAccessibleDrives(credentialActor(f.people.priya.id, null));
    expect(priyaListing.map((d) => [d.id, d.role])).toEqual([[f.drives.product.id, 'ADMIN']]);
    expect(await listedIds(f.people.omar.id)).toEqual([f.drives.product.id, f.drives.finance.id].sort());
  });

  it('X-6 (partial) a non-member sees no Northwind drive, not through a stale org row nor a former lead\'s leftover OWNER row, and a guest sees exactly the one drive they were invited to', async () => {
    const f = await northwind();
    flags.orgsEnabled = true;
    const { dana, chris, fred } = f.people;

    // A former lead's leftover OWNER row opens and lists nothing.
    expect(await getUserAccessLevel(credentialActor(fred.id, null), f.drives.research.id)).toBeNull();
    expect(await getUserAccessLevel(credentialActor(fred.id, null), f.pages.researchPage.id)).toBeNull();
    expect((await getDriveAccess(f.drives.research.id, credentialActor(fred.id, null))).isMember).toBe(false);
    expect(await listedIds(fred.id)).toEqual([]);

    for (const target of [f.drives.product.id, f.pages.productPage.id, f.drives.research.id, f.drives.finance.id]) {
      expect(await getUserAccessLevel(credentialActor(dana.id, null), target)).toBeNull();
    }
    expect((await getDriveAccess(f.drives.product.id, credentialActor(dana.id, null))).isMember).toBe(false);
    expect(await listedIds(dana.id)).toEqual([f.drives.acmeWiki.id, f.drives.personal.id].sort());

    // The guest: Product only, even though a Finance page is shared with them.
    for (const options of LIST_OPTIONS) {
      expect(await listedIds(chris.id, options)).toEqual([f.drives.product.id]);
    }
    expect(await getUserAccessLevel(credentialActor(chris.id, null), f.drives.research.id)).toBeNull();
    expect(await getUserAccessLevel(credentialActor(chris.id, null), f.drives.finance.id)).toBeNull();
    expect(await getUserAccessLevel(credentialActor(chris.id, null), f.pages.productPrivatePage.id)).toBeNull();
    expect(await getDriveAccess(f.drives.product.id, credentialActor(chris.id, null))).toEqual({ isOwner: false, isAdmin: false, isMember: true, role: 'MEMBER', customRoleId: null });
  });

  it('ORG-4 (partial) org power never mints an explicit-role MCP key scope: an org Admin with no row must use an inheriting scope, which stops resolving once they are demoted', async () => {
    const f = await northwind();
    flags.orgsEnabled = true;
    const { priya, omar, nina, marcus, eve } = f.people;
    const full = { canView: true, canEdit: true, canShare: true, canDelete: true };
    const refused = (driveId: string) => ({ invalidDriveIds: [], unauthorizedRoles: [], invalidCustomRoles: [], unauthorizedCustomRoles: [], explicitRoleWithoutMembership: [driveId] });
    const accepted = { invalidDriveIds: [], unauthorizedRoles: [], invalidCustomRoles: [], unauthorizedCustomRoles: [], explicitRoleWithoutMembership: [] };

    // The reviewer's repro, step 1: an explicit ADMIN (or MEMBER) scope on PRIVATE Finance from org power alone is refused.
    expect(await validateDriveScopeAccess([{ id: f.drives.finance.id, role: 'ADMIN' }], credentialActor(priya.id, null))).toEqual(refused(f.drives.finance.id));
    expect(await validateDriveScopeAccess([{ id: f.drives.finance.id, role: 'MEMBER' }], credentialActor(priya.id, null))).toEqual(refused(f.drives.finance.id));
    // Implicit OPEN membership and an org-materialized row are org-derived too.
    expect(await validateDriveScopeAccess([{ id: f.drives.product.id, role: 'MEMBER' }], credentialActor(nina.id, null))).toEqual(refused(f.drives.product.id));
    expect(await validateDriveScopeAccess([{ id: f.drives.product.id, role: 'MEMBER' }], credentialActor(marcus.id, null))).toEqual(refused(f.drives.product.id));
    // A real invited row still grants explicit scopes, capped to that row: Omar's ADMIN row, Eve's MEMBER row.
    expect(await validateDriveScopeAccess([{ id: f.drives.finance.id, role: 'ADMIN' }], credentialActor(omar.id, null))).toEqual(accepted);
    expect(await validateDriveScopeAccess([{ id: f.drives.research.id, role: 'MEMBER' }], credentialActor(eve.id, null))).toEqual(accepted);
    expect(await validateDriveScopeAccess([{ id: f.drives.research.id, role: 'ADMIN' }], credentialActor(eve.id, null)))
      .toEqual({ ...accepted, unauthorizedRoles: [f.drives.research.id] });
    // The org Owner's real row on Research is MEMBER: an explicit scope is capped to it, not to org power.
    expect(await validateDriveScopeAccess([{ id: f.drives.research.id, role: 'MEMBER' }], credentialActor(f.people.jono.id, null))).toEqual(accepted);
    expect(await validateDriveScopeAccess([{ id: f.drives.research.id, role: 'ADMIN' }], credentialActor(f.people.jono.id, null)))
      .toEqual({ ...accepted, unauthorizedRoles: [f.drives.research.id] });

    // The inheriting scope is accepted and re-resolves on every use.
    expect(await validateDriveScopeAccess([{ id: f.drives.finance.id, role: null }], credentialActor(priya.id, null))).toEqual(accepted);
    const inherit = [{ driveId: f.drives.finance.id, role: null, customRoleId: null }];
    expect(await getScopedDriveAccessLevel(inherit, credentialActor(priya.id, null), f.drives.finance.id)).toEqual(full);

    // Step 2: demote Priya. Step 3: neither she nor her inheriting scopes reach Finance any more.
    await db.update(orgMembers).set({ role: 'MEMBER' }).where(and(eq(orgMembers.orgId, f.org.id), eq(orgMembers.userId, priya.id)));
    expect(await getUserAccessLevel(credentialActor(priya.id, null), f.drives.finance.id)).toBeNull();
    expect(await getScopedDriveAccessLevel(inherit, credentialActor(priya.id, null), f.drives.finance.id)).toBeNull();
  });

  it('ORG-4 (partial) org power never mints an explicit-role OAuth drive scope (authorize and device flow share checkGrantAuthority): an org Admin with no row must consent to an inheriting scope, which stops resolving once they are demoted', async () => {
    const f = await northwind();
    flags.orgsEnabled = true;
    const { priya, omar, nina } = f.people;
    const full = { canView: true, canEdit: true, canShare: true, canDelete: true };

    // The same rule through OAuth consent: authority built exactly as apps/web resolveGrantAuthority builds it.
    const consentAuthority = async (scopeText: string, userId: string) => {
      const parsed = parseScopeList(scopeText);
      if (!parsed.ok) throw new Error(`bad scope ${scopeText}`);
      const entries = await Promise.all(Array.from(parsed.scopes.drives, async ([driveId, scope]) => {
        const access = await getDriveAccess(driveId, credentialActor(userId, null));
        const explicitScope = scope.role.kind !== 'inherit' && !access.isOwner
          ? await getExplicitScopeAuthority(driveId, userId)
          : undefined;
        return [driveId, {
          isOwner: access.isOwner,
          isMember: access.isMember,
          isAdmin: access.isAdmin,
          ownCustomRoleId: null,
          roleBelongsToDrive: () => true,
          ...(explicitScope ? { explicitScope } : {}),
        }] as const;
      }));
      return { scopes: parsed.scopes, result: checkGrantAuthority(parsed.scopes, new Map(entries) as GrantAuthority) };
    };
    expect((await consentAuthority(`drive:${f.drives.finance.id}:admin`, priya.id)).result)
      .toEqual({ ok: false, reason: 'org_derived_explicit_role', driveId: f.drives.finance.id });
    expect((await consentAuthority(`drive:${f.drives.product.id}:member`, nina.id)).result)
      .toEqual({ ok: false, reason: 'org_derived_explicit_role', driveId: f.drives.product.id });
    expect((await consentAuthority(`drive:${f.drives.finance.id}:admin`, omar.id)).result).toEqual({ ok: true });
    expect((await consentAuthority(`drive:${f.drives.research.id}:admin`, f.people.jono.id)).result)
      .toEqual({ ok: false, reason: 'admin_not_grantable', driveId: f.drives.research.id });
    const inheritConsent = await consentAuthority(`drive:${f.drives.finance.id}`, priya.id);
    expect(inheritConsent.result).toEqual({ ok: true });
    const oauthInherit = scopeSetToDriveScopes(inheritConsent.scopes);
    expect(await getScopedDriveAccessLevel(oauthInherit, credentialActor(priya.id, null), f.drives.finance.id)).toEqual(full);

    expect((await consentAuthority(`drive:${f.drives.personal.id}:admin`, nina.id)).result).toEqual({ ok: true });

    await db.update(orgMembers).set({ role: 'MEMBER' }).where(and(eq(orgMembers.orgId, f.org.id), eq(orgMembers.userId, priya.id)));
    expect(await getScopedDriveAccessLevel(oauthInherit, credentialActor(priya.id, null), f.drives.finance.id)).toBeNull();
  });
});
