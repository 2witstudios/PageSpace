import { describe, it, expect } from 'vitest';
import { parseWalletDraws, addWalletDraws, planWalletRefund, type WalletDraws } from '../wallet-draws';

const record: WalletDraws = {
  walletId: 'w-drive',
  totalCents: 200,
  allocationCents: 40,
  legs: [{ legId: 'leg-owner', cents: 100 }, { legId: 'leg-donation', cents: 30 }],
  debtCents: 30,
  debtWalletId: 'w-root',
};

describe('parseWalletDraws (untrusted jsonb)', () => {
  it('accepts a well-formed record for this wallet', () => {
    expect(parseWalletDraws({ generationIds: ['g'], walletDraws: record }, 'w-drive')).toEqual({ ok: true, draws: record });
  });

  it.each([
    ['no metadata', null, 'absent'],
    ['metadata without a record', { generationIds: ['g'] }, 'absent'],
    ['a null record', { walletDraws: null }, 'absent'],
    ['an array record', { walletDraws: [] }, 'malformed'],
    ['a numeric walletId', { walletDraws: { ...record, walletId: 7 } }, 'malformed'],
    ['another wallet', { walletDraws: { ...record, walletId: 'w-other' } }, 'other_wallet'],
    ['negative allocation', { walletDraws: { ...record, allocationCents: -40, totalCents: 120 } }, 'malformed'],
    ['string cents', { walletDraws: { ...record, totalCents: '200' } }, 'malformed'],
    ['debt with no wallet', { walletDraws: { ...record, debtWalletId: null } }, 'malformed'],
    ['a leg without an id', { walletDraws: { ...record, legs: [{ cents: 130 }] } }, 'malformed'],
    ['legs not an array', { walletDraws: { ...record, legs: { 'leg-owner': 130 } } }, 'malformed'],
    ['parts that do not add up', { walletDraws: { ...record, totalCents: 201 } }, 'sums_disagree'],
  ])('rejects %s', (_label, metadata, reason) => {
    expect(parseWalletDraws(metadata, 'w-drive')).toEqual({ ok: false, reason });
  });
});

describe('addWalletDraws', () => {
  it('starts a record from the first charge and folds a later one into it, same leg summed', () => {
    const first = addWalletDraws(null, { walletId: 'w', allocationCents: 10, legs: [{ legId: 'a', cents: 5 }], debtCents: 0, debtWalletId: null });
    const both = addWalletDraws(first, { walletId: 'w', allocationCents: 0, legs: [{ legId: 'a', cents: 3 }, { legId: 'b', cents: 7 }], debtCents: 2, debtWalletId: 'p' });
    expect(both).toEqual({ walletId: 'w', totalCents: 27, allocationCents: 10, legs: [{ legId: 'a', cents: 8 }, { legId: 'b', cents: 7 }], debtCents: 2, debtWalletId: 'p' });
  });
});

describe('planWalletRefund (inverse order of the draw)', () => {
  it('returns debt first, then the legs newest-drawn first, then the allocation', () => {
    const plan = planWalletRefund(record, 150);
    expect(plan).toMatchObject({
      debtCents: 30,
      debtWalletId: 'w-root',
      legCredits: [{ legId: 'leg-donation', cents: 30 }, { legId: 'leg-owner', cents: 90 }],
      allocationCents: 0,
    });
    expect(plan?.remaining).toEqual({ ...record, totalCents: 50, debtCents: 0, legs: [{ legId: 'leg-owner', cents: 10 }, { legId: 'leg-donation', cents: 0 }] });
  });

  it('never asks a leg for more than this call took from it', () => {
    const plan = planWalletRefund(record, 200);
    expect(plan?.legCredits).toEqual([{ legId: 'leg-donation', cents: 30 }, { legId: 'leg-owner', cents: 100 }]);
    expect(plan?.allocationCents).toBe(40);
  });

  it('refuses a refund larger than the record says was charged (the record and the correction disagree)', () => {
    expect(planWalletRefund(record, 201)).toBeNull();
    expect(planWalletRefund(record, -1)).toBeNull();
    expect(planWalletRefund(record, 1.5)).toBeNull();
  });
});
