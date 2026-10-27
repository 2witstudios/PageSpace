// @vitest-environment node
/**
 * Seats through the invitation route, the real seat service and the real Stripe seat adapter
 * (Spec SEAT-4, SEAT-5), against a REAL Postgres. Only the session, the invite email and the
 * Stripe HTTP client are faked.
 *
 * HOW "PRO RATA" IS PROVEN WITHOUT A STRIPE KEY. CI holds no sk_test, so Stripe's own proration
 * math cannot run here. What the product controls is the REQUEST: SEAT-4's raise is proven to
 * reach Stripe as exactly one `subscriptionItems.update(seatItem, { quantity: N,
 * proration_behavior: 'create_prorations' }, { idempotencyKey })` — through the production adapter
 * (stripeSeatBilling), with the exact quantity and the service's key. `create_prorations` IS
 * Stripe's pro-rata (it charges the unused part of the period at the new quantity). SEAT-5's
 * "without a charge" is the same seam asserting NO update at all mid-period and
 * `proration_behavior: 'none'` where a quantity changes at the boundary. Stripe applying its own
 * documented semantics is not re-tested (org-subscription.stripe.integration covers it with a key).
 *
 * Every row is deleted children first, users last.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { organizations, orgInvitations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import type { SessionAuthResult } from '@/lib/auth';

/** Stripe's subscription-item API as the adapter sees it: records every update, replays a repeated key. */
const { stripeItems } = vi.hoisted(() => {
  const quantities = new Map<string, number>();
  const replies = new Map<string, number>();
  const updates: Array<{ itemId: string; params: { quantity: number; proration_behavior: string }; options: { idempotencyKey: string } }> = [];
  return {
    stripeItems: {
      quantities,
      updates,
      async update(itemId: string, params: { quantity: number; proration_behavior: string }, options: { idempotencyKey: string }) {
        updates.push({ itemId, params, options });
        const replay = replies.get(options.idempotencyKey);
        if (replay !== undefined) return { id: itemId, quantity: replay };
        quantities.set(itemId, params.quantity);
        replies.set(options.idempotencyKey, params.quantity);
        return { id: itemId, quantity: params.quantity };
      },
      async retrieve(itemId: string) {
        return { id: itemId, quantity: quantities.get(itemId) ?? 0 };
      },
    },
  };
});

vi.mock('@/lib/auth', () => ({ authenticateRequestWithOptions: vi.fn(), isAuthError: vi.fn((r: object) => 'error' in r), getAllowedDriveIds: vi.fn(() => []) }));
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn(async () => ({ allowed: true })),
  DISTRIBUTED_RATE_LIMITS: { DRIVE_INVITE: 'DRIVE_INVITE', EMAIL_RESEND: 'EMAIL_RESEND', API: 'API' },
}));
vi.mock('@pagespace/lib/auth/verification-utils', () => ({ isEmailVerified: vi.fn(async () => true) }));
vi.mock('@/lib/orgs/org-invite-delivery', () => ({ deliverOrgInvite: vi.fn(async () => undefined) }));
vi.mock('@/lib/stripe', () => ({ stripe: { subscriptionItems: stripeItems } }));

import { authenticateRequestWithOptions } from '@/lib/auth';
import { removeMember } from '@pagespace/lib/organizations/membership';
import { releaseOrgSeats } from '@pagespace/lib/organizations/seat-service';
import { SEAT_RELEASE_LEAD_MS } from '@pagespace/lib/organizations/seats';
import { TIER_PLAN_LIMITS } from '@pagespace/lib/billing/subscription-tiers';
import { defaultSeatBilling } from '@/lib/org-billing/seat-billing';
import { POST as inviteRoute } from '../route';

const HOUR = 3_600_000;
const INCLUDED = TIER_PLAN_LIMITS.business.includedSeats;
const created = { orgs: [] as string[], users: [] as string[] };
let dbAvailable = false;

const session = (userId: string): SessionAuthResult => ({ userId, tokenVersion: 0, tokenType: 'session', sessionId: 'sess', role: 'user', adminRoleVersion: 0 });
const email = () => `invitee-${createId()}@northwind.test`;

async function inviteAs(userId: string, orgId: string, address = email()) {
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session(userId));
  const response = await inviteRoute(
    new Request(`https://example.test/api/orgs/${orgId}/invitations`, { method: 'POST', body: JSON.stringify({ email: address, role: 'MEMBER' }), headers: { 'content-type': 'application/json' } }),
    { params: Promise.resolve({ orgId }) },
  );
  return { status: response.status, body: (await response.json()) as { error?: string; code?: string } };
}

/** An org holding `seats` seats (Owner, one Admin, Members), a live funded subscription, members may invite. */
async function northwind(input: { seats: number; extra?: number; autoAdd: boolean; periodEnd?: Date }) {
  const people = await factories.createUsers(input.seats, { subscriptionTier: 'free' });
  created.users.push(...people.map((p) => p.id));
  const [org] = await db
    .insert(organizations)
    .values({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: people[0].id, seatAutoAdd: input.autoAdd, policies: { whoCanInvite: 'members' } })
    .returning();
  created.orgs.push(org.id);
  await db.insert(orgMembers).values(people.map((p, i) => ({ orgId: org.id, userId: p.id, role: i === 0 ? ('OWNER' as const) : i === 1 ? ('ADMIN' as const) : ('MEMBER' as const) })));
  const seatItemId = `si_${createId()}`;
  stripeItems.quantities.set(seatItemId, input.extra ?? 0);
  await db.insert(orgSubscriptions).values({
    orgId: org.id,
    stripeSubscriptionId: `sub_${createId()}`,
    stripeBasePriceId: 'price_base_test',
    stripeBaseItemId: `si_${createId()}`,
    stripeSeatPriceId: 'price_seat_test',
    stripeSeatItemId: seatItemId,
    extraSeatQuantity: input.extra ?? 0,
    status: 'active',
    currentPeriodStart: new Date(Date.now() - 20 * 24 * HOUR),
    currentPeriodEnd: input.periodEnd ?? new Date(Date.now() + 10 * 24 * HOUR),
    // The period's start boundary is reconciled: the sweep sees an ordinary mid-period org.
    seatsReconciledThrough: new Date(Date.now() - 20 * 24 * HOUR),
  });
  await factories.fundOrgSubscription(org.id);
  return { orgId: org.id, seatItemId, owner: people[0].id, admin: people[1].id, members: people.slice(2).map((p) => p.id) };
}

const updatesFor = (itemId: string) => stripeItems.updates.filter((u) => u.itemId === itemId);
const invitesFor = async (orgId: string) => db.select().from(orgInvitations).where(eq(orgInvitations.orgId, orgId));
const storedExtra = async (orgId: string) => (await db.select().from(orgSubscriptions).where(eq(orgSubscriptions.orgId, orgId)))[0]?.extraSeatQuantity;

describe('seats through the invitation route and the Stripe seat adapter (real Postgres)', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: organizations.id }).from(organizations).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('invitations seats.integration.test.ts', error);
    }
    process.env.DEPLOYMENT_MODE = 'cloud';
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    const orgIds = created.orgs.splice(0);
    if (orgIds.length > 0) {
      await db.delete(orgInvitations).where(inArray(orgInvitations.orgId, orgIds));
      await db.delete(orgMembers).where(inArray(orgMembers.orgId, orgIds));
      await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, orgIds));
      await db.delete(organizations).where(inArray(organizations.id, orgIds));
    }
    const userIds = created.users.splice(0);
    if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds));
  });

  it('SEAT-4 with auto-add on, an invite past the purchased count raises the extra-seat item by exactly one, pro rata (create_prorations, one idempotency key); with auto-add off the same invite is refused 402 seats_full with a clear message, writes no invite and calls no Stripe — and a Member is never told the seat count', async () => {
    if (!dbAvailable) return;
    // Auto-add ON, every included seat held: the next invite buys one extra seat.
    const on = await northwind({ seats: INCLUDED, autoAdd: true });
    const raised = await inviteAs(on.owner, on.orgId);
    expect(raised.status).toBe(201);
    expect(updatesFor(on.seatItemId)).toEqual([
      { itemId: on.seatItemId, params: { quantity: 1, proration_behavior: 'create_prorations' }, options: { idempotencyKey: expect.stringContaining(on.orgId) } },
    ]);
    expect(await storedExtra(on.orgId)).toBe(1);
    // The next one, from a Member (POL-5 lets members invite here), raises by exactly one more under a new key.
    expect((await inviteAs(on.members[0], on.orgId)).status).toBe(201);
    const [first, second] = updatesFor(on.seatItemId);
    expect(second.params).toEqual({ quantity: 2, proration_behavior: 'create_prorations' });
    expect(second.options.idempotencyKey).not.toBe(first.options.idempotencyKey);
    expect(await storedExtra(on.orgId)).toBe(2);

    // Auto-add OFF: refused, nothing written, nothing sent to Stripe — for every role.
    const off = await northwind({ seats: INCLUDED, autoAdd: false });
    const asOwner = await inviteAs(off.owner, off.orgId);
    const asAdmin = await inviteAs(off.admin, off.orgId);
    const asMember = await inviteAs(off.members[0], off.orgId);
    for (const refused of [asOwner, asAdmin, asMember]) {
      expect(refused.status).toBe(402);
      expect(refused.body.code).toBe('seats_full');
      expect(refused.body.error).toMatch(/seat/i);
    }
    expect(asOwner.body.error).toMatch(/automatic seat purchase/i);
    expect(asAdmin.body.error).toContain(`All ${INCLUDED} seats`);
    expect(asAdmin.body.error).toMatch(/Owner/);
    // SEAT-6: seat count is Owner/Admin information — the Member's refusal carries no number at all.
    expect(asMember.body.error).toMatch(/Owner/);
    expect(JSON.stringify(asMember.body)).not.toMatch(/\d/);
    expect(await invitesFor(off.orgId)).toEqual([]);
    expect(updatesFor(off.seatItemId)).toEqual([]);
    expect(await storedExtra(off.orgId)).toBe(0);
  });

  it('SEAT-5 removing a member frees the seat only at the period boundary: mid-period removal and re-add make no Stripe call and no charge, a re-add after the pre-boundary release raises with no proration, and the next period bills the lower count with no proration credit', async () => {
    if (!dbAvailable) return;
    const seatBilling = defaultSeatBilling();

    // Mid-period: one extra seat bought and held; a member leaves, then someone is re-added.
    const mid = await northwind({ seats: INCLUDED + 1, extra: 1, autoAdd: false });
    expect((await removeMember({ orgId: mid.orgId, actorId: mid.owner, targetId: mid.members[0] })).ok).toBe(true);
    expect(await releaseOrgSeats({ orgId: mid.orgId, now: new Date() }, seatBilling)).toEqual({ kind: 'kept', reason: 'mid_period' });
    expect((await inviteAs(mid.owner, mid.orgId)).status).toBe(201); // reuses the paid seat, even with auto-add off
    expect(updatesFor(mid.seatItemId)).toEqual([]);
    expect(await storedExtra(mid.orgId)).toBe(1);

    // The boundary: a member leaves near the period end; the release lowers the count for the next
    // period with NO proration credit (this period was paid in full).
    const end = await northwind({ seats: INCLUDED + 1, extra: 1, autoAdd: true, periodEnd: new Date(Date.now() + SEAT_RELEASE_LEAD_MS / 2) });
    expect((await removeMember({ orgId: end.orgId, actorId: end.owner, targetId: end.members[0] })).ok).toBe(true);
    expect(await releaseOrgSeats({ orgId: end.orgId, now: new Date() }, seatBilling)).toEqual({ kind: 'released', quantity: 0, catchUp: false });
    expect(updatesFor(end.seatItemId).map((u) => u.params)).toEqual([{ quantity: 0, proration_behavior: 'none' }]);
    expect(stripeItems.quantities.get(end.seatItemId)).toBe(0);

    // Re-added in the last stretch, after the release: still inside the paid period, so no charge —
    // the quantity goes back up with NO proration and Stripe bills it from the renewal.
    expect((await inviteAs(end.owner, end.orgId)).status).toBe(201);
    expect(updatesFor(end.seatItemId).map((u) => u.params)).toEqual([
      { quantity: 0, proration_behavior: 'none' },
      { quantity: 1, proration_behavior: 'none' },
    ]);
    expect(await storedExtra(end.orgId)).toBe(1);
    // ...and the sweep running again before the boundary changes nothing more.
    expect(await releaseOrgSeats({ orgId: end.orgId, now: new Date() }, seatBilling)).toEqual({ kind: 'kept', reason: 'nothing_unused' });
    expect(updatesFor(end.seatItemId)).toHaveLength(2);
  });
});
