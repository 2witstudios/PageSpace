/**
 * The account authority's membership facts against real Postgres and the Northwind org fixture.
 *
 * Master's agent-account permissions (decideAccountCreatePermission, decideAccountListView,
 * authorize) are pure; the org-aware answers they decide on come from AccountFactsRepository.
 * driveRole reads getDriveAccess and driveConsenters reads the drive audience, both in the
 * permissions layer. What only a database proves is that those two agree with each other and
 * with master's guarantees, for every membership shape the org resolvers tell apart:
 *   - a pending invitation grants nothing: no role, no consent;
 *   - a stale org row or a stale OWNER row makes nobody an admin.
 *
 * Run via:
 *   bun run --filter '@pagespace/lib' test:integration -- src/agent-accounts/__tests__/account-facts-repository.integration.test.ts
 */
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { db, pool } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import { factories } from '@pagespace/db/test/factories';
import { createAccountFactsRepository } from '../account-facts-repository';
import { cleanupNorthwind, northwind, type Fixture } from '../../permissions/__tests__/fixtures/northwind-org-drives';
import { credentialActor } from '../../permissions/access-actor';


const everyone = (f: Fixture) => Object.values(f.people).map((u) => u.id);
const everyDrive = (f: Fixture) => Object.values(f.drives).map((d) => d.id);

/** The people driveRole makes OWNER or ADMIN of a drive: who the authority lets create its accounts. */
async function leads(f: Fixture, driveId: string): Promise<string[]> {
  const facts = createAccountFactsRepository();
  const out: string[] = [];
  for (const userId of everyone(f)) {
    const role = await facts.driveRole({ driveId, actor: credentialActor(userId, null) });
    if (role === 'OWNER' || role === 'ADMIN') out.push(userId);
  }
  return out.sort();
}

describe('AccountFactsRepository on the org-aware permission path (integration)', () => {
  afterEach(async () => {
    await cleanupNorthwind();
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  it('every drive\'s consenters are exactly the people driveRole makes OWNER/ADMIN: org Owner/Admin power counts, stale rows do not', async () => {
    const f = await northwind();
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
    expect(await facts.driveRole({ driveId: f.drives.product.id, actor: credentialActor(f.people.kai.id, null) })).not.toBe('OWNER');
  });

  it('a pending ADMIN invitation grants no role and no consent', async () => {
    const f = await northwind();
    const invitee = f.people.lu;
    await factories.createDriveMember(f.drives.finance.id, invitee.id, { source: 'invite', role: 'ADMIN', acceptedAt: null });
    const facts = createAccountFactsRepository();

    expect(await facts.driveRole({ driveId: f.drives.finance.id, actor: credentialActor(invitee.id, null) })).toBeNull();
    expect(await facts.driveConsenters(f.drives.finance.id)).not.toContain(invitee.id);
    // Once accepted, the same row does both.
    await db.update(driveMembers).set({ acceptedAt: new Date() })
      .where(and(eq(driveMembers.driveId, f.drives.finance.id), eq(driveMembers.userId, invitee.id)));
    expect(await facts.driveRole({ driveId: f.drives.finance.id, actor: credentialActor(invitee.id, null) })).toBe('ADMIN');
    expect(await facts.driveConsenters(f.drives.finance.id)).toContain(invitee.id);
  });
});
