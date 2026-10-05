import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { dueDateFor, dueDay } from './due-date';

// Node rereads TZ when it is assigned, so each case runs in a real zone.
const zones = ['Europe/Berlin', 'UTC', 'America/Los_Angeles'] as const;
const original = process.env.TZ;

const inZone = <T>(zone: string, run: () => T): T => {
  process.env.TZ = zone;
  return run();
};

afterEach(() => {
  process.env.TZ = original;
});

/** What classic's DueDatePicker stores for a picked day: that day's local midnight, as an instant. */
const classicStores = (year: number, month: number, day: number): string => new Date(year, month - 1, day).toISOString();

describe('dueDay()', () => {
  test('a date classic set', () => {
    assert({
      given: '5 October picked in classic, in Berlin, UTC and Los Angeles',
      should: 'show 5 October in the same zone, as classic does',
      actual: zones.map((zone) => inZone(zone, () => [classicStores(2026, 10, 5), dueDay(classicStores(2026, 10, 5))])),
      expected: [
        ['2026-10-04T22:00:00.000Z', '2026-10-05'],
        ['2026-10-05T00:00:00.000Z', '2026-10-05'],
        ['2026-10-05T07:00:00.000Z', '2026-10-05'],
      ],
    });
  });

  test('no date', () => {
    assert({
      given: 'no due date',
      should: 'show nothing',
      actual: dueDay(null),
      expected: '',
    });
  });

  test('an unreadable date', () => {
    assert({
      given: 'a stored value that is not a date',
      should: 'show nothing rather than a bad day',
      actual: dueDay('soon'),
      expected: '',
    });
  });
});

describe('dueDateFor()', () => {
  test('a day picked in imago', () => {
    assert({
      given: '2 November picked in imago, in Berlin, UTC and Los Angeles',
      should: 'send that day’s local midnight, exactly what classic sends',
      actual: zones.map((zone) => inZone(zone, () => dueDateFor('2026-11-02'))),
      expected: zones.map((zone) => inZone(zone, () => classicStores(2026, 11, 2))),
    });
  });

  test('the round trip', () => {
    assert({
      given: 'a day picked in imago and read back, in each zone',
      should: 'show the same day',
      actual: zones.map((zone) => inZone(zone, () => dueDay(dueDateFor('2026-03-29')))),
      expected: ['2026-03-29', '2026-03-29', '2026-03-29'],
    });
  });

  test('a cleared field, and junk', () => {
    assert({
      given: 'an emptied field, a partial value and an impossible day',
      should: 'clear the due date rather than send a bad one',
      actual: [dueDateFor(''), dueDateFor('2026-11'), dueDateFor('2026-13-45'), dueDateFor('2026-02-30')],
      expected: [null, null, null, null],
    });
  });
});
