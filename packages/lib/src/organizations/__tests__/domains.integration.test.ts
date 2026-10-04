/**
 * Verified email domains and auto-join against a REAL Postgres (Spec SEC-1): claiming and proving a
 * domain (DNS through a fake resolver, email through a captured link), two orgs racing for one domain,
 * auto-join that takes a seat under the billing lock and opens Open drives only, and every case that
 * must NOT join.
 *
 * Every row a test creates is deleted in dependency order (drive rows, drives, domain rows, invites,
 * members, subscription, org, users last). The pool is ended by the integration teardown hook.
 *
 * Run via:
 *   bun run --filter '@pagespace/lib' test:integration -- src/organizations/__tests__/domains.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import { orgGuestHolds } from '@pagespace/db/schema/org-guest-holds';
import {
  organizations,
  orgDomainJoins,
  orgDomains,
  orgInvitations,
  orgMembers,
  orgSubscriptions,
} from '@pagespace/db/schema/organizations';
import {
  addOrgDomain,
  autoJoinVerifiedDomainOrg,
  confirmDomainProofEmail,
  listOrgDomains,
  removeOrgDomain,
  sendDomainProofEmail,
  verifyOrgDomainByDns,
  type TxtResolver,
} from '../domains';
import { dnsRecordName, dnsRecordValue } from '../domains-core';
import { removeMember } from '../membership';
import { countOrgSeats } from '../repository';
import type { SeatBillingPort } from '../seat-service';

vi.mock('../orgs-enabled', () => ({ ORGS_ENABLED: true }));

const audit = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));
vi.mock('../../audit/org-audit', () => ({
  recordOrgAuditEventAfterCommit: async (event: Record<string, unknown>) => {
    audit.events.push(event);
    return true;
  },
}));

const HOUR = 3_600_000;
const created = { orgs: [] as string[], users: [] as string[] };

class RecordingSeatStripe implements SeatBillingPort {
  calls: Array<{ quantity: number }> = [];
  async setSeatQuantity(params: { itemId: string; quantity: number }) {
    this.calls.push({ quantity: params.quantity });
    return { quantity: params.quantity };
  }
  async readSeatQuantity() {
    return 0;
  }
}

/** A DNS answer that publishes `tokens` at `domain`'s verification name and nothing anywhere else. */
const dnsWith = (domain: string, ...tokens: string[]): TxtResolver => async (name) =>
  name === dnsRecordName(domain) ? tokens.map((t) => [dnsRecordValue(t)]) : [];

const freshDomain = () => `northwind-${createId()}.com`;

async function person(email: string, opts: { verified?: boolean; createdAt?: Date } = {}) {
  const user = await factories.createUser({
    email,
    emailVerified: opts.verified === false ? null : new Date(),
    createdAt: opts.createdAt ?? new Date(),
    subscriptionTier: 'free',
  });
  created.users.push(user.id);
  return user;
}

/** Northwind Labs: Jono owns it; Product is Open, Customer Research Restricted, Finance Private. */
async function northwind(input: { members?: number; autoAdd?: boolean } = {}) {
  const jono = await person(`jono-${createId()}@owner.test`);
  const [org] = await db
    .insert(organizations)
    .values({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: jono.id, seatAutoAdd: input.autoAdd ?? false })
    .returning();
  created.orgs.push(org.id);
  await db.insert(orgMembers).values({ orgId: org.id, userId: jono.id, role: 'OWNER' });
  const extras = Math.max(0, (input.members ?? 1) - 1);
  for (let i = 0; i < extras; i++) {
    const m = await person(`member-${i}-${createId()}@elsewhere.test`);
    await db.insert(orgMembers).values({ orgId: org.id, userId: m.id, role: 'MEMBER' });
  }
  await db.insert(orgSubscriptions).values({
    orgId: org.id,
    stripeSubscriptionId: `sub_${createId()}`,
    stripeBasePriceId: 'price_base_test',
    stripeBaseItemId: `si_${createId()}`,
    stripeSeatPriceId: 'price_seat_test',
    stripeSeatItemId: `si_${createId()}`,
    extraSeatQuantity: 0,
    status: 'active',
    currentPeriodStart: new Date(Date.now() - 20 * 24 * HOUR),
    currentPeriodEnd: new Date(Date.now() + 10 * 24 * HOUR),
  });
  const product = await factories.createDrive(jono.id, { name: 'Product', slug: `product-${createId()}`, orgId: org.id, orgVisibility: 'OPEN' });
  const research = await factories.createDrive(jono.id, { name: 'Customer Research', slug: `research-${createId()}`, orgId: org.id, orgVisibility: 'RESTRICTED' });
  const finance = await factories.createDrive(jono.id, { name: 'Finance', slug: `finance-${createId()}`, orgId: org.id, orgVisibility: 'PRIVATE' });
  return { org, jono, product, research, finance };
}

/** Claim and DNS-verify `domain` for `orgId`. */
async function verifiedDomain(orgId: string, actorId: string, domain = freshDomain()) {
  const added = await addOrgDomain({ orgId, domain, actorId });
  if (!added.ok) throw new Error(`add failed: ${added.reason}`);
  const verified = await verifyOrgDomainByDns({
    orgId,
    domainId: added.domain.id,
    actorId,
    now: new Date(),
    resolveTxt: dnsWith(domain, added.domain.dnsToken),
  });
  if (!verified.ok) throw new Error(`verify failed: ${verified.reason}`);
  return verified.domain;
}

const membership = async (orgId: string, userId: string) =>
  (await db.select({ role: orgMembers.role }).from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId))))[0] ?? null;

const driveRowsOf = async (userId: string) =>
  (await db.select({ driveId: driveMembers.driveId }).from(driveMembers).where(eq(driveMembers.userId, userId))).map((r) => r.driveId);

async function teardownAll(): Promise<void> {
  const orgIds = created.orgs.splice(0);
  const userIds = created.users.splice(0);
  if (orgIds.length > 0) {
    const driveIds = (await db.select({ id: drives.id }).from(drives).where(inArray(drives.orgId, orgIds))).map((d) => d.id);
    if (driveIds.length > 0) {
      await db.delete(orgGuestHolds).where(inArray(orgGuestHolds.driveId, driveIds));
      await db.delete(driveMembers).where(inArray(driveMembers.driveId, driveIds));
      await db.delete(pages).where(inArray(pages.driveId, driveIds));
      await db.delete(drives).where(inArray(drives.id, driveIds));
    }
    await db.delete(orgDomainJoins).where(inArray(orgDomainJoins.orgId, orgIds));
    await db.delete(orgDomains).where(inArray(orgDomains.orgId, orgIds));
    await db.delete(orgInvitations).where(inArray(orgInvitations.orgId, orgIds));
    await db.delete(orgMembers).where(inArray(orgMembers.orgId, orgIds));
    await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, orgIds));
    await db.delete(organizations).where(inArray(organizations.id, orgIds));
  }
  if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds));
}

describe('verified email domains (real Postgres)', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: orgDomains.id }).from(orgDomains).limit(1);
    } catch (error) {
      requireDb('domains.integration.test.ts', error);
    }
  });

  afterEach(async () => {
    audit.events.length = 0;
    await teardownAll();
  });

  describe('proving control', () => {
    it('SEC-1 (partial) DNS: the claim\'s own TXT record verifies it; a missing record or another token does not', async () => {
      const { org, jono } = await northwind();
      const domain = freshDomain();
      const added = await addOrgDomain({ orgId: org.id, domain: domain.toUpperCase(), actorId: jono.id });
      expect(added.ok && added.domain.domain).toBe(domain);
      if (!added.ok) return;

      const none = await verifyOrgDomainByDns({ orgId: org.id, domainId: added.domain.id, actorId: jono.id, now: new Date(), resolveTxt: dnsWith(domain) });
      expect(none).toEqual({ ok: false, status: 422, reason: 'proof_not_found' });
      const wrong = await verifyOrgDomainByDns({ orgId: org.id, domainId: added.domain.id, actorId: jono.id, now: new Date(), resolveTxt: dnsWith(domain, 'someone-elses-token') });
      expect(wrong).toEqual({ ok: false, status: 422, reason: 'proof_not_found' });
      expect((await listOrgDomains(org.id))[0].verifiedAt).toBeNull();

      const ok = await verifyOrgDomainByDns({ orgId: org.id, domainId: added.domain.id, actorId: jono.id, now: new Date(), resolveTxt: dnsWith(domain, added.domain.dnsToken) });
      expect(ok.ok && ok.domain.verifiedMethod).toBe('dns');
      expect(audit.events.map((e) => e.eventType)).toEqual(['org.domain.added', 'org.domain.verified']);
      expect(audit.events[1]).toMatchObject({ orgId: org.id, actorId: jono.id, details: { domain, method: 'dns' } });
    });

    it('SEC-1 (partial) email: only an administrative mailbox receives the one-use link, which verifies once and then expires', async () => {
      const { org, jono } = await northwind();
      const domain = freshDomain();
      const added = await addOrgDomain({ orgId: org.id, domain, actorId: jono.id });
      if (!added.ok) throw new Error('add failed');
      const sent: Array<{ to: string; token: string }> = [];
      const result = await sendDomainProofEmail({
        orgId: org.id, domainId: added.domain.id, mailbox: 'postmaster', actorId: jono.id, now: new Date(),
        deliver: async ({ to, token }) => { sent.push({ to, token }); },
      });
      expect(result.ok && result.sentTo).toBe(`postmaster@${domain}`);
      expect(sent).toHaveLength(1);
      // The stored row never carries the raw token.
      const [row] = await db.select().from(orgDomains).where(eq(orgDomains.id, added.domain.id));
      expect(row.emailTokenHash).not.toBe(sent[0].token);
      expect(await listOrgDomains(org.id)).not.toContainEqual(expect.objectContaining({ emailTokenHash: expect.anything() }));

      expect(await confirmDomainProofEmail({ token: 'ps_orgdom_forged', actorId: jono.id, now: new Date() })).toEqual({ ok: false, status: 404, reason: 'not_found' });
      const later = new Date(Date.now() + 49 * HOUR);
      expect(await confirmDomainProofEmail({ token: sent[0].token, actorId: jono.id, now: later })).toEqual({ ok: false, status: 422, reason: 'link_expired' });

      const confirmed = await confirmDomainProofEmail({ token: sent[0].token, actorId: jono.id, now: new Date() });
      expect(confirmed.ok && confirmed.domain.verifiedMethod).toBe('email');
      // One use: the token is gone.
      expect(await confirmDomainProofEmail({ token: sent[0].token, actorId: jono.id, now: new Date() })).toEqual({ ok: false, status: 404, reason: 'not_found' });
    });

    it('SEC-1 (partial) a failed delivery withdraws the link it stored', async () => {
      const { org, jono } = await northwind();
      const added = await addOrgDomain({ orgId: org.id, domain: freshDomain(), actorId: jono.id });
      if (!added.ok) throw new Error('add failed');
      const result = await sendDomainProofEmail({
        orgId: org.id, domainId: added.domain.id, mailbox: 'admin', actorId: jono.id, now: new Date(),
        deliver: async () => { throw new Error('smtp down'); },
      });
      expect(result.ok).toBe(false);
      const [row] = await db.select().from(orgDomains).where(eq(orgDomains.id, added.domain.id));
      expect(row.emailTokenHash).toBeNull();
    });

    it('SEC-1 (partial) a shared mailbox provider can never be claimed', async () => {
      const { org, jono } = await northwind();
      expect(await addOrgDomain({ orgId: org.id, domain: 'gmail.com', actorId: jono.id })).toEqual({ ok: false, status: 400, reason: 'public_email_domain' });
    });

    it('SEC-1 (partial) an org cannot verify a claim that belongs to another org by guessing its id', async () => {
      const a = await northwind();
      const b = await northwind();
      const domain = freshDomain();
      const added = await addOrgDomain({ orgId: a.org.id, domain, actorId: a.jono.id });
      if (!added.ok) throw new Error('add failed');
      expect(await verifyOrgDomainByDns({ orgId: b.org.id, domainId: added.domain.id, actorId: b.jono.id, now: new Date(), resolveTxt: dnsWith(domain, added.domain.dnsToken) }))
        .toEqual({ ok: false, status: 404, reason: 'not_found' });
      expect(await removeOrgDomain({ orgId: b.org.id, domainId: added.domain.id, actorId: b.jono.id })).toBe(false);
    });
  });

  describe('two orgs, one domain', () => {
    it('SEC-1 (partial) the first proof holds the domain; the second org is refused even with its own valid proof, and cannot newly claim it', async () => {
      const a = await northwind();
      const b = await northwind();
      const domain = freshDomain();
      const claimA = await addOrgDomain({ orgId: a.org.id, domain, actorId: a.jono.id });
      const claimB = await addOrgDomain({ orgId: b.org.id, domain, actorId: b.jono.id });
      if (!claimA.ok || !claimB.ok) throw new Error('both pending claims should be allowed');
      const both = dnsWith(domain, claimA.domain.dnsToken, claimB.domain.dnsToken);

      expect((await verifyOrgDomainByDns({ orgId: a.org.id, domainId: claimA.domain.id, actorId: a.jono.id, now: new Date(), resolveTxt: both })).ok).toBe(true);
      expect(await verifyOrgDomainByDns({ orgId: b.org.id, domainId: claimB.domain.id, actorId: b.jono.id, now: new Date(), resolveTxt: both }))
        .toEqual({ ok: false, status: 409, reason: 'claimed_by_another_org' });
      const c = await northwind();
      expect(await addOrgDomain({ orgId: c.org.id, domain, actorId: c.jono.id })).toEqual({ ok: false, status: 409, reason: 'claimed_by_another_org' });
      // And no mailed proof can be started on B's claim either.
      expect(await sendDomainProofEmail({ orgId: b.org.id, domainId: claimB.domain.id, mailbox: 'admin', actorId: b.jono.id, now: new Date(), deliver: async () => {} }))
        .toEqual({ ok: false, status: 409, reason: 'claimed_by_another_org' });
    });

    it('SEC-1 (partial) two orgs proving at the same moment: exactly one holds the domain', async () => {
      const a = await northwind();
      const b = await northwind();
      const domain = freshDomain();
      const claimA = await addOrgDomain({ orgId: a.org.id, domain, actorId: a.jono.id });
      const claimB = await addOrgDomain({ orgId: b.org.id, domain, actorId: b.jono.id });
      if (!claimA.ok || !claimB.ok) throw new Error('add failed');
      const both = dnsWith(domain, claimA.domain.dnsToken, claimB.domain.dnsToken);
      const results = await Promise.all([
        verifyOrgDomainByDns({ orgId: a.org.id, domainId: claimA.domain.id, actorId: a.jono.id, now: new Date(), resolveTxt: both }),
        verifyOrgDomainByDns({ orgId: b.org.id, domainId: claimB.domain.id, actorId: b.jono.id, now: new Date(), resolveTxt: both }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, status: 409, reason: 'claimed_by_another_org' }]);
      const verifiedRows = await db.select().from(orgDomains).where(eq(orgDomains.domain, domain));
      expect(verifiedRows.filter((r) => r.verifiedAt !== null)).toHaveLength(1);
    });
  });

  describe('auto-join', () => {
    it('SEC-1 (partial) an unverified domain never auto-joins', async () => {
      const { org, jono } = await northwind();
      const domain = freshDomain();
      await addOrgDomain({ orgId: org.id, domain, actorId: jono.id });
      const lena = await person(`lena@${domain}`);
      expect(await autoJoinVerifiedDomainOrg({ userId: lena.id, now: new Date() })).toEqual({ kind: 'skipped', reason: 'no_verified_domain' });
      expect(await membership(org.id, lena.id)).toBeNull();
    });

    it('SEC-1 (partial) a verified domain joins a new signup as MEMBER, reserves a seat, and opens Open drives only — never Restricted or Private', async () => {
      const { org, jono, product, research, finance } = await northwind();
      const { domain } = await verifiedDomain(org.id, jono.id);
      const seatsBefore = await countOrgSeats(org.id);
      const lena = await person(`Lena.Schulz@${domain.toUpperCase()}`);

      const result = await autoJoinVerifiedDomainOrg({ userId: lena.id, now: new Date() });
      expect(result).toEqual({ kind: 'joined', orgId: org.id, seatRaised: false });
      expect(await membership(org.id, lena.id)).toEqual({ role: 'MEMBER' });
      expect(await countOrgSeats(org.id)).toBe(seatsBefore + 1);
      const rows = await driveRowsOf(lena.id);
      expect(rows).toContain(product.id);
      expect(rows).not.toContain(research.id);
      expect(rows).not.toContain(finance.id);
      expect(audit.events[audit.events.length - 1]).toMatchObject({ orgId: org.id, eventType: 'org.member.auto_joined', actorId: lena.id, details: { domain, role: 'MEMBER' } });

      // Idempotent: a second sign-in changes nothing.
      expect(await autoJoinVerifiedDomainOrg({ userId: lena.id, now: new Date() })).toEqual({ kind: 'skipped', reason: 'already_member' });
      expect(await countOrgSeats(org.id)).toBe(seatsBefore + 1);
    });

    it('SEC-1 (partial) a full org with automatic seat purchase off refuses cleanly with the SEAT-4 message: no member, no seat, an audit row', async () => {
      const { org, jono } = await northwind({ members: 5 });
      const { domain } = await verifiedDomain(org.id, jono.id);
      const marcus = await person(`marcus@${domain}`);
      const result = await autoJoinVerifiedDomainOrg({ userId: marcus.id, now: new Date() });
      expect(result).toMatchObject({ kind: 'refused', orgId: org.id, reason: 'seats_full' });
      expect(result.kind === 'refused' && result.reason === 'seats_full' && result.message).toMatch(/All 5 seats in this organization are taken/);
      expect(await membership(org.id, marcus.id)).toBeNull();
      expect(await countOrgSeats(org.id)).toBe(5);
      expect(await db.select().from(orgDomainJoins).where(eq(orgDomainJoins.userId, marcus.id))).toEqual([]);
      expect(audit.events[audit.events.length - 1]).toMatchObject({ orgId: org.id, eventType: 'org.member.auto_join_refused', details: { reason: 'seats_full' } });

      // A later sign-in after a seat frees joins: a refusal is not remembered as a join.
      const [someone] = await db.select({ userId: orgMembers.userId }).from(orgMembers).where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.role, 'MEMBER'))).limit(1);
      await db.delete(orgMembers).where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, someone.userId)));
      expect((await autoJoinVerifiedDomainOrg({ userId: marcus.id, now: new Date() })).kind).toBe('joined');
    });

    it('SEC-1 (partial) a full org with automatic seat purchase on raises the extra-seat quantity and joins', async () => {
      const { org, jono } = await northwind({ members: 5, autoAdd: true });
      const { domain } = await verifiedDomain(org.id, jono.id);
      const tomas = await person(`tomas@${domain}`);
      const stripe = new RecordingSeatStripe();
      expect(await autoJoinVerifiedDomainOrg({ userId: tomas.id, now: new Date(), seatBilling: stripe })).toEqual({ kind: 'joined', orgId: org.id, seatRaised: true });
      expect(stripe.calls).toEqual([{ quantity: 1 }]);
      const [sub] = await db.select().from(orgSubscriptions).where(eq(orgSubscriptions.orgId, org.id));
      expect(sub.extraSeatQuantity).toBe(1);
    });

    it('SEC-1 (partial) an unverified address, an account older than the verification, and an address on a subdomain never join', async () => {
      const { org, jono } = await northwind();
      const unverified = await person(`u-${createId()}@pending.test`, { verified: false });
      const old = await person(`old-${createId()}@pending.test`, { createdAt: new Date(Date.now() - 24 * HOUR) });
      const { domain } = await verifiedDomain(org.id, jono.id);
      await db.update(users).set({ email: `u@${domain}` }).where(eq(users.id, unverified.id));
      await db.update(users).set({ email: `old@${domain}` }).where(eq(users.id, old.id));
      const sub = await person(`eng@eng.${domain}`);

      expect(await autoJoinVerifiedDomainOrg({ userId: unverified.id, now: new Date() })).toEqual({ kind: 'skipped', reason: 'email_not_verified' });
      expect(await autoJoinVerifiedDomainOrg({ userId: old.id, now: new Date() })).toEqual({ kind: 'skipped', reason: 'account_predates_verification' });
      expect(await autoJoinVerifiedDomainOrg({ userId: sub.id, now: new Date() })).toEqual({ kind: 'skipped', reason: 'no_verified_domain' });
      for (const u of [unverified, old, sub]) expect(await membership(org.id, u.id)).toBeNull();
    });

    it('SEC-1 (partial) a guest of the org (D-OW-24) is never auto-joined as a member', async () => {
      const { org, jono, finance, research } = await northwind();
      const { domain } = await verifiedDomain(org.id, jono.id);
      const chris = await person(`chris@${domain}`);
      await factories.createDriveMember(finance.id, chris.id, { source: 'invite', role: 'GUEST' });
      expect(await autoJoinVerifiedDomainOrg({ userId: chris.id, now: new Date() })).toEqual({ kind: 'skipped', reason: 'org_guest' });
      expect(await membership(org.id, chris.id)).toBeNull();

      // A parked or pending guest hold counts too.
      const aisha = await person(`aisha@${domain}`);
      await db.insert(orgGuestHolds).values({ orgId: org.id, driveId: research.id, userId: aisha.id, state: 'pending_approval', origin: 'invite' });
      expect(await autoJoinVerifiedDomainOrg({ userId: aisha.id, now: new Date() })).toEqual({ kind: 'skipped', reason: 'org_guest' });
    });

    it('SEC-1 (partial) an open invite is left to the inviter\'s chosen role and holds the only seat', async () => {
      const { org, jono } = await northwind();
      const { domain } = await verifiedDomain(org.id, jono.id);
      const dana = await person(`dana@${domain}`);
      await db.insert(orgInvitations).values({ orgId: org.id, email: `DANA@${domain}`, role: 'ADMIN', tokenHash: `hash-${createId()}`, invitedBy: jono.id, expiresAt: new Date(Date.now() + 24 * HOUR) });
      const seats = await countOrgSeats(org.id);
      expect(await autoJoinVerifiedDomainOrg({ userId: dana.id, now: new Date() })).toEqual({ kind: 'skipped', reason: 'invited' });
      expect(await countOrgSeats(org.id)).toBe(seats);
    });

    it('SEC-1 (partial) un-verifying stops future joins and removes nobody; a removed member is never re-added by signing in', async () => {
      const { org, jono } = await northwind();
      const claim = await verifiedDomain(org.id, jono.id);
      const lena = await person(`lena@${claim.domain}`);
      expect((await autoJoinVerifiedDomainOrg({ userId: lena.id, now: new Date() })).kind).toBe('joined');

      expect(await removeOrgDomain({ orgId: org.id, domainId: claim.id, actorId: jono.id })).toBe(true);
      expect(await membership(org.id, lena.id)).toEqual({ role: 'MEMBER' });
      expect(audit.events[audit.events.length - 1]).toMatchObject({ eventType: 'org.domain.removed', details: { domain: claim.domain, wasVerified: true } });
      const marcus = await person(`marcus@${claim.domain}`);
      expect(await autoJoinVerifiedDomainOrg({ userId: marcus.id, now: new Date() })).toEqual({ kind: 'skipped', reason: 'no_verified_domain' });

      // Re-verified later, Lena (removed meanwhile) is still not swept back in.
      await removeMember({ orgId: org.id, actorId: jono.id, targetId: lena.id });
      const again = await verifiedDomain(org.id, jono.id, claim.domain);
      const reSignIn = await autoJoinVerifiedDomainOrg({ userId: lena.id, now: new Date() });
      expect(reSignIn.kind).toBe('skipped');
      expect(await membership(org.id, lena.id)).toBeNull();
      expect(again.verifiedAt).not.toBeNull();
    });

    it('SEC-1 (partial) a lapsed org admits nobody', async () => {
      const { org, jono } = await northwind();
      const { domain } = await verifiedDomain(org.id, jono.id);
      await db.update(orgSubscriptions).set({ status: 'canceled' }).where(eq(orgSubscriptions.orgId, org.id));
      const eve = await person(`eve@${domain}`);
      expect(await autoJoinVerifiedDomainOrg({ userId: eve.id, now: new Date() })).toEqual({ kind: 'refused', orgId: org.id, reason: 'org_lapsed' });
      expect(await membership(org.id, eve.id)).toBeNull();
    });
  });
});
