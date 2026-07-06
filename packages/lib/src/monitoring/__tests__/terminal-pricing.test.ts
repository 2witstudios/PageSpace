import { describe, it, expect } from 'vitest';
import {
  calculateTerminalCostDollars,
  calculateTerminalChargeCents,
  calculateTerminalStorageCostDollars,
} from '../terminal-pricing';
import {
  MARKUP_BPS,
  TERMINAL_RATES,
  TERMINAL_ASSUMED_CPUS,
  TERMINAL_ASSUMED_MEMORY_GB,
  TERMINAL_STORAGE_USD_PER_GB_MONTH,
} from '../../billing/credit-pricing';

describe('calculateTerminalCostDollars', () => {
  it('bills one hour of active runtime at the assumed default machine shape', () => {
    // 1 cpu x $0.07/hr + 0.25 GB x $0.04375/hr = $0.0809375 for one hour, rounded
    // to 6 decimal places (0.080938) like every other pricing function in this file.
    expect(calculateTerminalCostDollars({ activeSeconds: 3600 })).toBeCloseTo(0.0809375, 5);
  });

  it('prorates partial seconds (1 second of a hourly rate)', () => {
    const perSecond =
      (TERMINAL_ASSUMED_CPUS * TERMINAL_RATES.usdPerCpuHour +
        TERMINAL_ASSUMED_MEMORY_GB * TERMINAL_RATES.usdPerMemGbHour) /
      3600;
    expect(calculateTerminalCostDollars({ activeSeconds: 1 })).toBeCloseTo(perSecond, 6);
  });

  it('returns 0 for missing/invalid/zero active seconds rather than a NaN or negative charge', () => {
    expect(calculateTerminalCostDollars({})).toBe(0);
    expect(calculateTerminalCostDollars({ activeSeconds: 0 })).toBe(0);
    expect(calculateTerminalCostDollars({ activeSeconds: -5 })).toBe(0);
    expect(calculateTerminalCostDollars({ activeSeconds: Number.NaN })).toBe(0);
  });

  it('bills hibernated (zero-duration) runs nothing', () => {
    expect(calculateTerminalCostDollars({ activeSeconds: 0 })).toBe(0);
  });
});

describe('TERMINAL_RATES defaults pinned to Sprites published pricing', () => {
  it('active CPU-hour = $0.07, mem GB-hour = $0.04375', () => {
    expect(TERMINAL_RATES.usdPerCpuHour).toBeCloseTo(0.07, 6);
    expect(TERMINAL_RATES.usdPerMemGbHour).toBeCloseTo(0.04375, 6);
  });
});

describe('calculateTerminalChargeCents', () => {
  it('maps a known active-window (cpu-seconds, mem) to the expected charge in cents', () => {
    // 3600s @ the assumed shape = $0.0809375 real cost; marked up at MARKUP_BPS
    // (1.5x by default) = $0.12140625 -> rounds to 12 cents.
    const cost = calculateTerminalCostDollars({ activeSeconds: 3600 });
    const expectedCents = Math.round(cost * (MARKUP_BPS / 10000) * 100);
    expect(calculateTerminalChargeCents({ activeSeconds: 3600 })).toBe(expectedCents);
    expect(calculateTerminalChargeCents({ activeSeconds: 3600 })).toBe(12);
  });

  it('pins the shared MARKUP_BPS default at >=1.5x — NOT an independent per-source floor', () => {
    // This only asserts the GLOBAL constant every AI surface shares is still >=15000bps.
    // calculateTerminalChargeCents applies whatever MARKUP_BPS currently is, same as
    // every other source — it has no terminal-specific floor logic of its own (see
    // terminal-pricing.ts's module doc). If this default is ever lowered, or split
    // per-source, this test — and the "amount never less than 1.5x" check below — stop
    // meaning what their names say; they'd need a real per-source floor to test instead.
    expect(MARKUP_BPS).toBeGreaterThanOrEqual(15000);
    for (const activeSeconds of [1, 60, 900, 3600, 7200]) {
      const cost = calculateTerminalCostDollars({ activeSeconds });
      const chargeCents = calculateTerminalChargeCents({ activeSeconds });
      // Formula consistency, not floor enforcement: this holds for ANY positive
      // MARKUP_BPS >= ~1.0x, so it does not by itself prove a 1.5x floor exists.
      expect(chargeCents).toBeGreaterThanOrEqual(Math.floor(cost * 1.5 * 100));
    }
  });

  it('charges nothing for a hibernated (zero-duration) window', () => {
    expect(calculateTerminalChargeCents({ activeSeconds: 0 })).toBe(0);
    expect(calculateTerminalChargeCents({})).toBe(0);
  });
});

describe('calculateTerminalStorageCostDollars', () => {
  it('bills GB-months at the published storage rate', () => {
    expect(calculateTerminalStorageCostDollars(1)).toBeCloseTo(TERMINAL_STORAGE_USD_PER_GB_MONTH, 6);
    expect(calculateTerminalStorageCostDollars(2.5)).toBeCloseTo(TERMINAL_STORAGE_USD_PER_GB_MONTH * 2.5, 6);
  });

  it('returns 0 for missing/invalid/non-positive quantity', () => {
    expect(calculateTerminalStorageCostDollars(0)).toBe(0);
    expect(calculateTerminalStorageCostDollars(-1)).toBe(0);
    expect(calculateTerminalStorageCostDollars(Number.NaN)).toBe(0);
  });
});
