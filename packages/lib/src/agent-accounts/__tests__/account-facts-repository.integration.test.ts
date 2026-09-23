/**
 * The account authority's membership facts against real Postgres and the Northwind org fixture.
 *
 * Master's agent-account permissions (decideAccountCreatePermission, decideAccountListView,
 * authorize) are pure; the org-aware answers they decide on come from AccountFactsRepository.
 * driveRole reads getDriveAccess and driveConsenters reads the drive audience, both in the
 * permissions layer. What only a database proves is that those two agree with each other and
 * with master's guarantees, for every membership shape the org resolvers tell apart:
 *   - a pending invitation grants nothing: no role, no consent;
 *   - a stale org row or a stale OWNER row makes nobody an admin once orgs are enabled;
 *   - while orgs are dark the consenters are exactly master's query (lead + accepted ADMIN rows).
 *
 * Run via:
 *   bun run --filter '@pagespace/lib' test:integration -- src/agent-accounts/__tests__/account-facts-repository.integration.test.ts
 */
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { db, pool } from '@pagespace/db/db';
import { and, eq, isNotNull } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import { factories } from '@pagespace/db/test/factories';
import { createAccountFactsRepository } from '../account-facts-repository';
import { cleanupNorthwind, northwind, type Fixture } from '../../permissions/__tests__/fixtures/northwind-org-drives';

const flags = vi.hoisted(() => ({ orgsEnabled: false }));
vi.mock('../../organizations/orgs-enabled', () => ({
  get ORGS_ENABLED() {
    return flags.orgsEnabled;
  },
}));

/** Master's driveConsenters, verbatim in effect: the drive's ownerId plus its accepted ADMIN rows. */
async function masterConsenters(driveId: string): Promise<string[]> {
  const owner = await db.select({ ownerId: drives.ownerId }).from(drives).where(eq(drives.id, driveId)).limit(1);
  const admins = await db
    .select({ userId: driveMembers.userId })
    .from(driveMembers)
    .where(and(eq(driveMembers.driveId, driveId), eq(driveMembers.role, 'ADMIN'), isNotNull(driveMembers.acceptedAt)))
    .limit(100);
  return [...new Set([...owner.map((r) => r.ownerId), ...admins.map((r) => r.userId)])].sort();
}

const everyone = (f: Fixture) => Object.values(f.people).map((u) => u.id);
const everyDrive = (f: Fixture) => Object.values(f.drives).map((d) => d.id);

/** The people driveRole makes OWNER or ADMIN of a drive: who the authority lets create its accounts. */
async function leads(f: Fixture, driveId: string): Promise<string[]> {
  const facts = createAccountFactsRepository();
  const out: string[] = [];
  for (const userId of everyone(f)) {
    const role = await facts.driveRole({ driveId, userId });
    if (role === 'OWNER' || role === 'ADMIN') out.push(userId);
  }
  return out.sort();
}

describe('AccountFactsRepository on the org-aware permission path (integration)', () => {
  afterEach(async () => {
    flags.orgsEnabled = false;
    await cleanupNorthwind();
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  it('while orgs are dark, every drive\'s consenters are exactly master\'s (lead + accepted ADMIN rows); driveRole differs only by master\'s own non-lead OWNER rows', async () => {
    const f = await northwind();
    flags.orgsEnabled = false;
    const facts = createAccountFactsRepository();

    for (const driveId of everyDrive(f)) {
      const consenters = [...await facts.driveConsenters(driveId)];
      expect(consenters, `consenters ${driveId}`).toEqual(await masterConsenters(driveId));
      // Dark, getDriveAccess is master's pre-org resolver, which reports an accepted role='OWNER'
      // row held by someone other than the lead as role OWNER; master's consenter query never
      // counted such a row. Both halves are master's behavior, kept exactly while dark; the
      // org-enabled test below shows the two agreeing once the stale row is refused.
      const [lead] = await db.select({ ownerId: drives.ownerId }).from(drives).where(eq(drives.id, driveId));
      const nonLeadOwnerRows = (await db
        .select({ userId: driveMembers.userId })
        .from(driveMembers)
        .where(and(eq(driveMembers.driveId, driveId), eq(driveMembers.role, 'OWNER'), isNotNull(driveMembers.acceptedAt))))
        .map((r) => r.userId)
        .filter((userId) => userId !== lead?.ownerId && everyone(f).includes(userId));
      expect(await leads(f, driveId), `driveRole leads ${driveId}`).toEqual([...new Set([...consenters, ...nonLeadOwnerRows])].sort());
    }
    // Not vacuous: Finance has a non-lead ADMIN row (Omar) that must be pinned.
    expect(await facts.driveConsenters(f.drives.finance.id)).toContain(f.people.omar.id);
  });

  it('with orgs enabled, every drive\'s consenters are exactly the people driveRole makes OWNER/ADMIN: org Owner/Admin power counts, stale rows do not', async () => {
    const f = await northwind();
    flags.orgsEnabled = true;
    const facts = createAccountFactsRepository();

    for (const driveId of everyDrive(f)) {
      expect([...await facts.driveConsenters(driveId)], `consenters vs driveRole ${driveId}`).toEqual(await leads(f, driveId));
    }
    // The org Owner and an org Admin consent on an org drive they hold no row on...
    const product = await facts.driveConsenters(f.drives.product.id);
    expect(product).toEqual(expect.arrayContaining([f.people.jono.id, f.people.priya.id]));
    // ...and Kai's stale OWNER row on Product makes him no consenter (master's query ignored it
    // only because its role is OWNER, not ADMIN: the audience refuses it on principle).
    expect(product).not.toContain(f.people.kai.id);
    expect(await facts.driveRole({ driveId: f.drives.product.id, userId: f.people.kai.id })).not.toBe('OWNER');
  });

  it('a pending ADMIN invitation grants no role and no consent, orgs dark or enabled', async () => {
    const f = await northwind();
    const invitee = f.people.lu;
    await factories.createDriveMember(f.drives.finance.id, invitee.id, { source: 'invite', role: 'ADMIN', acceptedAt: null });
    const facts = createAccountFactsRepository();

    for (const enabled of [false, true]) {
      flags.orgsEnabled = enabled;
      expect(await facts.driveRole({ driveId: f.drives.finance.id, userId: invitee.id }), `driveRole orgs=${enabled}`).toBeNull();
      expect(await facts.driveConsenters(f.drives.finance.id), `consenters orgs=${enabled}`).not.toContain(invitee.id);
    }
    // Once accepted, the same row does both.
    await db.update(driveMembers).set({ acceptedAt: new Date() })
      .where(and(eq(driveMembers.driveId, f.drives.finance.id), eq(driveMembers.userId, invitee.id)));
    flags.orgsEnabled = false;
    expect(await facts.driveRole({ driveId: f.drives.finance.id, userId: invitee.id })).toBe('ADMIN');
    expect(await facts.driveConsenters(f.drives.finance.id)).toContain(invitee.id);
  });
});
