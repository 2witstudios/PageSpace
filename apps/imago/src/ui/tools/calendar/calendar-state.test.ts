import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  calendarRangeLabel,
  defaultNewEventRange,
  formatCalendarDate,
  parseCalendarState,
  stepCalendarDate,
  withCalendarPatch,
} from './calendar-state';

const now = new Date(2026, 9, 12, 10, 20);

describe('parseCalendarState (IMC-6.1)', () => {
  test('an empty address', () => {
    const state = parseCalendarState(new URLSearchParams(''), now);
    assert({
      given: 'no calendar parameters',
      should: 'open the week of today with no event and no composer',
      actual: [state.view, formatCalendarDate(state.date), state.eventId, state.compose],
      expected: ['week', '2026-10-12', null, false],
    });
  });

  test('a shared address', () => {
    const state = parseCalendarState(new URLSearchParams('view=month&date=2026-10-13&eventId=evt_1&compose=1'), now);
    assert({
      given: 'view, date, event and composer in the URL',
      should: 'read each back so a reload keeps the same view',
      actual: [state.view, formatCalendarDate(state.date), state.eventId, state.compose],
      expected: ['month', '2026-10-13', 'evt_1', true],
    });
  });

  test('bad values fall back to the defaults', () => {
    const state = parseCalendarState(new URLSearchParams('view=yearly&date=not-a-date&eventId='), now);
    assert({
      given: 'an unknown view, an unreadable date and an empty event id',
      should: 'fall back to week, today and no event',
      actual: [state.view, formatCalendarDate(state.date), state.eventId],
      expected: ['week', '2026-10-12', null],
    });
  });
});

describe('withCalendarPatch', () => {
  test('sets and removes keys while keeping the rest', () => {
    assert({
      given: 'an address with a date and an open event',
      should: 'set the view, keep the date and drop the event when it is null',
      actual: withCalendarPatch('?date=2026-10-13&eventId=evt_1', { view: 'day', eventId: null }),
      expected: '?date=2026-10-13&view=day',
    });
  });

  test('an empty address stays bare', () => {
    assert({
      given: 'a patch that removes the only key',
      should: 'leave no question mark behind',
      actual: withCalendarPatch('?compose=1', { compose: null }),
      expected: '',
    });
  });
});

describe('calendarRangeLabel', () => {
  test('a Monday-first week, as the board draws it', () => {
    assert({
      given: 'a date in the week of Mon Oct 12, 2026',
      should: 'name the range Oct 12 – 18, 2026',
      actual: calendarRangeLabel('week', new Date(2026, 9, 14)),
      expected: 'Oct 12 – 18, 2026',
    });
  });

  test('a week that crosses a month', () => {
    assert({
      given: 'a week from Mon Sep 28 to Sun Oct 4, 2026',
      should: 'name both months',
      actual: calendarRangeLabel('week', new Date(2026, 8, 30)),
      expected: 'Sep 28 – Oct 4, 2026',
    });
  });

  test('a month and a day', () => {
    assert({
      given: 'month and day views',
      should: 'name the month, or the full day',
      actual: [calendarRangeLabel('month', now), calendarRangeLabel('day', now)],
      expected: ['October 2026', 'Monday, October 12, 2026'],
    });
  });
});

describe('stepCalendarDate', () => {
  test('moves by the view’s unit', () => {
    assert({
      given: 'a week view and a month view',
      should: 'step a week and a month in each direction',
      actual: [
        formatCalendarDate(stepCalendarDate('week', now, 1)),
        formatCalendarDate(stepCalendarDate('week', now, -1)),
        formatCalendarDate(stepCalendarDate('month', now, 1)),
      ],
      expected: ['2026-10-19', '2026-10-05', '2026-11-12'],
    });
  });
});

describe('defaultNewEventRange', () => {
  test('today starts at the next full hour', () => {
    const range = defaultNewEventRange(now, now);
    assert({
      given: 'the viewed day is today at 10:20',
      should: 'start at 11:00 and last an hour',
      actual: [range.startAt.getHours(), range.startAt.getMinutes(), range.endAt.getHours()],
      expected: [11, 0, 12],
    });
  });

  test('another day starts at 9 AM', () => {
    const range = defaultNewEventRange(new Date(2026, 9, 13), now);
    assert({
      given: 'a day other than today',
      should: 'start at 9 AM',
      actual: [range.startAt.getHours(), range.endAt.getHours()],
      expected: [9, 10],
    });
  });
});
