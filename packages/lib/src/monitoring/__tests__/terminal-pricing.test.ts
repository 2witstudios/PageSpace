import { describe, it, expect } from 'vitest';
import {
  calculateTerminalCostDollars,
  TERMINAL_RATES,
  TERMINAL_ASSUMED_CPUS,
  TERMINAL_ASSUMED_MEMORY_GB,
} from '../terminal-pricing';

describe('calculateTerminalCostDollars', () => {
  it('bills one hour of active runtime at the assumed default machine shape', () => {
    // 1 cpu x $0.07/hr + 0.25 GB x $0.04375/hr = $0.0809375 for one hour, rounded
    // to 6 decimal places (0.080938) like every other pricing function in this file.
    expect(calculateTerminalCostDollars({ activeSeconds: 3600 })).toBeCloseTo(0.0809375, 5);
  });

  it('prorates partial seconds (1 second of a hurly rate)', () => {
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
