/**
 * B7c: the permission primitives every former inline access gate now calls, against real Postgres.
 *
 * - loadDriveRelationship / loadDriveRelationships answer "is this person the drive's lead, and what
 *   is their effective membership" (the question every `drives.ownerId === userId` plus
 *   `drive_members` read in apps/web used to answer on its own).
 * - listMemberDrives answers "which drives is this person a member of" (the owned-plus-rows unions
 *   in commands, activity, pulse, memory, the app shell and the channel candidate queries).
 * - memberOfAnyDriveCondition answers the same question inside SQL, for the profile search.
 *
 * Each is checked for every person and drive of the Northwind fixture against the canonical
 * resolvers (getDriveAccess, listAccessibleDrives), with ORGS_ENABLED on, and against the frozen
 * pre-org inline shapes with ORGS_ENABLED off.
 *
 * Requires a running Postgres database with the latest migrations applied.
 * Run via:
 *   bun run --filter '@pagespace/lib' test:integration -- src/permissions/__tests__/drive-gate-primitives.integration.test.ts
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { factories } from '@pagespace/db/test/factories';
import { db, pool } from '@pagespace/db/db';
import { and, eq, inArray, isNotNull } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import { orgMembers } from '@pagespace/db/schema/organizations';
import { getDriveAccess, listAccessibleDrives } from '../../services/drive-service';
import { canAdministerDrive, driveRoleOf, isDriveLead, type RelationshipDrive } from '../drive-relationship';
import { loadDriveRelationship, loadDriveRelationships } from '../drive-relationship-loader';
import { getMemberDriveIds, listMemberDrives, memberOfAnyDriveCondition, sharesMemberDrive } from '../member-drives';
import { cleanupNorthwind, createUser, northwind } from './fixtures/northwind-org-drives';

const flags = vi.hoisted(() => ({ orgsEnabled: false }));
vi.mock('../../organizations/orgs-enabled', () => ({
  get ORGS_ENABLED() {
    return flags.orgsEnabled;
  },
}));

/**
 * Northwind plus the shapes the former inline gates had to tell apart:
 * - Tomás holds PENDING invitations (acceptedAt null): ADMIN on Finance, MEMBER on Marcus Notes.
 * - Fred holds a leftover OWNER row on Marcus's personal drive (a personal drive's rows count as they are).
 * - Marcus's second personal drive is trashed; Nina is an accepted member of it.
 * - Lu's only link to Marcus Notes is an EXPIRED page share.
 */
async function gateFixture() {
  const f = await northwind();
  const tomas = await createUser('Tomás Alvarez');
  await db.insert(orgMembers).values({ orgId: f.org.id, userId: tomas.id, role: 'MEMBER' });
  await factories.createDriveMember(f.drives.finance.id, tomas.id, { source: 'invite', role: 'ADMIN', acceptedAt: null });
  await factories.createDriveMember(f.drives.personal.id, tomas.id, { source: 'invite', acceptedAt: null });
  await factories.createDriveMember(f.drives.personal.id, f.people.fred.id, { source: 'invite', role: 'OWNER' });
  await factories.createPagePermission(f.pages.personalPage.id, f.people.lu.id, { expiresAt: new Date(Date.now() - 60_000) });
  const archive = await factories.createDrive(f.people.marcus.id, { name: 'Marcus Archive', slug: `archive-${Date.now()}`, isTrashed: true, trashedAt: new Date() });
  await factories.createDriveMember(archive.id, f.people.nina.id, { source: 'invite' });

  const people = { ...f.people, tomas };
  const allDrives: RelationshipDrive[] = await db
    .select({ id: drives.id, ownerId: drives.ownerId, orgId: drives.orgId, orgVisibility: drives.orgVisibility })
    .from(drives)
    .where(inArray(drives.id, [...Object.values(f.drives).map((d) => d.id), archive.id]));
  const nameOf = new Map([...Object.values(f.drives), archive].map((d) => [d.id, d.name]));
  return { ...f, people, archive, allDrives, nameOf };
}

type Fixture = Awaited<ReturnType<typeof gateFixture>>;

/** The pre-org inline union every former gate ran: owned drives plus accepted rows, with the row's role. */
async function legacyInlineMemberDrives(userId: string, includeTrashed: boolean) {
  const owned = await db.select({ id: drives.id }).from(drives)
    .where(includeTrashed ? eq(drives.ownerId, userId) : and(eq(drives.ownerId, userId), eq(drives.isTrashed, false)));
  const rows = await db.select({ driveId: driveMembers.driveId, role: driveMembers.role })
    .from(driveMembers)
    .innerJoin(drives, eq(drives.id, driveMembers.driveId))
    .where(includeTrashed
      ? and(eq(driveMembers.userId, userId), isNotNull(driveMembers.acceptedAt))
      : and(eq(driveMembers.userId, userId), isNotNull(driveMembers.acceptedAt), eq(drives.isTrashed, false)));
  const out = new Map<string, string>();
  for (const d of owned) out.set(d.id, 'OWNER*');
  for (const r of rows) if (!out.has(r.driveId)) out.set(r.driveId, r.role);
  return [...out].map(([id, role]) => `${id}:${role}`).sort();
}

const memberDriveKeys = async (userId: string, includeTrashed: boolean) =>
  (await listMemberDrives(userId, { includeTrashed }))
    .map((d) => `${d.driveId}:${d.isOwner ? 'OWNER*' : d.role}`)
    .sort();

/** Disagreements between the relationship primitives and getDriveAccess, as readable lines. */
async function relationshipDisagreements(f: Fixture) {
  const out: string[] = [];
  for (const [name, person] of Object.entries(f.people)) {
    const batch = await loadDriveRelationships(person.id, f.allDrives);
    for (const drive of f.allDrives) {
      const where = `${name} on ${f.nameOf.get(drive.id)}`;
      const access = await getDriveAccess(drive.id, person.id);
      const expected = {
        isOwner: access.isOwner,
        admin: access.isOwner || access.isAdmin,
        member: access.isOwner || access.isMember,
        role: access.role,
      };
      const single = await loadDriveRelationship(person.id, drive);
      const answer = (r: typeof single | undefined) => r && {
        isOwner: r.isOwner,
        admin: canAdministerDrive(r),
        member: r.isOwner || r.membership !== null,
        role: driveRoleOf(r),
      };
      if (JSON.stringify(answer(single)) !== JSON.stringify(expected)) {
        out.push(`loadDriveRelationship: ${where} answered ${JSON.stringify(answer(single))}, canonical ${JSON.stringify(expected)}`);
      }
      if (JSON.stringify(answer(batch.get(drive.id))) !== JSON.stringify(expected)) {
        out.push(`loadDriveRelationships: ${where} answered ${JSON.stringify(answer(batch.get(drive.id)))}, canonical ${JSON.stringify(expected)}`);
      }
      if (isDriveLead(person.id, drive) !== (drive.ownerId === person.id)) out.push(`isDriveLead: ${where}`);
    }
  }
  return out;
}

/**
 * Enabled: a member drive is one the person is listed on (listAccessibleDrives) AND a member of
 * (getDriveAccess): owned, a valid row, or an OPEN drive of their org. A page share alone never makes
 * one, and neither does org power over a RESTRICTED or PRIVATE drive they have not joined (DRV-6).
 */
async function memberDriveDisagreements(f: Fixture) {
  const out: string[] = [];
  for (const [name, person] of Object.entries(f.people)) {
    for (const includeTrashed of [true, false]) {
      const listed = await listAccessibleDrives(person.id, { includeTrash: includeTrashed });
      const expected: string[] = [];
      for (const d of listed) {
        const access = await getDriveAccess(d.id, person.id);
        if (access.isOwner) expected.push(`${d.id}:OWNER*`);
        else if (access.isMember) expected.push(`${d.id}:${d.role}`);
      }
      expected.sort();
      const actual = await memberDriveKeys(person.id, includeTrashed);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        const label = (keys: string[]) => keys.map((k) => `${f.nameOf.get(k.split(':')[0])}:${k.split(':')[1]}`);
        out.push(`listMemberDrives(${includeTrashed ? 'with trash' : 'no trash'}): ${name} answered ${JSON.stringify(label(actual))}, canonical ${JSON.stringify(label(expected))}`);
      }
      const ids = (await getMemberDriveIds(person.id, { includeTrashed })).sort();
      if (JSON.stringify(ids) !== JSON.stringify(expected.map((k) => k.split(':')[0]))) {
        out.push(`getMemberDriveIds: ${name} disagrees with listMemberDrives`);
      }
    }
  }
  return out;
}

/** memberOfAnyDriveCondition (SQL) must pick exactly the people listMemberDrives (the decision) lists, drive by drive. */
async function sqlConditionDisagreements(f: Fixture) {
  const out: string[] = [];
  const everyone = Object.values(f.people).map((p) => p.id);
  for (const drive of f.allDrives) {
    const rows = await db.select({ id: users.id }).from(users)
      .where(and(inArray(users.id, everyone), memberOfAnyDriveCondition(users.id, [drive.id])));
    const actual = new Set(rows.map((r) => r.id));
    for (const [name, person] of Object.entries(f.people)) {
      const expected = (await getMemberDriveIds(person.id, { includeTrashed: true })).includes(drive.id);
      if (actual.has(person.id) !== expected) {
        out.push(`memberOfAnyDriveCondition: ${name} on ${f.nameOf.get(drive.id)} answered ${actual.has(person.id)}, listMemberDrives ${expected}`);
      }
    }
  }
  return out;
}

async function countQueries<T>(run: () => Promise<T>): Promise<number> {
  const spy = vi.spyOn(pool, 'query');
  try {
    await run();
    return spy.mock.calls.length;
  } finally {
    spy.mockRestore();
  }
}

describe('B7c: the gate primitives agree with the canonical resolvers (integration)', () => {
  afterEach(async () => {
    flags.orgsEnabled = false;
    await cleanupNorthwind();
  }, 120_000);

  it('ORG-4 (partial) DRV-5 (partial) X-6 (partial) loadDriveRelationship(s) answer every person and drive exactly as getDriveAccess: org power, implicit Open members, stale org rows, former-lead OWNER rows, guests and pending invitations', async () => {
    flags.orgsEnabled = true;
    const f = await gateFixture();

    expect(await relationshipDisagreements(f)).toEqual([]);

    // Non-vacuity: the shapes the inline gates got wrong.
    const rel = (userId: string, drive: { id: string }) =>
      loadDriveRelationship(userId, f.allDrives.find((d) => d.id === drive.id) as RelationshipDrive);
    expect(canAdministerDrive(await rel(f.people.priya.id, f.drives.finance))).toBe(true); // org Admin, no valid row
    expect(driveRoleOf(await rel(f.people.nina.id, f.drives.product))).toBe('MEMBER'); // implicit Open member, no row
    expect(driveRoleOf(await rel(f.people.marcus.id, f.drives.finance))).toBeNull(); // stale source='org' row
    expect(driveRoleOf(await rel(f.people.dana.id, f.drives.product))).toBeNull(); // stale org row, not in the org
    expect(driveRoleOf(await rel(f.people.tomas.id, f.drives.finance))).toBeNull(); // pending ADMIN invitation
    expect(driveRoleOf(await rel(f.people.fred.id, f.drives.personal))).toBe('OWNER'); // a personal drive's row counts as it is
    expect(driveRoleOf(await rel(f.people.kai.id, f.drives.product))).toBe('MEMBER'); // former lead's OWNER row on an org drive
  });

  it('DRV-5 (partial) DRV-6 (partial) X-6 (partial) listMemberDrives lists exactly the drives a person is listed on and a member of: an OPEN drive of their org with no row, never a stale org row, a page share, a pending invitation, or an unjoined RESTRICTED or PRIVATE drive', async () => {
    flags.orgsEnabled = true;
    const f = await gateFixture();

    expect(await memberDriveDisagreements(f)).toEqual([]);

    const names = async (userId: string) =>
      (await listMemberDrives(userId, { includeTrashed: true })).map((d) => f.nameOf.get(d.driveId)).sort();
    expect(await names(f.people.nina.id)).toEqual(['Marcus Archive', 'Marcus Notes', 'Product']);
    expect(await names(f.people.marcus.id)).toEqual(['Marcus Archive', 'Marcus Notes', 'Product']);
    expect(await names(f.people.dana.id)).toEqual(['Acme Wiki', 'Marcus Notes']);
    expect(await names(f.people.priya.id)).toEqual(['Product']);
    expect(await names(f.people.chris.id)).toEqual(['Product']);
    expect(await names(f.people.tomas.id)).toEqual(['Product']);
    expect(await names(f.people.lu.id)).toEqual(['Handbook']);
    expect(await names(f.people.fred.id)).toEqual(['Marcus Notes']);
  });

  it('DRV-5 (partial) X-6 (partial) memberOfAnyDriveCondition picks, inside SQL, exactly the people listMemberDrives lists on each drive', async () => {
    flags.orgsEnabled = true;
    const f = await gateFixture();
    expect(await sqlConditionDisagreements(f)).toEqual([]);
  });

  it('X-6 (partial) sharesMemberDrive: an implicit Open member shares Product with its lead; a person holding only a stale org row shares nothing through it', async () => {
    flags.orgsEnabled = true;
    const f = await gateFixture();
    expect(await sharesMemberDrive(f.people.nina.id, f.people.lena.id)).toBe(true);
    expect(await sharesMemberDrive(f.people.lena.id, f.people.nina.id)).toBe(true);
    expect(await sharesMemberDrive(f.people.dana.id, f.people.lena.id)).toBe(false);
    expect(await sharesMemberDrive(f.people.chris.id, f.people.eve.id)).toBe(true); // a guest and an implicit member of Product
    expect(await sharesMemberDrive(f.people.dana.id, f.people.priya.id)).toBe(false);
    expect(await sharesMemberDrive(f.people.lu.id, f.people.marcus.id)).toBe(false);
  });

  it('while ORGS_ENABLED is false every primitive returns exactly the pre-org inline answer (owned drives plus accepted rows)', async () => {
    const f = await gateFixture();

    expect(await relationshipDisagreements(f)).toEqual([]);
    for (const [name, person] of Object.entries(f.people)) {
      for (const includeTrashed of [true, false]) {
        expect(await memberDriveKeys(person.id, includeTrashed), `${name} includeTrashed=${includeTrashed}`)
          .toEqual(await legacyInlineMemberDrives(person.id, includeTrashed));
      }
    }
    expect(await sqlConditionDisagreements(f)).toEqual([]);
    // Non-vacuity: dark, Marcus's stale Finance org row still makes Finance his (the pre-org answer).
    expect((await getMemberDriveIds(f.people.marcus.id, { includeTrashed: true }))).toContain(f.drives.finance.id);
    expect(await sharesMemberDrive(f.people.dana.id, f.people.lena.id)).toBe(true);
  });

  it('batch and listing paths run a constant number of queries, however many drives (no N+1)', async () => {
    flags.orgsEnabled = true;
    const f = await gateFixture();
    const priya = f.people.priya.id;

    // Nina (org MEMBER) opens no PRIVATE drive through org power, so no ORG-4 audit claim (deduped per
    // window by B7b) is counted: this measures resolution alone. Product needs its default role in both.
    const nina = f.people.nina.id;
    const few = await countQueries(() => loadDriveRelationships(nina, f.allDrives.filter((d) => d.id === f.drives.product.id)));
    const many = await countQueries(() => loadDriveRelationships(nina, f.allDrives));
    expect(many).toBe(few);
    expect(few).toBe(3); // accepted rows, org roles, default roles

    const listBefore = await countQueries(() => listMemberDrives(priya, { includeTrashed: true }));
    for (let i = 0; i < 12; i++) {
      await factories.createDrive(f.people.lena.id, { name: `Extra ${i}`, slug: `extra-${i}-${Date.now()}`, orgId: f.org.id, orgVisibility: 'OPEN' });
    }
    const listAfter = await countQueries(() => listMemberDrives(priya, { includeTrashed: true }));
    expect(listAfter).toBe(listBefore);
    expect((await getMemberDriveIds(priya, { includeTrashed: true })).length).toBe(13);
  });
});
