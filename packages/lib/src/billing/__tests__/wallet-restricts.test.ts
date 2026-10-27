import { describe, it, expect } from 'vitest';
import { capChangeOnlyRestricts, walletPatchOnlyRestricts } from '../wallet-admin';

/** [D-OW-33] what a LAPSED org's admins may still change on its wallets: only what restricts. */
describe('walletPatchOnlyRestricts', () => {
  it('SEAT-9 (partial) WAL-7 (partial) pausing (the kill switch), refusing fallback and closing donations restrict', () => {
    expect(walletPatchOnlyRestricts({ paused: true })).toBe(true);
    expect(walletPatchOnlyRestricts({ fallbackRule: 'refuse' })).toBe(true);
    expect(walletPatchOnlyRestricts({ donationsEnabled: false })).toBe(true);
    expect(walletPatchOnlyRestricts({ paused: true, fallbackRule: 'refuse', donationsEnabled: false })).toBe(true);
  });

  it.each([
    [{ paused: false }],
    [{ fallbackRule: 'own_credits' as const }],
    [{ fallbackRule: 'seat_allowance' as const }],
    [{ fallbackRule: null }],
    [{ donationsEnabled: true }],
    [{ allocationCents: 0 }],
    [{ overshootChoice: null }],
    [{ defaultSpendSource: 'drive_wallet' as const }],
    [{ paused: true, allocationCents: 1 }],
  ])('SEAT-9 (partial) %j moves money, loosens, or is not a restriction: refused while lapsed', (input) => {
    expect(walletPatchOnlyRestricts(input)).toBe(false);
  });

  it('SEAT-9 (partial) an empty change restricts nothing and is not accepted as one', () => {
    expect(walletPatchOnlyRestricts({})).toBe(false);
  });
});

describe('capChangeOnlyRestricts', () => {
  const caps = (dailyCents: number | null, monthlyCents: number | null) => ({ dailyCents, monthlyCents });

  it('SEAT-9 (partial) WAL-7 (partial) lowering a window, or capping one that had none, restricts', () => {
    expect(capChangeOnlyRestricts(caps(300, 3_000), caps(100, 3_000))).toBe(true);
    expect(capChangeOnlyRestricts(caps(null, null), caps(10, 100))).toBe(true);
    expect(capChangeOnlyRestricts(caps(null, 3_000), caps(50, 3_000))).toBe(true);
    expect(capChangeOnlyRestricts(caps(300, 3_000), caps(300, 3_000))).toBe(true);
  });

  it('SEAT-9 (partial) raising either window, or lifting one to no cap, loosens', () => {
    expect(capChangeOnlyRestricts(caps(300, 3_000), caps(301, 3_000))).toBe(false);
    expect(capChangeOnlyRestricts(caps(300, 3_000), caps(50, 4_000))).toBe(false);
    expect(capChangeOnlyRestricts(caps(300, 3_000), caps(300, null))).toBe(false);
    expect(capChangeOnlyRestricts(caps(300, 3_000), caps(null, null))).toBe(false);
  });
});
