import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { dueDateFor } from '../task-detail/due-date';
import { task } from '../task-model/fixtures';
import { dueLabel, dueToneOf, isBlocked, isPriority, localToday, priorities, priorityFlag } from './task-meta';

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

describe('priorities', () => {
  test('the choices', () => {
    assert({
      given: 'PageSpace’s three priorities',
      should: 'offer them highest first, under their names',
      actual: priorities.map(({ value, label }) => `${value}:${label}`),
      expected: ['high:High', 'medium:Medium', 'low:Low'],
    });
  });

  test('isPriority()', () => {
    assert({
      given: 'each priority and a value that is none',
      should: 'accept only the priorities',
      actual: ['high', 'medium', 'low', 'urgent'].map(isPriority),
      expected: [true, true, true, false],
    });
  });
});

describe('priorityFlag()', () => {
  test('a raised or lowered priority', () => {
    assert({
      given: 'a high, a medium and a low task',
      should: 'flag high and low by name, and say nothing for medium, the default',
      actual: (['high', 'medium', 'low'] as const).map((priority) => priorityFlag(task('t', { priority }))),
      expected: [{ level: 'high', label: 'High priority' }, null, { level: 'low', label: 'Low priority' }],
    });
  });
});

describe('isBlocked()', () => {
  test('PageSpace’s Blocked status', () => {
    assert({
      given: 'a task in the blocked status and tasks in others',
      should: 'flag only the blocked one',
      actual: ['blocked', 'pending', 'in_progress', 'completed'].map((status) => isBlocked(task('t', { status }))),
      expected: [true, false, false, false],
    });
  });
});

describe('localToday()', () => {
  test('the viewer’s own day', () => {
    // 23:30 UTC on 5 October is already 6 October in Berlin, still the 5th in Los Angeles.
    const now = new Date('2026-10-05T23:30:00.000Z');
    assert({
      given: 'the same instant in Berlin, UTC and Los Angeles',
      should: 'read the calendar day where the viewer is',
      actual: zones.map((zone) => inZone(zone, () => localToday(now))),
      expected: ['2026-10-06', '2026-10-05', '2026-10-05'],
    });
  });
});

describe('dueLabel()', () => {
  test('a date set in classic or imago', () => {
    assert({
      given: '7 October picked in each zone, read back in that zone',
      should: 'label it 7 October, never the UTC day of the stored instant',
      actual: zones.map((zone) => inZone(zone, () => dueLabel(dueDateFor('2026-10-07'), '2026-10-01'))),
      expected: ['Oct 7', 'Oct 7', 'Oct 7'],
    });
  });

  test('today and yesterday', () => {
    assert({
      given: 'a due date today and one yesterday, in Berlin',
      should: 'say Today and Yesterday',
      actual: inZone('Europe/Berlin', () => [
        dueLabel(dueDateFor('2026-10-05'), '2026-10-05'),
        dueLabel(dueDateFor('2026-10-04'), '2026-10-05'),
      ]),
      expected: ['Today', 'Yesterday'],
    });
  });

  test('no date, and an unreadable one', () => {
    assert({
      given: 'no due date and a stored value that is not a date',
      should: 'label nothing',
      actual: [dueLabel(null, '2026-10-05'), dueLabel('soon', '2026-10-05')],
      expected: ['', ''],
    });
  });
});

describe('dueToneOf()', () => {
  test('by the viewer’s own day', () => {
    // Berlin's 6 October is stored as 22:00 UTC on the 5th: by its UTC day it would read overdue.
    assert({
      given: 'a task due on 6 October, viewed in Berlin on the 6th',
      should: 'read it as due soon, not overdue',
      actual: inZone('Europe/Berlin', () => dueToneOf(dueDateFor('2026-10-06'), '2026-10-06', false)),
      expected: 'soon',
    });
  });

  test('each tone', () => {
    assert({
      given: 'open tasks due yesterday, in three days and in a week, and a done one due yesterday',
      should: 'read overdue, soon, later, and later once done',
      actual: [
        dueToneOf(dueDateFor('2026-10-04'), '2026-10-05', false),
        dueToneOf(dueDateFor('2026-10-08'), '2026-10-05', false),
        dueToneOf(dueDateFor('2026-10-12'), '2026-10-05', false),
        dueToneOf(dueDateFor('2026-10-04'), '2026-10-05', true),
      ],
      expected: ['overdue', 'soon', 'later', 'later'],
    });
  });

  test('no date', () => {
    assert({
      given: 'no due date and an unreadable one',
      should: 'have no tone',
      actual: [dueToneOf(null, '2026-10-05', false), dueToneOf('soon', '2026-10-05', false)],
      expected: [null, null],
    });
  });
});
