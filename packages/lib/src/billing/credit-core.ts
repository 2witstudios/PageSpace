/**
 * credit-core — the PURE decision layer for prepaid AI-credits billing.
 *
 * INVARIANT: this module has zero I/O. No db, no Stripe SDK, no env, no clock.
 * Every input is an explicit argument; every output is a value. All billing
 * decisions live here so they can be tested exhaustively and deterministically;
 * the imperative shells (credit-consume / credit-funding / credit-gate /
 * credit-backfill / the webhook) read state, call these functions, and persist
 * the result. The purity invariant is enforced by a test in __tests__.
 *
 * Money is always whole cents of customer-facing credit value. Two buckets:
 *   - monthly: the subscription allowance; RESETS each period (use-it-or-lose-it)
 *   - topup:   one-time purchased packs; NEVER expires
 * Spend always draws monthly first (it's the one that expires).
 */

import type { SubscriptionTier } from '../services/subscription-utils';

export interface Balance {
  monthlyCents: number;
  topupCents: number;
}

/**
 * Convert a real provider cost (in dollars) into the customer-facing charge in
 * whole cents, applying the markup. Non-positive or non-finite cost yields 0.
 */
export function markupCents(realCostDollars: number, markupBps: number): number {
  if (!Number.isFinite(realCostDollars) || realCostDollars <= 0) return 0;
  return Math.round(realCostDollars * (markupBps / 10000) * 100);
}

/**
 * Convert a real provider cost (dollars) into the customer-facing charge in
 * MILLICENTS (1/1000 of a cent), applying the markup. Millicents is the fine unit
 * we accumulate so that sub-cent costs aren't silently rounded down to $0 and
 * billed nothing on high-volume cheap calls. Non-positive or non-finite cost
 * yields 0. Integer-only — no float ever reaches stored state.
 */
export function chargeMillicents(realCostDollars: number, markupBps: number): number {
  if (!Number.isFinite(realCostDollars) || realCostDollars <= 0) return 0;
  return Math.round(realCostDollars * (markupBps / 10000) * 100_000);
}

export interface AccrualResult {
  /** Whole cents to debit from the balance now. */
  wholeCents: number;
  /** Sub-cent remainder to carry to the next call; always in [0, 1000). */
  newPending: number;
}

/**
 * Fold a call's charge (already in millicents) into the per-user fractional
 * remainder, yielding the whole cents to debit now and the leftover to carry.
 * This is what stops a stream of sub-cent calls from each rounding to $0: their
 * fractions accumulate in `pending` until they cross a whole cent. Inputs are
 * clamped to non-negative integers; `newPending` is always in [0, 1000).
 */
export function accruePending(pendingMillicents: number, chargeMc: number): AccrualResult {
  const total = Math.max(0, Math.round(pendingMillicents)) + Math.max(0, Math.round(chargeMc));
  const wholeCents = Math.floor(total / 1000);
  return { wholeCents, newPending: total - wholeCents * 1000 };
}

/**
 * Convenience composition of {@link chargeMillicents} + {@link accruePending}:
 * compute a call's charge from dollars and fold it into the remainder in one step.
 */
export function accrueCharge(
  pendingMillicents: number,
  realCostDollars: number,
  markupBps: number,
): AccrualResult {
  return accruePending(pendingMillicents, chargeMillicents(realCostDollars, markupBps));
}

export interface SpendResult {
  monthlyCents: number;
  topupCents: number;
  spentMonthly: number;
  spentTopup: number;
  /** What actually left the balance (spentMonthly + spentTopup); <= amount spent. */
  appliedCents: number;
  shortfallCents: number;
}

/**
 * Draw `amountCents` from the balance, monthly bucket first then top-up.
 * Buckets clamp at zero; any uncovered remainder is reported as `shortfallCents`.
 * `appliedCents` is what truly came out of the balance — the figure the ledger
 * must record so the books reconcile against the balance delta (the uncovered
 * `shortfallCents` is owed as debt, not silently dropped).
 */
export function allocateSpend(balance: Balance, amountCents: number): SpendResult {
  const amount = Math.max(0, Math.round(amountCents));
  const spentMonthly = Math.min(balance.monthlyCents, amount);
  const afterMonthly = amount - spentMonthly;
  const spentTopup = Math.min(balance.topupCents, afterMonthly);
  const shortfallCents = afterMonthly - spentTopup;
  return {
    monthlyCents: balance.monthlyCents - spentMonthly,
    topupCents: balance.topupCents - spentTopup,
    spentMonthly,
    spentTopup,
    appliedCents: spentMonthly + spentTopup,
    shortfallCents,
  };
}

export type GateReason =
  | 'unlimited'
  | 'ok'
  | 'out_of_credits'
  | 'needs_init'
  | 'too_many_in_flight'
  // Allowed reason: the gate computed a denial but enforcement is dark-launched
  // (CREDITS_ENFORCEMENT_ENABLED=false), so the request proceeds and is still
  // metered. The shell — not evaluateGate — produces this reason.
  | 'enforcement_disabled';

export interface GateInput {
  billingEnabled: boolean;
  balance: Balance | null;
  reserveFloorCents: number;
  /**
   * Sum of this user's already-placed, non-expired holds (estimated spend on
   * calls still in flight). Subtracted from spendable so concurrent calls can't
   * collectively overshoot the balance. Defaults to 0 (no outstanding holds).
   */
  reservedCents?: number;
  /** This call's own reservation, also subtracted from spendable. Defaults to 0. */
  estCostCents?: number;
  /** Count of this user's non-expired holds (calls currently in flight). Defaults to 0. */
  inFlightCount?: number;
  /**
   * Max concurrent in-flight calls for this user. `undefined`/`null` means no cap
   * (paid tiers are bounded by credits alone). The free-tier cap stops a single
   * user from fanning out many simultaneous streams that each overshoot.
   */
  maxInFlight?: number | null;
}

export interface GateResult {
  allowed: boolean;
  reason: GateReason;
  /** Set by the gate shell when a hold row was inserted for an allowed request. */
  holdId?: string;
}

/**
 * The prepaid hard-cap decision. Billing-disabled deployments (tenant/onprem)
 * are always allowed. A missing balance row returns `needs_init` so the shell
 * can lazy-init and re-evaluate.
 *
 * Two limiters, checked in order:
 *   1. in-flight cap — deny (`too_many_in_flight`) when this user already has
 *      `maxInFlight` non-expired holds. Checked first so a user fanning out many
 *      simultaneous calls is bounded even while they still have credits.
 *   2. credits — allow only while spendable, AFTER subtracting outstanding holds
 *      and this call's own reservation, exceeds the reserve floor. The floor +
 *      per-call reservation together bound how far concurrent calls can overshoot.
 */
export function evaluateGate(input: GateInput): GateResult {
  if (!input.billingEnabled) return { allowed: true, reason: 'unlimited' };
  if (input.balance === null) return { allowed: false, reason: 'needs_init' };

  const inFlightCount = Math.max(0, input.inFlightCount ?? 0);
  if (input.maxInFlight != null && inFlightCount >= input.maxInFlight) {
    return { allowed: false, reason: 'too_many_in_flight' };
  }

  const reserved = Math.max(0, input.reservedCents ?? 0);
  const estCost = Math.max(0, input.estCostCents ?? 0);
  const spendable = input.balance.monthlyCents + input.balance.topupCents - reserved - estCost;
  if (spendable > input.reserveFloorCents) return { allowed: true, reason: 'ok' };
  return { allowed: false, reason: 'out_of_credits' };
}

/**
 * Normalize the configured per-call hold estimate into a whole-cent reservation.
 * Clamps to a non-negative integer; a non-finite or non-positive estimate yields
 * 0 (the hold still counts toward the in-flight cap, it just reserves no spend).
 */
export function reservationCents(estimateCents: number): number {
  if (!Number.isFinite(estimateCents) || estimateCents <= 0) return 0;
  return Math.round(estimateCents);
}

/**
 * Per-call chat hold estimate, in whole cents, clamped to [floorCents, ceilingCents].
 *
 * Takes a PRE-markup real-cost estimate for the call (dollars — the shell derives it
 * from the model catalog and a token estimate), applies the markup, and clamps. The
 * model-awareness lives in the dollar estimate the shell passes; this stays pure (no
 * catalog, env, or clock). The floor keeps a sub-cent call from reserving nothing; the
 * ceiling caps the reservation at the legacy flat hold so a pricey model can't lock up
 * an unbounded slice of spendable. A misconfigured ceiling below the floor coerces up
 * to the floor so the range is never inverted. Sits alongside {@link reservationCents}
 * (the flat-estimate path); this is the cost-derived path.
 */
export function estimateChatHoldCents(
  estimatedRealCostDollars: number,
  markupBps: number,
  floorCents: number,
  ceilingCents: number,
): number {
  const floor = Math.max(0, Math.round(floorCents));
  const ceiling = Math.max(floor, Math.round(ceilingCents));
  const charged = markupCents(estimatedRealCostDollars, markupBps);
  return Math.min(ceiling, Math.max(floor, charged));
}

/**
 * The instant a hold placed at `nowMs` should expire, in epoch ms. Pure (operates
 * on numbers only — the shell converts to/from Date). A hold lives long enough to
 * cover the longest stream plus its post-call settle; after that the reconcile
 * cron treats it as abandoned and sweeps it so a crashed stream's reservation
 * can't permanently shrink spendable.
 */
export function holdExpiresAt(nowMs: number, ttlMs: number): number {
  return nowMs + Math.max(0, ttlMs);
}

export interface MonthlyRefill {
  monthlyRemainingCents: number;
  monthlyAllowanceCents: number;
}

/**
 * Compute the reset state for a new billing period: remaining is reset to the
 * full tier allowance (unspent prior credits are dropped — use-it-or-lose-it).
 * Unknown tiers fall back to the free allowance.
 */
export function computeMonthlyRefill(
  tier: SubscriptionTier,
  allowanceTable: Record<SubscriptionTier, number>,
): MonthlyRefill {
  const allowance = allowanceTable[tier] ?? allowanceTable.free;
  return { monthlyRemainingCents: allowance, monthlyAllowanceCents: allowance };
}

/**
 * Add a purchased credit pack to the top-up bucket. The monthly bucket is never
 * touched. A negative pack amount is a programming error and throws.
 */
export function applyTopup(currentTopupCents: number, packCents: number): number {
  if (!Number.isFinite(packCents) || packCents < 0) {
    throw new Error(`applyTopup: packCents must be a non-negative number, got ${packCents}`);
  }
  return currentTopupCents + Math.round(packCents);
}

export type StripeAction =
  | { kind: 'monthly_refill' }
  | { kind: 'topup'; packCents: number }
  | { kind: 'tier_change' }
  | { kind: 'ignore' };

/**
 * Structural subset of a Stripe.Event we need to route funding. Kept minimal so
 * this stays pure and trivially testable without the Stripe SDK types.
 */
export interface ClassifiableEvent {
  type: string;
  data: {
    object: {
      mode?: string | null;
      metadata?: Record<string, string> | null;
    };
  };
}

/**
 * Map a Stripe webhook event to the funding action it should trigger.
 *   invoice.paid                       -> monthly_refill (subscription renewal)
 *   checkout.session.completed (pack)  -> topup
 *   customer.subscription.*            -> tier_change
 *   everything else                    -> ignore
 */
export function classifyStripeEvent(event: ClassifiableEvent): StripeAction {
  if (event.type === 'invoice.paid') {
    return { kind: 'monthly_refill' };
  }
  if (event.type === 'checkout.session.completed') {
    const obj = event.data.object;
    if (obj.mode === 'payment' && obj.metadata?.kind === 'credit_pack') {
      // Strict: only a canonical unsigned-integer string credits. parseInt would
      // accept "2500usd"; for a money amount from event metadata we require digits.
      const raw = obj.metadata.packCents ?? '';
      if (/^\d+$/.test(raw)) {
        const packCents = Number.parseInt(raw, 10);
        if (packCents > 0) return { kind: 'topup', packCents };
      }
    }
    return { kind: 'ignore' };
  }
  if (
    event.type === 'customer.subscription.updated' ||
    event.type === 'customer.subscription.created'
  ) {
    return { kind: 'tier_change' };
  }
  return { kind: 'ignore' };
}

export interface PendingLedgerRow {
  id: string;
}

export interface OrphanUsageRow {
  aiUsageLogId: string;
  userId: string;
  costDollars: number;
}

export type BackfillAction =
  | { kind: 'retry_pending'; ledgerId: string }
  | { kind: 'apply_orphan'; aiUsageLogId: string; userId: string; costDollars: number };

/**
 * Plan the reconcile work: retry every unsettled ('pending') ledger row, then
 * apply a decrement for every usage row that has no ledger entry at all. The
 * DB query is responsible for selection (status/age/orphan); this just maps the
 * already-filtered rows into actions so the cron shell stays dumb.
 */
export function computeBackfillActions(
  pending: PendingLedgerRow[],
  orphans: OrphanUsageRow[],
): BackfillAction[] {
  return [
    ...pending.map((row): BackfillAction => ({ kind: 'retry_pending', ledgerId: row.id })),
    ...orphans.map((row): BackfillAction => ({
      kind: 'apply_orphan',
      aiUsageLogId: row.aiUsageLogId,
      userId: row.userId,
      costDollars: row.costDollars,
    })),
  ];
}
