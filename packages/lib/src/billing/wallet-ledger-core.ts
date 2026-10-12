/**
 * wallet-ledger-core — the PURE rules that make the ledger wallet-keyed and complete (Spec WAL-5):
 * every movement of money in or out of a wallet is a credit_ledger row on THAT wallet, so each
 * wallet — a personal root, an org pool, a drive wallet — reconciles against its own rows.
 *
 * Two rules live here:
 *   - An allocation draw (WAL-3) is a TRANSFER: a drive wallet's spend draws its allocation from
 *     the parent as it happens, so the settle writes a pair — out of the parent, into the child —
 *     exactly like a donation or a lead's top-up. A refund returning allocation is the reverse pair.
 *   - Reconciliation: a wallet's net (monthly + top-up − debt) equals the sum of what its rows
 *     moved. `ledgerMovementCents` says what one row moved; `computeWalletDrift` compares.
 *
 * INVARIANT: zero I/O. The shells (credit-consume, monitoring-queries) read and write.
 */

import type { SpendKind } from '@pagespace/db/schema/credits';

/** The entry type of an allocation transfer row (see the credit_ledger.entryType list). */
export const ALLOCATION_DRAW_ENTRY = 'allocation_draw' as const;

export interface AllocationTransferRow {
  userId: string;
  walletId: string;
  entryType: typeof ALLOCATION_DRAW_ENTRY;
  bucket: 'monthly';
  amountCents: number;
  appliedCents: number;
  aiUsageLogId: string | null;
  consumeStatus: 'applied';
  spendKind: SpendKind;
}

/**
 * The pair of rows for `cents` of allocation moving from `fromWalletId` to `toWalletId`: a settle
 * draws parent → child; a refund returns child → parent. Recorded under the consumer whose call
 * moved it (`userId`) and the call's usage row. None for a non-positive amount.
 */
export function allocationTransferRows(input: {
  fromWalletId: string;
  toWalletId: string;
  cents: number;
  userId: string;
  aiUsageLogId: string | null;
  spendKind: SpendKind;
}): AllocationTransferRow[] {
  const cents = Number.isFinite(input.cents) ? Math.round(input.cents) : 0;
  if (cents <= 0) return [];
  const row = (walletId: string, signed: number): AllocationTransferRow => ({
    userId: input.userId,
    walletId,
    entryType: ALLOCATION_DRAW_ENTRY,
    bucket: 'monthly',
    amountCents: signed,
    appliedCents: signed,
    aiUsageLogId: input.aiUsageLogId,
    consumeStatus: 'applied',
    spendKind: input.spendKind,
  });
  return [row(input.fromWalletId, -cents), row(input.toWalletId, cents)];
}

/**
 * Debt cleared with no payment (WAL-6d): `debt_forgiven` when a renewal's clamp drops what the
 * carried balance and the new allowance could not absorb (a personal root, an org pool);
 * `allocation_reset` when a drive wallet's debt is netted from its next allocation. Either raises
 * the wallet's net by the debt cleared, so it is a row like every other balance change.
 */
export const DEBT_FORGIVEN_ENTRY = 'debt_forgiven' as const;
/**
 * The cutover's one row per wallet (migration 0345_wallet_opening_balance): its net at cutover less
 * what its earlier rows already account for, so reconciliation is exact from the cutover forward.
 * The migration's SQL mirrors {@link ledgerMovementCents} as of that cutover.
 */
export const OPENING_BALANCE_ENTRY = 'opening_balance' as const;
/** An owner funding leg refunded out of a drive wallet (money leaves it): the leg's cents, negative. */
export const LEG_REFUND_ENTRY = 'leg_refund' as const;
export const ALLOCATION_RESET_ENTRY = 'allocation_reset' as const;

export interface DebtClearedRow {
  userId: string;
  walletId: string;
  entryType: typeof DEBT_FORGIVEN_ENTRY | typeof ALLOCATION_RESET_ENTRY;
  bucket: 'monthly';
  amountCents: number;
  appliedCents: number;
  consumeStatus: 'applied';
}

/** The row recording `clearedCents` of debt cleared on `walletId`; null when none was. */
export function debtClearedRow(input: {
  entryType: DebtClearedRow['entryType'];
  userId: string;
  walletId: string;
  clearedCents: number;
}): DebtClearedRow | null {
  const cents = Number.isFinite(input.clearedCents) ? Math.round(input.clearedCents) : 0;
  if (cents <= 0) return null;
  return { userId: input.userId, walletId: input.walletId, entryType: input.entryType, bucket: 'monthly', amountCents: cents, appliedCents: cents, consumeStatus: 'applied' };
}

/**
 * The rows of one entry type on one wallet, summed as reconciliation reads them (one row is a sum of
 * one): `appliedCents` sums appliedCents with a null as 0; `appliedOrAmountCents` sums, per row,
 * appliedCents when set and amountCents when not.
 */
export interface LedgerTotals {
  entryType: string;
  amountCents: number;
  appliedCents: number;
  appliedOrAmountCents: number;
}

/** The totals of a single row. */
export function rowTotals(row: { entryType: string; amountCents: number; appliedCents: number | null }): LedgerTotals {
  return { entryType: row.entryType, amountCents: row.amountCents, appliedCents: row.appliedCents ?? 0, appliedOrAmountCents: row.appliedCents ?? row.amountCents };
}

/** Entry types whose `amountCents` is the money that moved (a grant or purchase lands in full). */
const CREDITED_IN_FULL = new Set<string>(['monthly_grant', 'topup_purchase', 'missed_grant', DEBT_FORGIVEN_ENTRY, ALLOCATION_RESET_ENTRY, OPENING_BALANCE_ENTRY]);
/** Entry types that move what `appliedCents` says (null: nothing has moved yet, e.g. a pending claim). */
const APPLIED_ONLY = new Set<string>(['usage', 'donation', 'wallet_topup', ALLOCATION_DRAW_ENTRY, LEG_REFUND_ENTRY]);
/** Attribution rows: they move no money. */
const NO_MONEY = new Set(['seat_overshoot_month', 'seat_overshoot_day']);

/**
 * The signed cents rows moved on their wallet's NET balance (monthly + top-up − debt):
 *   - a grant or purchase, debt cleared without payment (forgiven, netted at a reset), or the
 *     cutover's opening balance: its amount;
 *   - a usage claim, a transfer (donation, top-up, allocation draw), a leg refund: what it applied;
 *   - an `adjustment`: what it applied, else its amount — a debt row (overshoot landing on this
 *     wallet) applies nothing to the buckets and raises debt by its amount;
 *   - seat-overshoot attribution: nothing.
 * Any other type counts what it applied, else its amount, so an unknown row shows up as drift
 * rather than vanishing.
 */
export function ledgerMovementCents(totals: LedgerTotals): number {
  if (NO_MONEY.has(totals.entryType)) return 0;
  if (CREDITED_IN_FULL.has(totals.entryType)) return Math.round(totals.amountCents);
  if (APPLIED_ONLY.has(totals.entryType)) return Math.round(totals.appliedCents);
  return Math.round(totals.appliedOrAmountCents);
}

export interface WalletDriftInput {
  /** Σ ledgerMovementCents over every row on the wallet. */
  ledgerNetCents: number;
  monthlyRemainingCents: number;
  topupRemainingCents: number;
  debtCents: number;
}

export interface WalletDriftResult {
  expectedNetCents: number;
  materializedNetCents: number;
  driftCents: number;
  flagged: boolean;
}

/**
 * A wallet's materialized net against what its own rows moved (WAL-5). Every balance change is a
 * row — forgiveness at a renewal and netting at an allocation reset included — so any drift past
 * `toleranceCents` is a change that bypassed the ledger.
 */
export function computeWalletDrift(input: WalletDriftInput, toleranceCents: number): WalletDriftResult {
  const materializedNetCents =
    Math.round(input.monthlyRemainingCents) + Math.round(input.topupRemainingCents) - Math.max(0, Math.round(input.debtCents));
  const expectedNetCents = Math.round(input.ledgerNetCents);
  const driftCents = materializedNetCents - expectedNetCents;
  return { expectedNetCents, materializedNetCents, driftCents, flagged: Math.abs(driftCents) > Math.max(0, Math.round(toleranceCents)) };
}
