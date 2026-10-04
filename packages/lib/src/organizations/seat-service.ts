/**
 * seat-service — the IO around the pure seat decisions (seats.ts): admission of a seat under
 * the org's billing lock, the Stripe extra-seat quantity, and the period-end release sweep
 * (Spec SEAT-3, SEAT-4, SEAT-5; decision A-8). Builds on D1's stored linkage
 * (org_subscriptions.stripeSeatItemId / extraSeatQuantity / seatRevision) and its idempotency
 * keys (planSeatQuantitySync); it introduces no second source of truth for either.
 *
 * SERIALISATION. Every seat decision runs under the org's billing advisory lock
 * (orgBillingLockKey — the SAME lock provisioning, the webhook mirror and the org delete take),
 * and reads the count INSIDE it. So two invites at once cannot both take the last seat, and
 * cannot both raise the quantity off the same stale count: the second waits, then sees the
 * first one's invite row and stored quantity. Lock order is fixed: invite-address lock, then
 * billing lock; nothing takes them the other way round.
 *
 * STRIPE WRITES. Keyed by planSeatQuantitySync: org + operation + (item, revision, quantity,
 * proration). A replay of the same attempt is one request to Stripe; reaching the same
 * quantity again after another change is a new request. The quantity is ABSOLUTE, so even a
 * replay after Stripe's 24-hour key window sets a value Stripe already holds and prorates
 * nothing. Raises are prorated (SEAT-4); a release is not (SEAT-5: the period was paid).
 *
 * MID-FLIGHT FAILURE (Stripe runs inside the locked transaction, like D1's provisioning):
 *   - Stripe errors or is unreachable: the transaction rolls back; no invite, no stored
 *     change. The caller gets the error; retrying starts from what is stored.
 *   - Stripe APPLIED the change but the response or the commit was lost: the row still shows
 *     the old quantity, the retry derives the SAME key (same revision) and Stripe replays the
 *     first answer — one increment, not two. A release sweep also re-reads Stripe's real
 *     quantity inside the boundary window and restores it if it is below the seats held
 *     (never a free seat past the renewal), or releases it if above.
 *   - The invite email fails AFTER commit: the invite is undone (invitations.ts) but the
 *     paid seat stays until the period end, when the release hands it back.
 *
 * MONEY. Nothing here touches a wallet, a leg, a ledger row or a cap: a quantity change
 * neither grants nor destroys credits. Funding stays on the invoice.paid path, from what was
 * actually paid.
 */

import { db } from '@pagespace/db/db';
import { and, eq, lte, sql } from '@pagespace/db/operators';
import { organizations, orgSubscriptions, type OrgRole } from '@pagespace/db/schema/organizations';
import { isBillingEnabled } from '../deployment-mode';
import { isLiveOrgSubscriptionStatus, orgBillingLockKey, planSeatQuantitySync } from '../billing/org-subscription-core';
import { TIER_PLAN_LIMITS } from '../billing/subscription-tiers';
import { loggers } from '../logging/logger-config';
import { recordOrgAuditEventAfterCommit } from '../audit/org-audit';
import { countOrgSeatParts } from './repository';
import {
  SEAT_RELEASE_LEAD_MS,
  decideSeatAdmission,
  decideSeatRelease,
  seatQuantity,
  seatRefusalMessage,
} from './seats';

export const SEAT_REFUSED_CODE = 'seats_full' as const;

export type SeatProration = 'create_prorations' | 'none';

/** The two Stripe operations seats need; the web shell implements them over the real client. */
export interface SeatBillingPort {
  setSeatQuantity(
    params: { itemId: string; quantity: number; prorationBehavior: SeatProration },
    idempotencyKey: string,
  ): Promise<{ quantity: number }>;
  /** Stripe's current quantity on the seat item. */
  readSeatQuantity(itemId: string): Promise<number>;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const INCLUDED = TIER_PLAN_LIMITS.business.includedSeats;

/**
 * How long a seat decision may WAIT for the billing lock. The holder makes a Stripe call inside
 * its transaction (D1's pattern), so a waiter can legitimately queue behind a slow one; the app
 * pool's 5s lock_timeout / 15s statement_timeout would turn that queue into a 500 on a correct
 * invite. Raised for THIS transaction only (set_config is_local), never on the pool.
 */
export const SEAT_LOCK_WAIT_MS = 30_000;

async function lockOrgBilling(tx: Tx, orgId: string): Promise<void> {
  await tx.execute(sql`select set_config('lock_timeout', ${`${SEAT_LOCK_WAIT_MS}ms`}, true), set_config('statement_timeout', ${`${SEAT_LOCK_WAIT_MS}ms`}, true)`);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${orgBillingLockKey(orgId)}, 0))`);
}

async function loadLiveSubscription(tx: Tx, orgId: string) {
  const [row] = await tx.select().from(orgSubscriptions).where(eq(orgSubscriptions.orgId, orgId)).limit(1);
  return row && isLiveOrgSubscriptionStatus(row.status) ? row : null;
}

export type SeatAdmission =
  /** `quantity` is the extra-seat quantity Stripe now bills, set when this admission raised it. */
  | { ok: true; raised: boolean; quantity?: number }
  | { ok: false; status: 402; reason: typeof SEAT_REFUSED_CODE; message: string; purchased: number; held: number };

/**
 * May ONE more seat be taken for this org, inside the caller's transaction? Takes the billing
 * lock, counts inside it, and — when auto-add raises the quantity — makes the Stripe write and
 * stores it in this same transaction, so the seat and its purchase commit or roll back together.
 *
 * `port` is needed only for a raise; a caller that can never reach one (no subscription) may
 * omit it, and a raise without one throws rather than admitting an unbilled seat.
 */
export async function admitSeat(
  tx: Tx,
  input: { orgId: string; actorRole: OrgRole },
  port?: SeatBillingPort,
): Promise<SeatAdmission> {
  await lockOrgBilling(tx, input.orgId);
  const [org] = await tx.select({ seatAutoAdd: organizations.seatAutoAdd }).from(organizations).where(eq(organizations.id, input.orgId)).limit(1);
  const sub = await loadLiveSubscription(tx, input.orgId);
  const parts = await countOrgSeatParts(input.orgId, tx);
  const { held } = seatQuantity({ ...parts, included: INCLUDED });

  const decision = decideSeatAdmission({
    held,
    included: INCLUDED,
    purchasedExtra: sub?.extraSeatQuantity ?? 0,
    autoAdd: org?.seatAutoAdd ?? false,
    billingEnabled: isBillingEnabled(),
  });
  if (decision.action === 'admit') return { ok: true, raised: false };
  if (decision.action === 'refuse') {
    return {
      ok: false,
      status: 402,
      reason: SEAT_REFUSED_CODE,
      message: seatRefusalMessage({ purchased: decision.purchased, held: decision.held, actorRole: input.actorRole }),
      purchased: decision.purchased,
      held: decision.held,
    };
  }
  // No live subscription yet (provisioning is pending): D1's provisioning prices the real
  // count when it happens, so the seat is taken now and billed then.
  if (!sub) return { ok: true, raised: false };
  if (!port) throw new Error('seat billing port is required to raise the extra-seat quantity');

  const plan = planSeatQuantitySync({
    orgId: input.orgId,
    stored: { seatItemId: sub.stripeSeatItemId, extraSeatQuantity: sub.extraSeatQuantity, seatRevision: sub.seatRevision },
    seats: held + 1,
    prorationBehavior: 'create_prorations',
  });
  if (plan.kind === 'noop') return { ok: true, raised: false };
  const item = await port.setSeatQuantity(
    { itemId: plan.itemId, quantity: plan.quantity, prorationBehavior: 'create_prorations' },
    plan.idempotencyKey,
  );
  await tx
    .update(orgSubscriptions)
    .set({ extraSeatQuantity: item.quantity, seatRevision: plan.nextRevision })
    .where(eq(orgSubscriptions.orgId, input.orgId));
  loggers.api.info('org extra-seat quantity raised for an invite', { orgId: input.orgId, quantity: item.quantity, held: held + 1 });
  return { ok: true, raised: true, quantity: item.quantity };
}

export type SeatReleaseOutcome =
  | { kind: 'released'; quantity: number }
  | { kind: 'restored'; quantity: number }
  | { kind: 'kept'; reason: 'mid_period' | 'nothing_unused' | 'ending' | 'no_period' }
  | { kind: 'no_subscription' };

/**
 * SEAT-5: at the period boundary, make Stripe's extra-seat quantity equal what is held — lower
 * it (no proration) when seats are unused, raise it (prorated) when fewer are billed than
 * held. Outside the lead window it reads nothing and writes nothing.
 */
export async function releaseOrgSeats(
  input: { orgId: string; now: Date; leadMs?: number },
  port: SeatBillingPort,
): Promise<SeatReleaseOutcome> {
  const outcome = await releaseOrgSeatsInTx(input, port);
  if (outcome.kind === 'released' || outcome.kind === 'restored') {
    // AUD-1: the period boundary changed what Stripe bills (a system action, no actor).
    await recordOrgAuditEventAfterCommit({
      orgId: input.orgId,
      eventType: 'org.seat.quantity_changed',
      resourceType: 'organization',
      resourceId: input.orgId,
      details: { reason: outcome.kind === 'released' ? 'period_end_release' : 'period_end_restore', quantity: outcome.quantity },
    });
  }
  return outcome;
}

function releaseOrgSeatsInTx(
  input: { orgId: string; now: Date; leadMs?: number },
  port: SeatBillingPort,
): Promise<SeatReleaseOutcome> {
  return db.transaction(async (tx): Promise<SeatReleaseOutcome> => {
    await lockOrgBilling(tx, input.orgId);
    const sub = await loadLiveSubscription(tx, input.orgId);
    if (!sub) return { kind: 'no_subscription' };
    const parts = await countOrgSeatParts(input.orgId, tx);
    const { held } = seatQuantity({ ...parts, included: INCLUDED });
    const common = { held, included: INCLUDED, currentPeriodEnd: sub.currentPeriodEnd, cancelAtPeriodEnd: sub.cancelAtPeriodEnd, now: input.now, leadMs: input.leadMs };

    // Outside the window nothing is read from Stripe.
    const early = decideSeatRelease({ ...common, purchasedExtra: sub.extraSeatQuantity });
    if (early.action === 'keep' && early.reason !== 'nothing_unused') return { kind: 'kept', reason: early.reason };

    // Inside it, Stripe's own quantity is the truth the decision is made against.
    const actual = await port.readSeatQuantity(sub.stripeSeatItemId);
    const decision = decideSeatRelease({ ...common, purchasedExtra: actual });
    if (decision.action === 'keep') {
      if (actual !== sub.extraSeatQuantity) {
        await tx.update(orgSubscriptions).set({ extraSeatQuantity: actual }).where(eq(orgSubscriptions.orgId, input.orgId));
      }
      return { kind: 'kept', reason: decision.reason };
    }
    const prorationBehavior: SeatProration = decision.action === 'release' ? 'none' : 'create_prorations';
    const plan = planSeatQuantitySync({
      orgId: input.orgId,
      stored: { seatItemId: sub.stripeSeatItemId, extraSeatQuantity: actual, seatRevision: sub.seatRevision },
      seats: held,
      prorationBehavior,
    });
    if (plan.kind === 'noop') return { kind: 'kept', reason: 'nothing_unused' };
    const item = await port.setSeatQuantity({ itemId: plan.itemId, quantity: plan.quantity, prorationBehavior }, plan.idempotencyKey);
    await tx
      .update(orgSubscriptions)
      .set({ extraSeatQuantity: item.quantity, seatRevision: plan.nextRevision })
      .where(eq(orgSubscriptions.orgId, input.orgId));
    loggers.api.info('org extra-seat quantity reconciled at the period boundary', { orgId: input.orgId, action: decision.action, quantity: item.quantity, held });
    return decision.action === 'release' ? { kind: 'released', quantity: item.quantity } : { kind: 'restored', quantity: item.quantity };
  });
}

export interface SeatSweepResult {
  scanned: number;
  released: number;
  /** Quantities restored up to the seats held. */
  healed: number;
  failed: number;
}

const SWEEP_BATCH = 200;

/**
 * The cron's work: every live org subscription whose period ends inside the lead window (or
 * already has) gets releaseOrgSeats. One org's failure never stops the others; it is counted
 * and the next tick retries it.
 */
export async function releaseDueSeats(input: { now: Date; leadMs?: number }, port: SeatBillingPort): Promise<SeatSweepResult> {
  const lead = input.leadMs ?? SEAT_RELEASE_LEAD_MS;
  const horizon = new Date(input.now.getTime() + lead);
  const result: SeatSweepResult = { scanned: 0, released: 0, healed: 0, failed: 0 };
  let cursor = '';
  for (;;) {
    const rows = await db
      .select({ orgId: orgSubscriptions.orgId, status: orgSubscriptions.status })
      .from(orgSubscriptions)
      .where(and(lte(orgSubscriptions.currentPeriodEnd, horizon), eq(orgSubscriptions.cancelAtPeriodEnd, false), sql`${orgSubscriptions.orgId} > ${cursor}`))
      .orderBy(orgSubscriptions.orgId)
      .limit(SWEEP_BATCH);
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].orgId;
    for (const row of rows) {
      if (!isLiveOrgSubscriptionStatus(row.status)) continue;
      result.scanned += 1;
      try {
        const outcome = await releaseOrgSeats({ orgId: row.orgId, now: input.now, leadMs: lead }, port);
        if (outcome.kind === 'released') result.released += 1;
        if (outcome.kind === 'restored') result.healed += 1;
      } catch (error) {
        result.failed += 1;
        loggers.api.error('org seat release failed; the next tick retries it', error as Error, { orgId: row.orgId });
      }
    }
  }
  return result;
}

/** SEAT-4's switch. Returns false when the org does not exist. */
export async function setSeatAutoAdd(orgId: string, autoAdd: boolean, actorId?: string): Promise<boolean> {
  const updated = await db.update(organizations).set({ seatAutoAdd: autoAdd }).where(eq(organizations.id, orgId)).returning({ id: organizations.id });
  if (updated.length === 0) return false;
  await recordOrgAuditEventAfterCommit({
    orgId,
    eventType: 'org.seat.auto_add_changed',
    actorId,
    resourceType: 'organization',
    resourceId: orgId,
    details: { autoAdd },
  });
  return true;
}

/**
 * AUD-1 seat events of an admission, once the invite (or join) that took the seat has committed: the
 * raise when one was bought, or the refusal when none could be granted.
 */
export async function recordSeatAdmissionEvents(input: {
  orgId: string;
  actorId?: string;
  admission: SeatAdmission;
  /** What took (or tried to take) the seat: 'invite', 'resend', 'auto_join'. */
  operation: string;
}): Promise<void> {
  const { admission } = input;
  if (admission.ok && !admission.raised) return;
  await recordOrgAuditEventAfterCommit({
    orgId: input.orgId,
    eventType: admission.ok ? 'org.seat.quantity_changed' : 'org.seat.refused',
    actorId: input.actorId,
    resourceType: 'organization',
    resourceId: input.orgId,
    details: admission.ok
      ? { reason: input.operation, quantity: admission.quantity ?? null }
      : { operation: input.operation, purchased: admission.purchased, held: admission.held },
  });
}

export interface SeatSummary {
  members: number;
  pendingInvites: number;
  held: number;
  included: number;
  /** Extra seats Stripe is set to bill (0 with no live subscription). */
  purchasedExtra: number;
  /** Seats the org may hold without buying more. */
  purchased: number;
  autoAdd: boolean;
  hasSubscription: boolean;
  currentPeriodEnd: Date | null;
}

/** What the Owner and Admins see of the org's seats (SEAT-6). */
export async function getSeatSummary(orgId: string): Promise<SeatSummary> {
  return db.transaction(async (tx) => {
    const [org] = await tx.select({ seatAutoAdd: organizations.seatAutoAdd }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
    const sub = await loadLiveSubscription(tx, orgId);
    const parts = await countOrgSeatParts(orgId, tx);
    const { held } = seatQuantity({ ...parts, included: INCLUDED });
    const purchasedExtra = sub?.extraSeatQuantity ?? 0;
    return {
      ...parts,
      held,
      included: INCLUDED,
      purchasedExtra,
      purchased: INCLUDED + purchasedExtra,
      autoAdd: org?.seatAutoAdd ?? false,
      hasSubscription: sub !== null,
      currentPeriodEnd: sub?.currentPeriodEnd ?? null,
    };
  });
}
