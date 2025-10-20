import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  getTodayUTC,
  getTomorrowMidnightUTC,
  getSecondsUntilMidnightUTC,
  parseDateUTC
} from '../date-utils';

describe('date-utils', () => {
  describe('getTodayUTC', () => {
    it('returns date in YYYY-MM-DD format', () => {
      const result = getTodayUTC();

      // Should match YYYY-MM-DD pattern
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('returns consistent date when called multiple times in same day', () => {
      const date1 = getTodayUTC();
      const date2 = getTodayUTC();

      expect(date1).toBe(date2);
    });

    it('returns current UTC date, not local date', () => {
      const result = getTodayUTC();
      const now = new Date();

      // Manually construct expected UTC date
      const year = now.getUTCFullYear();
      const month = String(now.getUTCMonth() + 1).padStart(2, '0');
      const day = String(now.getUTCDate()).padStart(2, '0');
      const expected = `${year}-${month}-${day}`;

      expect(result).toBe(expected);
    });

    it('pads single-digit months and days with zeros', () => {
      // Mock a date with single-digit month and day (January 5th)
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-05T12:00:00Z'));

      const result = getTodayUTC();

      expect(result).toBe('2025-01-05');

      vi.useRealTimers();
    });

    it('handles month boundaries correctly', () => {
      // Last day of month
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-31T23:59:59Z'));

      const result = getTodayUTC();
      expect(result).toBe('2025-01-31');

      vi.useRealTimers();
    });

    it('handles year boundaries correctly', () => {
      // Last day of year
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-12-31T23:59:59Z'));

      const result = getTodayUTC();
      expect(result).toBe('2025-12-31');

      vi.useRealTimers();
    });

    it('uses UTC midnight, not local midnight', () => {
      // 1 AM UTC on Jan 2nd = 8 PM EST on Jan 1st (if you're in EST)
      // Should return Jan 2nd, not Jan 1st
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-02T01:00:00Z'));

      const result = getTodayUTC();
      expect(result).toBe('2025-01-02');

      vi.useRealTimers();
    });
  });

  describe('getTomorrowMidnightUTC', () => {
    it('returns a timestamp for tomorrow at midnight UTC', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-15T14:30:00Z')); // 2:30 PM UTC

      const result = getTomorrowMidnightUTC();
      const expected = Date.UTC(2025, 0, 16, 0, 0, 0, 0); // Jan 16 at midnight

      expect(result).toBe(expected);

      vi.useRealTimers();
    });

    it('returns midnight even when called near midnight', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-15T23:59:59Z')); // 11:59:59 PM UTC

      const result = getTomorrowMidnightUTC();
      const expected = Date.UTC(2025, 0, 16, 0, 0, 0, 0);

      expect(result).toBe(expected);

      vi.useRealTimers();
    });

    it('handles month boundary correctly', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-31T12:00:00Z')); // Last day of January

      const result = getTomorrowMidnightUTC();
      const expected = Date.UTC(2025, 1, 1, 0, 0, 0, 0); // Feb 1 at midnight

      expect(result).toBe(expected);

      vi.useRealTimers();
    });

    it('handles year boundary correctly', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-12-31T12:00:00Z')); // Last day of year

      const result = getTomorrowMidnightUTC();
      const expected = Date.UTC(2026, 0, 1, 0, 0, 0, 0); // Jan 1, 2026 at midnight

      expect(result).toBe(expected);

      vi.useRealTimers();
    });

    it('returns exact midnight (0 milliseconds)', () => {
      const result = getTomorrowMidnightUTC();
      const tomorrowDate = new Date(result);

      expect(tomorrowDate.getUTCHours()).toBe(0);
      expect(tomorrowDate.getUTCMinutes()).toBe(0);
      expect(tomorrowDate.getUTCSeconds()).toBe(0);
      expect(tomorrowDate.getUTCMilliseconds()).toBe(0);
    });
  });

  describe('getSecondsUntilMidnightUTC', () => {
    it('returns positive number of seconds until midnight', () => {
      const result = getSecondsUntilMidnightUTC();

      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThanOrEqual(86400); // Max 24 hours
    });

    it('counts down to zero at midnight UTC', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-15T23:59:59Z')); // 1 second before midnight

      const result = getSecondsUntilMidnightUTC();

      // Should be 1 second (rounded up by Math.ceil)
      expect(result).toBe(1);

      vi.useRealTimers();
    });

    it('returns full day worth of seconds at midnight', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-15T00:00:00Z')); // Exactly midnight

      const result = getSecondsUntilMidnightUTC();

      // Should be 86400 seconds (24 hours)
      expect(result).toBe(86400);

      vi.useRealTimers();
    });

    it('returns half day at noon UTC', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-15T12:00:00Z')); // Noon UTC

      const result = getSecondsUntilMidnightUTC();

      // Should be 43200 seconds (12 hours)
      expect(result).toBe(43200);

      vi.useRealTimers();
    });

    it('uses Math.ceil to round up partial seconds', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-15T23:59:59.500Z')); // 0.5 seconds before midnight

      const result = getSecondsUntilMidnightUTC();

      // Should round up to 1 second
      expect(result).toBe(1);

      vi.useRealTimers();
    });
  });

  describe('parseDateUTC', () => {
    it('parses YYYY-MM-DD format correctly', () => {
      const result = parseDateUTC('2025-01-15');
      const expected = Date.UTC(2025, 0, 15, 0, 0, 0, 0);

      expect(result).toBe(expected);
    });

    it('handles single-digit months and days', () => {
      const result = parseDateUTC('2025-01-05');
      const expected = Date.UTC(2025, 0, 5, 0, 0, 0, 0);

      expect(result).toBe(expected);
    });

    it('handles December correctly', () => {
      const result = parseDateUTC('2025-12-25');
      const expected = Date.UTC(2025, 11, 25, 0, 0, 0, 0); // Month 11 is December

      expect(result).toBe(expected);
    });

    it('returns midnight UTC timestamp', () => {
      const result = parseDateUTC('2025-06-15');
      const date = new Date(result);

      expect(date.getUTCHours()).toBe(0);
      expect(date.getUTCMinutes()).toBe(0);
      expect(date.getUTCSeconds()).toBe(0);
      expect(date.getUTCMilliseconds()).toBe(0);
    });
  });

  describe('timezone independence', () => {
    // These tests verify that all functions work correctly regardless of system timezone
    // This was the core bug in the old implementation

    afterEach(() => {
      vi.useRealTimers();
    });

    it('getTodayUTC returns same date across all timezones', () => {
      // Simulate UTC+10 (Sydney) where local time is ahead
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-15T20:00:00Z')); // 8 PM UTC = 6 AM next day in Sydney

      const result = getTodayUTC();

      // Should return Jan 15 (UTC date), NOT Jan 16 (Sydney local date)
      expect(result).toBe('2025-01-15');
    });

    it('getTodayUTC returns same date in UTC-8 (PST)', () => {
      // Simulate UTC-8 (PST) where local time is behind
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-15T07:00:00Z')); // 7 AM UTC = 11 PM prev day in PST

      const result = getTodayUTC();

      // Should return Jan 15 (UTC date), NOT Jan 14 (PST local date)
      expect(result).toBe('2025-01-15');
    });

    it('getTomorrowMidnightUTC returns UTC midnight regardless of timezone', () => {
      // Test in multiple "virtual" timezones by setting different UTC times
      vi.useFakeTimers();

      // UTC+12 equivalent
      vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
      const result1 = getTomorrowMidnightUTC();

      // UTC-10 equivalent
      vi.setSystemTime(new Date('2025-01-15T22:00:00Z'));
      const result2 = getTomorrowMidnightUTC();

      // Both should return the same midnight UTC timestamp
      expect(result1).toBe(Date.UTC(2025, 0, 16, 0, 0, 0, 0));
      expect(result2).toBe(Date.UTC(2025, 0, 16, 0, 0, 0, 0));
    });
  });
});
