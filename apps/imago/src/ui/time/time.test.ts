import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { dayLabel, dayOf, formatTime, todayOf } from './time';

describe('formatTime()', () => {
  test('a time of day in UTC', () => {
    assert({
      given: 'times across midnight, the morning, noon and the evening, in UTC',
      should: 'read as a 12-hour UTC clock whatever the runtime’s zone',
      actual: [
        '2026-10-05T00:05:00.000Z',
        '2026-10-05T09:12:00.000Z',
        '2026-10-05T12:00:00.000Z',
        '2026-10-05T23:59:00.000Z',
      ].map(formatTime),
      expected: ['12:05 AM', '9:12 AM', '12:00 PM', '11:59 PM'],
    });
  });
});

describe('dayOf()', () => {
  test('the UTC day', () => {
    assert({
      given: 'an ISO time late in the UTC day',
      should: 'be that UTC calendar day',
      actual: dayOf('2026-10-05T23:59:59.000Z'),
      expected: '2026-10-05',
    });
  });
});

describe('todayOf()', () => {
  test('an injected clock', () => {
    assert({
      given: 'a clock reading late on 5 October UTC',
      should: 'be that UTC day',
      actual: todayOf(new Date('2026-10-05T23:30:00.000Z')),
      expected: '2026-10-05',
    });
  });
});

describe('dayLabel()', () => {
  test('relative to today', () => {
    const today = '2026-10-05';
    assert({
      given: 'posts today, yesterday, earlier this year and across a year',
      should: 'say Today, Yesterday, else the month and day',
      actual: [
        '2026-10-05T08:00:00.000Z',
        '2026-10-04T23:00:00.000Z',
        '2026-09-18T10:00:00.000Z',
        '2025-12-31T10:00:00.000Z',
      ].map((at) => dayLabel(at, today)),
      expected: ['Today', 'Yesterday', 'Sep 18', 'Dec 31'],
    });
  });
});
