/**
 * Seat accounting against a REAL Postgres (Spec SEAT-3, SEAT-4, SEAT-5): admission under the
 * org's billing lock with genuinely concurrent callers on separate connections, the Stripe
 * extra-seat quantity through a recording fake that replays on a repeated idempotency key,
 * period-end release, and the guarantee that none of it moves a credit.
 *
 * Every row a test creates is deleted in dependency order (legs and wallets, invites, members,
 * subscription, drives, org, users last). The pool is ended by the integration teardown hook.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray, sql } from '@pagespace/db/operators';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveAgentMembers, driveMembers } from '@pagespace/db/schema/members';
import { pageShareLinks } from '@pagespace/db/schema/share-links';
import { organizations, orgInvitations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { wallets, walletFundingLegs } from '@pagespace/db/schema/wallets';
import { creditLedger } from '@pagespace/db/schema/credits';
import { expectWalletLegInvariant } from '../../test/wallet-leg-invariant';
import { EnforcedAuthContext } from '../../permissions/enforced-context';
import { createPageShareLink, redeemPageShareLink } from '../../permissions/share-link-service';
import { acceptInvitation, createOrRotateInvitation, resendInvitation } from '../invitations';
import { removeMember } from '../membership';
import { countOrgSeats } from '../repository';
import { getSeatSummary, releaseDueSeats, releaseOrgSeats, setSeatAutoAdd, type SeatBillingPort } from '../seat-service';
import { SEAT_RELEASE_LEAD_MS } from '../seats';

vi.mock('../orgs-enabled', () => ({ ORGS_ENABLED: true }));

const HOUR = 3_600_000;
const deliver = async () => {};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stripe's seat item as a recording fake: a repeated idempotency key replays the first answer. */
class RecordingSeatStripe implements SeatBillingPort {
  calls: Array<{ itemId: string; quantity: number; prorationBehavior: string; key: string }> = [];
  quantities = new Map<string, number>();
  private replies = new Map<string, number>();
  failNext = false;
  /** Fail AFTER Stripe applied the change: the response is lost. */
  loseResponseNext = false;
  constructor(private readonly latencyMs = 40) {}

  async setSeatQuantity(params: { itemId: string; quantity: number; prorationBehavior: 'create_prorations' | 'none' }, key: string) {
    await sleep(this.latencyMs);
    this.calls.push({ itemId: params.itemId, quantity: params.quantity, prorationBehavior: params.prorationBehavior, key });
    const replay = this.replies.get(key);
    if (replay !== undefined) return { quantity: replay };
    if (this.failNext) {
      this.failNext = false;
      throw new Error('stripe unreachable');
    }
    this.quantities.set(params.itemId, params.quantity);
    this.replies.set(key, params.quantity);
    if (this.loseResponseNext) {
      this.loseResponseNext = false;
      throw new Error('response lost');
    }
    return { quantity: params.quantity };
  }

  async readSeatQuantity(itemId: string) {
    return this.quantities.get(itemId) ?? 0;
  }
}

interface Fixture {
  orgId: string;
  ownerId: string;
  memberIds: string[];
  itemId: string;
  poolId: string;
  /** The drive wallet under the pool: the wallet whose funding legs the invariant covers. */
  driveWalletId: string;
  driveId: string;
  pageId: string;
}

const created = { orgs: [] as string[], users: [] as string[] };

/** An org with `members` accepted members (the Owner is the first), a subscription row and a funded pool. */
async function buildOrg(input: {
  members: number;
  extra?: number;
  autoAdd?: boolean;
  subscription?: boolean;
  periodEnd?: Date;
  cancelAtPeriodEnd?: boolean;
}): Promise<Fixture> {
  const people = await factories.createUsers(input.members, { subscriptionTier: 'free' });
  created.users.push(...people.map((p) => p.id));
  const owner = people[0];
  const [org] = await db
    .insert(organizations)
    .values({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: owner.id, seatAutoAdd: input.autoAdd ?? false })
    .returning();
  created.orgs.push(org.id);
  await db.insert(orgMembers).values(people.map((p, i) => ({ orgId: org.id, userId: p.id, role: i === 0 ? ('OWNER' as const) : ('MEMBER' as const) })));
  const itemId = `si_${createId()}`;
  if (input.subscription !== false) {
    await db.insert(orgSubscriptions).values({
      orgId: org.id,
      stripeSubscriptionId: `sub_${createId()}`,
      stripeBasePriceId: 'price_base_test',
      stripeBaseItemId: `si_${createId()}`,
      stripeSeatPriceId: 'price_seat_test',
      stripeSeatItemId: itemId,
      extraSeatQuantity: input.extra ?? 0,
      status: 'active',
      currentPeriodStart: new Date(Date.now() - 20 * 24 * HOUR),
      currentPeriodEnd: input.periodEnd ?? new Date(Date.now() + 10 * 24 * HOUR),
      cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
    });
  }
  const drive = await factories.createDrive(owner.id, { name: 'Product', slug: `product-${createId()}`, orgId: org.id, orgVisibility: 'OPEN' });
  const page = await factories.createPage(drive.id, { title: 'Roadmap' });
  // A funded drive wallet under the org pool: the money invariant must hold through every seat path.
  const [pool] = await db.insert(wallets).values({ ownerType: 'org', orgId: org.id, monthlyRemainingCents: 900_000 }).returning();
  // Wallet and its leg commit together: the invariant trigger is deferred to commit.
  const driveWallet = await db.transaction(async (tx) => {
    const [w] = await tx
      .insert(wallets)
      .values({ ownerType: 'org', orgId: org.id, subjectType: 'drive', subjectId: drive.id, parentWalletId: pool.id, topupRemainingCents: 5_000 })
      .returning();
    await tx.insert(walletFundingLegs).values({ walletId: w.id, funderKind: 'owner', funderOrgId: org.id, originalCents: 5_000, remainingCents: 5_000, nonRefundable: false });
    return w;
  });
  return { orgId: org.id, ownerId: owner.id, memberIds: people.map((p) => p.id), itemId, poolId: pool.id, driveWalletId: driveWallet.id, driveId: drive.id, pageId: page.id };
}

async function teardownAll(): Promise<void> {
  const orgIds = created.orgs.splice(0);
  const userIds = created.users.splice(0);
  if (orgIds.length > 0) {
    const orgDrives = await db.select({ id: drives.id }).from(drives).where(inArray(drives.orgId, orgIds));
    const driveIds = orgDrives.map((d) => d.id);
    if (driveIds.length > 0) {
      await db.delete(pageShareLinks).where(inArray(pageShareLinks.pageId, db.select({ id: pages.id }).from(pages).where(inArray(pages.driveId, driveIds))));
      await db.delete(driveAgentMembers).where(inArray(driveAgentMembers.driveId, driveIds));
      await db.delete(driveMembers).where(inArray(driveMembers.driveId, driveIds));
      await db.delete(pages).where(inArray(pages.driveId, driveIds));
      await db.delete(drives).where(inArray(drives.id, driveIds));
    }
    await db.delete(wallets).where(inArray(wallets.parentWalletId, db.select({ id: wallets.id }).from(wallets).where(inArray(wallets.orgId, orgIds))));
    await db.delete(creditLedger).where(inArray(creditLedger.walletId, db.select({ id: wallets.id }).from(wallets).where(inArray(wallets.orgId, orgIds))));
    await db.delete(wallets).where(inArray(wallets.orgId, orgIds));
    await db.delete(orgInvitations).where(inArray(orgInvitations.orgId, orgIds));
    await db.delete(orgMembers).where(inArray(orgMembers.orgId, orgIds));
    await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, orgIds));
    await db.delete(organizations).where(inArray(organizations.id, orgIds));
  }
  if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds));
}

let emailSeq = 0;
const freshEmail = () => `invitee-${emailSeq++}-${createId()}@northwind.test`;

function invite(f: Fixture, stripe: RecordingSeatStripe | undefined, email = freshEmail(), actorRole: 'OWNER' | 'ADMIN' = 'OWNER') {
  return createOrRotateInvitation({
    orgId: f.orgId,
    email,
    role: 'MEMBER',
    invitedBy: f.ownerId,
    actorRole,
    now: new Date(),
    deliver,
    seatBilling: stripe,
  });
}

/** An invite that has expired: it holds no seat until it is resent. */
async function expiredInvite(f: Fixture): Promise<{ id: string; email: string }> {
  const email = freshEmail();
  const [row] = await db
    .insert(orgInvitations)
    .values({ orgId: f.orgId, email, role: 'MEMBER', tokenHash: `hash-${createId()}`, invitedBy: f.ownerId, expiresAt: new Date(Date.now() - HOUR) })
    .returning({ id: orgInvitations.id });
  return { id: row.id, email };
}

function resend(f: Fixture, invitationId: string, stripe: RecordingSeatStripe | undefined, actorRole: 'OWNER' | 'ADMIN' = 'OWNER') {
  return resendInvitation({ orgId: f.orgId, invitationId, actorRole, now: new Date(), deliver, seatBilling: stripe });
}

const storedExtra = async (orgId: string) => (await db.select().from(orgSubscriptions).where(eq(orgSubscriptions.orgId, orgId)))[0]?.extraSeatQuantity;

describe('seat accounting (real Postgres)', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: organizations.id }).from(organizations).limit(1);
    } catch (error) {
      requireDb('seat-service.integration.test.ts', error);
    }
  });

  afterEach(async () => {
    await teardownAll();
  });

  describe('what a seat is', () => {
    it('SEAT-3 (partial) a guest who redeems a share link is a GUEST drive member and takes no seat; nor does an agent; a pending invite does', async () => {
      const f = await buildOrg({ members: 3 });
      const guest = await factories.createUser({ subscriptionTier: 'free' });
      created.users.push(guest.id);
      expect(await countOrgSeats(f.orgId)).toBe(3);

      // The real redemption path (D-OW-24): the redeemer becomes a GUEST drive member.
      const ownerCtx = EnforcedAuthContext.fromSession({ sessionId: 's1', userId: f.ownerId, userRole: 'user', tokenVersion: 0, adminRoleVersion: 0, type: 'user', scopes: ['*'], expiresAt: new Date(Date.now() + HOUR) });
      const link = await createPageShareLink(ownerCtx, f.pageId, { permissions: ['VIEW'] });
      if (!link.ok) throw new Error(`share link refused: ${link.error}`);
      const guestCtx = EnforcedAuthContext.fromSession({ sessionId: 's2', userId: guest.id, userRole: 'user', tokenVersion: 0, adminRoleVersion: 0, type: 'user', scopes: ['*'], expiresAt: new Date(Date.now() + HOUR) });
      expect((await redeemPageShareLink(guestCtx, link.data.rawToken)).ok).toBe(true);
      const [guestRow] = await db.select().from(driveMembers).where(eq(driveMembers.userId, guest.id));
      expect(guestRow.role).toBe('GUEST');
      expect(await countOrgSeats(f.orgId)).toBe(3);

      // An agent (a page) that is a drive agent member is not a person and not a seat.
      const agent = await factories.createPage(f.driveId, { title: 'Helper', type: 'AI_CHAT' });
      await db.insert(driveAgentMembers).values({ driveId: f.driveId, agentPageId: agent.id, addedBy: f.ownerId });
      expect(await countOrgSeats(f.orgId)).toBe(3);
      expect((await getSeatSummary(f.orgId)).held).toBe(3);

      // A pending invite holds a seat; a revoked or expired one does not.
      expect((await invite(f, new RecordingSeatStripe(0))).ok).toBe(true);
      expect(await countOrgSeats(f.orgId)).toBe(4);
      expect((await getSeatSummary(f.orgId)).held).toBe(4);
    });

    it('SEAT-3 (partial) a guest never counts toward the purchased seats either: a full org still refuses a member, and its guests change nothing', async () => {
      const f = await buildOrg({ members: 5, autoAdd: false });
      const guests = await factories.createUsers(3, { subscriptionTier: 'free' });
      created.users.push(...guests.map((g) => g.id));
      await db.insert(driveMembers).values(guests.map((g) => ({ driveId: f.driveId, userId: g.id, role: 'GUEST' as const, acceptedAt: new Date() })));
      const stripe = new RecordingSeatStripe(0);
      const refused = await invite(f, stripe);
      expect(refused).toMatchObject({ ok: false, reason: 'seats_full' });
      expect(stripe.calls).toEqual([]);
      expect((await getSeatSummary(f.orgId)).held).toBe(5);
    });
  });

  describe('auto-add and refusal', () => {
    it('SEAT-4 (partial) inside the included five no Stripe call is made, auto-add on or off', async () => {
      const f = await buildOrg({ members: 4, autoAdd: false });
      const stripe = new RecordingSeatStripe(0);
      expect((await invite(f, stripe)).ok).toBe(true);
      expect(stripe.calls).toEqual([]);
      expect(await storedExtra(f.orgId)).toBe(0);
    });

    it('SEAT-4 (partial) auto-add ON: the sixth seat raises the quantity to one, pro rata, and stores it', async () => {
      const f = await buildOrg({ members: 5, autoAdd: true });
      const stripe = new RecordingSeatStripe(0);
      expect((await invite(f, stripe)).ok).toBe(true);
      expect(stripe.calls).toHaveLength(1);
      expect(stripe.calls[0]).toMatchObject({ itemId: f.itemId, quantity: 1, prorationBehavior: 'create_prorations' });
      expect(await storedExtra(f.orgId)).toBe(1);
    });

    it('SEAT-4 (partial) auto-add OFF: the sixth seat is refused with the message, writes no invite, and calls no Stripe', async () => {
      const f = await buildOrg({ members: 5, autoAdd: false });
      const stripe = new RecordingSeatStripe(0);
      const result = await invite(f, stripe, freshEmail(), 'ADMIN');
      expect(result).toMatchObject({ ok: false, status: 402, reason: 'seats_full' });
      if (result.ok || result.reason !== 'seats_full') throw new Error('expected refusal');
      expect(result.message).toMatch(/All 5 seats/);
      expect(result.message).toMatch(/Owner/);
      expect(stripe.calls).toEqual([]);
      expect(await db.select().from(orgInvitations).where(eq(orgInvitations.orgId, f.orgId))).toHaveLength(0);
      const ownerTold = await invite(f, stripe, freshEmail(), 'OWNER');
      if (ownerTold.ok || ownerTold.reason !== 'seats_full') throw new Error('expected refusal');
      expect(ownerTold.message).toMatch(/automatic seat purchase/i);
    });

    it('SEAT-4 (partial) turning auto-add on lets the same invite through', async () => {
      const f = await buildOrg({ members: 5, autoAdd: false });
      const stripe = new RecordingSeatStripe(0);
      const email = freshEmail();
      expect((await invite(f, stripe, email)).ok).toBe(false);
      expect(await setSeatAutoAdd(f.orgId, true)).toBe(true);
      expect((await invite(f, stripe, email)).ok).toBe(true);
      expect(stripe.calls.map((c) => c.quantity)).toEqual([1]);
    });

    it('SEAT-4 (partial) SEAT-9 (partial) D-OW-30 an org whose subscription is not provisioned yet has not paid, so it is lapsed: an invite takes no seat and makes no Stripe call', async () => {
      const f = await buildOrg({ members: 5, autoAdd: true, subscription: false });
      const stripe = new RecordingSeatStripe(0);
      expect(await invite(f, stripe)).toMatchObject({ ok: false, reason: 'org_lapsed' });
      expect(stripe.calls).toEqual([]);
      expect((await getSeatSummary(f.orgId)).held).toBe(5);
    });

    it('SEAT-4 (partial) accepting an invite changes nothing in Stripe: the invite already held the seat', async () => {
      const f = await buildOrg({ members: 5, autoAdd: true });
      const stripe = new RecordingSeatStripe(0);
      const joiner = await factories.createUser({ subscriptionTier: 'free' });
      created.users.push(joiner.id);
      const issued = await invite(f, stripe, joiner.email);
      if (!issued.ok) throw new Error('invite refused');
      expect(stripe.calls).toHaveLength(1);
      const accepted = await acceptInvitation({ token: issued.token, userId: joiner.id, now: new Date() }, { syncMemberAccess: async () => null as never, publishSyncEvents: async () => {} });
      expect(accepted).toMatchObject({ ok: true, joined: true });
      expect(stripe.calls).toHaveLength(1);
      expect(await countOrgSeats(f.orgId)).toBe(6);
      expect(await storedExtra(f.orgId)).toBe(1);
    });
  });

  describe('resend of an expired invite takes a seat again', () => {
    it('SEAT-4 (partial) resending an EXPIRED invite in a full org with auto-add off is refused like a new invite: no seat taken, invite left expired, no Stripe call', async () => {
      const f = await buildOrg({ members: 5, autoAdd: false });
      const old = await expiredInvite(f);
      const stripe = new RecordingSeatStripe(0);
      expect(await countOrgSeats(f.orgId)).toBe(5);
      const result = await resend(f, old.id, stripe, 'ADMIN');
      expect(result).toMatchObject({ ok: false, status: 402, reason: 'seats_full' });
      expect(await countOrgSeats(f.orgId)).toBe(5);
      const [row] = await db.select().from(orgInvitations).where(eq(orgInvitations.id, old.id));
      expect(row.expiresAt.getTime()).toBeLessThan(Date.now());
      expect(stripe.calls).toEqual([]);
    });

    it('SEAT-4 (partial) resending an expired invite past the purchased count with auto-add ON raises the quantity, pro rata', async () => {
      const f = await buildOrg({ members: 5, autoAdd: true });
      const old = await expiredInvite(f);
      const stripe = new RecordingSeatStripe(0);
      expect((await resend(f, old.id, stripe)).ok).toBe(true);
      expect(stripe.calls).toHaveLength(1);
      expect(stripe.calls[0]).toMatchObject({ quantity: 1, prorationBehavior: 'create_prorations' });
      expect(await storedExtra(f.orgId)).toBe(1);
      expect(await countOrgSeats(f.orgId)).toBe(6);
    });

    it('SEAT-4 (partial) resending a LIVE invite takes no new seat and is never refused, even in a full org', async () => {
      const f = await buildOrg({ members: 4, autoAdd: false });
      const stripe = new RecordingSeatStripe(0);
      const live = await invite(f, stripe);
      if (!live.ok) throw new Error('invite refused');
      expect(await countOrgSeats(f.orgId)).toBe(5);
      expect((await resend(f, live.invitation.id, stripe)).ok).toBe(true);
      expect(await countOrgSeats(f.orgId)).toBe(5);
      expect(stripe.calls).toEqual([]);
    });

    it('SEAT-4 (partial) a resend of an expired invite racing a new invite for the LAST purchased seat: exactly one takes it, round after round', async () => {
      for (let round = 0; round < 8; round += 1) {
        const f = await buildOrg({ members: 5, extra: 1, autoAdd: false });
        const old = await expiredInvite(f);
        const stripe = new RecordingSeatStripe(30);
        const results = await Promise.all([resend(f, old.id, stripe), invite(f, stripe)]);
        expect(results.filter((r) => r.ok), `round ${round}`).toHaveLength(1);
        expect(results.filter((r) => !r.ok && r.reason === 'seats_full')).toHaveLength(1);
        expect(await countOrgSeats(f.orgId)).toBe(6);
      }
    }, 120_000);

    it('SEAT-4 (partial) two resends of two expired invites racing for the last seat: exactly one takes it', async () => {
      for (let round = 0; round < 6; round += 1) {
        const f = await buildOrg({ members: 5, extra: 1, autoAdd: false });
        const [a, b] = [await expiredInvite(f), await expiredInvite(f)];
        const stripe = new RecordingSeatStripe(30);
        const results = await Promise.all([resend(f, a.id, stripe), resend(f, b.id, stripe)]);
        expect(results.filter((r) => r.ok), `round ${round}`).toHaveLength(1);
        expect(await countOrgSeats(f.orgId)).toBe(6);
      }
    }, 120_000);
  });

  describe('concurrency', () => {
    it('SEAT-4 (partial) two invites at once for the LAST purchased seat: exactly one takes it, the other is refused (auto-add off), round after round', async () => {
      // 5 held, 6 purchased (one extra seat already bought), auto-add off: one seat left. With no
      // Stripe call in this path the race window is narrow, so each round is a fresh org.
      for (let round = 0; round < 12; round += 1) {
        const f = await buildOrg({ members: 5, extra: 1, autoAdd: false });
        const stripe = new RecordingSeatStripe(50);
        const results = await Promise.all([invite(f, stripe), invite(f, stripe)]);
        expect(results.filter((r) => r.ok), `round ${round}`).toHaveLength(1);
        expect(results.filter((r) => !r.ok && r.reason === 'seats_full')).toHaveLength(1);
        expect(await countOrgSeats(f.orgId)).toBe(6);
        expect(stripe.calls).toEqual([]);
      }
    }, 120_000);

    it('SEAT-4 (partial) two invites at once past the purchased count (auto-add on) raise to one then two — never both to one', async () => {
      const f = await buildOrg({ members: 5, autoAdd: true });
      const stripe = new RecordingSeatStripe(50);
      const results = await Promise.all([invite(f, stripe), invite(f, stripe)]);
      expect(results.every((r) => r.ok)).toBe(true);
      expect(stripe.calls.map((c) => c.quantity).sort()).toEqual([1, 2]);
      expect(new Set(stripe.calls.map((c) => c.key)).size).toBe(2);
      expect(await storedExtra(f.orgId)).toBe(2);
      expect(await countOrgSeats(f.orgId)).toBe(7);
    });

    it('SEAT-4 (partial) one paid seat left and two invites at once (auto-add on): one is free, one raises — a single increment', async () => {
      const f = await buildOrg({ members: 5, extra: 1, autoAdd: true });
      const stripe = new RecordingSeatStripe(50);
      const results = await Promise.all([invite(f, stripe), invite(f, stripe)]);
      expect(results.every((r) => r.ok)).toBe(true);
      expect(stripe.calls.map((c) => c.quantity)).toEqual([2]);
      expect(await storedExtra(f.orgId)).toBe(2);
    });

    it('SEAT-4 (partial) six callers racing for one seat: exactly one wins', async () => {
      const f = await buildOrg({ members: 5, extra: 1, autoAdd: false });
      const stripe = new RecordingSeatStripe(10);
      const results = await Promise.all(Array.from({ length: 6 }, () => invite(f, stripe)));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(await countOrgSeats(f.orgId)).toBe(6);
    });
  });

  describe('a slow Stripe call under the billing lock', () => {
    it('SEAT-4 (partial) a second invite queues behind a Stripe call slower than the app pool\'s 5s lock_timeout and succeeds, instead of failing with a lock timeout', async () => {
      const f = await buildOrg({ members: 5, autoAdd: true });
      const stripe = new RecordingSeatStripe(6_500);
      const results = await Promise.all([invite(f, stripe), invite(f, stripe)]);
      expect(results.every((r) => r.ok)).toBe(true);
      expect(stripe.calls.map((c) => c.quantity).sort()).toEqual([1, 2]);
      expect(await storedExtra(f.orgId)).toBe(2);
    }, 60_000);
  });

  describe('mid-flight failure and recovery', () => {
    it('SEAT-4 (partial) a Stripe failure leaves no invite and no stored change; the next attempt succeeds', async () => {
      const f = await buildOrg({ members: 5, autoAdd: true });
      const stripe = new RecordingSeatStripe(0);
      stripe.failNext = true;
      const email = freshEmail();
      await expect(invite(f, stripe, email)).rejects.toThrow('stripe unreachable');
      expect(await countOrgSeats(f.orgId)).toBe(5);
      expect(await storedExtra(f.orgId)).toBe(0);
      expect((await invite(f, stripe, email)).ok).toBe(true);
      expect(await storedExtra(f.orgId)).toBe(1);
      expect(stripe.quantities.get(f.itemId)).toBe(1);
    });

    it('SEAT-4 (partial) a lost Stripe response (applied, never recorded) is replayed by the same key on retry: one increment, not two', async () => {
      const f = await buildOrg({ members: 5, autoAdd: true });
      const stripe = new RecordingSeatStripe(0);
      stripe.loseResponseNext = true;
      const email = freshEmail();
      await expect(invite(f, stripe, email)).rejects.toThrow('response lost');
      expect(stripe.quantities.get(f.itemId)).toBe(1);
      expect(await storedExtra(f.orgId)).toBe(0);
      expect((await invite(f, stripe, email)).ok).toBe(true);
      expect(stripe.calls).toHaveLength(2);
      expect(stripe.calls[1].key).toBe(stripe.calls[0].key);
      expect(stripe.quantities.get(f.itemId)).toBe(1);
      expect(await storedExtra(f.orgId)).toBe(1);
    });

    it('SEAT-4 (partial) an email that fails to deliver undoes the invite but keeps the paid seat, released at period end', async () => {
      const f = await buildOrg({ members: 5, autoAdd: true });
      const stripe = new RecordingSeatStripe(0);
      const result = await createOrRotateInvitation({
        orgId: f.orgId, email: freshEmail(), role: 'MEMBER', invitedBy: f.ownerId, actorRole: 'OWNER', now: new Date(),
        deliver: async () => { throw new Error('smtp down'); }, seatBilling: stripe,
      });
      expect(result).toMatchObject({ ok: false, reason: 'delivery_failed' });
      expect(await countOrgSeats(f.orgId)).toBe(5);
      expect(await storedExtra(f.orgId)).toBe(1);
      // A later invite reuses the paid seat: no second Stripe call.
      expect((await invite(f, stripe)).ok).toBe(true);
      expect(stripe.calls).toHaveLength(1);
    });
  });

  describe('removal, re-add and period-end release', () => {
    async function removeOne(f: Fixture): Promise<string> {
      const victim = f.memberIds[f.memberIds.length - 1];
      const removed = await removeMember({ orgId: f.orgId, actorId: f.ownerId, targetId: victim });
      expect(removed.ok).toBe(true);
      return victim;
    }

    it('SEAT-5 (partial) removing a member makes no Stripe call and does not lower the quantity mid-period', async () => {
      const f = await buildOrg({ members: 6, extra: 1, autoAdd: false });
      const stripe = new RecordingSeatStripe(0);
      await removeOne(f);
      expect(stripe.calls).toEqual([]);
      expect(await storedExtra(f.orgId)).toBe(1);
      const swept = await releaseDueSeats({ now: new Date() }, stripe);
      expect(swept.released).toBe(0);
      expect(stripe.calls).toEqual([]);
    });

    it('SEAT-5 (partial) removal then re-add within the period reuses the paid seat: no Stripe call, even with auto-add off', async () => {
      const f = await buildOrg({ members: 6, extra: 1, autoAdd: false });
      const stripe = new RecordingSeatStripe(0);
      await removeOne(f);
      expect((await invite(f, stripe)).ok).toBe(true);
      expect(stripe.calls).toEqual([]);
      expect(await storedExtra(f.orgId)).toBe(1);
    });

    it('SEAT-5 (partial) at period end the unused seat is handed back with no proration, and the next period bills the lower count', async () => {
      const f = await buildOrg({ members: 6, extra: 1, autoAdd: false, periodEnd: new Date(Date.now() + SEAT_RELEASE_LEAD_MS / 2) });
      const stripe = new RecordingSeatStripe(0);
      await removeOne(f);
      stripe.quantities.set(f.itemId, 1);
      expect(await releaseDueSeats({ now: new Date() }, stripe)).toMatchObject({ released: 1, failed: 0 });
      expect(stripe.calls).toHaveLength(1);
      expect(stripe.calls[0]).toMatchObject({ itemId: f.itemId, quantity: 0, prorationBehavior: 'none' });
      expect(await storedExtra(f.orgId)).toBe(0);
      // Replaying the sweep changes nothing.
      expect(await releaseDueSeats({ now: new Date() }, stripe)).toMatchObject({ released: 0 });
      expect(stripe.calls).toHaveLength(1);
    });

    it('SEAT-5 (partial) a seat that is held again before the boundary is never released', async () => {
      const f = await buildOrg({ members: 6, extra: 1, autoAdd: false, periodEnd: new Date(Date.now() + SEAT_RELEASE_LEAD_MS / 2) });
      const stripe = new RecordingSeatStripe(0);
      stripe.quantities.set(f.itemId, 1);
      expect(await releaseOrgSeats({ orgId: f.orgId, now: new Date() }, stripe)).toMatchObject({ kind: 'kept', reason: 'nothing_unused' });
      expect(stripe.calls).toEqual([]);
    });

    it('SEAT-5 (partial) a sweep that finds Stripe already LOWER than the stored quantity (a release whose commit was lost) raises it back before the renewal', async () => {
      const f = await buildOrg({ members: 7, extra: 2, autoAdd: false, periodEnd: new Date(Date.now() + SEAT_RELEASE_LEAD_MS / 2) });
      const stripe = new RecordingSeatStripe(0);
      stripe.quantities.set(f.itemId, 0); // Stripe says 0, the row says 2, seven seats are held
      const swept = await releaseDueSeats({ now: new Date() }, stripe);
      expect(swept).toMatchObject({ healed: 1, failed: 0 });
      expect(stripe.quantities.get(f.itemId)).toBe(2);
      expect(await storedExtra(f.orgId)).toBe(2);
    });

    it('SEAT-5 (partial) a failed release leaves the row and Stripe as they were, and the next sweep retries it', async () => {
      const f = await buildOrg({ members: 6, extra: 1, autoAdd: false, periodEnd: new Date(Date.now() + SEAT_RELEASE_LEAD_MS / 2) });
      await removeOne(f);
      const stripe = new RecordingSeatStripe(0);
      stripe.quantities.set(f.itemId, 1);
      stripe.failNext = true;
      expect(await releaseDueSeats({ now: new Date() }, stripe)).toMatchObject({ failed: 1, released: 0 });
      expect(await storedExtra(f.orgId)).toBe(1);
      expect(await releaseDueSeats({ now: new Date() }, stripe)).toMatchObject({ failed: 0, released: 1 });
      expect(await storedExtra(f.orgId)).toBe(0);
    });
  });

  describe('money', () => {
    it('SEAT-4 (partial) raising, refusing, reusing and releasing seats grant and destroy no credit: pool, legs and ledger are untouched and the leg invariant holds', async () => {
      const f = await buildOrg({ members: 5, autoAdd: true, periodEnd: new Date(Date.now() + SEAT_RELEASE_LEAD_MS / 2) });
      const snapshot = async () => ({
        wallets: await db.select().from(wallets).where(eq(wallets.orgId, f.orgId)),
        legs: await db.select().from(walletFundingLegs).where(eq(walletFundingLegs.walletId, f.driveWalletId)),
        ledger: await db.select().from(creditLedger).where(eq(creditLedger.walletId, f.driveWalletId)),
      });
      const before = await snapshot();
      const stripe = new RecordingSeatStripe(0);
      expect((await invite(f, stripe)).ok).toBe(true); // raise to 1
      await setSeatAutoAdd(f.orgId, false);
      expect((await invite(f, stripe)).ok).toBe(false); // refuse
      await db.delete(orgInvitations).where(eq(orgInvitations.orgId, f.orgId));
      await releaseDueSeats({ now: new Date() }, stripe); // release back to 0
      expect(await storedExtra(f.orgId)).toBe(0);
      expect(await snapshot()).toEqual(before);
      await expectWalletLegInvariant([f.driveWalletId]);
      const [{ pool, legs }] = await db
        .select({
          pool: wallets.topupRemainingCents,
          legs: sql<number>`(select coalesce(sum("remainingCents"), 0)::int from wallet_funding_legs where "walletId" = ${f.driveWalletId})`,
        })
        .from(wallets)
        .where(eq(wallets.id, f.driveWalletId));
      expect(pool).toBe(legs);
    });

    it('SEAT-4 (partial) seat accounting never writes a seat cap: no wallet_consumer_caps row appears for any member', async () => {
      const f = await buildOrg({ members: 5, autoAdd: true });
      const stripe = new RecordingSeatStripe(0);
      await invite(f, stripe);
      const { rows } = (await db.execute(sql`select count(*)::int as n from wallet_consumer_caps where "walletId" = ${f.poolId}`)) as unknown as { rows: Array<{ n: number }> };
      expect(rows[0].n).toBe(0);
    });
  });
});
