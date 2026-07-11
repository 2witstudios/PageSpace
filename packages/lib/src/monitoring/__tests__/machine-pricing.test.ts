import { describe, it, expect } from 'vitest';
import {
  calculateMachineCostDollars,
  calculateMachineStorageCostDollars,
} from '../machine-pricing';
import {
  MACHINE_MARKUP_BPS,
  MACHINE_RATES,
  MACHINE_ASSUMED_CPUS,
  MACHINE_ASSUMED_MEMORY_GB,
  MACHINE_STORAGE_USD_PER_GB_MONTH,
} from '../../billing/credit-pricing';

describe('calculateMachineCostDollars', () => {
  it('bills one hour of active runtime at the assumed default machine shape', () => {
    // 1 cpu x $0.07/hr + 0.25 GB x $0.04375/hr = $0.0809375 for one hour, rounded
    // to 6 decimal places (0.080938) like every other pricing function in this file.
    expect(calculateMachineCostDollars({ activeSeconds: 3600 })).toBeCloseTo(0.0809375, 5);
  });

  it('prorates partial seconds (1 second of a hourly rate)', () => {
    const perSecond =
      (MACHINE_ASSUMED_CPUS * MACHINE_RATES.usdPerCpuHour +
        MACHINE_ASSUMED_MEMORY_GB * MACHINE_RATES.usdPerMemGbHour) /
      3600;
    expect(calculateMachineCostDollars({ activeSeconds: 1 })).toBeCloseTo(perSecond, 6);
  });

  it('returns 0 for missing/invalid/zero active seconds rather than a NaN or negative charge', () => {
    expect(calculateMachineCostDollars({})).toBe(0);
    expect(calculateMachineCostDollars({ activeSeconds: 0 })).toBe(0);
    expect(calculateMachineCostDollars({ activeSeconds: -5 })).toBe(0);
    expect(calculateMachineCostDollars({ activeSeconds: Number.NaN })).toBe(0);
  });

  it('bills hibernated (zero-duration) runs nothing', () => {
    expect(calculateMachineCostDollars({ activeSeconds: 0 })).toBe(0);
  });
});

describe('MACHINE_RATES defaults pinned to Sprites published pricing', () => {
  it('active CPU-hour = $0.07, mem GB-hour = $0.04375', () => {
    expect(MACHINE_RATES.usdPerCpuHour).toBeCloseTo(0.07, 6);
    expect(MACHINE_RATES.usdPerMemGbHour).toBeCloseTo(0.04375, 6);
  });
});

describe('MACHINE_MARKUP_BPS is an independent 1.5x floor, not derived from the shared AI markup', () => {
  it('defaults to >=15000 bps (1.5x) on its own env var, decoupled from CREDIT_MARKUP_BPS', () => {
    // Real floor enforcement: this constant is read from its OWN env var
    // (MACHINE_MARKUP_BPS), not derived from MARKUP_BPS — so lowering
    // CREDIT_MARKUP_BPS for AI-model billing cannot silently move this value.
    // (See machine-billing.ts / machine-storage-billing.ts: both pass this
    // constant to AIMonitoring.trackUsage as `markupBpsOverride`, and
    // credit-consume.ts's consumeCredits uses `markupBpsOverride ?? MARKUP_BPS`
    // — an explicit override, never a fallback to the shared default.)
    expect(MACHINE_MARKUP_BPS).toBeGreaterThanOrEqual(15000);
  });

  it('marks up a known active-window to the expected whole-cent charge at the terminal floor', () => {
    // 3600s @ the assumed shape = $0.0809375 real cost; marked up at
    // MACHINE_MARKUP_BPS (1.5x by default) = $0.12140625 -> rounds to 12 cents.
    const cost = calculateMachineCostDollars({ activeSeconds: 3600 });
    const chargeCents = Math.round(cost * (MACHINE_MARKUP_BPS / 10000) * 100);
    expect(chargeCents).toBe(12);
  });
});

describe('calculateMachineStorageCostDollars', () => {
  it('bills GB-months at the published storage rate', () => {
    expect(calculateMachineStorageCostDollars(1)).toBeCloseTo(MACHINE_STORAGE_USD_PER_GB_MONTH, 6);
    expect(calculateMachineStorageCostDollars(2.5)).toBeCloseTo(MACHINE_STORAGE_USD_PER_GB_MONTH * 2.5, 6);
  });

  it('returns 0 for missing/invalid/non-positive quantity', () => {
    expect(calculateMachineStorageCostDollars(0)).toBe(0);
    expect(calculateMachineStorageCostDollars(-1)).toBe(0);
    expect(calculateMachineStorageCostDollars(Number.NaN)).toBe(0);
  });
});
