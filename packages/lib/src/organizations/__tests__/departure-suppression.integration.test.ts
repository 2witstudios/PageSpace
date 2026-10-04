/**
 * [D-OW-27] A departed member who deletes their account is not auto-joined back by a new account with the
 * same address (SEC-1): the org keeps only a keyed hash of the address, which survives the account's
 * deletion, holds nothing readable, and an org Admin can clear. Real Postgres, real account deletion.
 *
 * Every org, drive and user row is deleted (users last); the suppression rows go with the org.
 *
 * Run via:
 *   bun run --filter '@pagespace/lib' test:integration -- src/organizations/__tests__/departure-suppression.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { users } from '@pagespace/db/schema/auth';
import { orgDepartureSuppressions, orgDomains, orgMemberDepartures, orgMembers, orgSubscriptions, organizations } from '@pagespace/db/schema/organizations';
import { accountRepository } from '../../repositories/account-repository';
import { addOrgDomain, autoJoinVerifiedDomainOrg, verifyOrgDomainByDns } from '../domains';
import { dnsRecordName, dnsRecordValue } from '../domains-core';
import { removeMember } from '../membership';
import { clearDepartureSuppression } from '../departure-suppression';

vi.mock('../orgs-enabled', () => ({ ORGS_ENABLED: true }));

const audit = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));
vi.mock('../../audit/org-audit', () => ({
  recordOrgAuditEvent: vi.fn(async () => {}),
  recordOrgAuditEventAfterCommit: vi.fn(async (event: Record<string, unknown>) => {
    audit.events.push(event);
    return true;
  }),
}));

const created = { orgs: [] as string[], users: [] as string[] };

async function person(email: string) {
  const user = await factories.createUser({ email, emailVerified: new Date(), createdAt: new Date(), subscriptionTier: 'free' });
  created.users.push(user.id);
  return user;
}

/** Northwind with a verified domain and room for members. */
async function northwind() {
  const jono = await person(`jono-${createId()}@owner.test`);
  const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: jono.id }).returning();
  created.orgs.push(org.id);
  await db.insert(orgMembers).values({ orgId: org.id, userId: jono.id, role: 'OWNER' });
  await db.insert(orgSubscriptions).values({
    orgId: org.id, stripeSubscriptionId: `sub_${createId()}`, stripeBasePriceId: 'price_base_test', stripeBaseItemId: `si_${createId()}`,
    stripeSeatPriceId: 'price_seat_test', stripeSeatItemId: `si_${createId()}`, status: 'active',
    currentPeriodStart: new Date(Date.now() - 86_400_000), currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
  });
  const domain = `northwind-${createId()}.com`;
  const claim = await addOrgDomain({ orgId: org.id, domain, actorId: jono.id });
  if (!claim.ok) throw new Error('domain');
  const proof = async (name: string) => (name === dnsRecordName(domain) ? [[dnsRecordValue(claim.domain.dnsToken)]] : []);
  expect((await verifyOrgDomainByDns({ orgId: org.id, domainId: claim.domain.id, actorId: jono.id, now: new Date(), resolveTxt: proof })).ok).toBe(true);
  return { orgId: org.id, jono, domain };
}

/** Dana joins by the domain, is removed by Jono, then deletes her account. */
async function danaRemovedThenDeleted(w: { orgId: string; jono: { id: string }; domain: string }) {
  const email = `dana@${w.domain}`;
  const dana = await person(email);
  expect((await autoJoinVerifiedDomainOrg({ userId: dana.id, now: new Date() })).kind).toBe('joined');
  expect((await removeMember({ orgId: w.orgId, actorId: w.jono.id, targetId: dana.id })).ok).toBe(true);
  await accountRepository.deleteUser(dana.id);
  return { email, danaId: dana.id };
}

describe('[D-OW-27] departed members stay suppressed after deleting their account', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: orgDepartureSuppressions.id }).from(orgDepartureSuppressions).limit(1);
    } catch (error) {
      requireDb('departure-suppression.integration.test.ts', error);
    }
  });

  afterEach(async () => {
    audit.events.length = 0;
    const orgIds = created.orgs.splice(0);
    if (orgIds.length > 0) {
      await db.delete(orgDepartureSuppressions).where(inArray(orgDepartureSuppressions.orgId, orgIds));
      await db.delete(orgDomains).where(inArray(orgDomains.orgId, orgIds));
      await db.delete(orgMemberDepartures).where(inArray(orgMemberDepartures.orgId, orgIds));
      await db.delete(orgMembers).where(inArray(orgMembers.orgId, orgIds));
      await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, orgIds));
      await db.delete(organizations).where(inArray(organizations.id, orgIds));
    }
    const userIds = created.users.splice(0);
    if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds));
  });

  it('SEC-1 (partial) removed, then the account deleted: deletion succeeds, the departure record goes with the user, the keyed suppression survives it, and holds nothing readable', async () => {
    const w = await northwind();
    const { email, danaId } = await danaRemovedThenDeleted(w);
    expect(await db.select().from(users).where(eq(users.id, danaId))).toEqual([]);
    expect(await db.select().from(orgMemberDepartures).where(eq(orgMemberDepartures.userId, danaId))).toEqual([]);
    const rows = await db.select().from(orgDepartureSuppressions).where(eq(orgDepartureSuppressions.orgId, w.orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0].emailHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows[0])).not.toContain('dana');
    expect(JSON.stringify(rows[0])).not.toContain(email);
  });

  it('SEC-1 (partial) a new account with the same address is refused auto-join, whatever its case or surrounding whitespace', async () => {
    const w = await northwind();
    const { email } = await danaRemovedThenDeleted(w);
    const again = await person(email);
    expect(await autoJoinVerifiedDomainOrg({ userId: again.id, now: new Date() })).toEqual({ kind: 'skipped', reason: 'departure_suppressed' });
    await db.delete(users).where(eq(users.id, again.id));
    const shouted = await person(`  DANA@${w.domain.toUpperCase()}  `);
    expect(await autoJoinVerifiedDomainOrg({ userId: shouted.id, now: new Date() })).toEqual({ kind: 'skipped', reason: 'departure_suppressed' });
    expect(await db.select().from(orgMembers).where(eq(orgMembers.userId, shouted.id))).toEqual([]);
  });

  it('SEC-1 (partial) a different person on the domain is admitted', async () => {
    const w = await northwind();
    await danaRemovedThenDeleted(w);
    const lena = await person(`lena@${w.domain}`);
    expect(await autoJoinVerifiedDomainOrg({ userId: lena.id, now: new Date() })).toMatchObject({ kind: 'joined' });
  });

  it('SEC-1 (partial) an org Admin clears the suppression by typing the address, audited without it; the address is then admitted', async () => {
    const w = await northwind();
    const { email } = await danaRemovedThenDeleted(w);
    expect(await clearDepartureSuppression({ orgId: w.orgId, email: `someone-else@${w.domain}`, actorId: w.jono.id })).toBe(false);
    expect(await clearDepartureSuppression({ orgId: w.orgId, email: ` ${email.toUpperCase()} `, actorId: w.jono.id })).toBe(true);
    const cleared = audit.events.find((e) => e.eventType === 'org.member.suppression_cleared');
    expect(cleared).toMatchObject({ orgId: w.orgId, actorId: w.jono.id, resourceType: 'org_departure_suppression' });
    expect(JSON.stringify(cleared)).not.toContain('dana');
    const back = await person(email);
    expect(await autoJoinVerifiedDomainOrg({ userId: back.id, now: new Date() })).toMatchObject({ kind: 'joined' });
  });

  it('SEC-1 (partial) a suppression belongs to the org the person left: another org cannot clear it', async () => {
    const w = await northwind();
    const other = await northwind();
    const { email } = await danaRemovedThenDeleted(w);
    expect(await clearDepartureSuppression({ orgId: other.orgId, email, actorId: other.jono.id })).toBe(false);
    expect(await db.select().from(orgDepartureSuppressions).where(eq(orgDepartureSuppressions.orgId, w.orgId))).toHaveLength(1);
  });
});
