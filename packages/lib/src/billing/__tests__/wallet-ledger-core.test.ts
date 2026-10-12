import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { allocationTransferRows, computeWalletDrift, ledgerMovementCents, rowTotals, ALLOCATION_DRAW_ENTRY } from '../wallet-ledger-core';

describe('allocationTransferRows: an allocation draw is a transfer pair', () => {
  it('WAL-5 (partial) a settle drawing 60¢ of allocation writes 60¢ out of the parent and 60¢ into the drive wallet, under the consumer and the call', () => {
    expect(allocationTransferRows({ fromWalletId: 'w-pool', toWalletId: 'w-product', cents: 60, userId: 'u-marcus', aiUsageLogId: 'aul-1', spendKind: 'ai' })).toEqual([
      { userId: 'u-marcus', walletId: 'w-pool', entryType: ALLOCATION_DRAW_ENTRY, bucket: 'monthly', amountCents: -60, appliedCents: -60, aiUsageLogId: 'aul-1', consumeStatus: 'applied', spendKind: 'ai' },
      { userId: 'u-marcus', walletId: 'w-product', entryType: ALLOCATION_DRAW_ENTRY, bucket: 'monthly', amountCents: 60, appliedCents: 60, aiUsageLogId: 'aul-1', consumeStatus: 'applied', spendKind: 'ai' },
    ]);
  });

  it('nothing drawn writes nothing', () => {
    for (const cents of [0, -5, Number.NaN]) {
      expect(allocationTransferRows({ fromWalletId: 'a', toWalletId: 'b', cents, userId: 'u', aiUsageLogId: null, spendKind: 'ai' })).toEqual([]);
    }
  });
});

describe('ledgerMovementCents: what one row moved on its wallet\'s net', () => {
  it('WAL-5 (partial) grants and purchases count their amount; usage and transfers what they applied; a debt adjustment its amount; seat attribution nothing', () => {
    expect(ledgerMovementCents(rowTotals({ entryType: 'monthly_grant', amountCents: 500, appliedCents: null }))).toBe(500);
    expect(ledgerMovementCents(rowTotals({ entryType: 'topup_purchase', amountCents: 1000, appliedCents: null }))).toBe(1000);
    expect(ledgerMovementCents(rowTotals({ entryType: 'usage', amountCents: -150, appliedCents: -60 }))).toBe(-60);
    // A pending claim has moved nothing yet.
    expect(ledgerMovementCents(rowTotals({ entryType: 'usage', amountCents: -150, appliedCents: null }))).toBe(0);
    for (const entryType of ['donation', 'wallet_topup', ALLOCATION_DRAW_ENTRY]) {
      expect(ledgerMovementCents(rowTotals({ entryType, amountCents: -40, appliedCents: -40 }))).toBe(-40);
    }
    // Overshoot landing as debt on this wallet: nothing out of the buckets, debt up by the amount.
    expect(ledgerMovementCents(rowTotals({ entryType: 'adjustment', amountCents: -90, appliedCents: null }))).toBe(-90);
    // A reconcile correction says what it applied.
    expect(ledgerMovementCents(rowTotals({ entryType: 'adjustment', amountCents: -10, appliedCents: -7 }))).toBe(-7);
    expect(ledgerMovementCents(rowTotals({ entryType: 'seat_overshoot_month', amountCents: 0, appliedCents: 0 }))).toBe(0);
  });

  it('WAL-5 (partial) summed per entry type, a debt row and a reconcile correction of the same type still count each their own way', () => {
    // -90 debt (applied null) and a -7 correction (amount -10): applied-or-amount sums -97.
    expect(ledgerMovementCents({ entryType: 'adjustment', amountCents: -100, appliedCents: -7, appliedOrAmountCents: -97 })).toBe(-97);
  });
});

describe('computeWalletDrift', () => {
  it('WAL-5 (partial) a wallet whose net (monthly + top-up − debt) equals what its rows moved is not flagged; a gap past the tolerance is', () => {
    expect(computeWalletDrift({ ledgerNetCents: 410, monthlyRemainingCents: 300, topupRemainingCents: 200, debtCents: 90 }, 10))
      .toEqual({ expectedNetCents: 410, materializedNetCents: 410, driftCents: 0, flagged: false });
    expect(computeWalletDrift({ ledgerNetCents: 400, monthlyRemainingCents: 300, topupRemainingCents: 200, debtCents: 90 }, 10))
      .toMatchObject({ driftCents: 10, flagged: false });
    expect(computeWalletDrift({ ledgerNetCents: 300, monthlyRemainingCents: 300, topupRemainingCents: 200, debtCents: 90 }, 10))
      .toMatchObject({ driftCents: 110, flagged: true });
  });
});

describe('wallet-ledger-core purity', () => {
  it('imports nothing that does I/O', () => {
    const src = readFileSync(fileURLToPath(new URL('../wallet-ledger-core.ts', import.meta.url)), 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports).toEqual(['@pagespace/db/schema/credits']);
    expect(src).toMatch(/^import type /m);
  });
});
