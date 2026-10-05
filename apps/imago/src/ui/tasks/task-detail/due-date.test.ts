import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { dueDateFor, dueDay } from './due-date';

describe('dueDay()', () => {
  test('a date and none', () => {
    assert({
      given: 'a stored due date, and none',
      should: 'show its calendar day, or nothing',
      actual: [dueDay('2026-10-09T12:00:00.000Z'), dueDay('2026-10-09'), dueDay(null)],
      expected: ['2026-10-09', '2026-10-09', ''],
    });
  });
});

describe('dueDateFor()', () => {
  test('a day', () => {
    assert({
      given: 'a day picked in the date field',
      should: 'send noon UTC that day, so every timezone reads the same day',
      actual: dueDateFor('2026-11-02'),
      expected: '2026-11-02T12:00:00.000Z',
    });
  });

  test('a cleared field, and junk', () => {
    assert({
      given: 'an emptied field, a partial value and an impossible day',
      should: 'clear the due date rather than send a bad one',
      actual: [dueDateFor(''), dueDateFor('2026-11'), dueDateFor('2026-13-45')],
      expected: [null, null, null],
    });
  });
});
