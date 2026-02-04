import { describe, it, expect } from 'vitest';
import {
  getUserTimeOfDay,
  getStartOfTodayInTimezone,
  buildTimestampSystemPrompt,
} from '../timestamp-utils';

describe('timestamp-utils', () => {
  describe('getUserTimeOfDay', () => {
    it('should return morning for hours before 12', () => {
      // Mock the current time to 9 AM UTC
      const testDate = new Date('2024-06-15T09:00:00Z');
      const originalDate = Date;
      global.Date = class extends originalDate {
        constructor(...args: unknown[]) {
          if (args.length === 0) {
            super(testDate);
          } else {
            // @ts-expect-error - spread args
            super(...args);
          }
        }
        static now() {
          return testDate.getTime();
        }
      } as DateConstructor;

      const result = getUserTimeOfDay('UTC');
      expect(result.hour).toBe(9);
      expect(result.timeOfDay).toBe('morning');

      global.Date = originalDate;
    });

    it('should return afternoon for hours between 12 and 17', () => {
      const testDate = new Date('2024-06-15T14:00:00Z');
      const originalDate = Date;
      global.Date = class extends originalDate {
        constructor(...args: unknown[]) {
          if (args.length === 0) {
            super(testDate);
          } else {
            // @ts-expect-error - spread args
            super(...args);
          }
        }
        static now() {
          return testDate.getTime();
        }
      } as DateConstructor;

      const result = getUserTimeOfDay('UTC');
      expect(result.hour).toBe(14);
      expect(result.timeOfDay).toBe('afternoon');

      global.Date = originalDate;
    });

    it('should return evening for hours 17 and later', () => {
      const testDate = new Date('2024-06-15T19:00:00Z');
      const originalDate = Date;
      global.Date = class extends originalDate {
        constructor(...args: unknown[]) {
          if (args.length === 0) {
            super(testDate);
          } else {
            // @ts-expect-error - spread args
            super(...args);
          }
        }
        static now() {
          return testDate.getTime();
        }
      } as DateConstructor;

      const result = getUserTimeOfDay('UTC');
      expect(result.hour).toBe(19);
      expect(result.timeOfDay).toBe('evening');

      global.Date = originalDate;
    });

    it('should handle different timezones correctly', () => {
      // At 14:00 UTC, it's 10:00 in New York (EDT, UTC-4)
      const testDate = new Date('2024-06-15T14:00:00Z');
      const originalDate = Date;
      global.Date = class extends originalDate {
        constructor(...args: unknown[]) {
          if (args.length === 0) {
            super(testDate);
          } else {
            // @ts-expect-error - spread args
            super(...args);
          }
        }
        static now() {
          return testDate.getTime();
        }
      } as DateConstructor;

      const utcResult = getUserTimeOfDay('UTC');
      expect(utcResult.timeOfDay).toBe('afternoon'); // 14:00 UTC

      const nyResult = getUserTimeOfDay('America/New_York');
      expect(nyResult.timeOfDay).toBe('morning'); // 10:00 EDT

      global.Date = originalDate;
    });

    it('should default to UTC when timezone is null or undefined', () => {
      const result1 = getUserTimeOfDay(null);
      const result2 = getUserTimeOfDay(undefined);

      // Both should work without throwing
      expect(result1.timeOfDay).toBeDefined();
      expect(result2.timeOfDay).toBeDefined();
    });
  });

  describe('getStartOfTodayInTimezone', () => {
    it('should return midnight UTC for UTC timezone', () => {
      const testDate = new Date('2024-06-15T14:30:00Z');
      const originalDate = Date;
      global.Date = class extends originalDate {
        constructor(...args: unknown[]) {
          if (args.length === 0) {
            super(testDate);
          } else {
            // @ts-expect-error - spread args
            super(...args);
          }
        }
        static now() {
          return testDate.getTime();
        }
      } as DateConstructor;

      const result = getStartOfTodayInTimezone('UTC');
      const expected = new Date('2024-06-15T00:00:00Z');
      expect(result.toISOString()).toBe(expected.toISOString());

      global.Date = originalDate;
    });

    it('should handle null timezone by defaulting to UTC', () => {
      const result = getStartOfTodayInTimezone(null);
      expect(result).toBeInstanceOf(Date);
    });

    it('should handle different timezones', () => {
      // At 2:00 UTC on June 15, it's June 14 22:00 in New York (EDT, UTC-4)
      const testDate = new Date('2024-06-15T02:00:00Z');
      const originalDate = Date;
      global.Date = class extends originalDate {
        constructor(...args: unknown[]) {
          if (args.length === 0) {
            super(testDate);
          } else {
            // @ts-expect-error - spread args
            super(...args);
          }
        }
        static now() {
          return testDate.getTime();
        }
      } as DateConstructor;

      const utcStart = getStartOfTodayInTimezone('UTC');
      const nyStart = getStartOfTodayInTimezone('America/New_York');

      // UTC midnight June 15 is 2024-06-15T00:00:00Z
      expect(utcStart.toISOString().split('T')[0]).toBe('2024-06-15');

      // NY midnight June 14 is 2024-06-14T04:00:00Z
      // (midnight in EDT = 4:00 UTC due to -4 offset)
      expect(nyStart.toISOString().split('T')[0]).toBe('2024-06-14');

      global.Date = originalDate;
    });
  });

  describe('buildTimestampSystemPrompt', () => {
    it('should include the timezone in the output', () => {
      const result = buildTimestampSystemPrompt('America/Los_Angeles');
      expect(result).toContain('America/Los_Angeles');
      expect(result).toContain("User's timezone");
    });

    it('should default to UTC when no timezone provided', () => {
      const result = buildTimestampSystemPrompt(null);
      expect(result).toContain('UTC');
    });

    it('should include time of day information', () => {
      const result = buildTimestampSystemPrompt('UTC');
      expect(result).toContain('Time of day:');
      // Should contain one of: morning, afternoon, evening, or day
      expect(result).toMatch(/Time of day: (morning|afternoon|evening|day)/);
    });

    it('should include current timestamp information', () => {
      const result = buildTimestampSystemPrompt('UTC');
      expect(result).toContain('CURRENT TIMESTAMP CONTEXT');
      expect(result).toContain('Current date and time');
    });
  });
});
