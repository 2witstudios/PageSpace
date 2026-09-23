/**
 * Drift guard: the CLI's copy of the credit formatter (`../credits.ts`) must render exactly
 * what the money model's canonical `formatCreditCount` does (MON-5 / UI-12). The CLI cannot
 * import lib at runtime (published-entry-no-lib), so this test-only import is the tie.
 */
import { describe, expect, it } from 'vitest';
import { formatCreditCount as libFormatCreditCount } from '@pagespace/lib/billing/money-model';
import { formatCreditCount, formatCredits } from '../credits.js';

const SAMPLES = [0, 1, 7, 99, 100, 120, 999, 1_000, 1_250, 9_000, 420_000, 12_345_678, 0.4, 0.5, 1.5, 2.5, -0.2, -1, -1_200, -12_345.5];

describe('CLI credit formatter — drift guard vs the money model', () => {
  it('X-1 (partial) formatCreditCount matches lib for every sample (grouping, rounding, -0, overage)', () => {
    for (const cents of SAMPLES) {
      expect(formatCreditCount(cents), String(cents)).toBe(libFormatCreditCount(cents));
    }
  });

  it('X-1 (partial) formatCredits appends the unit and never a currency symbol', () => {
    expect(formatCredits(120_000)).toBe('120,000 credits');
    expect(formatCredits(1)).toBe('1 credit');
    expect(formatCredits(0)).toBe('0 credits');
    expect(formatCredits(-500)).toBe('-500 credits');
    expect(SAMPLES.map(formatCredits).join(' ')).not.toMatch(/\$/);
  });
});
