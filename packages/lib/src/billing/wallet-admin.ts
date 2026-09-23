/**
 * wallet-admin — the PURE decisions behind running a drive wallet (Spec UI-9, WAL-3, WAL-6,
 * WAL-7, SPEND-3): what a change sets and which action authorizes it, a top-up's money
 * movement, and whether a wallet may be deleted. The drive-wallet service loads and locks the
 * rows, asks the permissions module (wallet-access) whether the viewer may take each action
 * named here, and writes the answer.
 */

import type { WalletAction } from '../permissions/wallet-access';
import { allocateSpend, applyPaymentToDebt, type Balance } from './credit-core';
import { walletStatusFor, type FallbackRule, type SpendSourceKind, type WalletStatus } from './wallet-core';

/** Money columns are Postgres `integer`: no amount may exceed it. */
export const MAX_WALLET_CENTS = 2_147_483_647;

const isWholeCents = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= MAX_WALLET_CENTS;

// ---------------------------------------------------------------------------
// A change (allocation, pause, rules, default source)
// ---------------------------------------------------------------------------

export interface WalletPatchInput {
  /** The monthly allocation drawn against the parent (WAL-3). */
  allocationCents?: number;
  /** The kill switch (WAL-7). */
  paused?: boolean;
  /** POL-7 fallback when the chosen source is empty; null clears it. */
  fallbackRule?: FallbackRule | null;
  /** WAL-4: whether others may donate to this wallet. */
  donationsEnabled?: boolean;
  /** SPEND-3: what a new conversation in this drive preselects; null clears it. */
  defaultSpendSource?: SpendSourceKind | null;
}

export interface WalletPatchSet {
  monthlyAllowanceCents?: number;
  status?: WalletStatus;
  fallbackRule?: FallbackRule | null;
  donationsEnabled?: boolean;
  defaultSpendSource?: SpendSourceKind | null;
}

export type WalletPatchPlan =
  | { kind: 'patch'; actions: WalletAction[]; set: WalletPatchSet }
  | { kind: 'refuse'; reason: 'invalid_amount' | 'nothing_to_change' };

export function planWalletPatch(input: WalletPatchInput, current: { status: WalletStatus; debtCents: number }): WalletPatchPlan {
  const actions = new Set<WalletAction>();
  const set: WalletPatchSet = {};
  if (input.allocationCents !== undefined) {
    if (!isWholeCents(input.allocationCents)) return { kind: 'refuse', reason: 'invalid_amount' };
    actions.add('allocate');
    set.monthlyAllowanceCents = input.allocationCents;
  }
  if (input.paused !== undefined) {
    actions.add('pause');
    set.status = walletStatusFor({ paused: input.paused, debtCents: current.debtCents });
  }
  if (input.fallbackRule !== undefined) {
    actions.add('set_rules');
    set.fallbackRule = input.fallbackRule;
  }
  if (input.donationsEnabled !== undefined) {
    actions.add('set_rules');
    set.donationsEnabled = input.donationsEnabled;
  }
  if (input.defaultSpendSource !== undefined) {
    actions.add('set_rules');
    set.defaultSpendSource = input.defaultSpendSource;
  }
  if (actions.size === 0) return { kind: 'refuse', reason: 'nothing_to_change' };
  return { kind: 'patch', actions: [...actions], set };
}

// ---------------------------------------------------------------------------
// A top-up (WAL-3)
// ---------------------------------------------------------------------------

export interface TopUpInput {
  amountCents: number;
  /** The wallet that pays: the org pool for an org drive, the lead's personal wallet for a personal drive. */
  payer: { walletId: string; balance: Balance; heldCents: number };
  target: { walletId: string; legsRemainingCents: number; debtCents: number };
}

export type TopUpRefusal = 'invalid_amount' | 'same_wallet' | 'insufficient_funds';

export type TopUpPlan =
  | {
      kind: 'top_up';
      amountCents: number;
      payer: { monthlyRemainingCents: number; topupRemainingCents: number; spentMonthly: number; spentTopup: number };
      /** The owner's leg: refundable (only donations are not, D-OW-13), lasting until spent. */
      leg: { originalCents: number; remainingCents: number; nonRefundable: false };
      target: { topupRemainingCents: number; debtCents: number; paidDebtCents: number };
    }
  | { kind: 'refuse'; reason: TopUpRefusal };

/**
 * Move `amountCents` from the payer into the drive wallet as an owner funding leg. Never
 * partial and never into debt: the payer must cover the whole amount now, net of its debt and
 * in-flight holds. The payer is drawn monthly first, then top-up (the spend order); the wallet
 * pays its own debt first, exactly as a donation does.
 */
export function planTopUp(input: TopUpInput): TopUpPlan {
  const amount = input.amountCents;
  if (!isWholeCents(amount) || amount === 0) return { kind: 'refuse', reason: 'invalid_amount' };
  if (input.payer.walletId === input.target.walletId) return { kind: 'refuse', reason: 'same_wallet' };
  const b = input.payer.balance;
  const available = b.monthlyCents + b.topupCents - Math.max(0, b.debtCents ?? 0) - Math.max(0, Math.round(input.payer.heldCents));
  if (available < amount) return { kind: 'refuse', reason: 'insufficient_funds' };

  const draw = allocateSpend(b, amount);
  const landed = applyPaymentToDebt(input.target.debtCents, input.target.legsRemainingCents, amount);
  return {
    kind: 'top_up',
    amountCents: amount,
    payer: { monthlyRemainingCents: draw.monthlyCents, topupRemainingCents: draw.topupCents, spentMonthly: draw.spentMonthly, spentTopup: draw.spentTopup },
    leg: { originalCents: amount, remainingCents: amount - landed.paidDebt, nonRefundable: false },
    target: { topupRemainingCents: landed.topupCents, debtCents: landed.debtCents, paidDebtCents: landed.paidDebt },
  };
}

// ---------------------------------------------------------------------------
// Deleting a drive wallet
// ---------------------------------------------------------------------------

export type DeleteBlocker = 'calls_in_flight' | 'has_money_history' | 'holds_funds' | 'carries_debt';

export type DeletePlan = { kind: 'delete' } | { kind: 'refuse'; reason: 'wallet_in_use'; blockers: DeleteBlocker[] };

/**
 * A drive wallet may be deleted only while it is unused. credit_ledger and credit_holds rows
 * CASCADE with their wallet, so deleting a wallet that ever moved money would erase that
 * history (WAL-5: the ledger is keyed on wallet); funds still in its legs (a donor's gift, an
 * owner's top-up) and its debt would vanish with it. Such a wallet is paused instead (WAL-7).
 * Its unspent allocation needs no return: it never left the parent (WAL-3).
 */
export function planDeleteWallet(input: {
  liveHoldCount: number;
  ledgerEntryCount: number;
  legsRemainingCents: number;
  debtCents: number;
}): DeletePlan {
  const blockers: DeleteBlocker[] = [];
  if (input.liveHoldCount > 0) blockers.push('calls_in_flight');
  if (input.ledgerEntryCount > 0) blockers.push('has_money_history');
  if (input.legsRemainingCents > 0) blockers.push('holds_funds');
  if (input.debtCents > 0) blockers.push('carries_debt');
  return blockers.length === 0 ? { kind: 'delete' } : { kind: 'refuse', reason: 'wallet_in_use', blockers };
}
