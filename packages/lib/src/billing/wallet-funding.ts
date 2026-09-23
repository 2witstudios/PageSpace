/**
 * wallet-funding — the PURE decisions for putting money into wallets (Spec MON-3,
 * WAL-3, WAL-4; decisions D-OW-12, D-OW-13).
 *
 *   - Org pool refill (MON-3): an org invoice paid refills the pool with
 *     (Business base + extra-seat items) paid × ratio, through the same money-model
 *     derivation a personal invoice uses. No second constant.
 *   - Allocation reset (D-OW-12): a child wallet's allocation resets when its
 *     governing period starts — the pool's refill date under an org, the personal
 *     renewal under a person. Two clocks, never collapsed into one.
 *   - Donation (WAL-4, D-OW-13): a one-off amount from the donor's personal root
 *     wallet into a drive wallet the donor can see, when the drive allows it. The
 *     donation lands as funds that last until spent and has no way back out.
 *
 * INVARIANT: zero I/O, like wallet-core. The caller supplies `nowMs` and every row it
 * read; wallet-funding-shell.ts does the reads and writes. Money is whole cents of
 * credit value; credit counts only enter through money-model (MON-5).
 */

import { allocateSpend, applyPaymentToDebt, computeMonthlyRefill, type Balance } from './credit-core';
import type { InvoiceGrant } from './invoice-grant';
import { MONEY_MODEL_V2_ACTIVE, allowanceCentsForPaidCents, centsFromDollars, tierListPriceCents } from './money-model';
import { TIER_PLAN_LIMITS } from './subscription-tiers';
import {
  allocateWalletSpend,
  type FundingLeg,
  governingAllocationPeriodStartMs,
  isAllocationResetDue,
  renewWalletAllocation,
  utcMonthStartMs,
  walletStatusFor,
  type WalletStatus,
} from './wallet-core';

// ---------------------------------------------------------------------------
// Org pool refill (MON-3)
// ---------------------------------------------------------------------------

/** The tier an org pool is always sized at: Business is the org plan (SEAT-2). */
export const ORG_POOL_TIER = 'business' as const;

/**
 * [D-OW-23] PENDING (Jono): D-OW-16 extended to orgs. A trial or gifted ORG
 * subscription pays nothing, and the literal MON-3 refill would leave the Business
 * trial with an empty pool; with this on, such an invoice funds the pool at LIST
 * price × ratio, exactly as a personal trial or gift is funded. This is the one line
 * that reverses the policy: set it to false and a trial or gift org invoice grants
 * nothing — a trial pays 0 and a gift is a 100%-coupon subscription whose lines net to
 * 0, and the refill is sized from what was PAID. Every trial/gift amount comes from
 * {@link orgPoolListPriceGrantCents}.
 */
export const ORG_POOL_FUNDS_TRIALS_AND_GIFTS = true;

/**
 * The pool grant for an org subscription we fund ourselves (trial or gift): the
 * Business list price for the base plus `extraSeats` extra seats at the list seat
 * price, times the Business ratio. Integer cents; multiply before any divide.
 */
export function orgPoolListPriceGrantCents(extraSeats: number, active: boolean = MONEY_MODEL_V2_ACTIVE): number {
  const seats = Number.isInteger(extraSeats) && extraSeats > 0 ? extraSeats : 0;
  const listCents =
    tierListPriceCents(ORG_POOL_TIER) + centsFromDollars(TIER_PLAN_LIMITS[ORG_POOL_TIER].extraSeatUsd) * seats;
  return allowanceCentsForPaidCents(listCents, ORG_POOL_TIER, active);
}

/**
 * Structural subset of a Stripe invoice line the pool refill reads. `amount` is the
 * line total BEFORE discounts (signed: proration credits are negative); what a coupon
 * took off that line is in `discount_amounts`.
 */
export interface OrgInvoiceLine {
  amount?: number | null;
  discount_amounts?: ReadonlyArray<{ amount?: number | null } | null> | null;
}

export interface OrgPoolRefillInput {
  /** The org subscription invoice's line items: the Business base and the extra-seat items. */
  lines: ReadonlyArray<OrgInvoiceLine | null | undefined>;
  /** Stripe invoice.amount_paid: what was actually collected (tax included), minor units. */
  amountPaidCents: number | null | undefined;
  /**
   * Whether the invoice was generated for a subscription (invoice.parent.subscription_details).
   * A manual or one-off invoice never refills a pool, whatever it paid — the same
   * security gate the personal grant applies. Fails closed.
   */
  hasSubscriptionParent: boolean;
  /** Stripe invoice.billing_reason. */
  billingReason?: string | null;
  /** Stripe invoice.subtotal: 0 on a trial-create invoice, the list price under a 100% coupon. */
  subtotalCents?: number | null;
  /** The org subscription was gifted by an admin. */
  gifted?: boolean;
  /** Extra seats on the subscription, for sizing a trial or gift at list price. */
  extraSeats?: number;
}

function wholeCents(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
}

/**
 * What the org PAID for the subscription's lines: each line net of its discounts,
 * summed (proration credits net in), and never more than the invoice actually
 * collected — so a coupon, a customer-balance credit or a partial payment all shrink
 * the refill, and tax (in amount_paid, not in the lines) never grows it.
 */
export function orgInvoicePaidCents(input: Pick<OrgPoolRefillInput, 'lines' | 'amountPaidCents'>): number {
  let net = 0;
  for (const line of input.lines) {
    net += wholeCents(line?.amount);
    for (const discount of line?.discount_amounts ?? []) net -= wholeCents(discount?.amount);
  }
  return Math.max(0, Math.min(net, wholeCents(input.amountPaidCents)));
}

/**
 * MON-3: size the pool refill from what the org invoice PAID for its lines (the
 * Business base and the extra seats), net of discounts, times the Business ratio. More
 * seats paid means a bigger pool through the same derivation, with no second constant.
 * A trial (paid 0, subtotal 0, subscription_create) or a gifted org subscription is
 * funded at list price × ratio only while `fundTrialsAndGifts` is on ([D-OW-23],
 * D-OW-16 extended to orgs); with it off both grant nothing, because both paid
 * nothing. A 100% coupon on a non-gifted subscription grants nothing (D-OW-16d).
 * `active` (D-OW-17) defaults to the money-model constant.
 */
export function orgPoolRefillGrant(
  input: OrgPoolRefillInput,
  active: boolean = MONEY_MODEL_V2_ACTIVE,
  fundTrialsAndGifts: boolean = ORG_POOL_FUNDS_TRIALS_AND_GIFTS,
): InvoiceGrant {
  const paidCents = orgInvoicePaidCents(input);
  if (input.hasSubscriptionParent !== true) {
    return { paidCents, allowanceCents: 0, basis: 'none', reason: 'not_a_subscription_invoice' };
  }
  if (fundTrialsAndGifts) {
    const trial = input.billingReason === 'subscription_create' && paidCents === 0 && wholeCents(input.subtotalCents) === 0;
    const funded = input.gifted === true ? 'gifted' : trial ? 'trial' : null;
    if (funded !== null) {
      const allowanceCents = orgPoolListPriceGrantCents(input.extraSeats ?? 0, active);
      return allowanceCents > 0
        ? { paidCents, allowanceCents, basis: 'list', reason: funded }
        : { paidCents, allowanceCents: 0, basis: 'none', reason: 'no_ratio' };
    }
  }
  if (paidCents === 0) return { paidCents, allowanceCents: 0, basis: 'none', reason: 'zero_amount' };
  const allowanceCents = allowanceCentsForPaidCents(paidCents, ORG_POOL_TIER, active);
  return allowanceCents > 0
    ? { paidCents, allowanceCents, basis: 'paid', reason: 'paid' }
    : { paidCents, allowanceCents: 0, basis: 'none', reason: 'no_ratio' };
}

export interface PoolBalance {
  monthlyRemainingCents: number;
  debtCents: number;
}

export interface PoolRefillWrite {
  monthlyRemainingCents: number;
  monthlyAllowanceCents: number;
  debtCents: 0;
}

/**
 * The pool after a refill lands: the same rollover rule as a personal renewal (debt
 * netted against the carry, then the grant added; debt beyond that is forgiven,
 * WAL-6d).
 */
export function refillPool(pool: PoolBalance | null, allowanceCents: number): PoolRefillWrite {
  return computeMonthlyRefill(allowanceCents, pool?.monthlyRemainingCents ?? 0, pool?.debtCents ?? 0);
}

/**
 * The service period an invoice pays for, from its line items: the line with the
 * LATEST period end (a plan-change invoice carries proration lines for the old plan
 * beside the new plan's full period). Stripe's invoice-level period describes the
 * cycle that just ended, so it is only the fallback. Seconds in, epoch ms out.
 */
export function invoiceServicePeriodMs(input: {
  lines: ReadonlyArray<{ period?: { start?: number | null; end?: number | null } | null } | null | undefined>;
  periodStart?: number | null;
  periodEnd?: number | null;
}): { startMs: number | null; endMs: number | null } {
  const ms = (s: number | null | undefined): number | null =>
    typeof s === 'number' && Number.isFinite(s) ? s * 1000 : null;
  let startMs: number | null = null;
  let endMs: number | null = null;
  for (const line of input.lines) {
    const lineStart = ms(line?.period?.start);
    const lineEnd = ms(line?.period?.end);
    if (lineStart !== null && lineEnd !== null && (endMs === null || lineEnd > endMs)) {
      startMs = lineStart;
      endMs = lineEnd;
    }
  }
  return { startMs: startMs ?? ms(input.periodStart), endMs: endMs ?? ms(input.periodEnd) };
}

// ---------------------------------------------------------------------------
// Allocation reset (D-OW-12)
// ---------------------------------------------------------------------------

/** The root wallet whose period governs a child allocation: the org pool or a personal wallet. */
export interface GoverningRoot {
  ownerType: 'org' | 'user';
  periodStartMs: number | null;
  periodEndMs: number | null;
}

export interface ChildAllocation {
  periodStartMs: number | null;
  allocationCents: number;
  spentCents: number;
  debtCents: number;
  paused: boolean;
}

export type AllocationResetPlan =
  | { due: false }
  | {
      due: true;
      periodStartMs: number;
      periodEndMs: number;
      spentCents: number;
      debtCents: 0;
      status: WalletStatus;
    };

function nextUtcMonthStartMs(nowMs: number): number {
  const d = new Date(utcMonthStartMs(nowMs));
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/**
 * The governing root's CURRENT period. A root that is still inside its period governs
 * with it. A root whose period ended without a renewal (a late or lapsed invoice, a
 * Free personal root that never refills) is rolled forward by whole periods of its own
 * length, starting exactly at its period end — which is where the renewal Stripe will
 * stamp begins, so a renewal that arrives late lands on the SAME start and resets
 * nothing twice. Without that roll the anchor would freeze and every allocation under
 * it would stay exhausted forever. A root never refilled governs with the UTC calendar
 * month (D20).
 */
export function currentGoverningPeriodMs(governing: GoverningRoot, nowMs: number): { startMs: number; endMs: number } {
  const start = governing.periodStartMs;
  const end = governing.periodEndMs;
  if (start === null) {
    const monthStart = utcMonthStartMs(nowMs);
    return { startMs: monthStart, endMs: nextUtcMonthStartMs(monthStart) };
  }
  if (end === null || end <= start) return { startMs: start, endMs: nextUtcMonthStartMs(start) };
  if (nowMs < end) return { startMs: start, endMs: end };
  const length = end - start;
  const rolledStart = end + Math.floor((nowMs - end) / length) * length;
  return { startMs: rolledStart, endMs: rolledStart + length };
}

/**
 * D-OW-12: whether a child allocation resets now, and to what. The period comes from
 * its governing root — the pool's refill date under an org, the personal renewal under
 * a person — see {@link currentGoverningPeriodMs}. A reset puts spend back to zero,
 * nets the wallet debt against the new allocation and clears it (WAL-6d), and never
 * touches top-ups or donations (WAL-3: they last until spent).
 *
 * Idempotent by construction: once the wallet carries the governing period start, the
 * same period is never due again, however many times this runs.
 */
export function planAllocationReset(input: {
  wallet: ChildAllocation;
  governing: GoverningRoot;
  nowMs: number;
}): AllocationResetPlan {
  const current = currentGoverningPeriodMs(input.governing, input.nowMs);
  const governingStartMs = governingAllocationPeriodStartMs({
    rootOwner: input.governing.ownerType,
    poolPeriodStartMs: input.governing.ownerType === 'org' ? current.startMs : null,
    personalPeriodStartMs: input.governing.ownerType === 'user' ? current.startMs : null,
    nowMs: input.nowMs,
  });
  // A governing period that has not begun yet is not this period.
  if (governingStartMs > input.nowMs) return { due: false };
  if (
    input.wallet.periodStartMs !== null &&
    !isAllocationResetDue({ walletPeriodStartMs: input.wallet.periodStartMs, governingPeriodStartMs: governingStartMs })
  ) {
    return { due: false };
  }

  const periodEndMs = current.endMs;
  const renewed = renewWalletAllocation(
    {
      allocationCents: input.wallet.allocationCents,
      allocationSpentCents: input.wallet.spentCents,
      topupLegs: [],
      debtCents: input.wallet.debtCents,
    },
    input.wallet.allocationCents,
  );
  return {
    due: true,
    periodStartMs: governingStartMs,
    periodEndMs,
    spentCents: renewed.allocationSpentCents,
    debtCents: 0,
    status: walletStatusFor({ paused: input.wallet.paused, debtCents: 0 }),
  };
}

// ---------------------------------------------------------------------------
// Funding legs (WAL-3, D-OW-13)
// ---------------------------------------------------------------------------

/** A wallet_funding_legs row as the shell reads it. */
export interface StoredFundingLeg {
  id: string;
  funderKind: 'owner' | 'donation';
  funderUserId: string | null;
  remainingCents: number;
  nonRefundable: boolean;
  createdAtMs: number;
}

/**
 * The defined draw order: FIFO by arrival (createdAt), then id, across owner top-ups
 * and donations alike, so no funder's money is preferred over another's.
 */
export function orderFundingLegs<L extends { id: string; createdAtMs: number }>(legs: readonly L[]): L[] {
  return [...legs].sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The stored row as wallet-core's `FundingLeg` (legId = id, funder = funderKind). */
export function toFundingLeg(leg: StoredFundingLeg): FundingLeg {
  return {
    legId: leg.id,
    funder: leg.funderKind,
    donorUserId: leg.funderKind === 'donation' ? leg.funderUserId : null,
    remainingCents: leg.remainingCents,
  };
}

export interface LegDrawResult {
  draws: { legId: string; cents: number }[];
  /** Every leg's remaining after the draw, in draw order. */
  legs: FundingLeg[];
  appliedCents: number;
  shortfallCents: number;
}

/**
 * Draw `amountCents` from a wallet's funding legs in the defined order, through
 * wallet-core's own leg draw (allocateWalletSpend with no allocation), so the gate
 * and this module cannot disagree about how a leg is spent.
 */
export function drawFundingLegs(legs: readonly StoredFundingLeg[], amountCents: number): LegDrawResult {
  const drawn = allocateWalletSpend({
    parent: { monthlyCents: 0, topupCents: 0 },
    wallet: { allocationCents: 0, allocationSpentCents: 0, topupLegs: orderFundingLegs(legs).map(toFundingLeg), debtCents: 0 },
    amountCents,
  });
  return {
    draws: drawn.legDraws,
    legs: drawn.wallet.topupLegs.map((leg) => ({ ...leg })),
    appliedCents: drawn.appliedCents,
    shortfallCents: drawn.shortfallCents,
  };
}

export type LegRefundPlan =
  | { kind: 'refund'; legId: string; cents: number; remainingCents: number }
  | { kind: 'refuse'; legId: string; reason: 'donation_non_refundable' | 'non_refundable' | 'invalid_amount' | 'exceeds_remaining' };

/**
 * D-OW-13: a refund never draws from a donation leg — not when the wallet is deleted,
 * not when its drive leaves the org, not ever. Only an owner leg marked refundable
 * gives back, and never more than it still holds.
 */
export function planLegRefund(leg: StoredFundingLeg, cents: number): LegRefundPlan {
  if (leg.funderKind === 'donation') return { kind: 'refuse', legId: leg.id, reason: 'donation_non_refundable' };
  if (leg.nonRefundable) return { kind: 'refuse', legId: leg.id, reason: 'non_refundable' };
  if (!Number.isInteger(cents) || cents <= 0) return { kind: 'refuse', legId: leg.id, reason: 'invalid_amount' };
  if (cents > leg.remainingCents) return { kind: 'refuse', legId: leg.id, reason: 'exceeds_remaining' };
  return { kind: 'refund', legId: leg.id, cents, remainingCents: leg.remainingCents - cents };
}

// ---------------------------------------------------------------------------
// Donations (WAL-4, D-OW-13)
// ---------------------------------------------------------------------------

export interface DonorWallet {
  walletId: string;
  /** Must be the donor's personal root wallet: a donation is "from their own balance". */
  isPersonalRoot: boolean;
  balance: Balance;
  /** The donor's outstanding holds on that wallet (calls in flight). */
  heldCents: number;
}

export interface DonationTarget {
  walletId: string;
  subjectType: 'drive' | 'agent_page' | null;
  donationsEnabled: boolean;
  /** SUM of the wallet's funding legs' remaining (mirrored on wallets.topupRemainingCents). */
  legsRemainingCents: number;
  debtCents: number;
}

export interface DonationInput {
  amountCents: number;
  /** Decided by the permissions module: the donor can see the drive the wallet funds. */
  donorCanSeeDrive: boolean;
  donor: DonorWallet;
  target: DonationTarget;
}

export type DonationRefusal =
  | 'invalid_amount'
  | 'not_a_drive_wallet'
  | 'cannot_see_drive'
  | 'donations_disabled'
  | 'not_personal_wallet'
  | 'same_wallet'
  | 'insufficient_funds';

export type DonationPlan =
  | {
      kind: 'donate';
      amountCents: number;
      donor: { monthlyRemainingCents: number; topupRemainingCents: number; spentMonthly: number; spentTopup: number };
      /** The new donation leg: the whole gift, less whatever paid the wallet's debt. */
      leg: { originalCents: number; remainingCents: number; nonRefundable: true };
      target: { topupRemainingCents: number; debtCents: number; paidDebtCents: number };
    }
  | { kind: 'refuse'; reason: DonationRefusal };

/**
 * WAL-4: plan a one-off donation. Refused unless the amount is a positive whole number
 * of cents, the target is a drive wallet, the donor can see that drive, the drive has
 * donations on, the source is the donor's own personal wallet, and that wallet covers
 * the whole amount now (net of debt and in-flight holds) — a donation never puts the
 * donor into debt and is never partial.
 *
 * The donor's balance is drawn monthly first, then top-up (the spend order). The drive
 * wallet receives it as its own non-refundable funding leg (D-OW-13) that lasts until
 * spent (WAL-3), paying the wallet's debt first exactly as a top-up does.
 */
export function planDonation(input: DonationInput): DonationPlan {
  const amount = input.amountCents;
  if (!Number.isInteger(amount) || amount <= 0) return { kind: 'refuse', reason: 'invalid_amount' };
  if (input.target.subjectType !== 'drive') return { kind: 'refuse', reason: 'not_a_drive_wallet' };
  if (!input.donorCanSeeDrive) return { kind: 'refuse', reason: 'cannot_see_drive' };
  if (!input.target.donationsEnabled) return { kind: 'refuse', reason: 'donations_disabled' };
  if (!input.donor.isPersonalRoot) return { kind: 'refuse', reason: 'not_personal_wallet' };
  if (input.donor.walletId === input.target.walletId) return { kind: 'refuse', reason: 'same_wallet' };

  const b = input.donor.balance;
  const available =
    b.monthlyCents + b.topupCents - Math.max(0, b.debtCents ?? 0) - Math.max(0, Math.round(input.donor.heldCents));
  if (available < amount) return { kind: 'refuse', reason: 'insufficient_funds' };

  const draw = allocateSpend(b, amount);
  const landed = applyPaymentToDebt(input.target.debtCents, input.target.legsRemainingCents, amount);
  return {
    kind: 'donate',
    amountCents: amount,
    donor: {
      monthlyRemainingCents: draw.monthlyCents,
      topupRemainingCents: draw.topupCents,
      spentMonthly: draw.spentMonthly,
      spentTopup: draw.spentTopup,
    },
    leg: { originalCents: amount, remainingCents: amount - landed.paidDebt, nonRefundable: true },
    target: { topupRemainingCents: landed.topupCents, debtCents: landed.debtCents, paidDebtCents: landed.paidDebt },
  };
}
