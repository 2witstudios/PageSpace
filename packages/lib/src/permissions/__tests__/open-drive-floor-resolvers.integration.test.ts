/**
 * POL-6 at RESOLUTION time, against real Postgres: the org's Open-drive role floor is read by the
 * implicit-membership resolver, so an org member whose access to an Open org drive comes from the implicit
 * membership holds at least the floor on every non-private page and at the drive root, however the data
 * got below it (a default role written before the write guards, a per-page entry on the default, an org
 * row frozen on a former default, an explicit page grant below the floor).
 *
 * The consistency test runs ONE fixture through EVERY resolver path and requires each to answer exactly
 * the expected table, so a path that resolves the same access without the floor goes red on its own.
 *
 * The floors are written straight into organizations.policies, past the write guards: that is the
 * "data written before the guards" shape the read-time floor exists for.
 *
 * Run via:
 *   bun run --filter '@pagespace/lib' test:integration -- src/permissions/__tests__/open-drive-floor-resolvers.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { factories } from '@pagespace/db/test/factories';
import { db, pool } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { mcpTokens, users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveRoles, mcpTokenDrives } from '@pagespace/db/schema/members';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { orgGuestHolds } from '@pagespace/db/schema/org-guest-holds';
import { resetAuditDbBindingForTests } from '../../audit/audit-db-binding';
import { resetDefaultSecurityAuditForTests } from '../../audit/security-audit';
import { openDefaultRoleMeetsFloor, type OpenRoleFloor } from '../../organizations/policies-core';
import {
  getBatchPagePermissions,
  getUserAccessLevel,
  getUserAccessiblePagesInDrive,
  getUserAccessiblePagesInDriveWithDetails,
  getUserDrivePermissions,
  getUsersWhoCanViewPage,
} from '../permissions';
import { getAppAccessLevel, getAppAccessiblePagesInDrive } from '../app-permissions';
import { getDriveWithAccess, listAccessibleDrives } from '../../services/drive-service';
import { updateOrgPolicies } from '../../organizations/policies';

const flags = vi.hoisted(() => ({ orgsEnabled: true }));
vi.mock('../../organizations/orgs-enabled', () => ({
  get ORGS_ENABLED() {
    return flags.orgsEnabled;
  },
}));
// Parking a guest kicks their live sessions through the realtime service; keep it offline.
vi.mock('../revocation-kick', () => ({
  kickForPagePermissionRevocation: vi.fn(async () => undefined),
  kickForDriveMembershipRevocation: vi.fn(async () => undefined),
}));

const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

async function user(name: string) {
  const created = await factories.createUser({ name });
  createdUserIds.push(created.id);
  return created;
}

const VIEW_ONLY = { canView: true, canEdit: false, canShare: false };
const DENY_ENTRY = { canView: false, canEdit: false, canShare: false };

/**
 * Harbor: one org, three OPEN drives below any floor, a RESTRICTED and a PRIVATE drive, and every
 * relationship the floor must tell apart. Lena leads every drive.
 */
async function harbor() {
  const lena = await user('Lena Lead');
  const ada = await user('Ada OrgAdmin');
  const ivy = await user('Ivy Implicit');
  const sam = await user('Sam Synced');
  const fay = await user('Fay Frozen');
  const gil = await user('Gil Granted');
  const ira = await user('Ira Invited');
  const oz = await user('Oz Outsider');
  const gus = await user('Gus Guest');
  const pat = await user('Pat PendingOutsider');
  const zed = await user('Zed Stranger');

  const [org] = await db.insert(organizations).values({ name: 'Harbor', slug: `harbor-${createId()}`, ownerId: ada.id }).returning();
  createdOrgIds.push(org.id);
  await factories.createOrgSubscription(org.id);
  await db.insert(orgMembers).values([
    { orgId: org.id, userId: ada.id, role: 'OWNER' },
    { orgId: org.id, userId: lena.id, role: 'MEMBER' },
    { orgId: org.id, userId: ivy.id, role: 'MEMBER' },
    { orgId: org.id, userId: sam.id, role: 'MEMBER' },
    { orgId: org.id, userId: fay.id, role: 'MEMBER' },
    { orgId: org.id, userId: gil.id, role: 'MEMBER' },
    { orgId: org.id, userId: ira.id, role: 'MEMBER' },
  ]);

  const drive = (name: string, orgVisibility: 'OPEN' | 'RESTRICTED' | 'PRIVATE') =>
    factories.createDrive(lena.id, { name, slug: `${name.toLowerCase()}-${createId()}`, orgId: org.id, orgVisibility });
  const open = await drive('Docks', 'OPEN');
  const bare = await drive('Bare', 'OPEN');
  const shut = await drive('Shut', 'OPEN');
  const restricted = await drive('Vault', 'RESTRICTED');
  const priv = await drive('Ledger', 'PRIVATE');

  const pagesOf = async (driveId: string) => ({
    roadmap: await factories.createPage(driveId, { title: 'Roadmap' }),
    secret: await factories.createPage(driveId, { title: 'Secret' }),
    hiring: await factories.createPage(driveId, { title: 'Hiring', isPrivate: true }),
  });
  const pages = {
    open: await pagesOf(open.id),
    bare: await pagesOf(bare.id),
    shut: await pagesOf(shut.id),
    restricted: await pagesOf(restricted.id),
    priv: await pagesOf(priv.id),
  };

  const role = async (driveId: string, name: string, values: { isDefault: boolean; driveWide: typeof VIEW_ONLY | null; permissions?: Record<string, typeof VIEW_ONLY> }) => {
    const [created] = await db.insert(driveRoles).values({
      driveId, name, isDefault: values.isDefault, permissions: values.permissions ?? {}, driveWidePermissions: values.driveWide,
    }).returning();
    return created;
  };
  // Docks' default: drive-wide view only, and a per-page entry that hides Secret (Review #2762 P2-4).
  const docksDefault = await role(open.id, 'Below', { isDefault: true, driveWide: VIEW_ONLY, permissions: { [pages.open.secret.id]: DENY_ENTRY } });
  // A FORMER default that denies everything (P2-3: org rows frozen on it).
  const docksFormer = await role(open.id, 'Former', { isDefault: false, driveWide: DENY_ENTRY });
  // An explicit role an admin gives by invitation: drive-wide view, and it hides Secret.
  const docksReader = await role(open.id, 'Reader', { isDefault: false, driveWide: VIEW_ONLY, permissions: { [pages.open.secret.id]: DENY_ENTRY } });
  // Bare has no default role at all (members hold the plain MEMBER role); Shut's default denies viewing.
  await role(shut.id, 'Closed', { isDefault: true, driveWide: DENY_ENTRY });
  const vaultDefault = await role(restricted.id, 'Below', { isDefault: true, driveWide: DENY_ENTRY });
  const vaultReader = await role(restricted.id, 'Reader', { isDefault: false, driveWide: VIEW_ONLY });

  // Sam: org row on the current default. Fay: org row frozen on the former default.
  await factories.createDriveMember(open.id, sam.id, { source: 'org', customRoleId: docksDefault.id });
  await factories.createDriveMember(open.id, fay.id, { source: 'org', customRoleId: docksFormer.id });
  // Stale org rows on RESTRICTED and PRIVATE drives open nothing, floor or not.
  await factories.createDriveMember(restricted.id, sam.id, { source: 'org', customRoleId: vaultDefault.id });
  await factories.createDriveMember(priv.id, sam.id, { source: 'org' });
  // Gil: implicit on Docks, plus an explicit page grant BELOW the floor on Roadmap.
  await factories.createPagePermission(pages.open.roadmap.id, gil.id, { canView: true, canEdit: false });
  // Ira: an org member INVITED with an explicit view-only role (Docks, Vault): explicit, so not raised.
  await factories.createDriveMember(open.id, ira.id, { source: 'invite', customRoleId: docksReader.id });
  await factories.createDriveMember(restricted.id, ira.id, { source: 'invite', customRoleId: vaultReader.id });
  // Oz: NOT in the org, invited to Docks with the same explicit role.
  await factories.createDriveMember(open.id, oz.id, { source: 'invite', customRoleId: docksReader.id });
  // Gus: a guest (a redeemed page share link): a GUEST row and a view grant on Docks' Roadmap.
  await factories.createDriveMember(open.id, gus.id, { source: 'invite', role: 'GUEST' });
  await factories.createPagePermission(pages.open.roadmap.id, gus.id);
  // Pat: a PENDING invitation to Docks, never accepted.
  await factories.createDriveMember(open.id, pat.id, { source: 'invite', acceptedAt: null });

  const people = { lena, ada, ivy, sam, fay, gil, ira, oz, gus, pat, zed };

  // Every person holds an INHERITING key scoped to every drive: it must answer exactly as its person.
  const tokens = new Map<string, string>();
  for (const person of Object.values(people)) {
    const [token] = await db.insert(mcpTokens).values({
      userId: person.id, tokenHash: `hash-${createId()}`, tokenPrefix: 'mcp_test', name: `${person.name} inherit`, isScoped: true,
    }).returning();
    await db.insert(mcpTokenDrives).values([open, bare, shut, restricted, priv].map((d) => ({ tokenId: token.id, driveId: d.id, role: null })));
    tokens.set(person.id, token.id);
  }

  return { org, people, tokens, drives: { open, bare, shut, restricted, priv }, pages };
}

type Harbor = Awaited<ReturnType<typeof harbor>>;
type PersonKey = keyof Harbor['people'];
type DriveKey = keyof Harbor['drives'];
type PageKey = 'roadmap' | 'secret' | 'hiring';
type ViewEdit = [view: boolean, edit: boolean];

async function setFloor(orgId: string, floor: OpenRoleFloor) {
  await db.update(organizations).set({ policies: { openDriveRoleFloor: floor } }).where(eq(organizations.id, orgId));
}

const OPEN_DRIVES: DriveKey[] = ['open', 'bare', 'shut'];
/** The members whose Docks access comes from the implicit org membership. Gil's grant rides on it. */
const IMPLICIT_ON_DOCKS: PersonKey[] = ['ivy', 'sam', 'fay', 'gil'];
/** Org members with no row on Bare or Shut: implicit there. */
const ORG_MEMBERS: PersonKey[] = ['ivy', 'sam', 'fay', 'gil', 'ira'];

/** The answer every page path must give, written from the rules, not from the code. */
function expectedPage(person: PersonKey, drive: DriveKey, page: PageKey, floor: OpenRoleFloor): ViewEdit {
  const none: ViewEdit = [false, false];
  if (person === 'lena' || person === 'ada') return [true, true];
  const floorEdit = floor === 'edit';
  if (OPEN_DRIVES.includes(drive)) {
    const implicit = drive === 'open' ? IMPLICIT_ON_DOCKS.includes(person) : ORG_MEMBERS.includes(person);
    if (implicit) return page === 'hiring' ? none : [true, floorEdit];
    // Explicit invited role (an org member's or an outsider's): drive-wide view, Secret hidden, never raised.
    if (drive === 'open' && (person === 'ira' || person === 'oz')) return page === 'roadmap' ? [true, false] : none;
    if (drive === 'open' && person === 'gus') return page === 'roadmap' ? [true, false] : none;
    return none;
  }
  if (drive === 'restricted' && person === 'ira') return page === 'hiring' ? none : [true, false];
  return none;
}

/** The drive-wide edit answer (drive root, drive permissions, the listing's canCreatePages). */
function expectedDriveEdit(person: PersonKey, drive: DriveKey, floor: OpenRoleFloor): boolean {
  if (person === 'lena' || person === 'ada') return true;
  if (!OPEN_DRIVES.includes(drive)) return false;
  const implicit = drive === 'open' ? IMPLICIT_ON_DOCKS.includes(person) : ORG_MEMBERS.includes(person);
  if (!implicit) return false;
  // Bare has no default role: the plain MEMBER already edits the drive root (#2627).
  return drive === 'bare' || floor === 'edit';
}

/** Every resolver path's answer for every (person, drive, page), as readable disagreement lines. */
async function disagreements(h: Harbor, floor: OpenRoleFloor): Promise<{ lines: string[]; compared: number }> {
  const lines: string[] = [];
  let compared = 0;
  const check = (path: string, at: string, actual: unknown, expected: unknown) => {
    compared += 1;
    if (JSON.stringify(actual) !== JSON.stringify(expected)) lines.push(`${path} ${at}: ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  };
  const ve = (p: { canView: boolean; canEdit: boolean } | null | undefined): ViewEdit => [p?.canView === true, p?.canEdit === true];

  for (const [personKey, person] of Object.entries(h.people) as Array<[PersonKey, Harbor['people'][PersonKey]]>) {
    const token = h.tokens.get(person.id) as string;
    const listed = new Map((await listAccessibleDrives(person.id)).map((d) => [d.id, d.canCreatePages]));
    for (const driveKey of Object.keys(h.drives) as DriveKey[]) {
      const drive = h.drives[driveKey];
      const at = `${personKey}@${driveKey}`;
      const driveEdit = expectedDriveEdit(personKey, driveKey, floor);
      check('getUserAccessLevel(drive root).canEdit', at, (await getUserAccessLevel(person.id, drive.id))?.canEdit === true, driveEdit);
      check('getUserDrivePermissions.canEdit', at, (await getUserDrivePermissions(person.id, drive.id))?.canEdit === true, driveEdit);
      // An org Admin opens a RESTRICTED or PRIVATE drive but is not LISTED on it until joined (DRV-6).
      const listedForAdmin = personKey !== 'ada' || OPEN_DRIVES.includes(driveKey);
      check('listAccessibleDrives.canCreatePages', at, listed.get(drive.id) === true, driveEdit && listedForAdmin);
      check('getDriveWithAccess.canCreatePages', at, (await getDriveWithAccess(drive.id, person.id))?.canCreatePages === true, driveEdit);

      const drivePages = h.pages[driveKey];
      const pageIds = Object.values(drivePages).map((p) => p.id);
      const batch = await getBatchPagePermissions(person.id, pageIds);
      const tree = new Set(await getUserAccessiblePagesInDrive(person.id, drive.id));
      const details = new Map((await getUserAccessiblePagesInDriveWithDetails(person.id, drive.id)).map((p) => [p.id, p.permissions]));
      const appDetails = new Map((await getAppAccessiblePagesInDrive(token, drive.id)).map((p) => [p.id, p.permissions]));
      for (const pageKey of Object.keys(drivePages) as PageKey[]) {
        const pageId = drivePages[pageKey].id;
        const pageAt = `${at}/${pageKey}`;
        const [view, edit] = expectedPage(personKey, driveKey, pageKey, floor);
        check('getUserAccessLevel', pageAt, ve(await getUserAccessLevel(person.id, pageId)), [view, edit]);
        check('getBatchPagePermissions', pageAt, ve(batch.get(pageId)), [view, edit]);
        check('getUsersWhoCanViewPage', pageAt, (await getUsersWhoCanViewPage(pageId, [person.id])).has(person.id), view);
        check('getUserAccessiblePagesInDrive', pageAt, tree.has(pageId), view);
        check('getUserAccessiblePagesInDriveWithDetails', pageAt, ve(details.get(pageId)), [view, edit]);
        check('getAppAccessLevel (inheriting key)', pageAt, ve(await getAppAccessLevel(token, pageId)), [view, edit]);
        check('getAppAccessiblePagesInDrive (inheriting key)', pageAt, ve(appDetails.get(pageId)), [view, edit]);
      }
    }
  }
  return { lines, compared };
}

describe('POL-6: the Open-drive role floor is read by every implicit-membership resolver (integration)', () => {
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
    flags.orgsEnabled = true;
    // Children before parents, users last: holds, drives (cascading pages, rows, roles, grants and key
    // scopes), subscriptions, org members, orgs, then the users (cascading their keys).
    const orgIds = createdOrgIds.splice(0);
    if (orgIds.length > 0) {
      await db.delete(orgGuestHolds).where(inArray(orgGuestHolds.orgId, orgIds));
      await db.delete(drives).where(inArray(drives.orgId, orgIds));
      await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, orgIds));
      await db.delete(orgMembers).where(inArray(orgMembers.orgId, orgIds));
      await db.delete(organizations).where(inArray(organizations.id, orgIds));
    }
    const userIds = createdUserIds.splice(0);
    if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds));
  }, 120_000);

  afterAll(async () => {
    for (const [key, value] of savedAuditEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetAuditBinding();
    await pool.end();
  });

  for (const floor of ['view', 'edit'] as const) {
    it(`POL-6 the consistency matrix under a ${floor} floor: every resolver path answers the floored table for every person, drive and page`, async () => {
      const h = await harbor();
      await setFloor(h.org.id, floor);

      const { lines, compared } = await disagreements(h, floor);
      expect(lines).toEqual([]);
      expect(compared).toBeGreaterThan(500);
    }, 180_000);
  }

  it('POL-6 the matrix is not vacuous: the stored roles sit below both floors, and dark (no org resolution) the implicit members hold nothing', async () => {
    const h = await harbor();
    await setFloor(h.org.id, 'edit');

    // What the write guard would judge: Docks' and Shut's defaults, and Fay's frozen role, are below even the view floor.
    const roles = await db.select({ name: driveRoles.name, driveId: driveRoles.driveId, driveWide: driveRoles.driveWidePermissions, permissions: driveRoles.permissions })
      .from(driveRoles).where(inArray(driveRoles.driveId, [h.drives.open.id, h.drives.shut.id]));
    for (const name of ['Below', 'Former', 'Closed']) {
      const r = roles.find((x) => x.name === name);
      expect(r, name).toBeDefined();
      expect(openDefaultRoleMeetsFloor('view', r?.driveWide ?? null, r?.permissions ?? {}), name).toBe(false);
    }

    flags.orgsEnabled = false;
    expect(await getUserAccessLevel(h.people.ivy.id, h.pages.open.roadmap.id)).toBeNull();
    expect(await getUserAccessLevel(h.people.sam.id, h.pages.open.secret.id)).toBeNull();
    expect(await getUserAccessLevel(h.people.fay.id, h.pages.open.roadmap.id)).toBeNull();
    expect(await getUserAccessLevel(h.people.gil.id, h.pages.open.roadmap.id)).toEqual({ canView: true, canEdit: false, canShare: false, canDelete: false });
  }, 180_000);

  it('POL-6 guests-off parking still wins: a parked outsider and a parked guest resolve nothing in any path, while the floor still holds for org members', async () => {
    const h = await harbor();
    await setFloor(h.org.id, 'edit');
    const parked = await updateOrgPolicies({ orgId: h.org.id, actorId: h.people.ada.id, patch: { guests: 'off' } });
    expect(parked).toMatchObject({ ok: true });

    const { lines } = await disagreements(h, 'edit');
    // Only the two outsiders' cells change, each from its pre-parking answer to nothing.
    const outsiders = lines.filter((line) => / (oz|gus)@/.test(line));
    expect(outsiders.length).toBeGreaterThan(0);
    expect(lines.filter((line) => !/ (oz|gus)@/.test(line))).toEqual([]);
    for (const person of [h.people.oz, h.people.gus]) {
      const token = h.tokens.get(person.id) as string;
      for (const page of Object.values(h.pages.open)) {
        expect(await getUserAccessLevel(person.id, page.id)).toBeNull();
        expect(await getAppAccessLevel(token, page.id)).toBeNull();
        expect((await getBatchPagePermissions(person.id, [page.id])).get(page.id)?.canView).toBe(false);
        expect((await getUsersWhoCanViewPage(page.id, [person.id])).size).toBe(0);
      }
      expect(await getUserAccessiblePagesInDrive(person.id, h.drives.open.id)).toEqual([]);
      expect(await getUserAccessiblePagesInDriveWithDetails(person.id, h.drives.open.id)).toEqual([]);
      expect(await getUserDrivePermissions(person.id, h.drives.open.id)).toBeNull();
    }
    // The org's implicit members keep the floor.
    expect(await getUserAccessLevel(h.people.ivy.id, h.pages.open.secret.id)).toEqual({ canView: true, canEdit: true, canShare: false, canDelete: false });
  }, 180_000);

  it('POL-6 the floor is read at resolution: lowering it in the policy lowers what the floor adds on the very next read, and never below the explicit grant', async () => {
    const h = await harbor();
    const { ivy, gil } = h.people;
    await setFloor(h.org.id, 'edit');
    expect(await getUserAccessLevel(ivy.id, h.pages.open.roadmap.id)).toEqual({ canView: true, canEdit: true, canShare: false, canDelete: false });
    await setFloor(h.org.id, 'view');
    expect(await getUserAccessLevel(ivy.id, h.pages.open.roadmap.id)).toEqual({ canView: true, canEdit: false, canShare: false, canDelete: false });
    // A damaged stored floor reads as view (fail closed: a floor only adds), never as edit.
    await db.update(organizations).set({ policies: { openDriveRoleFloor: 'admin' } }).where(eq(organizations.id, h.org.id));
    expect(await getUserAccessLevel(gil.id, h.pages.open.roadmap.id)).toEqual({ canView: true, canEdit: false, canShare: false, canDelete: false });
    expect(await getUserAccessLevel(ivy.id, h.pages.open.secret.id)).toEqual({ canView: true, canEdit: false, canShare: false, canDelete: false });
  }, 180_000);
});
