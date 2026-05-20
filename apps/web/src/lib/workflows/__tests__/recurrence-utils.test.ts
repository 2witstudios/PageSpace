import { describe, it, expect } from 'vitest';
import { expandOccurrences, type RecurrenceRule } from '../recurrence-utils';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const dates = (arr: Date[]) => arr.map(iso);

// 9 AM UTC on 2026-06-01 (Monday)
const BASE = new Date('2026-06-01T09:00:00Z');
const FROM = new Date('2026-06-01T00:00:00Z');

describe('expandOccurrences — DAILY', () => {
  it('returns one occurrence per day for interval=1', () => {
    const rule: RecurrenceRule = { frequency: 'DAILY', interval: 1, count: 5 };
    const result = dates(expandOccurrences(rule, BASE, FROM, new Date('2026-12-31'), []));
    expect(result).toEqual(['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05']);
  });

  it('skips every other day for interval=2', () => {
    const rule: RecurrenceRule = { frequency: 'DAILY', interval: 2, count: 3 };
    const result = dates(expandOccurrences(rule, BASE, FROM, new Date('2026-12-31'), []));
    expect(result).toEqual(['2026-06-01', '2026-06-03', '2026-06-05']);
  });

  it('preserves time-of-day across all occurrences', () => {
    const rule: RecurrenceRule = { frequency: 'DAILY', interval: 1, count: 3 };
    const result = expandOccurrences(rule, BASE, FROM, new Date('2026-12-31'), []);
    for (const d of result) {
      expect(d.getUTCHours()).toBe(9);
      expect(d.getUTCMinutes()).toBe(0);
    }
  });

  it('respects the to boundary', () => {
    const rule: RecurrenceRule = { frequency: 'DAILY', interval: 1 };
    const to = new Date('2026-06-03T23:59:59Z');
    const result = dates(expandOccurrences(rule, BASE, FROM, to, []));
    expect(result).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']);
  });

  it('skips exception dates', () => {
    const rule: RecurrenceRule = { frequency: 'DAILY', interval: 1, count: 5 };
    const result = dates(expandOccurrences(rule, BASE, FROM, new Date('2026-12-31'), ['2026-06-02', '2026-06-04']));
    expect(result).toEqual(['2026-06-01', '2026-06-03', '2026-06-05']);
  });

  it('stops at rule.until before to', () => {
    const rule: RecurrenceRule = { frequency: 'DAILY', interval: 1, until: '2026-06-03T23:59:59Z' };
    const result = dates(expandOccurrences(rule, BASE, FROM, new Date('2026-12-31'), []));
    expect(result).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']);
  });

  it('respects count and does not exceed it', () => {
    const rule: RecurrenceRule = { frequency: 'DAILY', interval: 1, count: 2 };
    const result = expandOccurrences(rule, BASE, FROM, new Date('2026-12-31'), []);
    expect(result).toHaveLength(2);
  });

  it('returns [] when from > to', () => {
    const rule: RecurrenceRule = { frequency: 'DAILY', interval: 1 };
    const result = expandOccurrences(rule, BASE, new Date('2026-12-31'), new Date('2026-06-01'), []);
    expect(result).toEqual([]);
  });

  it('excludes occurrences before from', () => {
    const rule: RecurrenceRule = { frequency: 'DAILY', interval: 1, count: 5 };
    const from = new Date('2026-06-03T00:00:00Z');
    const result = dates(expandOccurrences(rule, BASE, from, new Date('2026-12-31'), []));
    // COUNT still counts from series start; 5 total = Jun 1,2,3,4,5; only Jun 3-5 are in [from,to]
    expect(result).toEqual(['2026-06-03', '2026-06-04', '2026-06-05']);
  });

  it('count counts from series start, not from window start', () => {
    const rule: RecurrenceRule = { frequency: 'DAILY', interval: 1, count: 2 };
    const from = new Date('2026-06-03T00:00:00Z');
    // Only 2 occurrences total (Jun 1 + Jun 2); both before from — result is empty
    const result = expandOccurrences(rule, BASE, from, new Date('2026-12-31'), []);
    expect(result).toEqual([]);
  });
});

describe('expandOccurrences — WEEKLY', () => {
  // BASE is 2026-06-01 (Monday)

  it('returns weekly occurrences on same day-of-week when no byDay', () => {
    const rule: RecurrenceRule = { frequency: 'WEEKLY', interval: 1, count: 3 };
    const result = dates(expandOccurrences(rule, BASE, FROM, new Date('2026-12-31'), []));
    expect(result).toEqual(['2026-06-01', '2026-06-08', '2026-06-15']);
  });

  it('byDay emits multiple weekdays per week', () => {
    // MO + WE + FR from a Monday base
    const rule: RecurrenceRule = { frequency: 'WEEKLY', interval: 1, byDay: ['MO', 'WE', 'FR'], count: 6 };
    const result = dates(expandOccurrences(rule, BASE, FROM, new Date('2026-12-31'), []));
    // Week 1: Jun 1 (Mon), Jun 3 (Wed), Jun 5 (Fri); Week 2: Jun 8, Jun 10, Jun 12
    expect(result).toEqual(['2026-06-01', '2026-06-03', '2026-06-05', '2026-06-08', '2026-06-10', '2026-06-12']);
  });

  it('biweekly (interval=2) skips alternate weeks', () => {
    const rule: RecurrenceRule = { frequency: 'WEEKLY', interval: 2, count: 3 };
    const result = dates(expandOccurrences(rule, BASE, FROM, new Date('2026-12-31'), []));
    expect(result).toEqual(['2026-06-01', '2026-06-15', '2026-06-29']);
  });

  it('preserves time-of-day', () => {
    const rule: RecurrenceRule = { frequency: 'WEEKLY', interval: 1, count: 2 };
    const result = expandOccurrences(rule, BASE, FROM, new Date('2026-12-31'), []);
    for (const d of result) {
      expect(d.getUTCHours()).toBe(9);
    }
  });

  it('skips exception dates', () => {
    const rule: RecurrenceRule = { frequency: 'WEEKLY', interval: 1, count: 4 };
    const result = dates(expandOccurrences(rule, BASE, FROM, new Date('2026-12-31'), ['2026-06-08']));
    expect(result).toEqual(['2026-06-01', '2026-06-15', '2026-06-22']);
  });

  it('respects until', () => {
    const rule: RecurrenceRule = { frequency: 'WEEKLY', interval: 1, until: '2026-06-15T23:59:59Z' };
    const result = dates(expandOccurrences(rule, BASE, FROM, new Date('2026-12-31'), []));
    expect(result).toEqual(['2026-06-01', '2026-06-08', '2026-06-15']);
  });
});

describe('expandOccurrences — MONTHLY', () => {
  it('returns same day-of-month each month', () => {
    const rule: RecurrenceRule = { frequency: 'MONTHLY', interval: 1, count: 4 };
    const result = dates(expandOccurrences(rule, BASE, FROM, new Date('2026-12-31'), []));
    expect(result).toEqual(['2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01']);
  });

  it('interval=3 gives quarterly occurrences', () => {
    const rule: RecurrenceRule = { frequency: 'MONTHLY', interval: 3, count: 4 };
    const result = dates(expandOccurrences(rule, BASE, FROM, new Date('2027-12-31'), []));
    expect(result).toEqual(['2026-06-01', '2026-09-01', '2026-12-01', '2027-03-01']);
  });

  it('byMonthDay overrides the base day', () => {
    const rule: RecurrenceRule = { frequency: 'MONTHLY', interval: 1, byMonthDay: [15], count: 3 };
    const result = dates(expandOccurrences(rule, BASE, FROM, new Date('2026-12-31'), []));
    expect(result).toEqual(['2026-06-15', '2026-07-15', '2026-08-15']);
  });

  it('preserves time-of-day', () => {
    const rule: RecurrenceRule = { frequency: 'MONTHLY', interval: 1, count: 2 };
    const result = expandOccurrences(rule, BASE, FROM, new Date('2026-12-31'), []);
    for (const d of result) {
      expect(d.getUTCHours()).toBe(9);
    }
  });

  it('skips exception dates', () => {
    const rule: RecurrenceRule = { frequency: 'MONTHLY', interval: 1, count: 4 };
    const result = dates(expandOccurrences(rule, BASE, FROM, new Date('2026-12-31'), ['2026-07-01']));
    expect(result).toEqual(['2026-06-01', '2026-08-01', '2026-09-01']);
  });

  it('crosses year boundary correctly', () => {
    const base = new Date('2026-11-01T09:00:00Z');
    const rule: RecurrenceRule = { frequency: 'MONTHLY', interval: 1, count: 4 };
    const result = dates(expandOccurrences(rule, base, base, new Date('2027-12-31'), []));
    expect(result).toEqual(['2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01']);
  });
});

describe('expandOccurrences — YEARLY', () => {
  it('returns same date each year', () => {
    const rule: RecurrenceRule = { frequency: 'YEARLY', interval: 1, count: 4 };
    const result = dates(expandOccurrences(rule, BASE, FROM, new Date('2030-12-31'), []));
    expect(result).toEqual(['2026-06-01', '2027-06-01', '2028-06-01', '2029-06-01']);
  });

  it('interval=2 gives biennial occurrences', () => {
    const rule: RecurrenceRule = { frequency: 'YEARLY', interval: 2, count: 3 };
    const result = dates(expandOccurrences(rule, BASE, FROM, new Date('2035-12-31'), []));
    expect(result).toEqual(['2026-06-01', '2028-06-01', '2030-06-01']);
  });

  it('respects until', () => {
    const rule: RecurrenceRule = { frequency: 'YEARLY', interval: 1, until: '2028-06-01T23:59:59Z' };
    const result = dates(expandOccurrences(rule, BASE, FROM, new Date('2035-12-31'), []));
    expect(result).toEqual(['2026-06-01', '2027-06-01', '2028-06-01']);
  });

  it('preserves time-of-day', () => {
    const rule: RecurrenceRule = { frequency: 'YEARLY', interval: 1, count: 2 };
    const result = expandOccurrences(rule, BASE, FROM, new Date('2030-12-31'), []);
    for (const d of result) {
      expect(d.getUTCHours()).toBe(9);
    }
  });
});

describe('expandOccurrences — exception edge cases', () => {
  it('accepts full ISO exception strings and matches on date part', () => {
    const rule: RecurrenceRule = { frequency: 'DAILY', interval: 1, count: 3 };
    // Pass a full ISO string as an exception — should still match by date prefix
    const result = dates(expandOccurrences(rule, BASE, FROM, new Date('2026-12-31'), ['2026-06-02T09:00:00.000Z']));
    expect(result).toEqual(['2026-06-01', '2026-06-03']);
  });

  it('returns [] for a series fully exhausted by count before the window', () => {
    const rule: RecurrenceRule = { frequency: 'DAILY', interval: 1, count: 1 };
    const from = new Date('2026-06-05T00:00:00Z');
    const result = expandOccurrences(rule, BASE, from, new Date('2026-12-31'), []);
    expect(result).toEqual([]);
  });
});
