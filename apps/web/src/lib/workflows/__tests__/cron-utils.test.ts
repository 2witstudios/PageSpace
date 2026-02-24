import { describe, it, expect } from 'vitest';
import { validateCronExpression, validateTimezone, getNextRunDate, getHumanReadableCron } from '../cron-utils';

describe('validateCronExpression', () => {
  it('should return valid for a standard cron expression', () => {
    expect(validateCronExpression('0 9 * * 1-5')).toEqual({ valid: true });
  });

  it('should return valid for every-minute expression', () => {
    expect(validateCronExpression('* * * * *')).toEqual({ valid: true });
  });

  it('should return valid for complex expressions', () => {
    expect(validateCronExpression('*/5 * * * *')).toEqual({ valid: true });
    expect(validateCronExpression('0 9 1 * *')).toEqual({ valid: true });
  });

  it('should return invalid for a malformed expression', () => {
    const result = validateCronExpression('not-a-cron');
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should return invalid for too few fields', () => {
    const result = validateCronExpression('0 9 *');
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('getNextRunDate', () => {
  it('should return a Date object', () => {
    const result = getNextRunDate('* * * * *', 'UTC');
    expect(result).toBeInstanceOf(Date);
  });

  it('should return a future date', () => {
    const now = new Date();
    const result = getNextRunDate('* * * * *', 'UTC');
    expect(result.getTime()).toBeGreaterThan(now.getTime() - 1000);
  });

  it('should respect the after parameter', () => {
    const after = new Date('2025-01-01T00:00:00Z');
    const result = getNextRunDate('0 9 * * *', 'UTC', after);
    expect(result.getTime()).toBeGreaterThan(after.getTime());
  });

  it('should work with different timezones', () => {
    const result = getNextRunDate('0 9 * * *', 'America/New_York');
    expect(result).toBeInstanceOf(Date);
  });
});

describe('validateTimezone', () => {
  it('should accept UTC', () => {
    expect(validateTimezone('UTC')).toEqual({ valid: true });
  });

  it('should accept a valid IANA timezone', () => {
    expect(validateTimezone('America/New_York')).toEqual({ valid: true });
  });

  it('should reject garbage input', () => {
    const result = validateTimezone('Not/A_Timezone');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid timezone');
  });

  it('should reject empty string', () => {
    const result = validateTimezone('');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid timezone');
  });
});

describe('getHumanReadableCron', () => {
  it('should return a human-readable string for a valid expression', () => {
    const result = getHumanReadableCron('0 9 * * 1-5');
    expect(typeof result).toBe('string');
    expect(result).not.toBe('0 9 * * 1-5');
    expect(result.length).toBeGreaterThan(0);
  });

  it('should return the raw expression for invalid input', () => {
    const result = getHumanReadableCron('not-valid');
    expect(result).toBe('not-valid');
  });

  it('should describe every-minute cron', () => {
    const result = getHumanReadableCron('* * * * *');
    expect(result.toLowerCase()).toContain('every minute');
  });

  it('should describe hourly cron', () => {
    const result = getHumanReadableCron('0 * * * *');
    expect(result.toLowerCase()).toContain('every hour');
  });
});
