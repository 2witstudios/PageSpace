/**
 * The org-drive requirements (ORG-4, DRV-5, DRV-7, DRV-8, DRV-9), each proven end to end in ONE test against real
 * Postgres over the Northwind fixture, with orgs switched on. The narrower clause-by-clause tests live beside this
 * file (org-drive-resolvers, org-drive-sibling-resolvers, org-admin-access-audit); these are the ones that name the
 * whole requirement.
 *
 * ORG-4 "Using it on a Private drive writes an audit event" is read as: one authz.access.granted event per (person,
 * Private drive) per 15-minute UTC window (org-admin-access-audit.ts). A page view, a realtime re-check, a search hit
 * and an AI tool call each re-resolve the drive, so one event per resolver call would write hundreds of rows for one
 * person opening one drive; the window makes the unit of "use" one sitting. The test below stays inside one window.
 *
 * DRV-5 and DRV-9 name the sidebar and the picker. Both are one component (the sidebar's drive switcher opens the
 * picker dialog), fed by one store that holds exactly what GET /api/drives (listAccessibleDrives) answered; the web test
 * DriveSwitcherDialog.orgs.test.tsx proves that seam, so the groups built here from listAccessibleDrives are what the
 * person sees. DRV-8's Members-page label reads listDriveMembers' isGuest, asserted here; DriveMembers.orgs.test.tsx
 * renders it as "Guest".
 *
 * Requires a running Postgres database with the latest migrations applied.
 * Run via:
 *   bun run --filter '@pagespace/lib' test:integration -- src/permissions/__tests__/org-drive-requirements.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import { organizations } from '@pagespace/db/schema/organizations';
import { factories } from '@pagespace/db/test/factories';
import { resetAuditDbBindingForTests } from '../../audit/audit-db-binding';
import { resetDefaultSecurityAuditForTests, securityAudit } from '../../audit/security-audit';
import {
  getBatchPagePermissions,
  getUserAccessLevel,
  getUserAccessiblePagesInDrive,
  getUserDriveAccess,
  getUserDrivePermissions,
  isDriveOwnerOrAdmin,
  isUserDriveMember,
} from '../permissions';
import { accessiblePageIds } from '../accessible-page-ids';
import { listOrgDriveDirectory } from '../org-drive-directory';
import { decideOrgDriveAdmission } from '../guest-admission';
import { checkDriveMayLoosen } from '../org-lapse-guard';
import {
  getDriveAccess,
  getDriveAccessWithDrive,
  listAccessibleDrives,
  type ListDrivesOptions,
} from '../../services/drive-service';
import { checkDriveAccess, listDriveMembers } from '../../services/drive-member-service';
import { checkDriveAccessForRoles } from '../../services/drive-role-service';
import { requestToJoinDrive } from '../../services/drive-join-request-service';
import { resolveDriveMembership } from '../../services/agent-workspaces/agent-workspace-tenant';
import { countOrgSeatParts, countOrgSeats, listOrganizationsForUser } from '../../organizations/repository';
import { groupPickerDrives } from '../../organizations/drive-picker-groups';
import { cleanupNorthwind, createUser, northwind, type Fixture } from './fixtures/northwind-org-drives';
import { credentialActor } from '../access-actor';


const LIST_OPTIONS: ListDrivesOptions[] = [{}, { includeTrash: true }, { tokenScopable: true }];
const FULL = { canView: true, canEdit: true, canShare: true, canDelete: true };
const ORG_ADMIN = { isOwner: false, isAdmin: true, isMember: true, role: 'ADMIN', customRoleId: null };
const NO_MEMBERSHIP = { isOwner: false, isAdmin: false, isMember: false, role: null, customRoleId: null };
const AUDIT_WINDOW_MS = 15 * 60 * 1000;

const listedIds = async (userId: string, options?: ListDrivesOptions) =>
  (await listAccessibleDrives(credentialActor(userId, null), options)).map((d) => d.id).sort();

async function accessRows(driveId: string) {
  const rows = await securityAudit.queryEvents({ eventType: 'authz.access.granted', resourceId: driveId });
  return rows.map((r) => ({ userId: r.userId, details: r.details }));
}

/** Audit writes are fire-and-forget from the resolvers: let them land before counting. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 750));

/** Starts the test well inside one 15-minute audit window, so the dedupe is not split by a boundary. */
async function awayFromWindowEdge() {
  const left = AUDIT_WINDOW_MS - (Date.now() % AUDIT_WINDOW_MS);
  if (left < 45_000) await new Promise((resolve) => setTimeout(resolve, left + 1_000));
}

async function pageIdsOf(driveId: string) {
  return (await db.select({ id: pages.id }).from(pages).where(eq(pages.driveId, driveId))).map((p) => p.id).sort();
}

/** A drive "opens" for someone when its root or one of its pages resolves viewable. */
async function opens(userId: string, driveId: string): Promise<boolean> {
  if ((await getUserAccessLevel(credentialActor(userId, null), driveId))?.canView) return true;
  for (const pageId of await pageIdsOf(driveId)) {
    if ((await getUserAccessLevel(credentialActor(userId, null), pageId))?.canView) return true;
  }
  return false;
}

/**
 * The write the drive-invite acceptance makes (apps/web drive-invite-repository consumeInviteAndCreateMembership),
 * in the same order: the guest admission and the lapse guard, then an accepted row with the invited role.
 */
/**
 * The admission and write the drive-invite acceptance runs (apps/web drive-invite-repository
 * consumeInviteAndCreateMembership, which lib cannot import): the guest/lapse decisions are the real
 * lib functions; only the row insert is restated.
 */
async function acceptDriveInvite(driveId: string, userId: string, invitedBy: string, role: 'ADMIN' | 'MEMBER') {
  return db.transaction(async (tx) => {
    const admission = await decideOrgDriveAdmission({ driveId, userId }, tx);
    if (admission.decision !== 'allow') return admission;
    if (await checkDriveMayLoosen(tx, driveId, true)) return { decision: 'refuse' as const, refusal: 'org_lapsed' };
    await tx.insert(driveMembers).values({ driveId, userId, role, customRoleId: null, invitedBy, acceptedAt: new Date() });
    return admission;
  });
}

describe('org drive requirements (integration)', () => {
  // Pin the audit binding to the main database, as org-drive-resolvers.integration does, so the ORG-4 rows are read
  // back from the store they were written to.
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

  /** Northwind, paid: an unpaid org is lapsed (D-OW-30), and these tests are not about the lapse. */
  async function paidNorthwind(): Promise<Fixture> {
    const f = await northwind();
    await factories.createOrgSubscription(f.org.id, { status: 'active' });
    return f;
  }

  it('ORG-4 an org Owner and an org Admin with no drive_members row resolve full access on every org drive (Open, Restricted, Private) in every human resolver and the SQL twin, as the drive-admin branch; only org power used on the Private drive writes an authz.access.granted org_admin event, one per person per window, and a joined Admin or an Open/Restricted drive writes none', async () => {
    const f = await paidNorthwind();
    const { jono, priya, omar } = f.people;
    const northwindDrives = [f.drives.product, f.drives.research, f.drives.finance];
    // No row of any kind: the fixture's leftover OWNER, stale org and invited MEMBER rows are removed, so org power
    // is the only path.
    await db.delete(driveMembers).where(and(
      inArray(driveMembers.userId, [jono.id, priya.id]),
      inArray(driveMembers.driveId, northwindDrives.map((d) => d.id)),
    ));
    await awayFromWindowEdge();

    for (const person of [jono, priya]) {
      const sqlVisible = new Set(await accessiblePageIds(credentialActor(person.id, null)));
      for (const drive of northwindDrives) {
        const where = `${person.name} on ${drive.name}`;
        const pageIds = await pageIdsOf(drive.id);
        expect(await getUserAccessLevel(credentialActor(person.id, null), drive.id), where).toEqual(FULL);
        for (const pageId of pageIds) {
          expect(await getUserAccessLevel(credentialActor(person.id, null), pageId), `${where} page ${pageId}`).toEqual(FULL);
          expect(sqlVisible.has(pageId), `SQL twin ${where} page ${pageId}`).toBe(true);
        }
        const batch = await getBatchPagePermissions(credentialActor(person.id, null), pageIds);
        for (const pageId of pageIds) expect(batch.get(pageId), `batch ${where}`).toMatchObject(FULL);
        expect((await getUserAccessiblePagesInDrive(credentialActor(person.id, null), drive.id)).sort(), where).toEqual(pageIds);
        expect(await getDriveAccess(drive.id, credentialActor(person.id, null)), where).toEqual(ORG_ADMIN);
        expect((await getDriveAccessWithDrive(drive.id, credentialActor(person.id, null)))?.access, where).toEqual(ORG_ADMIN);
        expect(await getUserDriveAccess(credentialActor(person.id, null), drive.id), where).toBe(true);
        expect(await getUserDrivePermissions(credentialActor(person.id, null), drive.id), where).toMatchObject({ hasAccess: true, isOwner: false, isAdmin: true, isMember: true });
        expect(await isDriveOwnerOrAdmin(credentialActor(person.id, null), drive.id), where).toBe(true);
        expect(await isUserDriveMember(credentialActor(person.id, null), drive.id), where).toBe(true);
        expect(await checkDriveAccess(drive.id, credentialActor(person.id, null)), where).toMatchObject({ isOwner: false, isAdmin: true, isMember: true });
        expect(await checkDriveAccessForRoles(drive.id, credentialActor(person.id, null)), where).toMatchObject({ isOwner: false, isAdmin: true, isMember: true });
        expect(await resolveDriveMembership({ actor: credentialActor(person.id, null), driveId: drive.id }), where).toBe('admin');
      }
    }
    // Omar's own invited ADMIN row opens Finance: the drive-admin branch, not org power.
    expect(await getUserAccessLevel(credentialActor(omar.id, null), f.pages.financePrivatePage.id)).toEqual(FULL);
    expect(new Set(await accessiblePageIds(credentialActor(omar.id, null))).has(f.pages.financePrivatePage.id)).toBe(true);

    await vi.waitFor(async () => {
      expect((await accessRows(f.drives.finance.id)).map((r) => r.userId).sort()).toEqual([jono.id, priya.id].sort());
    }, { timeout: 10_000, interval: 200 });
    await settle();
    // Dozens of resolver calls each, TS and SQL alike, in one window: exactly one event per person.
    const finance = await accessRows(f.drives.finance.id);
    expect(finance.map((r) => r.userId).sort()).toEqual([jono.id, priya.id].sort());
    expect(finance.find((r) => r.userId === jono.id)?.details).toMatchObject({ via: 'org_admin', orgId: f.org.id, orgRole: 'OWNER', orgVisibility: 'PRIVATE' });
    expect(finance.find((r) => r.userId === priya.id)?.details).toMatchObject({ via: 'org_admin', orgId: f.org.id, orgRole: 'ADMIN', orgVisibility: 'PRIVATE' });
    expect(await accessRows(f.drives.product.id)).toEqual([]);
    expect(await accessRows(f.drives.research.id)).toEqual([]);
  }, 120_000);

  it('DRV-5 an org Member with no drive_members row resolves an Open drive with the drive\'s default role in getUserAccessLevel, getDriveAccess and the SQL twin, and the drive is in listAccessibleDrives and under its org header in the picker groups built from it', async () => {
    const f = await paidNorthwind();
    const { nina, marcus } = f.people;
    // Marcus's materialized row goes too: no row is needed.
    await db.delete(driveMembers).where(and(eq(driveMembers.driveId, f.drives.product.id), inArray(driveMembers.userId, [nina.id, marcus.id])));
    const defaultRole = { isOwner: false, isAdmin: false, isMember: true, role: 'MEMBER', customRoleId: f.roles.productDefault.id };
    // The default role is Contributor: drive-wide view and edit, no share.
    const contributor = { canView: true, canEdit: true, canShare: false, canDelete: false };

    for (const member of [nina, marcus]) {
      expect(await getDriveAccess(f.drives.product.id, credentialActor(member.id, null)), member.name).toEqual(defaultRole);
      expect((await getDriveAccessWithDrive(f.drives.product.id, credentialActor(member.id, null)))?.access, member.name).toEqual(defaultRole);
      expect(await getUserAccessLevel(credentialActor(member.id, null), f.drives.product.id), member.name).toEqual(contributor);
      expect(await getUserAccessLevel(credentialActor(member.id, null), f.pages.productPage.id), member.name).toEqual(contributor);
      expect(await getUserAccessLevel(credentialActor(member.id, null), f.pages.productPrivatePage.id), member.name).toBeNull();
      const sqlVisible = new Set(await accessiblePageIds(credentialActor(member.id, null)));
      expect(sqlVisible.has(f.pages.productPage.id), member.name).toBe(true);
      expect(sqlVisible.has(f.pages.productPrivatePage.id), member.name).toBe(false);

      for (const options of LIST_OPTIONS) {
        expect(await listedIds(member.id, options), `${member.name} ${JSON.stringify(options)}`).toContain(f.drives.product.id);
      }
      const listed = await listAccessibleDrives(credentialActor(member.id, null));
      expect(listed.find((d) => d.id === f.drives.product.id)).toMatchObject({ orgId: f.org.id, orgVisibility: 'OPEN', role: 'MEMBER', isOwned: false });
      const groups = groupPickerDrives(listed, await listOrganizationsForUser(member.id));
      const northwindGroup = groups.find((g) => g.kind === 'org' && g.orgId === f.org.id);
      expect(northwindGroup?.label).toBe('Northwind Labs');
      expect(northwindGroup?.drives.map((d) => d.id)).toEqual([f.drives.product.id]);
    }
  });

  it('DRV-7 a Private org drive is invite-only: a plain org member without an invitation cannot open, list, find in the directory or request it (the same 404 as a missing drive), and once they hold an accepted invited membership (admitted as invite acceptance admits it: decideOrgDriveAdmission, then the lapse guard) they resolve exactly the invited role, as on a personal drive', async () => {
    const f = await paidNorthwind();
    const { nina, marcus, lena } = f.people;
    const finance = f.drives.finance;
    const missingDrive = createId();

    // Nina has no row; Marcus holds a stale materialized one. Neither is invited.
    for (const member of [nina, marcus]) {
      for (const target of [finance.id, f.pages.financePage.id, f.pages.financePrivatePage.id]) {
        expect(await getUserAccessLevel(credentialActor(member.id, null), target), `${member.name} ${target}`).toBeNull();
      }
      expect(await getDriveAccess(finance.id, credentialActor(member.id, null))).toEqual(NO_MEMBERSHIP);
      expect(new Set(await accessiblePageIds(credentialActor(member.id, null))).has(f.pages.financePage.id)).toBe(false);
      for (const options of LIST_OPTIONS) expect(await listedIds(member.id, options)).not.toContain(finance.id);
      const directory = await listOrgDriveDirectory(f.org.id, member.id);
      expect(directory?.map((d) => d.id)).not.toContain(finance.id);
      expect(directory?.map((d) => d.id)).toContain(f.drives.research.id);
      const request = await requestToJoinDrive(member.id, finance.id);
      expect(request).toMatchObject({ ok: false, status: 404 });
      expect(request).toEqual(await requestToJoinDrive(member.id, missingDrive));
    }

    // The lead invites Nina as a MEMBER and she accepts; a newcomer accepts the same invitation on a personal drive.
    expect(await acceptDriveInvite(finance.id, nina.id, lena.id, 'MEMBER')).toMatchObject({ decision: 'allow' });
    const newcomer = await createUser('Pat Personal');
    expect(await acceptDriveInvite(f.drives.personal.id, newcomer.id, marcus.id, 'MEMBER')).toMatchObject({ decision: 'allow' });

    const invitedMember = { isOwner: false, isAdmin: false, isMember: true, role: 'MEMBER', customRoleId: null };
    expect(await getDriveAccess(finance.id, credentialActor(nina.id, null))).toEqual(invitedMember);
    expect(await getDriveAccess(f.drives.personal.id, credentialActor(newcomer.id, null))).toEqual(invitedMember);
    // Page by page, exactly what the same invitation gives on a personal drive: the open page, not the private one.
    expect(await getUserAccessLevel(credentialActor(nina.id, null), f.pages.financePage.id)).toEqual(await getUserAccessLevel(credentialActor(newcomer.id, null), f.pages.personalPage.id));
    expect(await getUserAccessLevel(credentialActor(nina.id, null), f.pages.financePrivatePage.id)).toEqual(await getUserAccessLevel(credentialActor(newcomer.id, null), f.pages.personalPrivatePage.id));
    expect(await getUserAccessLevel(credentialActor(nina.id, null), f.pages.financePage.id)).toMatchObject({ canView: true, canShare: false, canDelete: false });
    expect(await getUserAccessLevel(credentialActor(nina.id, null), f.pages.financePrivatePage.id)).toBeNull();
    expect(await listedIds(nina.id)).toContain(finance.id);
    // Marcus was not invited: still nothing.
    expect(await getUserAccessLevel(credentialActor(marcus.id, null), f.pages.financePage.id)).toBeNull();
  });

  it('DRV-8 an outsider invited to one org drive is a guest: the org\'s seat count does not change, they list and open only that drive (not the org\'s other Open, Restricted or Private drives, even with a page shared there), and the drive\'s Members listing labels them Guest while org members are not', async () => {
    const f = await paidNorthwind();
    const { lena, marcus, eve } = f.people;
    // The org lets guests in directly, so the invitation is admitted rather than queued for approval (POL-2).
    await db.update(organizations).set({ policies: { guests: 'on' } }).where(eq(organizations.id, f.org.id));
    const handbookOrgDrive = await factories.createDrive(lena.id, { name: 'Wiki', slug: `wiki-${createId()}`, orgId: f.org.id, orgVisibility: 'OPEN' });
    const seatsBefore = await countOrgSeatParts(f.org.id);

    const zoe = await createUser('Zoe Outsider');
    expect(await acceptDriveInvite(f.drives.product.id, zoe.id, lena.id, 'MEMBER')).toMatchObject({ decision: 'allow' });
    // Pages shared with her inside the Restricted and the Private drive.
    await factories.createPagePermission(f.pages.researchPage.id, zoe.id);
    await factories.createPagePermission(f.pages.financePage.id, zoe.id);

    // No seat: the seat count (what seat admission and the Stripe seat quantity are computed from, SEAT-3) is unchanged.
    expect(await countOrgSeatParts(f.org.id)).toEqual(seatsBefore);
    expect(await countOrgSeats(f.org.id)).toBe(seatsBefore.members + seatsBefore.pendingInvites);

    for (const options of LIST_OPTIONS) expect(await listedIds(zoe.id, options)).toEqual([f.drives.product.id]);
    expect(await opens(zoe.id, f.drives.product.id)).toBe(true);
    for (const drive of [handbookOrgDrive, f.drives.research, f.drives.finance]) {
      expect(await getUserAccessLevel(credentialActor(zoe.id, null), drive.id), drive.name).toBeNull();
      expect(await getDriveAccess(drive.id, credentialActor(zoe.id, null)), drive.name).toEqual(NO_MEMBERSHIP);
    }
    expect(await getUserAccessLevel(credentialActor(zoe.id, null), f.pages.productPrivatePage.id)).toBeNull();
    // In the picker she sees it under "Shared with you": the org's name is not hers to see.
    const groups = groupPickerDrives(await listAccessibleDrives(credentialActor(zoe.id, null)), await listOrganizationsForUser(zoe.id));
    expect(groups.map((g) => [g.kind, g.drives.map((d) => d.id)])).toEqual([['shared', [f.drives.product.id]]]);

    // The Members page read model: Zoe is labelled a guest; org members (materialized, invited, a former lead's row) are not.
    const members = await listDriveMembers(f.drives.product.id);
    const label = (userId: string) => members.find((m) => m.userId === userId)?.isGuest;
    expect(label(zoe.id)).toBe(true);
    expect(label(marcus.id)).toBe(false);
    expect(label(f.people.kai.id)).toBe(false);
    expect(label(f.people.chris.id)).toBe(true);
    // Dana left Northwind: her stale materialized row is neither a member nor a guest.
    expect(members.some((m) => m.userId === f.people.dana.id)).toBe(false);
    expect((await listDriveMembers(f.drives.research.id)).find((m) => m.userId === eve.id)?.isGuest).toBe(false);
  });

  it('DRV-9 for every persona (org Owner, Admins, Members, a lead, a guest, an outsider, people in two orgs) the picker groups built from listAccessibleDrives put each drive under its org header, Personal, or Shared with you for a foreign org, every listed drive opens, and no un-joined Restricted, uninvited Private or other-org drive is listed', async () => {
    const f = await paidNorthwind();
    const orgDrives = [f.drives.product, f.drives.research, f.drives.finance, f.drives.acmeWiki, f.drives.handbook];

    for (const [name, person] of Object.entries(f.people)) {
      const listed = await listAccessibleDrives(credentialActor(person.id, null));
      const orgs = await listOrganizationsForUser(person.id);
      const myOrgIds = new Set(orgs.map((o) => o.id));
      const groups = groupPickerDrives(listed, orgs);

      // Every listed drive appears exactly once, in the group its owner decides.
      expect(groups.flatMap((g) => g.drives.map((d) => d.id)).sort(), name).toEqual(listed.map((d) => d.id).sort());
      for (const group of groups) {
        for (const drive of group.drives) {
          const where = `${name}: ${drive.name} in ${group.label}`;
          if (!drive.orgId) expect(group.kind, where).toBe('personal');
          else if (myOrgIds.has(drive.orgId)) expect(group.kind === 'org' && group.orgId === drive.orgId, where).toBe(true);
          else expect(group.kind, where).toBe('shared');
          expect(await opens(person.id, drive.id), `${where} opens`).toBe(true);
        }
      }

      // Nothing they cannot already open: an org drive is listed only when it is Open in one of their orgs, or they
      // lead it, or they hold an accepted invited row on it.
      for (const drive of orgDrives) {
        const [row] = await db
          .select({ source: driveMembers.source, acceptedAt: driveMembers.acceptedAt })
          .from(driveMembers)
          .where(and(eq(driveMembers.driveId, drive.id), eq(driveMembers.userId, person.id)));
        const invited = row?.source === 'invite' && row.acceptedAt !== null;
        const inOrg = drive.orgId !== null && myOrgIds.has(drive.orgId);
        const isListed = listed.some((d) => d.id === drive.id);
        if (isListed) {
          const why = drive.ownerId === person.id || (inOrg && drive.orgVisibility === 'OPEN') || invited;
          expect(why, `${name} lists ${drive.name}`).toBe(true);
        }
        if (!(await opens(person.id, drive.id))) expect(isListed, `${name} cannot open ${drive.name}`).toBe(false);
      }
    }

    // Not vacuous: the personas the requirement names see exactly these groups.
    const view = async (userId: string) => groupPickerDrives(await listAccessibleDrives(credentialActor(userId, null)), await listOrganizationsForUser(userId))
      .map((g) => [g.label, g.drives.map((d) => d.name)]);
    // In two orgs (Northwind and Southwind), a plain Member of both, with a stale former-lead row on Handbook.
    expect(await view(f.people.kai.id)).toEqual([['Northwind Labs', ['Product']], ['Southwind', ['Handbook']]]);
    // An org Admin sees the Open drive but not un-joined Restricted or Private ones.
    expect(await view(f.people.priya.id)).toEqual([['Northwind Labs', ['Product']]]);
    // A joined Restricted drive is listed under its org.
    expect(await view(f.people.eve.id)).toEqual([['Northwind Labs', ['Customer Research', 'Product']]]);
    // Owner of Acme, invited to a personal drive, out of Northwind despite a stale row there.
    expect(await view(f.people.dana.id)).toEqual([['Acme', ['Acme Wiki']], ['Personal', ['Marcus Notes']]]);
    // A guest in no org: Shared with you; an outsider whose leftover lead row opens nothing: no groups at all.
    expect(await view(f.people.chris.id)).toEqual([['Shared with you', ['Product']]]);
    expect(await view(f.people.fred.id)).toEqual([]);
  }, 120_000);
});
