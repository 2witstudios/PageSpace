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
import { leaveOrganization } from '../leave';
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

  it('AUD-1 (partial) a refused re-join by a suppressed address leaves an org event the Owner can see, without the address', async () => {
    const w = await northwind();
    const { email } = await danaRemovedThenDeleted(w);
    audit.events.length = 0;
    const again = await person(email);
    expect(await autoJoinVerifiedDomainOrg({ userId: again.id, now: new Date() })).toEqual({ kind: 'skipped', reason: 'departure_suppressed' });
    const refused = audit.events.filter((e) => e.eventType === 'org.member.auto_join_refused');
    expect(refused).toEqual([expect.objectContaining({
      orgId: w.orgId,
      actorId: again.id,
      resourceType: 'user',
      resourceId: again.id,
      details: { domain: w.domain, reason: 'departure_suppressed' },
    })]);
    expect(JSON.stringify(refused)).not.toContain(email);
    expect(JSON.stringify(refused)).not.toContain('dana');
  });

  it('AUD-1 (partial) a removed member who kept the account and signs in again leaves the same event (previously departed); an ordinary skip leaves none', async () => {
    const w = await northwind();
    const dana = await danaRemoved(w);
    audit.events.length = 0;
    expect(await autoJoinVerifiedDomainOrg({ userId: dana.id, now: new Date() })).toEqual({ kind: 'skipped', reason: 'previously_departed' });
    expect(audit.events.filter((e) => e.eventType === 'org.member.auto_join_refused')).toEqual([
      expect.objectContaining({ orgId: w.orgId, resourceId: dana.id, details: { domain: w.domain, reason: 'previously_departed' } }),
    ]);

    audit.events.length = 0;
    const lena = await person(`lena@${w.domain}`);
    expect((await autoJoinVerifiedDomainOrg({ userId: lena.id, now: new Date() })).kind).toBe('joined');
    expect(await autoJoinVerifiedDomainOrg({ userId: lena.id, now: new Date() })).toEqual({ kind: 'skipped', reason: 'already_member' });
    expect(audit.events.filter((e) => e.eventType === 'org.member.auto_join_refused')).toEqual([]);
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

  /** Dana joins by the domain and is removed by Jono; she KEEPS her account. */
  async function danaRemoved(w: { orgId: string; jono: { id: string }; domain: string }) {
    const dana = await person(`dana@${w.domain}`);
    expect((await autoJoinVerifiedDomainOrg({ userId: dana.id, now: new Date() })).kind).toBe('joined');
    expect((await removeMember({ orgId: w.orgId, actorId: w.jono.id, targetId: dana.id })).ok).toBe(true);
    return dana;
  }

  it('SEC-1 (partial) case A: removed, account deleted, back as a +subaddress of the same mailbox: refused', async () => {
    const w = await northwind();
    await danaRemovedThenDeleted(w);
    const tagged = await person(`dana+pagespace@${w.domain}`);
    expect(await autoJoinVerifiedDomainOrg({ userId: tagged.id, now: new Date() })).toEqual({ kind: 'skipped', reason: 'departure_suppressed' });
  });

  it('SEC-1 (partial) case B: removed, KEEPS the account (refused as previously departed), opens a second account on the same mailbox: refused, written at departure', async () => {
    const w = await northwind();
    const dana = await danaRemoved(w);
    expect(await autoJoinVerifiedDomainOrg({ userId: dana.id, now: new Date() })).toEqual({ kind: 'skipped', reason: 'previously_departed' });
    // The suppression exists while the first account still does.
    expect(await db.select().from(orgDepartureSuppressions).where(eq(orgDepartureSuppressions.orgId, w.orgId))).toHaveLength(1);
    const second = await person(`dana+2@${w.domain}`);
    expect(await autoJoinVerifiedDomainOrg({ userId: second.id, now: new Date() })).toEqual({ kind: 'skipped', reason: 'departure_suppressed' });
  });

  it('SEC-1 (partial) a voluntary leaver is suppressed the same way', async () => {
    const w = await northwind();
    const dana = await person(`dana@${w.domain}`);
    expect((await autoJoinVerifiedDomainOrg({ userId: dana.id, now: new Date() })).kind).toBe('joined');
    expect((await leaveOrganization(dana.id, w.orgId)).ok).toBe(true);
    const second = await person(`dana+again@${w.domain}`);
    expect(await autoJoinVerifiedDomainOrg({ userId: second.id, now: new Date() })).toEqual({ kind: 'skipped', reason: 'departure_suppressed' });
  });

  it('SEC-1 (partial) a +subaddress in mixed case with surrounding whitespace is still refused; dana.x@ (dots are not folded) is admitted', async () => {
    const w = await northwind();
    await danaRemoved(w);
    const shouted = await person(`  Dana+X@${w.domain.toUpperCase()}  `);
    expect(await autoJoinVerifiedDomainOrg({ userId: shouted.id, now: new Date() })).toEqual({ kind: 'skipped', reason: 'departure_suppressed' });
    const dotted = await person(`dana.x@${w.domain}`);
    expect(await autoJoinVerifiedDomainOrg({ userId: dotted.id, now: new Date() })).toMatchObject({ kind: 'joined' });
  });

  it('SEC-1 (partial) the Admin clears with the plain address, and a +subaddress account is admitted after', async () => {
    const w = await northwind();
    await danaRemoved(w);
    expect(await clearDepartureSuppression({ orgId: w.orgId, email: `dana@${w.domain}`, actorId: w.jono.id })).toBe(true);
    const second = await person(`dana+2@${w.domain}`);
    expect(await autoJoinVerifiedDomainOrg({ userId: second.id, now: new Date() })).toMatchObject({ kind: 'joined' });
  });

  it('SEC-1 (partial) a suppression is org-scoped: when the domain moves to another org, it does not refuse a join there', async () => {
    const a = await northwind();
    await danaRemoved(a);
    // Org A gives the domain up; org B proves it.
    const [claimA] = await db.select().from(orgDomains).where(eq(orgDomains.orgId, a.orgId));
    await db.delete(orgDomains).where(eq(orgDomains.id, claimA.id));
    const b = await northwind();
    const claimB = await addOrgDomain({ orgId: b.orgId, domain: a.domain, actorId: b.jono.id });
    if (!claimB.ok) throw new Error(`claim: ${claimB.reason}`);
    const proof = async (name: string) => (name === dnsRecordName(a.domain) ? [[dnsRecordValue(claimB.domain.dnsToken)]] : []);
    expect((await verifyOrgDomainByDns({ orgId: b.orgId, domainId: claimB.domain.id, actorId: b.jono.id, now: new Date(), resolveTxt: proof })).ok).toBe(true);
    const second = await person(`dana+2@${a.domain}`);
    expect(await autoJoinVerifiedDomainOrg({ userId: second.id, now: new Date() })).toMatchObject({ kind: 'joined', orgId: b.orgId });
  });
});
