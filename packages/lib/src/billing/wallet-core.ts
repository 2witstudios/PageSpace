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
  /**
   * True when the consumer's cap, not the wallet's money, is what bounds `spendableCents`
   * (a seat's monthly allowance, WAL-2): an uncovered leg then refuses `source_cap_reached`.
   */
  capReached?: boolean;
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
  | 'guest_drive_wallet_off'
  /**
   * The source's wallet holds money, but this consumer's cap on it is spent for the period
   * (a seat's monthly allowance, WAL-2). Named apart from `source_empty`: the pool is not empty.
   */
  | 'source_cap_reached'
  /**
   * The wallet stored as this conversation's choice is not one this person may spend in
   * this drive now (deleted, another person's, a seat after leaving the org, another
   * drive's wallet). Refused rather than treated as "nothing chosen" (SPEND-4).
   */
  | 'chosen_wallet_unavailable';

export type SkipReason =
  | 'drive_wallet_empty'
  | 'drive_wallet_paused'
  | 'no_drive_wallet'
  /**
   * The person an automation runs on behalf of — its creator — is no longer an accepted member of the drive's org
   * (or of the drive, on a personal drive). Their caps left with them, so the run is refused rather than run
   * uncapped ([D-OW-34], review #2817 P2-2). Re-pointing an automation to a new owner is a separate decision.
   */
  | 'creator_departed';

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
      /**
       * The wallet of the chosen source a fallback moved the call off, else null. The gate
       * records it on the hold so the settle lands any overshoot where that choice would have
       * put it, never on the consumer (WAL-6b).
       */
      fallbackFromWalletId: string | null;
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

/** Every source this consumer may spend that covers the call, in source order (the refusal card's options). */
export function coveredSpendOptions(input: ResolveSpendSourceInput): SpendOption[] {
  return optionsExcept(input, null);
}

/** Why a leg that does not cover the call refuses: paused, its consumer cap spent, or empty. */
function refusalFor(leg: SpendLeg): RefusalReason {
  if (leg.status === 'paused') return 'source_paused';
  return leg.capReached === true ? 'source_cap_reached' : 'source_empty';
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
    return { kind: 'spend', source: 'drive_wallet', walletId: wallet.walletId, fallbackApplied: false, fallbackFrom: null, fallbackFromWalletId: null };
  }

  const overridden = input.userOverride.alwaysOwnCredits || input.userOverride.alwaysOwnCreditsInDrive;
  const chosen: SpendSourceKind | null = overridden ? 'own_credits' : input.chosen;
  if (chosen === null) return refuse(null, 'no_source_chosen', optionsExcept(input, null));

  const found = legFor(input, chosen);
  const offered = (): SpendOption[] => (overridden ? [] : optionsExcept(input, chosen));
  if (!('leg' in found)) return refuse(chosen, found.unavailable, offered());
  if (covers(found.leg, input.reservationCents)) {
    return { kind: 'spend', source: chosen, walletId: found.leg.walletId, fallbackApplied: false, fallbackFrom: null, fallbackFromWalletId: null };
  }

  const fallback = input.driveRule.fallback;
  if (!overridden && fallback !== 'refuse' && fallback !== chosen) {
    const fallbackLeg = coveredLeg(input, fallback);
    if (fallbackLeg) {
      return {
        kind: 'spend',
        source: fallback,
        walletId: fallbackLeg.walletId,
        fallbackApplied: true,
        fallbackFrom: chosen,
        // [D-OW-32] a PAUSED leg (its kill switch, or a lapsed org's legs) absorbs nothing: the
        // fallback is still reported, but no overshoot is carried back onto it.
        fallbackFromWalletId: found.leg.status === 'paused' ? null : found.leg.walletId,
      };
    }
  }
  return refuse(chosen, refusalFor(found.leg), offered());
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
  const fromAllocation = Math.min(allocationRemainingCents(wallet), wholeNonNegative(parentAvailableCents));
  const fromLegs = wallet.topupLegs.reduce((sum, leg) => sum + wholeNonNegative(leg.remainingCents), 0);
  return Math.max(0, fromAllocation + fromLegs - wholeNonNegative(wallet.debtCents));
}

export interface CapRemaining {
  dailyRemainingCents: number | null;
  monthlyRemainingCents: number | null;
}

/** A consumer's spendable on one wallet leg: the wallet's spendable, bounded by their caps (WAL-7). */
export function legSpendableCents(walletSpendableCents: number, caps: CapRemaining): number {
  let spendable = wholeNonNegative(walletSpendableCents);
  if (caps.dailyRemainingCents !== null) spendable = Math.min(spendable, wholeNonNegative(caps.dailyRemainingCents));
  if (caps.monthlyRemainingCents !== null) spendable = Math.min(spendable, wholeNonNegative(caps.monthlyRemainingCents));
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
  const allocationDraw = Math.min(amount, allocationRemainingCents(input.wallet), wholeNonNegative(balanceAvailableCents(input.parent)));
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

/** The source a consumer CHOSE, before a drive rule moved the call (resolveSpendSource `fallbackFrom`). */
export interface ChosenSourceCharge {
  source: SpendSourceKind;
  walletId: string;
  parentWalletId: string | null;
  funderChoice: OvershootFunderChoice;
}

export interface SettleOvershootInput {
  source: SpendSourceKind;
  overshootCents: number;
  /** The wallet the call was charged to. */
  chargedWalletId: string;
  /** Its parent; null for a root wallet (a personal wallet or an org pool). */
  parentWalletId: string | null;
  funderChoice: OvershootFunderChoice;
  /**
   * The chosen source when a drive rule fell back (`fallbackApplied`), else null. Required
   * so a caller cannot drop it: a fallback onto own credits is not the consumer's choice.
   */
  fallbackFrom: ChosenSourceCharge | null;
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
 * pool; a drive wallet's lands where its funder chose. A drive wallet with no parent
 * has nothing to absorb into, so its overshoot is wallet debt whatever the choice.
 *
 * A drive-rule fallback onto own credits is not the consumer choosing them (WAL-6b), so
 * that overshoot lands where the CHOSEN source would have put it.
 */
export function settleOvershoot(input: SettleOvershootInput): OvershootLanding {
  const cents = wholeNonNegative(input.overshootCents);
  if (cents === 0) return { kind: 'none', cents: 0 };
  if (input.source === 'own_credits' && input.fallbackFrom !== null && input.fallbackFrom.source !== 'own_credits') {
    const chosen = input.fallbackFrom;
    return settleOvershoot({
      source: chosen.source,
      overshootCents: cents,
      chargedWalletId: chosen.walletId,
      parentWalletId: chosen.parentWalletId,
      funderChoice: chosen.funderChoice,
      fallbackFrom: null,
    });
  }
  if (input.source !== 'drive_wallet') return { kind: 'root_debt', walletId: input.chargedWalletId, cents };
  if (input.funderChoice === 'absorb_to_parent' && input.parentWalletId !== null) {
    return { kind: 'parent_debt', walletId: input.parentWalletId, cents };
  }
  return { kind: 'wallet_debt', walletId: input.chargedWalletId, cents };
}

/**
 * The source a wallet row IS, from its shape: a child wallet is a drive wallet; a root owned by
 * an org is the pool a seat spends; a root owned by a person is their own credits.
 */
export function walletSourceKind(wallet: { ownerType: 'user' | 'org'; parentWalletId: string | null }): SpendSourceKind {
  if (wallet.parentWalletId !== null) return 'drive_wallet';
  return wallet.ownerType === 'org' ? 'seat_allowance' : 'own_credits';
}

/** The chosen source a fallback moved a call off, as the settle needs it (WAL-6b), from its wallet row. */
export function chosenSourceCharge(wallet: {
  id: string;
  ownerType: 'user' | 'org';
  parentWalletId: string | null;
  overshootChoice: OvershootFunderChoice | null;
}): ChosenSourceCharge {
  return {
    source: walletSourceKind(wallet),
    walletId: wallet.id,
    parentWalletId: wallet.parentWalletId,
    funderChoice: wallet.overshootChoice ?? DEFAULT_OVERSHOOT_CHOICE,
  };
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

/** The shape of a wallet as the debt notice reads it (WAL-6e). */
export interface DebtNoticeWallet {
  ownerType: 'user' | 'org';
  parentWalletId: string | null;
  subjectType: string | null;
  debtCents: number;
}

/**
 * WAL-6e: whose debt notice a settle that left `debtWallet` in debt raises, if any. The FUNDER
 * is told — never the consumer who spent:
 *   - a child (drive or agent) wallet carrying its own debt (the funder chose wallet_debt): the
 *     funder is whoever owns its PARENT, the wallet that funds its allocation;
 *   - an org POOL in debt (it absorbed a drive's overshoot, a seat's, or org compute's): the org;
 *   - a PERSONAL root in debt is a funder's notice only when it absorbed a CHILD wallet's
 *     overshoot (someone spent the person's drive wallet). A person past their own credits is
 *     the consumer and the funder at once: that debt is the account's own balance, shown as it
 *     always was, and raises no notice.
 */
export function debtNoticeFunder(input: {
  debtWallet: DebtNoticeWallet;
  /** The wallet the call charged: a child when the debt came from a drive or agent wallet. */
  chargedWalletIsChild: boolean;
}): 'parent' | 'self' | null {
  const wallet = input.debtWallet;
  if (wholeNonNegative(wallet.debtCents) === 0) return null;
  if (wallet.parentWalletId !== null) return 'parent';
  if (wallet.ownerType === 'org') return 'self';
  return input.chargedWalletIsChild ? 'self' : null;
}

/**
 * WAL-6e: the period a debt notice is once per — the debt-carrying wallet's own period when it
 * has begun, else the UTC calendar month (D20).
 */
export function debtNoticePeriodStartMs(input: { walletPeriodStartMs: number | null; nowMs: number }): number {
  const start = input.walletPeriodStartMs;
  return start !== null && start <= input.nowMs ? start : utcMonthStartMs(input.nowMs);
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

/** The consumer key a person's caps are stored under on a wallet (wallet_consumer_caps.consumerKey). */
export function userConsumerKey(userId: string): string {
  return `user:${userId}`;
}

/** Whole cents; null means unlimited within the wallet. */
export interface ConsumerCaps {
  dailyCents: number | null;
  monthlyCents: number | null;
}

/**
 * Defaults when an admin enables per-consumer caps without naming values: 50 credits a day and
 * 1,000 a month ([D-OW-31], replacing D20.5's 10/100, which sat below one image or uncatalogued
 * model's hold and so refused every such call). Caps never set stay unlimited within the wallet.
 * NOT the seat allowance: that is its own constant below.
 */
export const DEFAULT_CONSUMER_CAPS: ConsumerCaps = {
  dailyCents: Math.round(centsFromCredits(50)),
  monthlyCents: Math.round(centsFromCredits(1_000)),
};

export interface CapUsage {
  /** Charged spend since {@link utcDayStartMs}. */
  dailySpentCents: number;
  /** Charged spend since {@link utcMonthStartMs}. */
  monthlySpentCents: number;
  /**
   * This consumer's outstanding holds on the leg placed in today's / this month's window
   * (calls still in flight, not yet settled). Counted like spend, so overlapping calls
   * cannot each pass the cap on the same settled total.
   */
  dailyReservedCents: number;
  monthlyReservedCents: number;
}

export interface CapsResult extends CapRemaining {
  allowed: boolean;
  reason: 'ok' | 'daily_cap_exceeded' | 'monthly_cap_exceeded';
}

/** A set cap as whole cents. A non-finite cap is 0, so a corrupt value fails closed. */
function sanitizeCap(capCents: number | null): number | null {
  return capCents === null ? null : wholeNonNegative(capCents);
}

function capRemaining(capCents: number | null, usedCents: number): number | null {
  return capCents === null ? null : Math.max(0, capCents - usedCents);
}

/**
 * Both UTC caps against this call's reservation, counting settled spend plus
 * outstanding holds; the daily cap is reported first. Inputs are sanitized so a
 * non-finite cap or reservation denies instead of slipping through a NaN comparison.
 */
export function evaluateCaps(input: { caps: ConsumerCaps; usage: CapUsage; reservationCents: number }): CapsResult {
  const dailyUsed = wholeNonNegative(input.usage.dailySpentCents) + wholeNonNegative(input.usage.dailyReservedCents);
  const monthlyUsed = wholeNonNegative(input.usage.monthlySpentCents) + wholeNonNegative(input.usage.monthlyReservedCents);
  const dailyCap = sanitizeCap(input.caps.dailyCents);
  const monthlyCap = sanitizeCap(input.caps.monthlyCents);
  // A non-finite reservation is unknowable cost: deny rather than estimate it as zero.
  const reservation = Number.isFinite(input.reservationCents) ? wholeNonNegative(input.reservationCents) : null;
  const remaining: CapRemaining = {
    dailyRemainingCents: capRemaining(dailyCap, dailyUsed),
    monthlyRemainingCents: capRemaining(monthlyCap, monthlyUsed),
  };
  if (reservation === null) {
    if (dailyCap !== null) return { allowed: false, reason: 'daily_cap_exceeded', ...remaining };
    if (monthlyCap !== null) return { allowed: false, reason: 'monthly_cap_exceeded', ...remaining };
  }
  const daily = evaluateDailyCap({
    dailyChargedCents: dailyUsed,
    estCostCents: reservation ?? 0,
    capCents: dailyCap,
  });
  if (!daily.allowed) return { allowed: false, reason: 'daily_cap_exceeded', ...remaining };
  const monthly = evaluateDailyCap({
    dailyChargedCents: monthlyUsed,
    estCostCents: reservation ?? 0,
    capCents: monthlyCap,
  });
  if (!monthly.allowed) return { allowed: false, reason: 'monthly_cap_exceeded', ...remaining };
  return { allowed: true, reason: 'ok', ...remaining };
}

/** Funder alert thresholds, percent of a cap (D20.6). */
export const CAP_ALERT_THRESHOLDS = [80, 100] as const;
export type CapAlertThreshold = (typeof CAP_ALERT_THRESHOLDS)[number];
const PERCENT = 100;

/**
 * The thresholds a consumer's spend in one cap window has reached (spent >= threshold% of the
 * cap). The shell sends each at most once per window per period (wallet_cap_alerts), so a
 * reached threshold is due until it has been sent — no crossing can be missed by two settles
 * racing past it. A zero cap is reached at once; no cap reaches nothing.
 */
export function capThresholdsReached(input: { capCents: number | null; spentCents: number }): CapAlertThreshold[] {
  if (input.capCents === null || !Number.isFinite(input.capCents)) return [];
  const cap = wholeNonNegative(input.capCents);
  const spent = wholeNonNegative(input.spentCents);
  return CAP_ALERT_THRESHOLDS.filter((t) => spent * PERCENT >= cap * t);
}

/** A cap window of WAL-7: the UTC day, and the month (the pool period for a seat, D-OW-12). */
export type CapWindow = 'daily' | 'monthly';

/** A write of one consumer's caps; an omitted window keeps what it was (defaults when enabling). */
export interface ConsumerCapWriteInput {
  dailyCents?: number | null;
  monthlyCents?: number | null;
}

export type ConsumerCapWritePlan =
  | { kind: 'set'; caps: ConsumerCaps }
  | { kind: 'refuse'; reason: 'invalid_amount' };

const MAX_CAP_CENTS = 2_147_483_647;

function validCap(value: number | null | undefined): boolean {
  return value === undefined || value === null || (Number.isInteger(value) && value >= 0 && value <= MAX_CAP_CENTS);
}

/**
 * Plan a write of one consumer's caps on one leg (WAL-7). Enabling caps (no row yet) starts from
 * the D20.5 defaults, so a window the writer does not name takes its default; on an existing row
 * an unnamed window keeps its value. `null` is unlimited in that window. Anything that is not a
 * whole, non-negative cent count (or null) is refused and nothing is stored.
 */
export function planConsumerCapWrite(input: ConsumerCapWriteInput, existing: ConsumerCaps | null): ConsumerCapWritePlan {
  if (!validCap(input.dailyCents) || !validCap(input.monthlyCents)) return { kind: 'refuse', reason: 'invalid_amount' };
  const base = existing ?? DEFAULT_CONSUMER_CAPS;
  return {
    kind: 'set',
    caps: {
      dailyCents: input.dailyCents === undefined ? base.dailyCents : input.dailyCents,
      monthlyCents: input.monthlyCents === undefined ? base.monthlyCents : input.monthlyCents,
    },
  };
}

// ---------------------------------------------------------------------------
// Seat allowance (WAL-2): the per-consumer monthly cap on the org pool's own leg
// ---------------------------------------------------------------------------

/**
 * The org's default seat allowance (the POL-7 policy default and the fallback when an org sets
 * none): D20.5's 100 credits a month per member. Its own constant on purpose: [D-OW-31] moved the
 * per-consumer cap defaults and left the seat allowance where it was, so a cap edit must never
 * move what every member may draw from every pool. A seat is never unlimited — a seat with no
 * cap lets any one member spend the whole pool.
 */
export const DEFAULT_SEAT_ALLOWANCE_CENTS: number = Math.round(centsFromCredits(100));

/**
 * One consumer's seat allowance on the pool: their own monthly cap on the pool leg
 * (wallet_consumer_caps) when one is set, else the org's seat allowance, else the default.
 * A non-finite or negative value fails closed to zero.
 */
export function seatAllowanceCents(input: {
  consumerMonthlyCapCents: number | null;
  policySeatAllowanceCents: number | null;
}): number {
  return wholeNonNegative(input.consumerMonthlyCapCents ?? input.policySeatAllowanceCents ?? DEFAULT_SEAT_ALLOWANCE_CENTS);
}

const MILLICENTS_PER_CENT = 1000;

/**
 * A consumer's charged seat spend this period, from the ledger's summed millicents (usage
 * plus signed reconcile corrections). Rounded UP so the cap never under-counts; a net
 * refund below zero is nothing spent; a non-finite sum fails closed as everything spent.
 */
export function seatSpentCents(chargedMillicents: number): number {
  if (!Number.isFinite(chargedMillicents)) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.ceil(chargedMillicents / MILLICENTS_PER_CENT));
}

/** One consumer's seat spend in the pool's current period. */
export interface SeatUsage {
  /** Their settled seat spend this period (usage + reconcile rows, per call, dated by the call), as min(gross, the cap now). */
  periodChargedMillicents: number;
  /** Their live holds on the pool (calls in flight), counted like spend — this period and today. */
  periodReservedCents: number;
  /** The same since the start of today, UTC (WAL-7's daily window, D20.3), as min(gross, the daily cap now). */
  dayChargedMillicents: number;
}

/**
 * The seat caps against this call's reservation: spend plus in-flight holds plus this call must
 * fit the monthly allowance and, when the consumer has one set, their daily cap (WAL-7; unset is
 * no daily limit). In-flight holds are hours old at most, so they count against today as well.
 */
export function seatCapCheck(input: {
  capCents: number;
  dailyCapCents: number | null;
  usage: SeatUsage;
  reservationCents: number;
}): CapsResult {
  return evaluateCaps({
    caps: { dailyCents: input.dailyCapCents, monthlyCents: input.capCents },
    usage: {
      dailySpentCents: seatSpentCents(input.usage.dayChargedMillicents),
      monthlySpentCents: seatSpentCents(input.usage.periodChargedMillicents),
      dailyReservedCents: input.usage.periodReservedCents,
      monthlyReservedCents: input.usage.periodReservedCents,
    },
    reservationCents: input.reservationCents,
  });
}

/** One cap window's settled seat spend: every charged millicent, and how much of it the pool absorbed. */
export interface SeatWindowCharge {
  /** SUM(chargeMillicents) of the consumer's usage and reconcile rows in the window: what was spent. */
  grossMillicents: number;
  /** SUM of this window's own seat-overshoot rows: the part of that spend the pool took off the count. */
  absorbedMillicents: number;
}

/**
 * One window's seat count: its gross settled spend judged against the cap in force now,
 * min(gross, cap) and never below zero (null cap: no limit, the gross). Deciding a cap on this
 * is deciding it on gross — both refuse at gross >= cap and agree below it — so nothing stored
 * from an earlier cap can widen admission. A non-finite gross passes through, and the caps'
 * read (seatSpentCents) fails closed on it.
 */
export function seatCountedMillicents(input: { capCents: number | null; grossMillicents: number }): number {
  if (!Number.isFinite(input.grossMillicents)) return input.grossMillicents;
  const gross = Math.max(0, input.grossMillicents);
  return input.capCents === null ? gross : Math.min(gross, input.capCents * MILLICENTS_PER_CENT);
}

/**
 * WAL-2 / WAL-7 at SETTLE, one cap window at a time. Admission reserves an estimate and a
 * call's real cost can exceed it; the pool still pays the excess (WAL-6b/c: overshoot lands
 * on the funder, never on the consumer), but the excess is the pool's absorbed overshoot, not
 * the consumer's seat spend. A window's absorbed amount is kept at exactly
 * max(0, gross − cap): this returns the SIGNED change that restores that after a charge
 * (positive, the new excess) or a refund (negative, forgiveness that no longer applies — a
 * refund never frees more room than was really spent). The consumer's count, gross − absorbed,
 * is then min(gross, cap): at the cap, never over it, and never under what was really spent
 * below it.
 *
 * Each window answers for itself, so a DAILY overshoot never forgives the MONTH and a monthly
 * one never forgives the DAY (review 5340219245, IRV-A7). No cap (a null daily cap) keeps
 * nothing absorbed. A non-finite sum changes nothing here; the gate's read fails closed on it.
 */
export function seatOvershootDeltaMillicents(input: { capCents: number | null; window: SeatWindowCharge }): number {
  const target = input.capCents === null ? 0 : Math.max(0, input.window.grossMillicents - input.capCents * MILLICENTS_PER_CENT);
  const delta = target - input.window.absorbedMillicents;
  return Number.isFinite(delta) ? delta : 0;
}

/** What a consumer may still spend through their seat: the pool's spendable, bounded by what is left of their caps. */
export function seatLegSpendableCents(input: {
  poolSpendableCents: number;
  capCents: number;
  dailyCapCents: number | null;
  usage: SeatUsage;
}): number {
  const cap = seatCapCheck({ capCents: input.capCents, dailyCapCents: input.dailyCapCents, usage: input.usage, reservationCents: 0 });
  return legSpendableCents(input.poolSpendableCents, cap);
}

/** D-OW-12: a seat's cap resets on the pool's refill date, never on the person's own renewal. */
export function seatPeriodStartMs(input: { poolPeriodStartMs: number | null; nowMs: number }): number {
  return governingAllocationPeriodStartMs({
    rootOwner: 'org',
    poolPeriodStartMs: input.poolPeriodStartMs,
    personalPeriodStartMs: null,
    nowMs: input.nowMs,
  });
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
