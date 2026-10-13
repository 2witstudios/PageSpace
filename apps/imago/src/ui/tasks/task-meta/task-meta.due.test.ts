import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { dueWindowOf } from './task-meta';

// 2026-10-12 is a Monday: this week runs through Sunday the 18th.
const TODAY = '2026-10-12';

describe('dueWindowOf()', () => {
  test('where a due date falls, by the viewer’s own day', () => {
    assert({
      given: 'yesterday, today, Sunday the 18th, the 19th, no date, and a done task overdue by a week',
      should: 'name overdue, this week, this week, later, no window, and never overdue for a done task',
      actual: [
        dueWindowOf('2026-10-11T12:00:00', TODAY, false),
        dueWindowOf('2026-10-12T12:00:00', TODAY, false),
        dueWindowOf('2026-10-18T12:00:00', TODAY, false),
        dueWindowOf('2026-10-19T12:00:00', TODAY, false),
        dueWindowOf(null, TODAY, false),
        dueWindowOf('2026-10-05T12:00:00', TODAY, true),
      ],
      expected: ['overdue', 'this_week', 'this_week', 'later', null, 'later'],
    });
  });
});
