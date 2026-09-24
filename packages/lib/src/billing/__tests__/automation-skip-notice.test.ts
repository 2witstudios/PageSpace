import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { skipNoticePeriodStart, shouldNotifyLeadOfSkip } from '../automation-skip-notice';

const utc = (iso: string): Date => new Date(iso);

describe('automation skip notice: the period', () => {
  it('SPEND-6 (partial) a drive wallet with a running period governs the notice period', () => {
    expect(skipNoticePeriodStart({
      now: utc('2026-09-23T10:00:00Z'),
      walletPeriodStart: utc('2026-09-15T00:00:00Z'),
    })).toEqual(utc('2026-09-15T00:00:00Z'));
  });

  it('SPEND-6 (partial) with no wallet period the period is the UTC calendar month', () => {
    expect(skipNoticePeriodStart({ now: utc('2026-09-23T10:00:00Z'), walletPeriodStart: null }))
      .toEqual(utc('2026-09-01T00:00:00Z'));
  });

  it('SPEND-6 (partial) the month boundary is UTC: 23:30 on Aug 31 in Chicago is already September', () => {
    // 2026-08-31T23:30-05:00 is 2026-09-01T04:30Z.
    expect(skipNoticePeriodStart({ now: utc('2026-08-31T23:30:00-05:00'), walletPeriodStart: null }))
      .toEqual(utc('2026-09-01T00:00:00Z'));
    // One minute before midnight UTC on Aug 31 is still August, wherever the server sits.
    expect(skipNoticePeriodStart({ now: utc('2026-08-31T23:59:00Z'), walletPeriodStart: null }))
      .toEqual(utc('2026-08-01T00:00:00Z'));
  });

  it('a wallet period that has not begun yet does not govern; the UTC month does', () => {
    expect(skipNoticePeriodStart({
      now: utc('2026-09-23T10:00:00Z'),
      walletPeriodStart: utc('2026-10-01T00:00:00Z'),
    })).toEqual(utc('2026-09-01T00:00:00Z'));
  });
});

describe('automation skip notice: once per period', () => {
  const periodStart = utc('2026-09-01T00:00:00Z');

  it('SPEND-6 (partial) the first skip a lead has never been told about notifies', () => {
    expect(shouldNotifyLeadOfSkip({ lastNotifiedAt: null, periodStart })).toBe(true);
  });

  it('SPEND-6 (partial) two skips in one period notify once', () => {
    const first = shouldNotifyLeadOfSkip({ lastNotifiedAt: null, periodStart });
    const second = shouldNotifyLeadOfSkip({ lastNotifiedAt: utc('2026-09-02T08:00:00Z'), periodStart });
    expect([first, second]).toEqual([true, false]);
  });

  it('SPEND-6 (partial) a notice at the exact start of the period counts for that period', () => {
    expect(shouldNotifyLeadOfSkip({ lastNotifiedAt: periodStart, periodStart })).toBe(false);
  });

  it('SPEND-6 (partial) a skip in the next period notifies again', () => {
    const lastNotifiedAt = utc('2026-09-02T08:00:00Z');
    const nextPeriod = skipNoticePeriodStart({ now: utc('2026-10-01T00:00:01Z'), walletPeriodStart: null });
    expect(shouldNotifyLeadOfSkip({ lastNotifiedAt, periodStart: nextPeriod })).toBe(true);
  });
});

describe('automation skip notice purity', () => {
  it('imports nothing', () => {
    const src = readFileSync(fileURLToPath(new URL('../automation-skip-notice.ts', import.meta.url)), 'utf8');
    expect([...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])).toEqual([]);
  });
});
