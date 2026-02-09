import { describe, it } from 'vitest';
import { assert } from './riteway';
import { toISOTimestamp } from '../timestamp';

describe('toISOTimestamp', () => {
  it('should return null for null input', () => {
    assert({
      given: 'null timestamp',
      should: 'return null',
      actual: toISOTimestamp(null),
      expected: null,
    });
  });

  it('should pass through ISO strings ending in Z', () => {
    const iso = '2026-02-02T15:30:00.000Z';
    assert({
      given: 'an ISO string ending in Z',
      should: 'return the string unchanged',
      actual: toISOTimestamp(iso),
      expected: iso,
    });
  });

  it('should pass through ISO strings with timezone offset', () => {
    const withOffset = '2026-02-02T15:30:00+05:30';
    assert({
      given: 'an ISO string with timezone offset',
      should: 'return the string unchanged',
      actual: toISOTimestamp(withOffset),
      expected: withOffset,
    });
  });

  it('should pass through ISO strings with negative timezone offset', () => {
    const withOffset = '2026-02-02T15:30:00-08:00';
    assert({
      given: 'an ISO string with negative timezone offset',
      should: 'return the string unchanged',
      actual: toISOTimestamp(withOffset),
      expected: withOffset,
    });
  });

  it('should convert raw PostgreSQL timestamp to ISO UTC', () => {
    assert({
      given: 'a raw PostgreSQL timestamp without timezone',
      should: 'convert to ISO UTC string',
      actual: toISOTimestamp('2026-02-02 15:30:00'),
      expected: '2026-02-02T15:30:00.000Z',
    });
  });

  it('should convert PostgreSQL timestamp with milliseconds', () => {
    assert({
      given: 'a raw PostgreSQL timestamp with milliseconds',
      should: 'convert to ISO UTC string preserving milliseconds',
      actual: toISOTimestamp('2026-02-02 15:30:00.123'),
      expected: '2026-02-02T15:30:00.123Z',
    });
  });
});
