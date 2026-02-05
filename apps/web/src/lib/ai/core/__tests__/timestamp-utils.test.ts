import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildTimestampSystemPrompt,
  getStartOfTodayInTimezone,
  getUserTimeOfDay,
  isValidTimezone,
  normalizeTimezone,
} from '../timestamp-utils';

describe('timestamp-utils', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('isValidTimezone', () => {
    it('returns true for valid IANA timezone names', () => {
      expect(isValidTimezone('UTC')).toBe(true);
      expect(isValidTimezone('America/New_York')).toBe(true);
    });

    it('returns false for invalid timezone names', () => {
      expect(isValidTimezone('Invalid/Timezone')).toBe(false);
    });
  });

  describe('normalizeTimezone', () => {
    it('returns UTC for null, undefined, or empty values', () => {
      expect(normalizeTimezone(undefined)).toBe('UTC');
      expect(normalizeTimezone(null)).toBe('UTC');
      expect(normalizeTimezone('')).toBe('UTC');
      expect(normalizeTimezone('   ')).toBe('UTC');
    });

    it('returns UTC for invalid timezone values', () => {
      expect(normalizeTimezone('Invalid/Timezone')).toBe('UTC');
    });

    it('trims and returns valid timezone values', () => {
      expect(normalizeTimezone('  America/Los_Angeles  ')).toBe('America/Los_Angeles');
    });
  });

  describe('getUserTimeOfDay', () => {
    it('returns morning for hours before 12', () => {
      vi.setSystemTime(new Date('2024-06-15T09:00:00Z'));

      const result = getUserTimeOfDay('UTC');
      expect(result.hour).toBe(9);
      expect(result.timeOfDay).toBe('morning');
    });

    it('returns afternoon for hours between 12 and 17', () => {
      vi.setSystemTime(new Date('2024-06-15T14:00:00Z'));

      const result = getUserTimeOfDay('UTC');
      expect(result.hour).toBe(14);
      expect(result.timeOfDay).toBe('afternoon');
    });

    it('returns evening for hours 17 and later', () => {
      vi.setSystemTime(new Date('2024-06-15T19:00:00Z'));

      const result = getUserTimeOfDay('UTC');
      expect(result.hour).toBe(19);
      expect(result.timeOfDay).toBe('evening');
    });

    it('handles different timezones correctly', () => {
      // At 14:00 UTC, it's 10:00 in New York (EDT, UTC-4)
      vi.setSystemTime(new Date('2024-06-15T14:00:00Z'));

      const utcResult = getUserTimeOfDay('UTC');
      expect(utcResult.timeOfDay).toBe('afternoon');

      const nyResult = getUserTimeOfDay('America/New_York');
      expect(nyResult.timeOfDay).toBe('morning');
    });

    it('falls back to UTC when timezone is invalid', () => {
      vi.setSystemTime(new Date('2024-06-15T14:00:00Z'));

      const result = getUserTimeOfDay('Invalid/Timezone');
      expect(result.timeOfDay).toBe('afternoon');
    });
  });

  describe('getStartOfTodayInTimezone', () => {
    it('returns midnight UTC for UTC timezone', () => {
      vi.setSystemTime(new Date('2024-06-15T14:30:00Z'));

      const result = getStartOfTodayInTimezone('UTC');
      const expected = new Date('2024-06-15T00:00:00Z');
      expect(result.toISOString()).toBe(expected.toISOString());
    });

    it('handles different timezones', () => {
      // At 2:00 UTC on June 15, it's June 14 22:00 in New York (EDT, UTC-4)
      vi.setSystemTime(new Date('2024-06-15T02:00:00Z'));

      const utcStart = getStartOfTodayInTimezone('UTC');
      const nyStart = getStartOfTodayInTimezone('America/New_York');

      expect(utcStart.toISOString()).toBe('2024-06-15T00:00:00.000Z');
      expect(nyStart.toISOString()).toBe('2024-06-14T04:00:00.000Z');
    });

    it('handles DST start day without shifting away from midnight', () => {
      // On 2024-10-06 in Sydney, DST starts and local offset changes from +10 to +11.
      vi.setSystemTime(new Date('2024-10-06T12:00:00Z'));

      const sydneyStart = getStartOfTodayInTimezone('Australia/Sydney');
      expect(sydneyStart.toISOString()).toBe('2024-10-05T14:00:00.000Z');
    });

    it('handles DST end day without shifting away from midnight', () => {
      // On 2024-04-07 in Sydney, DST ends and local offset changes from +11 to +10.
      vi.setSystemTime(new Date('2024-04-07T12:00:00Z'));

      const sydneyStart = getStartOfTodayInTimezone('Australia/Sydney');
      expect(sydneyStart.toISOString()).toBe('2024-04-06T13:00:00.000Z');
    });

    it('falls back to UTC for invalid timezones', () => {
      vi.setSystemTime(new Date('2024-06-15T14:30:00Z'));

      const result = getStartOfTodayInTimezone('Invalid/Timezone');
      expect(result.toISOString()).toBe('2024-06-15T00:00:00.000Z');
    });
  });

  describe('buildTimestampSystemPrompt', () => {
    it('includes the timezone in the output', () => {
      const result = buildTimestampSystemPrompt('America/Los_Angeles');
      expect(result).toContain('America/Los_Angeles');
      expect(result).toContain("User's timezone");
    });

    it('defaults to UTC when no timezone provided', () => {
      const result = buildTimestampSystemPrompt(null);
      expect(result).toContain('UTC');
    });

    it('defaults to UTC when timezone is invalid', () => {
      const result = buildTimestampSystemPrompt('Invalid/Timezone');
      expect(result).toContain("User's timezone: UTC");
    });

    it('includes time of day information', () => {
      const result = buildTimestampSystemPrompt('UTC');
      expect(result).toContain('Time of day:');
      expect(result).toMatch(/Time of day: (morning|afternoon|evening)/);
    });

    it('includes current timestamp information', () => {
      const result = buildTimestampSystemPrompt('UTC');
      expect(result).toContain('CURRENT TIMESTAMP CONTEXT');
      expect(result).toContain('Current date and time');
    });
  });
});
