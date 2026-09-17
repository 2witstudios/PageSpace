/**
 * B7b: every human drive resolver answers with the one org-aware membership model, against real
 * Postgres. The consistency matrix runs every resolver for every (person, drive, page) of the
 * Northwind fixture and requires each answer to follow from the canonical one (getDriveAccess for
 * the drive, getUserAccessLevel for the page). Any sibling that reads drive_members on its own
 * disagrees on some row: an org Admin with no row, an implicit Open member, a stale source='org'
 * row, a former lead's OWNER row, a guest, a pending invitation, or a non-member.
 *
 * Requires a running Postgres database with the latest migrations applied.
 * Run via:
 *   bun run --filter '@pagespace/lib' test:integration -- src/permissions/__tests__/org-drive-sibling-resolvers.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { factories } from '@pagespace/db/test/factories';
import { db, pool } from '@pagespace/db/db';
import { and, eq, gt, inArray, isNull, or } from '@pagespace/db/operators';
import { mcpTokens } from '@pagespace/db/schema/auth';
import { pages } from '@pagespace/db/schema/core';
import { driveAgentMembers, driveRoles, mcpTokenDrives, pagePermissions } from '@pagespace/db/schema/members';
import { orgMembers } from '@pagespace/db/schema/organizations';
import type { SessionClaims } from '../../auth/session-service';
import { resetAuditDbBindingForTests } from '../../audit/audit-db-binding';
import { resetDefaultSecurityAuditForTests } from '../../audit/security-audit';
import {
  getBatchPagePermissions,
  getDriveIdsForUser,
  getUserAccessLevel,
  getUserAccessiblePagesInDrive,
  getUserAccessiblePagesInDriveWithDetails,
  getUserDriveAccess,
  getUserDrivePermissions,
  getUsersWhoCanViewPage,
  isDriveOwnerOrAdmin,
  isUserDriveMember,
  type PermissionLevel,
} from '../permissions';
import { getAgentAccessLevel, hasAgentDriveMembership } from '../agent-permissions';
import { getAppAccessLevel, hasAppDriveMembership, hasScopedDriveMembership } from '../app-permissions';
import { getMemberCustomRoleId } from '../membership-queries';
import { EnforcedAuthContext } from '../enforced-context';
import { revokePagePermission } from '../permission-mutations';
import { getDriveAccess, listAccessibleDrives } from '../../services/drive-service';
import { checkDriveAccess } from '../../services/drive-member-service';
import { checkDriveAccessForRoles } from '../../services/drive-role-service';
import { addAgentToDrive } from '../../services/drive-agent-service';
import { isUserMemberOfAnyEventDrive } from '../../services/calendar-event-drive-service';
import { resolveDriveMembership } from '../../services/agent-workspaces/agent-workspace-tenant';
import { cleanupNorthwind, createUser, northwind } from './fixtures/northwind-org-drives';
import {
  legacyCheckDriveAccess,
  legacyCheckDriveAccessForRoles,
  legacyGetBatchPagePermissions,
  legacyGetDriveIdsForUser,
  legacyGetMemberCustomRoleId,
  legacyGetPageIfCanShare,
  legacyGetUserAccessiblePagesInDrive,
  legacyGetUserAccessiblePagesInDriveWithDetails,
  legacyGetUserDriveAccess,
  legacyGetUserDrivePermissions,
  legacyGetUsersWhoCanViewPage,
  legacyIsDriveOwnerOrAdmin,
  legacyIsUserDriveMember,
  legacyIsUserMemberOfAnyEventDrive,
  legacyResolveDriveMembership,
} from './fixtures/pre-b7b-sibling-resolvers';

const flags = vi.hoisted(() => ({ orgsEnabled: false }));
vi.mock('../../organizations/orgs-enabled', () => ({
  get ORGS_ENABLED() {
    return flags.orgsEnabled;
  },
}));
// Revocation kicks call the realtime service; nothing here is revoked, but keep the gate probe offline.
vi.mock('../revocation-kick', () => ({ kickForPagePermissionRevocation: vi.fn(async () => undefined) }));

const DENY: PermissionLevel = { canView: false, canEdit: false, canShare: false, canDelete: false };

/**
 * Northwind plus the shapes only the siblings need: Tomás holds PENDING invitations (acceptedAt
 * null), as ADMIN on Finance and as MEMBER on Marcus's personal drive; Zed is a stranger used as the
 * revoke target; every person holds an inheriting MCP key scoped to every drive.
 */
async function matrixFixture() {
  const f = await northwind();
  const tomas = await createUser('Tomás Alvarez');
  const zed = await createUser('Zed Stranger');
  await db.insert(orgMembers).values({ orgId: f.org.id, userId: tomas.id, role: 'MEMBER' });
  await factories.createDriveMember(f.drives.finance.id, tomas.id, { source: 'invite', role: 'ADMIN', acceptedAt: null });
  await factories.createDriveMember(f.drives.personal.id, tomas.id, { source: 'invite', acceptedAt: null });
  // Lu's only link to Marcus's personal drive is a page share that has EXPIRED: it opens nothing and lists nothing.
  await factories.createPagePermission(f.pages.personalPage.id, f.people.lu.id, { expiresAt: new Date(Date.now() - 60_000) });

  const people = { ...f.people, tomas };
  const tokens = new Map<string, string>();
  for (const person of Object.values(people)) {
    const [token] = await db.insert(mcpTokens).values({
      userId: person.id,
      tokenHash: `hash-${createId()}`,
      tokenPrefix: 'mcp_test',
      name: `${person.name} inherit`,
      isScoped: true,
    }).returning();
    await db.insert(mcpTokenDrives).values(Object.values(f.drives).map((d) => ({ tokenId: token.id, driveId: d.id, role: null })));
    tokens.set(person.id, token.id);
  }

  const [productDefaultRole] = await db
    .select({ id: driveRoles.id })
    .from(driveRoles)
    .where(and(eq(driveRoles.driveId, f.drives.product.id), eq(driveRoles.isDefault, true)));

  return { ...f, people, zed, tokens, productDefaultRoleId: productDefaultRole.id };
}

type Matrix = Awaited<ReturnType<typeof matrixFixture>>;

const ctxFor = (userId: string) => EnforcedAuthContext.fromSession({
  sessionId: `session-${userId}`,
  userId,
  userRole: 'user',
  tokenVersion: 0,
  adminRoleVersion: 0,
  type: 'user',
  scopes: ['*'],
  expiresAt: new Date(Date.now() + 60_000),
} satisfies SessionClaims);

async function pagesOf(driveId: string) {
  return db.select({ id: pages.id }).from(pages).where(and(eq(pages.driveId, driveId), eq(pages.isTrashed, false)));
}

async function hasPageShareIn(userId: string, driveId: string) {
  const rows = await db
    .select({ id: pagePermissions.id })
    .from(pagePermissions)
    .innerJoin(pages, eq(pages.id, pagePermissions.pageId))
    .where(and(
      eq(pagePermissions.userId, userId),
      eq(pages.driveId, driveId),
      eq(pagePermissions.canView, true),
      or(isNull(pagePermissions.expiresAt), gt(pagePermissions.expiresAt, new Date())),
    ));
  return rows.length > 0;
}

/**
 * Every resolver's answer for one person and one drive, next to the canonical answer. Returns the
 * disagreements as readable lines, so a red matrix names the resolver, the person and the drive.
 */
async function disagreementsFor(m: Matrix, personName: string, userId: string, drive: { id: string; name: string; ownerId: string }) {
  const out: string[] = [];
  const where = `${personName} on ${drive.name}`;
  const check = (resolver: string, actual: unknown, expected: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      out.push(`${resolver}: ${where} answered ${JSON.stringify(actual)}, canonical ${JSON.stringify(expected)}`);
    }
  };

  const owner = drive.ownerId === userId;
  const access = await getDriveAccess(drive.id, userId);
  const member = owner || access.isMember;
  const admin = owner || access.isAdmin;
  const role = access.role;

  check('isUserDriveMember', await isUserDriveMember(userId, drive.id), member);
  check('isDriveOwnerOrAdmin', await isDriveOwnerOrAdmin(userId, drive.id), admin);
  check('getUserDriveAccess', await getUserDriveAccess(userId, drive.id), member || await hasPageShareIn(userId, drive.id));
  const drivePerms = await getUserDrivePermissions(userId, drive.id);
  check('getUserDrivePermissions', drivePerms && { hasAccess: drivePerms.hasAccess, isOwner: drivePerms.isOwner, isAdmin: drivePerms.isAdmin, isMember: drivePerms.isMember },
    owner ? { hasAccess: true, isOwner: true, isAdmin: false, isMember: false }
      : member ? { hasAccess: true, isOwner: false, isAdmin: admin, isMember: true } : null);
  const memberAccess = await checkDriveAccess(drive.id, userId);
  check('checkDriveAccess', [memberAccess.isOwner, memberAccess.isAdmin, memberAccess.isMember], [owner, admin, member]);
  const roleAccess = await checkDriveAccessForRoles(drive.id, userId);
  check('checkDriveAccessForRoles', [roleAccess.isOwner, roleAccess.isAdmin, roleAccess.isMember], [owner, admin, member]);
  check('resolveDriveMembership', await resolveDriveMembership({ userId, driveId: drive.id }),
    owner ? 'owner' : admin ? 'admin' : member ? 'member' : 'none');
  check('isUserMemberOfAnyEventDrive', await isUserMemberOfAnyEventDrive(userId, { id: createId(), driveId: drive.id }), member);
  check('hasAppDriveMembership (inheriting key)', await hasAppDriveMembership(m.tokens.get(userId) as string, drive.id), member);
  check('hasScopedDriveMembership (inheriting scope)',
    await hasScopedDriveMembership([{ driveId: drive.id, role: null, customRoleId: null }], userId, drive.id), member);

  const root = await getUserAccessLevel(userId, drive.id);
  check('getUserAccessLevel (drive root)', root && { canView: root.canView, canShare: root.canShare },
    member ? { canView: true, canShare: admin } : null);
  check('getDriveAccess role', role, owner ? 'OWNER' : admin ? 'ADMIN' : member ? 'MEMBER' : null);

  const drivePages = await pagesOf(drive.id);
  const pageIds = drivePages.map((p) => p.id);
  const batch = await getBatchPagePermissions(userId, pageIds);
  const tree = new Set(await getUserAccessiblePagesInDrive(userId, drive.id));
  const treeWithDetails = new Map((await getUserAccessiblePagesInDriveWithDetails(userId, drive.id)).map((p) => [p.id, p.permissions]));
  for (const pageId of pageIds) {
    const canonical = (await getUserAccessLevel(userId, pageId)) ?? DENY;
    const page = `${where} page ${pageId}`;
    const checkPage = (resolver: string, actual: unknown, expected: unknown) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        out.push(`${resolver}: ${page} answered ${JSON.stringify(actual)}, canonical ${JSON.stringify(expected)}`);
      }
    };
    const flags4 = (p: PermissionLevel | undefined) => p && [p.canView, p.canEdit, p.canShare, p.canDelete];
    checkPage('getBatchPagePermissions [view, edit, share, delete]', flags4(batch.get(pageId)), flags4(canonical));
    checkPage('getUsersWhoCanViewPage', (await getUsersWhoCanViewPage(pageId, [userId])).has(userId), canonical.canView);
    checkPage('getUserAccessiblePagesInDrive', tree.has(pageId), canonical.canView);
    checkPage('getUserAccessiblePagesInDriveWithDetails', treeWithDetails.get(pageId)?.canView ?? false, canonical.canView);
    const revoke = await revokePagePermission(ctxFor(userId), { pageId, targetUserId: m.zed.id });
    checkPage('getPageIfCanShare (revokePagePermission gate)', revoke.ok, canonical.canShare);
  }

  return out;
}

async function matrixDisagreements(m: Matrix) {
  const out: string[] = [];
  for (const [name, person] of Object.entries(m.people)) {
    for (const drive of Object.values(m.drives)) {
      out.push(...await disagreementsFor(m, name, person.id, drive));
    }
    const listed = (await listAccessibleDrives(person.id, { includeTrash: true })).map((d) => d.id).sort();
    const ids = (await getDriveIdsForUser(person.id)).sort();
    if (JSON.stringify(ids) !== JSON.stringify(listed)) {
      out.push(`getDriveIdsForUser: ${name} answered ${JSON.stringify(ids)}, listAccessibleDrives ${JSON.stringify(listed)}`);
    }
  }
  return out;
}

describe('B7b: every human drive resolver answers with one org-aware membership (integration)', () => {
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

  afterEach(async () => {
    flags.orgsEnabled = false;
    await cleanupNorthwind();
  }, 120_000);

  afterAll(async () => {
    for (const [key, value] of savedAuditEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetAuditBinding();
    await pool.end();
  });

  it('while ORGS_ENABLED is false every routed sibling returns exactly the pre-B7b result, except the two named fixes: a pending invitation manages no roles, and a drive-wide custom role opens no private page', async () => {
    const m = await matrixFixture();
    flags.orgsEnabled = false;
    const everyone = Object.entries(m.people);
    const drives = Object.values(m.drives);
    const eventId = createId();
    const differences: string[] = [];
    let compared = 0;
    const same = (resolver: string, at: string, live: unknown, legacy: unknown) => {
      compared += 1;
      if (JSON.stringify(live) !== JSON.stringify(legacy)) differences.push(`${resolver} ${at}`);
    };

    for (const [name, person] of everyone) {
      same('getDriveIdsForUser', name, await getDriveIdsForUser(person.id), await legacyGetDriveIdsForUser(person.id));
      for (const drive of drives) {
        const at = `${name} ${drive.name}`;
        same('isDriveOwnerOrAdmin', at, await isDriveOwnerOrAdmin(person.id, drive.id), await legacyIsDriveOwnerOrAdmin(person.id, drive.id));
        same('isUserDriveMember', at, await isUserDriveMember(person.id, drive.id), await legacyIsUserDriveMember(person.id, drive.id));
        same('getUserAccessiblePagesInDrive', at, await getUserAccessiblePagesInDrive(person.id, drive.id), await legacyGetUserAccessiblePagesInDrive(person.id, drive.id));
        same('getUserAccessiblePagesInDriveWithDetails', at, await getUserAccessiblePagesInDriveWithDetails(person.id, drive.id), await legacyGetUserAccessiblePagesInDriveWithDetails(person.id, drive.id));
        same('getUserDriveAccess', at, await getUserDriveAccess(person.id, drive.id), await legacyGetUserDriveAccess(person.id, drive.id));
        same('getUserDrivePermissions', at, await getUserDrivePermissions(person.id, drive.id), await legacyGetUserDrivePermissions(person.id, drive.id));
        same('getMemberCustomRoleId', at, await getMemberCustomRoleId(drive.id, person.id), await legacyGetMemberCustomRoleId(drive.id, person.id));
        same('checkDriveAccess', at, await checkDriveAccess(drive.id, person.id), await legacyCheckDriveAccess(drive.id, person.id));
        same('checkDriveAccessForRoles', at, await checkDriveAccessForRoles(drive.id, person.id), await legacyCheckDriveAccessForRoles(drive.id, person.id));
        same('resolveDriveMembership', at, await resolveDriveMembership({ userId: person.id, driveId: drive.id }), await legacyResolveDriveMembership({ userId: person.id, driveId: drive.id }));
        same('isUserMemberOfAnyEventDrive', at, await isUserMemberOfAnyEventDrive(person.id, { id: eventId, driveId: drive.id }), await legacyIsUserMemberOfAnyEventDrive(person.id, { id: eventId, driveId: drive.id }));

        const pageIds = (await pagesOf(drive.id)).map((p) => p.id);
        const liveBatch = await getBatchPagePermissions(person.id, pageIds);
        const legacyBatch = await legacyGetBatchPagePermissions(person.id, pageIds);
        for (const pageId of pageIds) {
          const pageAt = `${at} ${pageId}`;
          same('getBatchPagePermissions', pageAt, liveBatch.get(pageId), legacyBatch.get(pageId));
          const revoke = await revokePagePermission(ctxFor(person.id), { pageId, targetUserId: m.zed.id });
          same('getPageIfCanShare', pageAt, revoke.ok, (await legacyGetPageIfCanShare(person.id, pageId)).ok);
        }
      }
    }
    const candidates = everyone.map(([, person]) => person.id);
    for (const drive of drives) {
      for (const { id: pageId } of await pagesOf(drive.id)) {
        same('getUsersWhoCanViewPage', `${drive.name} ${pageId}`, [...await getUsersWhoCanViewPage(pageId, candidates)].sort(), [...await legacyGetUsersWhoCanViewPage(pageId, candidates)].sort());
      }
    }

    const hiring = m.pages.productPrivatePage.id;
    expect(differences.sort()).toEqual([
      // Tomás's pending ADMIN (Finance) and MEMBER (Marcus Notes) invitations passed the roles gate.
      `checkDriveAccessForRoles tomas ${m.drives.finance.name}`,
      `checkDriveAccessForRoles tomas ${m.drives.personal.name}`,
      // Marcus's Product row carries the Contributor role (drive-wide view): the private Hiring page leaked.
      `getBatchPagePermissions marcus ${m.drives.product.name} ${hiring}`,
      `getUsersWhoCanViewPage ${m.drives.product.name} ${hiring}`,
    ].sort());
    expect(compared).toBeGreaterThan(1000);

    // The fixes, by value: the legacy answers were the leaks.
    expect(await legacyCheckDriveAccessForRoles(m.drives.finance.id, m.people.tomas.id)).toMatchObject({ isAdmin: true, isMember: true });
    expect((await legacyGetBatchPagePermissions(m.people.marcus.id, [hiring])).get(hiring)?.canView).toBe(true);
    expect((await getBatchPagePermissions(m.people.marcus.id, [hiring])).get(hiring)?.canView).toBe(false);
    expect(await legacyGetUsersWhoCanViewPage(hiring, [m.people.marcus.id])).toEqual(new Set([m.people.marcus.id]));
    // Not vacuous while dark: stale org rows still open drives exactly as before orgs.
    expect(await isUserDriveMember(m.people.marcus.id, m.drives.finance.id)).toBe(true);
    expect(await isUserDriveMember(m.people.priya.id, m.drives.research.id)).toBe(false);
  }, 180_000);

  it('ORG-4 (partial) DRV-5 (partial) DRV-6 (partial) X-6 (partial) the consistency matrix: for every person and drive, every sibling resolver agrees with getDriveAccess and getUserAccessLevel', async () => {
    const m = await matrixFixture();
    flags.orgsEnabled = true;

    expect(await matrixDisagreements(m)).toEqual([]);

    // Not vacuous: the canonical answers cover every shape the matrix is meant to tell apart.
    const { priya, nina, marcus, dana, fred, kai, chris, tomas, jono } = m.people;
    expect(await getDriveAccess(m.drives.finance.id, priya.id)).toMatchObject({ isAdmin: true });
    expect(await getDriveAccess(m.drives.finance.id, jono.id)).toMatchObject({ isAdmin: true });
    expect(await getDriveAccess(m.drives.product.id, nina.id)).toMatchObject({ isMember: true, isAdmin: false });
    expect(await getDriveAccess(m.drives.research.id, marcus.id)).toMatchObject({ isMember: false });
    expect(await getDriveAccess(m.drives.product.id, dana.id)).toMatchObject({ isMember: false });
    expect(await getDriveAccess(m.drives.research.id, fred.id)).toMatchObject({ isMember: false });
    expect(await getDriveAccess(m.drives.product.id, kai.id)).toMatchObject({ isMember: true });
    expect(await getDriveAccess(m.drives.product.id, chris.id)).toMatchObject({ isMember: true });
    expect(await getDriveAccess(m.drives.finance.id, tomas.id)).toMatchObject({ isMember: false });
    expect(await getUserAccessLevel(m.people.lu.id, m.pages.personalPage.id)).toBeNull();
  }, 180_000);

  it('an expired page share lists no drive, dark or enabled: listAccessibleDrives and getDriveIdsForUser agree', async () => {
    const m = await matrixFixture();
    const { lu } = m.people;
    for (const enabled of [false, true]) {
      flags.orgsEnabled = enabled;
      for (const options of [{}, { includeTrash: true }]) {
        expect((await listAccessibleDrives(lu.id, options)).map((d) => d.id), `orgs ${enabled}`).not.toContain(m.drives.personal.id);
      }
      expect(await getDriveIdsForUser(lu.id)).not.toContain(m.drives.personal.id);
      expect(await getUserDriveAccess(lu.id, m.drives.personal.id)).toBe(false);
    }
  });

  it('DRV-5 (partial) an implicit Open member holds the drive default role in every custom-role reader, and an org Admin holds none', async () => {
    const m = await matrixFixture();
    flags.orgsEnabled = true;
    const { nina, kai, marcus, priya, chris } = m.people;

    expect(await getMemberCustomRoleId(m.drives.product.id, nina.id)).toBe(m.productDefaultRoleId);
    expect(await getMemberCustomRoleId(m.drives.product.id, kai.id)).toBe(m.productDefaultRoleId);
    expect(await getMemberCustomRoleId(m.drives.product.id, marcus.id)).toBe(m.productDefaultRoleId);
    expect(await getMemberCustomRoleId(m.drives.finance.id, priya.id)).toBeNull();
    expect(await getMemberCustomRoleId(m.drives.product.id, chris.id)).toBeNull();
    // The default role's drive-wide edit reaches the drive-wide permission reader too.
    expect(await getUserDrivePermissions(nina.id, m.drives.product.id)).toEqual({ hasAccess: true, isOwner: false, isAdmin: false, isMember: true, canEdit: true });
  });

  it('a pending invitation counts for nothing in any routed resolver, dark or enabled', async () => {
    const m = await matrixFixture();
    const { tomas } = m.people;

    for (const enabled of [false, true]) {
      flags.orgsEnabled = enabled;
      for (const drive of [m.drives.finance, m.drives.personal]) {
        const at = `orgs ${enabled ? 'on' : 'off'}, ${drive.name}`;
        expect(await isUserDriveMember(tomas.id, drive.id), at).toBe(false);
        expect(await isDriveOwnerOrAdmin(tomas.id, drive.id), at).toBe(false);
        expect(await getUserDriveAccess(tomas.id, drive.id), at).toBe(false);
        expect(await getUserDrivePermissions(tomas.id, drive.id), at).toBeNull();
        expect(await getUserAccessiblePagesInDrive(tomas.id, drive.id), at).toEqual([]);
        expect(await getUserAccessiblePagesInDriveWithDetails(tomas.id, drive.id), at).toEqual([]);
        const pageIds = (await pagesOf(drive.id)).map((p) => p.id);
        expect([...(await getBatchPagePermissions(tomas.id, pageIds)).values()], at).toEqual(pageIds.map(() => DENY));
        for (const pageId of pageIds) {
          expect((await getUsersWhoCanViewPage(pageId, [tomas.id])).size, at).toBe(0);
          expect(await revokePagePermission(ctxFor(tomas.id), { pageId, targetUserId: m.zed.id }), at)
            .toEqual({ ok: false, error: { code: 'PAGE_NOT_ACCESSIBLE', pageId } });
        }
        expect(await getDriveIdsForUser(tomas.id), at).not.toContain(drive.id);
        expect(await checkDriveAccess(drive.id, tomas.id), at).toMatchObject({ isOwner: false, isAdmin: false, isMember: false });
        // checkDriveAccessForRoles read pending rows before B7b: a pending ADMIN managed roles.
        expect(await checkDriveAccessForRoles(drive.id, tomas.id), at).toMatchObject({ isOwner: false, isAdmin: false, isMember: false });
        expect(await getMemberCustomRoleId(drive.id, tomas.id), at).toBeNull();
        expect(await resolveDriveMembership({ userId: tomas.id, driveId: drive.id }), at).toBe('none');
        expect(await isUserMemberOfAnyEventDrive(tomas.id, { id: createId(), driveId: drive.id }), at).toBe(false);
        expect(await hasAppDriveMembership(m.tokens.get(tomas.id) as string, drive.id), at).toBe(false);
      }
    }
  });

  it('ORG-4 (partial) agent and app identities never gain org-derived access: an agent holds only its own memberships, an explicit key role only its role, while an inheriting key follows its person', async () => {
    const m = await matrixFixture();
    flags.orgsEnabled = true;
    const { priya } = m.people;
    const full = { canView: true, canEdit: true, canShare: true, canDelete: true };

    // Priya (org Admin, no Finance row) reaches the Salaries page through org power.
    expect(await getUserAccessLevel(priya.id, m.pages.financePrivatePage.id)).toEqual(full);

    // Her agent, living in her own drive, gains nothing in Finance from her org role.
    const priyaNotes = await factories.createDrive(priya.id, { name: 'Priya Notes', slug: `priya-${createId()}` });
    const agent = await factories.createPage(priyaNotes.id, { title: 'Analyst', type: 'AI_CHAT' });
    expect(await hasAgentDriveMembership(agent.id, m.drives.finance.id)).toBe(false);
    expect(await getAgentAccessLevel(agent.id, m.pages.financePage.id)).toBeNull();
    // Granted as MEMBER through her org power, it reads what a MEMBER reads: never the private page.
    const granted = await addAgentToDrive({ actingUserId: priya.id, agentPageId: agent.id, driveId: m.drives.finance.id, requestedRole: 'MEMBER' });
    expect(granted.ok).toBe(true);
    expect(await getAgentAccessLevel(agent.id, m.pages.financePrivatePage.id)).toBeNull();

    // An explicit MEMBER key scope means MEMBER, whatever its owner's org role.
    const [explicitKey] = await db.insert(mcpTokens).values({ userId: priya.id, tokenHash: `hash-${createId()}`, tokenPrefix: 'mcp_test', name: 'explicit', isScoped: true }).returning();
    await db.insert(mcpTokenDrives).values({ tokenId: explicitKey.id, driveId: m.drives.finance.id, role: 'MEMBER' });
    expect(await getAppAccessLevel(explicitKey.id, m.pages.financePrivatePage.id)).toBeNull();
    // The inheriting key is Priya, only there.
    expect(await getAppAccessLevel(m.tokens.get(priya.id) as string, m.pages.financePrivatePage.id)).toEqual(full);

    await db.delete(driveAgentMembers).where(inArray(driveAgentMembers.agentPageId, [agent.id]));
  });

  it('DRV-7 (partial) resolveGranterAccess follows the shared membership: org power grants an agent up to ADMIN, a row-less member of a PRIVATE drive grants nothing, a pending invitation grants nothing', async () => {
    const m = await matrixFixture();
    flags.orgsEnabled = true;
    const { priya, nina, tomas } = m.people;

    const agentFor = async (userId: string, name: string) => {
      const home = await factories.createDrive(userId, { name: `${name} home`, slug: `home-${createId()}` });
      return factories.createPage(home.id, { title: `${name} agent`, type: 'AI_CHAT' });
    };
    const priyaAgent = await agentFor(priya.id, 'Priya');
    const ninaAgent = await agentFor(nina.id, 'Nina');
    const tomasAgent = await agentFor(tomas.id, 'Tomas');

    const inherited = await addAgentToDrive({ actingUserId: priya.id, agentPageId: priyaAgent.id, driveId: m.drives.finance.id });
    expect(inherited).toMatchObject({ ok: true, member: { role: 'ADMIN' } });
    expect(await addAgentToDrive({ actingUserId: nina.id, agentPageId: ninaAgent.id, driveId: m.drives.finance.id }))
      .toEqual({ ok: false, status: 403, error: 'You do not have access to this drive' });
    expect(await addAgentToDrive({ actingUserId: tomas.id, agentPageId: tomasAgent.id, driveId: m.drives.finance.id }))
      .toEqual({ ok: false, status: 403, error: 'You do not have access to this drive' });
    // An implicit Open member is capped to MEMBER and carries the drive's default role.
    expect(await addAgentToDrive({ actingUserId: nina.id, agentPageId: ninaAgent.id, driveId: m.drives.product.id }))
      .toMatchObject({ ok: true, member: { role: 'MEMBER', customRoleId: m.productDefaultRoleId } });
  });
});

