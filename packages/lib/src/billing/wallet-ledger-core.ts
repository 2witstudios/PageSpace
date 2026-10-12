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
const CREDITED_IN_FULL = new Set(['monthly_grant', 'topup_purchase', 'missed_grant']);
/** Entry types that move what `appliedCents` says (null: nothing has moved yet, e.g. a pending claim). */
const APPLIED_ONLY = new Set(['usage', 'donation', 'wallet_topup', ALLOCATION_DRAW_ENTRY]);
/** Attribution rows: they move no money. */
const NO_MONEY = new Set(['seat_overshoot_month', 'seat_overshoot_day']);

/**
 * The signed cents rows moved on their wallet's NET balance (monthly + top-up − debt):
 *   - a grant or purchase: its amount;
 *   - a usage claim, a transfer (donation, top-up, allocation draw): what it applied;
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
 * A wallet's materialized net against what its own rows moved (WAL-5). Forgiveness moves no money
 * and writes no row — debt clamped away at a renewal, a drive wallet's debt netted at its
 * allocation reset — so a flag means "look at this wallet", within `toleranceCents`.
 */
export function computeWalletDrift(input: WalletDriftInput, toleranceCents: number): WalletDriftResult {
  const materializedNetCents =
    Math.round(input.monthlyRemainingCents) + Math.round(input.topupRemainingCents) - Math.max(0, Math.round(input.debtCents));
  const expectedNetCents = Math.round(input.ledgerNetCents);
  const driftCents = materializedNetCents - expectedNetCents;
  return { expectedNetCents, materializedNetCents, driftCents, flagged: Math.abs(driftCents) > Math.max(0, Math.round(toleranceCents)) };
}
