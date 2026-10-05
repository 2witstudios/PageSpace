import { describe, it, expect } from 'vitest';
import { centsFromCredits } from '../money-model';
import { capAlertsDue, capAlertCopy } from '../cap-alerts-core';

const c = (credits: number): number => Math.round(centsFromCredits(credits));

describe('cap alerts: which are due and what the funder reads', () => {
  it('WAL-7 (partial) each cap window reports the thresholds its spend has reached; a window with no cap reports none', () => {
    expect(capAlertsDue([
      { window: 'daily', capCents: c(10), spentCents: c(8) },
      { window: 'monthly', capCents: c(100), spentCents: c(100) },
    ])).toEqual([
      { window: 'daily', threshold: 80 },
      { window: 'monthly', threshold: 80 },
      { window: 'monthly', threshold: 100 },
    ]);
    expect(capAlertsDue([{ window: 'daily', capCents: null, spentCents: c(500) }])).toEqual([]);
  });

  it.each([
    [80, 'daily', 'Marcus Oyelaran has used 80% of their daily cap in Product: 8 of 10 credits.'],
    [100, 'monthly', 'Marcus Oyelaran has reached their monthly cap in Product: 100 of 100 credits. Their calls on this wallet are refused until the cap resets or is raised.'],
  ] as const)('WAL-7 (partial) the %s%% %s alert names the person and the place, in credits — never a dollar sign', (threshold, window, message) => {
    const spent = threshold === 80 ? c(8) : c(100);
    const cap = threshold === 80 ? c(10) : c(100);
    const copy = capAlertCopy({ threshold, window, consumerName: 'Marcus Oyelaran', placeName: 'Product', spentCents: spent, capCents: cap });
    expect(copy.message).toBe(message);
    expect(`${copy.title} ${copy.message}`).not.toContain('$');
  });
});
