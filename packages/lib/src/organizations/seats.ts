/**
 * seats — the PURE seat decisions (Spec SEAT-3, SEAT-4, SEAT-5; decision A-8).
 *
 * TWO DIFFERENT THINGS ARE CALLED A SEAT; this module is only the first:
 *   1. the BILLING seat: one accepted member or one live pending invite, counted toward the
 *      extra-seat Stripe item's quantity (max(0, seats − included), D1's orgExtraSeatQuantity);
 *   2. the spend seat: a member's monthly and daily cap on the org pool's own leg (#2737,
 *      wallet_consumer_caps). Nothing here reads, writes or widens one.
 *
 * WHO HOLDS A BILLING SEAT (SEAT-3): org_members rows and live org_invitations rows. A guest
 * (a share-link redeemer is a GUEST drive member, D-OW-24), an agent account and an app are
 * never org_members rows, so they never reach this count; the count is taken by the one
 * query (countOrgSeatParts, repository.ts) that reads only those two tables.
 *
 * WHEN A SEAT IS PAID FOR (SEAT-4, SEAT-5): the org has PURCHASED `included + extra` seats,
 * where `extra` is the quantity Stripe was last set to. Admitting one more seat is free when
 * held < purchased — including a seat a removed member freed: removal writes nothing to
 * Stripe, so the seat stays paid for until the period ends, and a re-add inside the period
 * is a no-op (SEAT-5). Past the purchased count, auto-add ON raises the quantity (pro rata);
 * auto-add OFF refuses.
 *
 * WHEN A FREED SEAT IS HANDED BACK (SEAT-5): only at the period boundary. Inside the lead
 * window before the period's end, the quantity is lowered to what is held, with no proration
 * credit (the period it belongs to was paid for in full). Never mid-period, never below the
 * seats held. Each boundary reconciled is RECORDED (org_subscriptions.seatsReconciledThrough),
 * so a boundary that passed with no run — the cron missed its window, or the row was stale —
 * is caught up on the next run WITH prorations: Stripe already billed the renewal at the old
 * quantity, and the proration credits the unused seats back instead of billing a full extra
 * period (review 3+4 P2-8). Recorded once, so the catch-up never repeats.
 *
 * INVARIANT: zero I/O. The service (seat-service.ts) reads, locks and calls Stripe.
 */

import type { OrgRole } from '@pagespace/db/schema/organizations';

/**
 * How long before the billing period's end a freed seat is handed back. The renewal invoice
 * is created at the boundary, so the quantity must be lowered before it; the sweep that does
 * it runs every 15 minutes (docker/cron/crontab), so the window holds several ticks. A re-add
 * inside this last hour pays the pro-rata of that hour, not a month.
 */
export const SEAT_RELEASE_LEAD_MS = 60 * 60 * 1000;

const assertCount = (name: string, value: number): void => {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${value}`);
  }
};

/** SEAT-3: seats held = accepted members + pending invites; extra = what exceeds the included seats. */
export function seatQuantity(input: { members: number; pendingInvites: number; included: number }): { held: number; extra: number } {
  assertCount('members', input.members);
  assertCount('pendingInvites', input.pendingInvites);
  assertCount('included', input.included);
  const held = input.members + input.pendingInvites;
  return { held, extra: Math.max(0, held - input.included) };
}

export type SeatAdmissionDecision =
  | { action: 'admit' }
  | { action: 'raise'; toExtra: number }
  | { action: 'refuse'; reason: 'auto_add_off'; purchased: number; held: number };

/**
 * May ONE more seat be taken? `held` is the count BEFORE this seat (read under the org's
 * billing lock, so it is the truth the decision and the write both see). `purchasedExtra` is
 * the quantity Stripe was last set to, 0 while the org has no live subscription yet (its
 * provisioning prices the real count when it happens, D1).
 */
export function decideSeatAdmission(input: {
  held: number;
  included: number;
  purchasedExtra: number;
  autoAdd: boolean;
  billingEnabled: boolean;
}): SeatAdmissionDecision {
  if (!input.billingEnabled) return { action: 'admit' };
  assertCount('held', input.held);
  assertCount('purchasedExtra', input.purchasedExtra);
  const purchased = input.included + input.purchasedExtra;
  const after = input.held + 1;
  if (after <= purchased) return { action: 'admit' };
  if (!input.autoAdd) return { action: 'refuse', reason: 'auto_add_off', purchased, held: input.held };
  return { action: 'raise', toExtra: Math.max(0, after - input.included) };
}

export type SeatReleaseProration = 'none' | 'create_prorations';

export type SeatReleaseDecision =
  /** `boundary` is the period boundary this reconciles; the service records it once applied. */
  | { action: 'release'; toExtra: number; proration: SeatReleaseProration; boundary: Date }
  /** Stripe bills fewer extra seats than are held (a lost write, or seats granted before the subscription existed): bring it up, prorated. */
  | { action: 'restore'; toExtra: number; proration: 'create_prorations'; boundary: Date }
  /** Nothing to change in Stripe, but the boundary is reconciled (or, for `baseline`, first recorded). */
  | { action: 'keep'; reason: 'nothing_unused' | 'baseline'; boundary: Date }
  | { action: 'keep'; reason: 'mid_period' | 'ending' | 'no_period' };

/**
 * SEAT-5: hand back paid-for seats nobody holds, but only at the period boundary. Also the
 * boundary's reconciliation: `purchasedExtra` here is what STRIPE bills (the service reads
 * it), so a quantity below the seats actually held is restored rather than left as a free seat.
 *
 * WHICH boundary (review 3+4 P2-8): the period END inside the lead window (no proration: the
 * period was paid in full); otherwise a boundary that already PASSED unreconciled — the
 * current period's start after a missed window, or a stale row's end — caught up with
 * prorations. `reconciledThrough` is the last boundary recorded; null means never, and the
 * first sight records the current period's start as a baseline without touching Stripe.
 */
export function decideSeatRelease(input: {
  held: number;
  included: number;
  purchasedExtra: number;
  currentPeriodStart?: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  reconciledThrough?: Date | null;
  now: Date;
  leadMs?: number;
}): SeatReleaseDecision {
  assertCount('held', input.held);
  assertCount('purchasedExtra', input.purchasedExtra);
  if (input.cancelAtPeriodEnd) return { action: 'keep', reason: 'ending' };
  const end = input.currentPeriodEnd;
  if (end === null) return { action: 'keep', reason: 'no_period' };
  const start = input.currentPeriodStart ?? null;
  const reconciled = input.reconciledThrough ?? null;
  const done = (boundary: Date): boolean => reconciled !== null && reconciled.getTime() >= boundary.getTime();
  const lead = input.leadMs ?? SEAT_RELEASE_LEAD_MS;
  const nowMs = input.now.getTime();

  let boundary: Date;
  let proration: SeatReleaseProration;
  if (end.getTime() <= nowMs) {
    // The end already passed (the webhook has not rolled the row on): Stripe billed the renewal.
    if (done(end)) return { action: 'keep', reason: 'mid_period' };
    boundary = end;
    proration = 'create_prorations';
  } else if (end.getTime() - nowMs <= lead) {
    boundary = end;
    proration = 'none';
  } else if (start !== null && reconciled === null) {
    return { action: 'keep', reason: 'baseline', boundary: start };
  } else if (start !== null && !done(start)) {
    // The window before this period's start was missed: catch up now, prorated.
    boundary = start;
    proration = 'create_prorations';
  } else {
    return { action: 'keep', reason: 'mid_period' };
  }

  const needed = Math.max(0, input.held - input.included);
  if (needed === input.purchasedExtra) return { action: 'keep', reason: 'nothing_unused', boundary };
  return needed < input.purchasedExtra
    ? { action: 'release', toExtra: needed, proration, boundary }
    : { action: 'restore', toExtra: needed, proration: 'create_prorations', boundary };
}

/**
 * What the person who tried to invite sees when no seat can be granted (SEAT-4). No price and
 * no credit figure (MON-5). An Owner is told how to fix it; an Admin is told to ask the Owner (the
 * refusal is audited by the route; an in-app Owner notification needs a NotificationType value).
 */
export function seatRefusalMessage(input: { purchased: number; held: number; actorRole: OrgRole }): string {
  const plural = input.purchased === 1 ? 'seat' : 'seats';
  const state = `All ${input.purchased} ${plural} in this organization are taken (members and pending invitations).`;
  return input.actorRole === 'OWNER'
    ? `${state} Turn on automatic seat purchase in billing to add seats as you invite, or revoke an invitation or remove a member to free one.`
    : `${state} Ask the organization Owner to turn on automatic seat purchase or to free a seat.`;
}
