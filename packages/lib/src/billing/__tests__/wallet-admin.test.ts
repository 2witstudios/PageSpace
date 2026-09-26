import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { centsFromCredits } from '../money-model';
import { planWalletPatch, planTopUp, planDeleteWallet, MAX_WALLET_CENTS } from '../wallet-admin';

const c = (credits: number): number => Math.round(centsFromCredits(credits));

describe('wallet-admin: a change to a drive wallet', () => {
  const current = { status: 'active' as const, debtCents: 0 };

  it('UI-9 (partial) each field names the action that authorizes it', () => {
    expect(planWalletPatch({ allocationCents: c(1200) }, current)).toEqual({
      kind: 'patch', actions: ['allocate'], set: { monthlyAllowanceCents: c(1200) },
    });
    expect(planWalletPatch({ paused: true }, current)).toEqual({ kind: 'patch', actions: ['pause'], set: { status: 'paused' } });
    expect(planWalletPatch({ fallbackRule: 'own_credits', donationsEnabled: false, defaultSpendSource: 'drive_wallet' }, current)).toEqual({
      kind: 'patch',
      actions: ['set_rules'],
      set: { fallbackRule: 'own_credits', donationsEnabled: false, defaultSpendSource: 'drive_wallet' },
    });
  });

  it('WAL-7 (partial) resuming a paused wallet returns it to active, or to over while it carries debt', () => {
    expect(planWalletPatch({ paused: false }, { status: 'paused', debtCents: 0 })).toMatchObject({ set: { status: 'active' } });
    expect(planWalletPatch({ paused: false }, { status: 'paused', debtCents: 5 })).toMatchObject({ set: { status: 'over' } });
  });

  it('null clears a rule or the default; an empty change is refused', () => {
    expect(planWalletPatch({ fallbackRule: null, defaultSpendSource: null }, current)).toMatchObject({ set: { fallbackRule: null, defaultSpendSource: null } });
    expect(planWalletPatch({}, current)).toEqual({ kind: 'refuse', reason: 'nothing_to_change' });
  });

  it('an allocation must be a whole, non-negative number of cents that fits the column', () => {
    for (const bad of [-1, 1.5, Number.NaN, MAX_WALLET_CENTS + 1]) {
      expect(planWalletPatch({ allocationCents: bad }, current), String(bad)).toEqual({ kind: 'refuse', reason: 'invalid_amount' });
    }
    expect(planWalletPatch({ allocationCents: 0 }, current)).toMatchObject({ kind: 'patch' });
  });
});

describe('wallet-admin: a top-up', () => {
  const payer = { walletId: 'w-pool', balance: { monthlyCents: c(100), topupCents: c(50), debtCents: 0 }, heldCents: 0 };
  const target = { walletId: 'w-product', legsRemainingCents: c(40), debtCents: 0 };

  it('WAL-3 (partial) moves funds from the payer (monthly first, then top-up) into a refundable owner leg that lasts until spent', () => {
    expect(planTopUp({ amountCents: c(120), payer, target })).toEqual({
      kind: 'top_up',
      amountCents: c(120),
      payer: { monthlyRemainingCents: 0, topupRemainingCents: c(30), spentMonthly: c(100), spentTopup: c(20) },
      leg: { originalCents: c(120), remainingCents: c(120), nonRefundable: false },
      target: { topupRemainingCents: c(160), debtCents: 0, paidDebtCents: 0 },
    });
  });

  it('WAL-6 (partial) a top-up pays the wallet\'s debt first', () => {
    const plan = planTopUp({ amountCents: c(30), payer, target: { ...target, debtCents: c(10) } });
    expect(plan).toMatchObject({ kind: 'top_up', leg: { originalCents: c(30), remainingCents: c(20) }, target: { debtCents: 0, paidDebtCents: c(10) } });
  });

  it('is never partial and never puts the payer into debt: net of debt and in-flight holds', () => {
    expect(planTopUp({ amountCents: c(151), payer, target })).toEqual({ kind: 'refuse', reason: 'insufficient_funds' });
    expect(planTopUp({ amountCents: c(150), payer: { ...payer, heldCents: 1 }, target })).toEqual({ kind: 'refuse', reason: 'insufficient_funds' });
    expect(planTopUp({ amountCents: c(150), payer: { ...payer, balance: { ...payer.balance, debtCents: 1 } }, target })).toEqual({ kind: 'refuse', reason: 'insufficient_funds' });
  });

  it('refuses a bad amount and a payer that is the wallet itself', () => {
    expect(planTopUp({ amountCents: 0, payer, target })).toEqual({ kind: 'refuse', reason: 'invalid_amount' });
    expect(planTopUp({ amountCents: 1.5, payer, target })).toEqual({ kind: 'refuse', reason: 'invalid_amount' });
    expect(planTopUp({ amountCents: 1, payer: { ...payer, walletId: 'w-product' }, target })).toEqual({ kind: 'refuse', reason: 'same_wallet' });
  });
});

describe('wallet-admin: deleting a drive wallet', () => {
  const unused = { liveHoldCount: 0, ledgerEntryCount: 0, legsRemainingCents: 0, debtCents: 0 };

  it('an unused wallet deletes; its unspent allocation never left the parent', () => {
    expect(planDeleteWallet(unused)).toEqual({ kind: 'delete' });
  });

  it('WAL-5 (partial) a wallet with money history, funds, debt or calls in flight is refused (pause it instead), naming every reason', () => {
    expect(planDeleteWallet({ liveHoldCount: 1, ledgerEntryCount: 3, legsRemainingCents: 5, debtCents: 2 })).toEqual({
      kind: 'refuse',
      reason: 'wallet_in_use',
      blockers: ['calls_in_flight', 'has_money_history', 'holds_funds', 'carries_debt'],
    });
    expect(planDeleteWallet({ ...unused, ledgerEntryCount: 1 })).toMatchObject({ blockers: ['has_money_history'] });
  });
});

describe('wallet-admin purity', () => {
  it('imports nothing that does I/O', () => {
    const src = readFileSync(fileURLToPath(new URL('../wallet-admin.ts', import.meta.url)), 'utf8');
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['../permissions/wallet-access', './credit-core', './wallet-core']);
  });
});
