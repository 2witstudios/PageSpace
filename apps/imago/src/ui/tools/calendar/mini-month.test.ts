import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { format } from 'date-fns';
import { miniMonthWeeks } from './mini-month';

describe('miniMonthWeeks (C-Drive-Calendar mini month)', () => {
  test('October 2026 starts on the Monday before Oct 1 and ends on the week of Oct 31', () => {
    const weeks = miniMonthWeeks(new Date(2026, 9, 12));
    const first = weeks[0]?.[0];
    const last = weeks[weeks.length - 1]?.[6];
    assert({
      given: 'a date in October 2026',
      should: 'draw whole Monday-first weeks from Sep 28 through Nov 1',
      actual: [weeks.length, first && format(first, 'yyyy-MM-dd'), last && format(last, 'yyyy-MM-dd')],
      expected: [5, '2026-09-28', '2026-11-01'],
    });
  });
});
