import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  addDays,
  addMonths,
  allowed,
  dayForKey,
  dayName,
  inMonth,
  isDay,
  monthGrid,
  monthOf,
  monthTitle,
  quickPicks,
  shortDayLabel,
} from './calendar';

// 2026-10-19 is a Monday.
const TODAY = '2026-10-19';

describe('calendar arithmetic', () => {
  test('days and months', () => {
    assert({
      given: 'days either side of a month and a year end, and a day that does not exist',
      should: 'step across them and refuse the unreal day',
      actual: {
        forward: addDays('2026-10-31', 1),
        back: addDays('2026-01-01', -1),
        leap: addDays('2028-02-28', 1),
        real: [isDay('2026-02-28'), isDay('2026-02-30'), isDay('soon')],
        month: monthOf('2026-10-19'),
        next: addMonths({ year: 2026, month: 11 }, 1),
        previous: addMonths({ year: 2026, month: 0 }, -1),
        title: monthTitle({ year: 2026, month: 9 }),
        within: [inMonth('2026-10-01', { year: 2026, month: 9 }), inMonth('2026-11-01', { year: 2026, month: 9 })],
      },
      expected: {
        forward: '2026-11-01',
        back: '2025-12-31',
        leap: '2028-02-29',
        real: [true, false, false],
        month: { year: 2026, month: 9 },
        next: { year: 2027, month: 0 },
        previous: { year: 2025, month: 11 },
        title: 'October 2026',
        within: [true, false],
      },
    });
  });

  test('monthGrid()', () => {
    const grid = monthGrid({ year: 2026, month: 9 });
    assert({
      given: 'October 2026, whose 1st is a Thursday',
      should: 'give six Monday-first weeks from Sep 28 to Nov 8',
      actual: { weeks: grid.length, days: grid.map((week) => week.length), first: grid[0]?.[0], thursday: grid[0]?.[3], last: grid[5]?.[6] },
      expected: { weeks: 6, days: [7, 7, 7, 7, 7, 7], first: '2026-09-28', thursday: '2026-10-01', last: '2026-11-08' },
    });
  });

  test('names and labels', () => {
    assert({
      given: 'a day this month, another month, another year, and one that is not a day',
      should: 'name it in full for its button, and as short as the chip can say it unambiguously',
      actual: [
        dayName('2026-10-23'),
        shortDayLabel('2026-10-23', TODAY),
        shortDayLabel('2026-11-02', TODAY),
        shortDayLabel('2027-01-04', TODAY),
        shortDayLabel('nope', TODAY),
        dayName('nope'),
      ],
      expected: ['Friday, October 23, 2026', 'Fri 23', 'Mon 2 Nov', 'Mon 4 Jan 2027', '', ''],
    });
  });

  test('quickPicks() and allowed()', () => {
    assert({
      given: 'today, and a window from the 20th to the 26th',
      should: 'offer today, tomorrow, a week and two weeks out, and allow only days inside the window',
      actual: {
        picks: quickPicks(TODAY).map((pick) => [pick.label, pick.day]),
        allowed: ['2026-10-19', '2026-10-20', '2026-10-26', '2026-10-27'].map((day) => allowed(day, '2026-10-20', '2026-10-26')),
        open: [allowed('2026-10-19', undefined, undefined), allowed('2026-10-19', '', '')],
      },
      expected: {
        picks: [
          ['Today', '2026-10-19'],
          ['Tomorrow', '2026-10-20'],
          ['Next week', '2026-10-26'],
          ['In 2 weeks', '2026-11-02'],
        ],
        allowed: [false, true, true, false],
        open: [true, true],
      },
    });
  });

  test('dayForKey()', () => {
    assert({
      given: 'each key the grid moves by, from Wednesday March 31, and a key it does not',
      should: 'move a day, a week, to the week’s ends, or a month clamped to its last day; nothing else',
      actual: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'a'].map((key) =>
        dayForKey('2027-03-31', key),
      ),
      expected: ['2027-03-30', '2027-04-01', '2027-03-24', '2027-04-07', '2027-03-29', '2027-04-04', '2027-02-28', '2027-04-30', null],
    });
  });
});
