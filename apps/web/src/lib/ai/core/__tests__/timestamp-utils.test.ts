import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildTimestampSystemPrompt,
  floorToBucket,
  formatTimestampContext,
  getStartOfTodayInTimezone,
  getUserTimeOfDay,
  isValidTimezone,
  isNaiveISODatetime,
  normalizeTimezone,
  parseNaiveDatetimeInTimezone,
  parseDateTime,
} from '../timestamp-utils';
import { OPENROUTER_CACHE_TTL_SECONDS, TIMESTAMP_BUCKET_MS } from '../ai-providers-config';

// RITEway-style assertion: every test answers the 5 questions.
const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

const FIVE_MIN_MS = 5 * 60 * 1000;

describe('timestamp-utils', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('cache TTL constants', () => {
    it('defaults the OpenRouter cache TTL to 300 seconds', () => {
      assert({
        given: 'the OpenRouter response-cache default',
        should: 'be 300 seconds',
        actual: OPENROUTER_CACHE_TTL_SECONDS,
        expected: 300,
      });
    });

    it('derives the timestamp bucket from the TTL so they cannot drift', () => {
      assert({
        given: 'the cache TTL in seconds',
        should: 'equal the timestamp bucket in milliseconds',
        actual: TIMESTAMP_BUCKET_MS,
        expected: OPENROUTER_CACHE_TTL_SECONDS * 1000,
      });
    });
  });

  describe('floorToBucket', () => {
    it('floors an instant down to the bucket boundary, dropping seconds and sub-bucket minutes', () => {
      assert({
        given: 'an instant at 14:03:47.500 and a 5-minute bucket',
        should: 'floor to 14:00:00.000',
        actual: floorToBucket(Date.UTC(2024, 5, 15, 14, 3, 47, 500), FIVE_MIN_MS),
        expected: Date.UTC(2024, 5, 15, 14, 0, 0, 0),
      });
    });

    it('floors to the nearest lower 5-minute mark, not the nearest', () => {
      assert({
        given: 'an instant at 14:07:30 and a 5-minute bucket',
        should: 'floor down to 14:05:00 (never round up)',
        actual: floorToBucket(Date.UTC(2024, 5, 15, 14, 7, 30), FIVE_MIN_MS),
        expected: Date.UTC(2024, 5, 15, 14, 5, 0),
      });
    });

    it('lands on a 5-minute wall-clock boundary even in a half-hour-offset zone', () => {
      // Asia/Kolkata is UTC+5:30. Flooring the absolute instant to 5 min keeps
      // the local wall-clock minute a multiple of 5 (offset is a whole multiple of 5).
      const floored = new Date(floorToBucket(Date.UTC(2024, 5, 15, 14, 3, 47), FIVE_MIN_MS));
      const minuteInKolkata = parseInt(
        new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', minute: 'numeric' }).format(floored),
        10,
      );
      assert({
        given: 'a floored instant rendered in Asia/Kolkata (UTC+5:30)',
        should: 'sit on a 5-minute wall-clock boundary',
        actual: minuteInKolkata % 5,
        expected: 0,
      });
    });
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

    it('derives the label from an injected instant without reading the global clock', () => {
      // System clock is left at the fake-timer epoch (morning); the injected
      // instant is evening. The result must follow the injected instant.
      vi.setSystemTime(new Date('2024-06-15T09:00:00Z'));
      assert({
        given: 'an injected evening instant (19:00Z) while the global clock reads morning',
        should: 'return the label for the injected instant, not the global clock',
        actual: getUserTimeOfDay('UTC', Date.UTC(2024, 5, 15, 19, 0, 0)).timeOfDay,
        expected: 'evening',
      });
    });

    it('labels midnight as morning (guards the ICU "24"-hour edge)', () => {
      assert({
        given: 'an injected instant at 00:30 local',
        should: 'label it morning, never evening (hour normalized mod 24)',
        actual: getUserTimeOfDay('UTC', Date.UTC(2024, 5, 15, 0, 30, 0)).timeOfDay,
        expected: 'morning',
      });
    });

    it('defaults to the current clock when no instant is injected', () => {
      vi.setSystemTime(new Date('2024-06-15T19:00:00Z'));
      assert({
        given: 'no injected instant',
        should: 'fall back to the current global clock',
        actual: getUserTimeOfDay('UTC').timeOfDay,
        expected: 'evening',
      });
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

  describe('isNaiveISODatetime', () => {
    it('matches naive datetime with seconds', () => {
      expect(isNaiveISODatetime('2026-02-19T19:00:00')).toBe(true);
    });

    it('matches naive datetime without seconds', () => {
      expect(isNaiveISODatetime('2026-02-19T19:00')).toBe(true);
    });

    it('matches naive datetime with milliseconds', () => {
      expect(isNaiveISODatetime('2026-02-19T19:00:00.000')).toBe(true);
    });

    it('trims whitespace before matching', () => {
      expect(isNaiveISODatetime('  2026-02-19T19:00:00  ')).toBe(true);
    });

    it('rejects datetime with Z suffix', () => {
      expect(isNaiveISODatetime('2026-02-19T19:00:00Z')).toBe(false);
    });

    it('rejects datetime with positive UTC offset', () => {
      expect(isNaiveISODatetime('2026-02-19T19:00:00+05:00')).toBe(false);
    });

    it('rejects datetime with negative UTC offset', () => {
      expect(isNaiveISODatetime('2026-02-19T19:00:00-06:00')).toBe(false);
    });

    it('rejects date-only strings', () => {
      expect(isNaiveISODatetime('2026-02-19')).toBe(false);
    });

    it('rejects natural language', () => {
      expect(isNaiveISODatetime('tomorrow at 3pm')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(isNaiveISODatetime('')).toBe(false);
    });
  });

  describe('parseNaiveDatetimeInTimezone', () => {
    it('interprets a naive datetime in a standard timezone', () => {
      // 7pm Central (CST, UTC-6) = 2026-02-20T01:00:00Z
      const result = parseNaiveDatetimeInTimezone('2026-02-19T19:00:00', 'America/Chicago');
      expect(result.toISOString()).toBe('2026-02-20T01:00:00.000Z');
    });

    it('handles spring-forward DST transition (America/New_York)', () => {
      // 2024-03-10 at 2:00 AM ET clocks spring forward to 3:00 AM EDT.
      // "3:30 AM" on that day is EDT (UTC-4), so correct UTC = 07:30Z.
      const result = parseNaiveDatetimeInTimezone('2024-03-10T03:30:00', 'America/New_York');
      expect(result.toISOString()).toBe('2024-03-10T07:30:00.000Z');
    });

    it('handles fall-back DST transition (America/New_York)', () => {
      // 2024-11-03 at 2:00 AM EDT clocks fall back to 1:00 AM EST.
      // "2:30 AM" on that day is unambiguously EST (UTC-5), so correct UTC = 07:30Z.
      const result = parseNaiveDatetimeInTimezone('2024-11-03T02:30:00', 'America/New_York');
      expect(result.toISOString()).toBe('2024-11-03T07:30:00.000Z');
    });

    it('handles spring-forward DST in a positive-offset timezone (Australia/Sydney)', () => {
      // 2024-10-06 at 2:00 AM AEST clocks spring forward to 3:00 AM AEDT.
      // "3:30 AM" on that day is AEDT (UTC+11), so correct UTC = 2024-10-05T16:30Z.
      const result = parseNaiveDatetimeInTimezone('2024-10-06T03:30:00', 'Australia/Sydney');
      expect(result.toISOString()).toBe('2024-10-05T16:30:00.000Z');
    });

    it('handles a time well outside DST transitions', () => {
      // Midsummer New York: EDT (UTC-4). 14:00 local = 18:00Z.
      const result = parseNaiveDatetimeInTimezone('2024-07-15T14:00:00', 'America/New_York');
      expect(result.toISOString()).toBe('2024-07-15T18:00:00.000Z');
    });

    it('handles UTC timezone as a no-op offset', () => {
      const result = parseNaiveDatetimeInTimezone('2024-06-15T12:00:00', 'UTC');
      expect(result.toISOString()).toBe('2024-06-15T12:00:00.000Z');
    });

    it('throws for invalid datetime strings', () => {
      expect(() => parseNaiveDatetimeInTimezone('not-a-date', 'UTC')).toThrow('Invalid datetime');
    });
  });

  describe('formatTimestampContext', () => {
    it('is deterministic: same inputs produce a byte-identical string', () => {
      const now = Date.UTC(2024, 5, 15, 14, 2, 30);
      assert({
        given: 'the same { now, timezone } passed twice',
        should: 'return byte-identical strings (no internal clock read)',
        actual: formatTimestampContext({ now, timezone: 'America/New_York' })
          === formatTimestampContext({ now, timezone: 'America/New_York' }),
        expected: true,
      });
    });

    it('renders identical text for two instants in the same 5-minute bucket', () => {
      const early = formatTimestampContext({ now: Date.UTC(2024, 5, 15, 14, 0, 10), timezone: 'America/New_York' });
      const late = formatTimestampContext({ now: Date.UTC(2024, 5, 15, 14, 4, 59), timezone: 'America/New_York' });
      assert({
        given: 'two instants 14:00:10 and 14:04:59 in one 5-minute bucket',
        should: 'render identical text so the request body hash matches',
        actual: early === late,
        expected: true,
      });
    });

    it('renders different text across a bucket boundary', () => {
      const before = formatTimestampContext({ now: Date.UTC(2024, 5, 15, 14, 4, 59), timezone: 'America/New_York' });
      const after = formatTimestampContext({ now: Date.UTC(2024, 5, 15, 14, 5, 0), timezone: 'America/New_York' });
      assert({
        given: 'instants on either side of a 5-minute boundary (14:04:59 vs 14:05:00)',
        should: 'render different text',
        actual: before === after,
        expected: false,
      });
    });

    it('renders the full weekday/month/day date', () => {
      assert({
        given: 'an instant on Saturday June 15 2024',
        should: 'render the full date',
        actual: formatTimestampContext({ now: Date.UTC(2024, 5, 15, 14, 0, 0), timezone: 'UTC' })
          .includes('Saturday, June 15, 2024'),
        expected: true,
      });
    });

    it('renders minute-granularity time with no seconds', () => {
      const result = formatTimestampContext({ now: Date.UTC(2024, 5, 15, 14, 3, 47), timezone: 'UTC' });
      assert({
        given: 'an instant at 14:03:47 floored to the 5-minute bucket',
        should: 'render the bucketed minute (2:00 PM) and never a seconds field',
        actual: result.includes('2:00 PM') && !/\d{1,2}:\d{2}:\d{2}/.test(result),
        expected: true,
      });
    });

    it('formats correctly in a half-hour-offset timezone', () => {
      // 14:00:00Z in Asia/Kolkata (UTC+5:30) is 7:30 PM the same day.
      assert({
        given: 'an instant rendered in Asia/Kolkata (UTC+5:30)',
        should: 'show the correct local wall-clock time',
        actual: formatTimestampContext({ now: Date.UTC(2024, 5, 15, 14, 0, 0), timezone: 'Asia/Kolkata' })
          .includes('7:30 PM'),
        expected: true,
      });
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

    it('with an injected instant, delegates to the pure core (no timer mocking needed)', () => {
      const now = Date.UTC(2024, 5, 15, 14, 3, 47);
      assert({
        given: 'an injected instant',
        should: 'equal the pure renderer output for the same instant and timezone',
        actual: buildTimestampSystemPrompt('America/New_York', now),
        expected: formatTimestampContext({ now, timezone: 'America/New_York' }),
      });
    });

    it('reads the clock once: same bucket via the default arg yields a stable prompt', () => {
      // Two real-time calls within the same 5-minute bucket must be identical.
      vi.useRealTimers();
      try {
        const bucketStart = floorToBucket(Date.now(), 5 * 60 * 1000);
        const a = buildTimestampSystemPrompt('UTC', bucketStart + 10_000);
        const b = buildTimestampSystemPrompt('UTC', bucketStart + 290_000);
        assert({
          given: 'two instants in the same 5-minute bucket passed to the default-arg wrapper',
          should: 'produce identical prompts',
          actual: a === b,
          expected: true,
        });
      } finally {
        vi.useFakeTimers();
      }
    });

    it('preserves the single-argument call signature for existing callers', () => {
      assert({
        given: 'a caller that passes only a timezone (no instant)',
        should: 'still return a populated prompt string',
        actual: buildTimestampSystemPrompt('UTC').includes('CURRENT TIMESTAMP CONTEXT'),
        expected: true,
      });
    });
  });

  describe('parseDateTime', () => {
    it('parses ISO 8601 dates with timezone offset', () => {
      const result = parseDateTime('2024-06-15T14:00:00Z');
      expect(result.toISOString()).toBe('2024-06-15T14:00:00.000Z');
    });

    it('parses naive ISO datetime in specified timezone', () => {
      const result = parseDateTime('2024-06-15T14:00:00', undefined, 'America/New_York');
      // 2pm EDT = 6pm UTC
      expect(result.toISOString()).toBe('2024-06-15T18:00:00.000Z');
    });

    it('parses natural language dates via chrono-node', () => {
      vi.setSystemTime(new Date('2024-06-15T12:00:00Z'));
      const result = parseDateTime('tomorrow at 3pm', undefined, 'UTC');
      expect(result.getUTCHours()).toBe(15);
      expect(result.getUTCDate()).toBe(16);
    });

    it('throws for unparseable date strings', () => {
      expect(() => parseDateTime('not a date at all')).toThrow('Could not parse date');
    });

    it('uses referenceDate for relative parsing', () => {
      const ref = new Date('2024-01-10T12:00:00Z');
      const result = parseDateTime('tomorrow at 9am', ref, 'UTC');
      expect(result.getUTCDate()).toBe(11);
      expect(result.getUTCHours()).toBe(9);
    });
  });
});
