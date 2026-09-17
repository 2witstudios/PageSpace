/**
 * wallet-core — the PURE decision layer for wallets (Spec WAL-3, WAL-6, WAL-7, SPEND-1,
 * SPEND-4, SPEND-5, SPEND-6, POL-7; decisions D-OW-4, D-OW-12, D-OW-13, D-OW-14).
 *
 * INVARIANT: zero I/O. No db, no Stripe, no env, no clock. Every input is an explicit
 * argument (the caller supplies `nowMs`), every output a value. The wallets schema (C1)
 * and the credit gate (C3) read state, call these functions, and persist the result.
 * Purity is enforced by a test in __tests__/wallet-core.test.ts.
 *
 * Money is whole cents of credit VALUE, as everywhere in billing. Credit counts only
 * enter through the money-model module (`centsFromCredits`); this file defines no
 * conversion of its own (MON-5 seam guard).
 */

import { centsFromCredits } from './money-model';
import { allocateSpend, evaluateDailyCap, type Balance, type SpendResult } from './credit-core';

// ---------------------------------------------------------------------------
// Spend resolution (SPEND-1, SPEND-4, SPEND-5, SPEND-6, D-OW-4)
// ---------------------------------------------------------------------------

/** The three sources an AI call inside a drive can spend from (SPEND-1). */
export type SpendSourceKind = 'drive_wallet' | 'seat_allowance' | 'own_credits';

/** WAL-1 wallet status. `paused` is the kill switch (WAL-7); `over` carries debt (WAL-6e). */
export type WalletStatus = 'active' | 'paused' | 'over';

/** What happens when the chosen source is empty (POL-7). */
export type FallbackRule = 'refuse' | 'seat_allowance' | 'own_credits';

/**
 * One source as the caller sees it for THIS consumer right now. `spendableCents` is
 * already net of debt, holds, and the consumer's caps — see {@link childSpendableCents}
 * and {@link legSpendableCents}.
 */
export interface SpendLeg {
  walletId: string;
  status: WalletStatus;
  spendableCents: number;
}

export type SpendActor =
  | { kind: 'person'; userId: string; isGuest: boolean }
  /** Automations, triggers, scheduled workflows, channel mentions: the consumer is the drive (SPEND-6). */
  | { kind: 'automation'; driveId: string };

export interface DriveSpendRule {
  /** The effective fallback for this drive (see {@link effectiveSpendPolicy}). */
  fallback: FallbackRule;
  /** D-OW-4: guests may spend the drive wallet only when the drive turns this on. Default off. */
  guestsMaySpendDriveWallet: boolean;
}

/** SPEND-5 "Always my own credits": one global switch and one per drive. Either is absolute. */
export interface UserSpendOverride {
  alwaysOwnCredits: boolean;
  alwaysOwnCreditsInDrive: boolean;
}

export interface ResolveSpendSourceInput {
  actor: SpendActor;
  /** Null when the drive has no wallet. */
  driveWallet: SpendLeg | null;
  /** Null outside an org drive or for anyone without a seat. */
  seatAllowance: SpendLeg | null;
  /** The caller's personal root wallet. */
  personal: SpendLeg | null;
  /** The source chosen before the call (SPEND-3 preselection happens upstream). */
  chosen: SpendSourceKind | null;
  driveRule: DriveSpendRule;
  userOverride: UserSpendOverride;
  /** This call's reservation, whole cents; a source covers the call only if it covers this. */
  reservationCents: number;
}

export type RefusalReason =
  | 'no_source_chosen'
  | 'source_empty'
  | 'source_paused'
  | 'source_unavailable'
  | 'guest_drive_wallet_off';

export type SkipReason = 'drive_wallet_empty' | 'drive_wallet_paused' | 'no_drive_wallet';

export interface SpendOption {
  source: SpendSourceKind;
  walletId: string;
}

export type SpendResolution =
  | {
      kind: 'spend';
      source: SpendSourceKind;
      walletId: string;
      /** True only when a drive rule moved the call off the chosen source; the chip and strip must show it. */
      fallbackApplied: boolean;
      fallbackFrom: SpendSourceKind | null;
    }
  | {
      kind: 'refuse';
      /** The source that was refused, named for the refusal card; null when none was chosen. */
      source: SpendSourceKind | null;
      reason: RefusalReason;
      /** The other sources this consumer may pick that cover the call. */
      options: SpendOption[];
      chargeCents: 0;
    }
  | { kind: 'skip'; reason: SkipReason; walletId: string | null; chargeCents: 0 };

const SOURCE_ORDER: readonly SpendSourceKind[] = ['drive_wallet', 'seat_allowance', 'own_credits'];

function covers(leg: SpendLeg, reservationCents: number): boolean {
  const reservation = Math.max(0, Math.round(reservationCents));
  return leg.status !== 'paused' && leg.spendableCents > 0 && leg.spendableCents >= reservation;
}

/** The leg for `source` if this person may spend it at all, else why not. */
function legFor(
  input: ResolveSpendSourceInput,
  source: SpendSourceKind,
): { leg: SpendLeg } | { unavailable: 'source_unavailable' | 'guest_drive_wallet_off' } {
  const isGuest = input.actor.kind === 'person' && input.actor.isGuest;
  if (source === 'drive_wallet') {
    if (isGuest && !input.driveRule.guestsMaySpendDriveWallet) return { unavailable: 'guest_drive_wallet_off' };
    return input.driveWallet ? { leg: input.driveWallet } : { unavailable: 'source_unavailable' };
  }
  if (source === 'seat_allowance') {
    // DRV-8: guests hold no seat.
    if (isGuest) return { unavailable: 'source_unavailable' };
    return input.seatAllowance ? { leg: input.seatAllowance } : { unavailable: 'source_unavailable' };
  }
  return input.personal ? { leg: input.personal } : { unavailable: 'source_unavailable' };
}

function coveredLeg(input: ResolveSpendSourceInput, source: SpendSourceKind): SpendLeg | null {
  const found = legFor(input, source);
  return 'leg' in found && covers(found.leg, input.reservationCents) ? found.leg : null;
}

function optionsExcept(input: ResolveSpendSourceInput, excluded: SpendSourceKind | null): SpendOption[] {
  const options: SpendOption[] = [];
  for (const source of SOURCE_ORDER) {
    if (source === excluded) continue;
    const leg = coveredLeg(input, source);
    if (leg) options.push({ source, walletId: leg.walletId });
  }
  return options;
}

function refuse(source: SpendSourceKind | null, reason: RefusalReason, options: SpendOption[]): SpendResolution {
  return { kind: 'refuse', source, reason, options, chargeCents: 0 };
}

/**
 * Decide the ONE wallet an AI call spends from, before the call.
 *
 * - Automations spend the drive wallet only; an uncovered drive wallet SKIPS the run.
 *   Chosen source, override, and fallback rule are ignored: an automation never spends a
 *   person's credits or allowance (SPEND-6).
 * - "Always my own credits" (either switch) is absolute: own credits or refuse, never a
 *   fallback, and no other source is offered (SPEND-5).
 * - Otherwise the chosen source spends if it covers the reservation. If it is EMPTY
 *   (uncovered or paused) the drive rule may name a fallback; only a covered, permitted
 *   fallback other than the chosen source is used, and the result says
 *   `fallbackApplied: true`. Anything else refuses, names the source, offers the covered
 *   remaining options, and charges zero (SPEND-4). A source this person may not spend
 *   (a guest and the drive wallet with the switch off, D-OW-4; a guest and a seat) is
 *   refused without fallback.
 */
export function resolveSpendSource(input: ResolveSpendSourceInput): SpendResolution {
  if (input.actor.kind === 'automation') {
    const wallet = input.driveWallet;
    if (!wallet) return { kind: 'skip', reason: 'no_drive_wallet', walletId: null, chargeCents: 0 };
    if (wallet.status === 'paused') {
      return { kind: 'skip', reason: 'drive_wallet_paused', walletId: wallet.walletId, chargeCents: 0 };
    }
    if (!covers(wallet, input.reservationCents)) {
      return { kind: 'skip', reason: 'drive_wallet_empty', walletId: wallet.walletId, chargeCents: 0 };
    }
    return { kind: 'spend', source: 'drive_wallet', walletId: wallet.walletId, fallbackApplied: false, fallbackFrom: null };
  }

  const overridden = input.userOverride.alwaysOwnCredits || input.userOverride.alwaysOwnCreditsInDrive;
  const chosen: SpendSourceKind | null = overridden ? 'own_credits' : input.chosen;
  if (chosen === null) return refuse(null, 'no_source_chosen', optionsExcept(input, null));

  const found = legFor(input, chosen);
  const offered = (): SpendOption[] => (overridden ? [] : optionsExcept(input, chosen));
  if (!('leg' in found)) return refuse(chosen, found.unavailable, offered());
  if (covers(found.leg, input.reservationCents)) {
    return { kind: 'spend', source: chosen, walletId: found.leg.walletId, fallbackApplied: false, fallbackFrom: null };
  }

  const fallback = input.driveRule.fallback;
  if (!overridden && fallback !== 'refuse' && fallback !== chosen) {
    const fallbackLeg = coveredLeg(input, fallback);
    if (fallbackLeg) {
      return { kind: 'spend', source: fallback, walletId: fallbackLeg.walletId, fallbackApplied: true, fallbackFrom: chosen };
    }
  }
  return refuse(chosen, found.leg.status === 'paused' ? 'source_paused' : 'source_empty', offered());
}

// ---------------------------------------------------------------------------
// Policy (POL-7): a drive may only be stricter than its org
// ---------------------------------------------------------------------------

export interface SpendPolicy {
  /** Per-consumer monthly seat allowance, whole cents; null = unlimited within the pool. */
  seatAllowanceCents: number | null;
  fallback: FallbackRule;
}

/**
 * The policy in force for a drive. A drive seat allowance can only lower the org's. A
 * drive fallback applies only when it restates the org rule or is `refuse`; any other
 * drive rule resolves to `refuse`, because no fallback is stricter than refusing and
 * spending nothing is the only outcome that cannot loosen the org.
 */
export function effectiveSpendPolicy(org: SpendPolicy, drive: Partial<SpendPolicy> | null): SpendPolicy {
  const driveAllowance = drive?.seatAllowanceCents;
  const seatAllowanceCents =
    driveAllowance === undefined || driveAllowance === null
      ? org.seatAllowanceCents
      : org.seatAllowanceCents === null
        ? driveAllowance
        : Math.min(org.seatAllowanceCents, driveAllowance);

  const driveFallback = drive?.fallback;
  const fallback: FallbackRule =
    driveFallback === undefined || driveFallback === org.fallback ? org.fallback : 'refuse';

  return { seatAllowanceCents, fallback };
}

// ---------------------------------------------------------------------------
// Allocation math (WAL-3, D-OW-13)
// ---------------------------------------------------------------------------

/**
 * A funding leg that moved funds INTO the wallet and lasts until spent (WAL-3): the
 * owner's top-up or a donation (WAL-4). D-OW-13: each donation is its own leg with its
 * donor, so what it funded is attributable and it is never pooled into the owner's.
 */
export interface FundingLeg {
  legId: string;
  funder: 'owner' | 'donation';
  donorUserId: string | null;
  remainingCents: number;
}

/** The funds of a child wallet (a drive wallet under an org pool or a personal wallet). */
export interface WalletFunds {
  /** This period's allocation: a budget drawn against the parent, never moved out of it. */
  allocationCents: number;
  allocationSpentCents: number;
  /** Drawn in the order given, after the allocation. */
  topupLegs: readonly FundingLeg[];
  /** Wallet debt (WAL-6c), a non-negative magnitude netted from the next allocation. */
  debtCents: number;
}

function wholeNonNegative(cents: number): number {
  return Number.isFinite(cents) ? Math.max(0, Math.round(cents)) : 0;
}

function allocationRemainingCents(wallet: WalletFunds): number {
  return Math.max(0, wholeNonNegative(wallet.allocationCents) - wholeNonNegative(wallet.allocationSpentCents));
}

function balanceAvailableCents(balance: Balance): number {
  return balance.monthlyCents + balance.topupCents - Math.max(0, balance.debtCents ?? 0);
}

/**
 * What a child wallet can spend now: its remaining allocation (no more than the parent
 * can cover), plus its funding legs, less its debt. Never negative.
 */
export function childSpendableCents(wallet: WalletFunds, parentAvailableCents: number): number {
  const fromAllocation = Math.min(allocationRemainingCents(wallet), Math.max(0, parentAvailableCents));
  const fromLegs = wallet.topupLegs.reduce((sum, leg) => sum + wholeNonNegative(leg.remainingCents), 0);
  return Math.max(0, fromAllocation + fromLegs - wholeNonNegative(wallet.debtCents));
}

export interface CapRemaining {
  dailyRemainingCents: number | null;
  monthlyRemainingCents: number | null;
}

/** A consumer's spendable on one wallet leg: the wallet's spendable, bounded by their caps (WAL-7). */
export function legSpendableCents(walletSpendableCents: number, caps: CapRemaining): number {
  let spendable = Math.max(0, walletSpendableCents);
  if (caps.dailyRemainingCents !== null) spendable = Math.min(spendable, Math.max(0, caps.dailyRemainingCents));
  if (caps.monthlyRemainingCents !== null) spendable = Math.min(spendable, Math.max(0, caps.monthlyRemainingCents));
  return spendable;
}

export interface WalletSpendInput {
  parent: Balance;
  wallet: WalletFunds;
  amountCents: number;
}

export interface WalletSpendResult {
  /** The parent after the allocation draw (credit-core allocateSpend: monthly, then top-up). */
  parent: Balance;
  wallet: WalletFunds;
  allocationDrawCents: number;
  parentDraw: SpendResult;
  legDraws: { legId: string; cents: number }[];
  /** What truly left the parent and the legs. */
  appliedCents: number;
  /** Uncovered remainder: the overshoot to settle with {@link settleOvershoot}. */
  shortfallCents: number;
}

/**
 * Draw a spend across parent and child (WAL-3): the allocation first, charged to the
 * parent as it happens and capped by what the parent can cover, then the wallet's
 * funding legs in order. Setting or holding an allocation moves nothing; only spend
 * does. Inputs are not mutated.
 */
export function allocateWalletSpend(input: WalletSpendInput): WalletSpendResult {
  const amount = wholeNonNegative(input.amountCents);
  const allocationDraw = Math.min(amount, allocationRemainingCents(input.wallet), Math.max(0, balanceAvailableCents(input.parent)));
  const parentDraw = allocateSpend(input.parent, allocationDraw);

  let remaining = amount - parentDraw.appliedCents;
  const legDraws: { legId: string; cents: number }[] = [];
  const topupLegs = input.wallet.topupLegs.map((leg) => {
    const cents = Math.min(remaining, wholeNonNegative(leg.remainingCents));
    remaining -= cents;
    if (cents > 0) legDraws.push({ legId: leg.legId, cents });
    return { ...leg, remainingCents: wholeNonNegative(leg.remainingCents) - cents };
  });

  const legTotal = legDraws.reduce((sum, d) => sum + d.cents, 0);
  return {
    parent: { ...input.parent, monthlyCents: parentDraw.monthlyCents, topupCents: parentDraw.topupCents },
    wallet: {
      ...input.wallet,
      allocationSpentCents: wholeNonNegative(input.wallet.allocationSpentCents) + parentDraw.appliedCents,
      topupLegs,
    },
    allocationDrawCents: parentDraw.appliedCents,
    parentDraw,
    legDraws,
    appliedCents: parentDraw.appliedCents + legTotal,
    shortfallCents: remaining,
  };
}

// ---------------------------------------------------------------------------
// Overshoot, debt, renewal (WAL-6)
// ---------------------------------------------------------------------------

/** WAL-6c: set by the wallet's funder. `absorb_to_parent` is the default (D20.2). */
export type OvershootFunderChoice = 'absorb_to_parent' | 'wallet_debt';
export const DEFAULT_OVERSHOOT_CHOICE: OvershootFunderChoice = 'absorb_to_parent';

export interface SettleOvershootInput {
  source: SpendSourceKind;
  overshootCents: number;
  /** The wallet the call was charged to. */
  chargedWalletId: string;
  /** Its parent; null for a root wallet (a personal wallet or an org pool). */
  parentWalletId: string | null;
  funderChoice: OvershootFunderChoice;
}

export type OvershootLanding =
  | { kind: 'none'; cents: 0 }
  /** Debt on a root wallet that was itself charged: the pool behind a seat, or own credits. */
  | { kind: 'root_debt'; walletId: string; cents: number }
  | { kind: 'parent_debt'; walletId: string; cents: number }
  | { kind: 'wallet_debt'; walletId: string; cents: number };

/**
 * Where actual-cost overshoot beyond a covered reservation lands (WAL-6b/c). It lands on
 * the consumer only when they spent their own credits; a seat's overshoot lands on the
 * pool; a drive wallet's lands where its funder chose.
 */
export function settleOvershoot(input: SettleOvershootInput): OvershootLanding {
  const cents = wholeNonNegative(input.overshootCents);
  if (cents === 0) return { kind: 'none', cents: 0 };
  if (input.source !== 'drive_wallet') return { kind: 'root_debt', walletId: input.chargedWalletId, cents };
  if (input.funderChoice === 'absorb_to_parent' && input.parentWalletId !== null) {
    return { kind: 'parent_debt', walletId: input.parentWalletId, cents };
  }
  return { kind: 'wallet_debt', walletId: input.chargedWalletId, cents };
}

/** WAL-6e / WAL-7: the kill switch wins; any debt shows "over". */
export function walletStatusFor(input: { paused: boolean; debtCents: number }): WalletStatus {
  if (input.paused) return 'paused';
  return wholeNonNegative(input.debtCents) > 0 ? 'over' : 'active';
}

/** WAL-6e: notify the funder of wallet debt once per period. */
export function shouldNotifyFunderOfDebt(input: {
  debtCents: number;
  periodStartMs: number;
  lastNotifiedAtMs: number | null;
}): boolean {
  if (wholeNonNegative(input.debtCents) === 0) return false;
  return input.lastNotifiedAtMs === null || input.lastNotifiedAtMs < input.periodStartMs;
}

/**
 * WAL-6d: the next allocation lands. Wallet debt is netted from it and cleared (debt
 * beyond the allocation is not carried further, as personal debt is forgiven at renewal
 * today). Funding legs last until spent and are untouched (WAL-3).
 */
export function renewWalletAllocation(wallet: WalletFunds, allocationCents: number): WalletFunds {
  const allocation = wholeNonNegative(allocationCents);
  return {
    ...wallet,
    allocationCents: allocation,
    allocationSpentCents: Math.min(allocation, wholeNonNegative(wallet.debtCents)),
    debtCents: 0,
  };
}

// ---------------------------------------------------------------------------
// Per-consumer caps (WAL-7)
// ---------------------------------------------------------------------------

/** Whole cents; null means unlimited within the wallet. */
export interface ConsumerCaps {
  dailyCents: number | null;
  monthlyCents: number | null;
}

/** Defaults on enable: 10 credits a day, 100 a month (D20.5 restated in credits). */
export const DEFAULT_CONSUMER_CAPS: ConsumerCaps = {
  dailyCents: centsFromCredits(10),
  monthlyCents: centsFromCredits(100),
};

export interface CapUsage {
  /** Charged spend since {@link utcDayStartMs}. */
  dailySpentCents: number;
  /** Charged spend since {@link utcMonthStartMs}. */
  monthlySpentCents: number;
}

export interface CapsResult extends CapRemaining {
  allowed: boolean;
  reason: 'ok' | 'daily_cap_exceeded' | 'monthly_cap_exceeded';
}

function capRemaining(capCents: number | null, spentCents: number): number | null {
  return capCents === null ? null : Math.max(0, wholeNonNegative(capCents) - wholeNonNegative(spentCents));
}

/** Both UTC caps against this call's reservation; the daily cap is reported first. */
export function evaluateCaps(input: { caps: ConsumerCaps; usage: CapUsage; reservationCents: number }): CapsResult {
  const remaining: CapRemaining = {
    dailyRemainingCents: capRemaining(input.caps.dailyCents, input.usage.dailySpentCents),
    monthlyRemainingCents: capRemaining(input.caps.monthlyCents, input.usage.monthlySpentCents),
  };
  const daily = evaluateDailyCap({
    dailyChargedCents: input.usage.dailySpentCents,
    estCostCents: input.reservationCents,
    capCents: input.caps.dailyCents,
  });
  if (!daily.allowed) return { allowed: false, reason: 'daily_cap_exceeded', ...remaining };
  const monthly = evaluateDailyCap({
    dailyChargedCents: input.usage.monthlySpentCents,
    estCostCents: input.reservationCents,
    capCents: input.caps.monthlyCents,
  });
  if (!monthly.allowed) return { allowed: false, reason: 'monthly_cap_exceeded', ...remaining };
  return { allowed: true, reason: 'ok', ...remaining };
}

/** Funder alert thresholds, percent of a cap (D20.6). */
export const CAP_ALERT_THRESHOLDS = [80, 100] as const;
export type CapAlertThreshold = (typeof CAP_ALERT_THRESHOLDS)[number];
const PERCENT = 100;

/** The thresholds a spend moved across, from strictly below to at-or-above. */
export function capAlertThresholdsCrossed(input: {
  capCents: number | null;
  beforeCents: number;
  afterCents: number;
}): CapAlertThreshold[] {
  if (input.capCents === null || input.capCents <= 0) return [];
  const cap = input.capCents;
  return CAP_ALERT_THRESHOLDS.filter(
    (t) => input.beforeCents * PERCENT < cap * t && input.afterCents * PERCENT >= cap * t,
  );
}

// ---------------------------------------------------------------------------
// Periods (WAL-7 UTC windows, D-OW-12 allocation resets)
// ---------------------------------------------------------------------------

export function utcDayStartMs(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function utcMonthStartMs(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/**
 * D-OW-12: an allocation under an org resets on the pool's refill date; one under a
 * person resets on their personal renewal. With no such date yet (no subscription), the
 * UTC calendar month (D20) governs.
 */
export function governingAllocationPeriodStartMs(input: {
  rootOwner: 'org' | 'user';
  poolPeriodStartMs: number | null;
  personalPeriodStartMs: number | null;
  nowMs: number;
}): number {
  const anchor = input.rootOwner === 'org' ? input.poolPeriodStartMs : input.personalPeriodStartMs;
  return anchor ?? utcMonthStartMs(input.nowMs);
}

/** A wallet renews when its governing period started after the wallet's own period. */
export function isAllocationResetDue(input: { walletPeriodStartMs: number; governingPeriodStartMs: number }): boolean {
  return input.governingPeriodStartMs > input.walletPeriodStartMs;
}

// ---------------------------------------------------------------------------
// Entitlement (D-OW-14)
// ---------------------------------------------------------------------------

/**
 * D-OW-14: with several funders the wallet OWNER's tier governs, never a donor's. Own
 * credits are self-funded, so the consumer's own tier governs there.
 */
export function entitlementTierFor<Tier extends string>(input: {
  source: SpendSourceKind;
  walletOwnerTier: Tier;
  consumerTier: Tier;
}): Tier {
  return input.source === 'own_credits' ? input.consumerTier : input.walletOwnerTier;
}
