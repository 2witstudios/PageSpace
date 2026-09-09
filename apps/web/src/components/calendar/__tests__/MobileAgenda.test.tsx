import { describe, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { assert } from '@/stores/__tests__/riteway';
import { MobileAgenda } from '../MobileAgenda';
import type { CalendarEvent, CalendarEventAttendee, CalendarHandlers } from '../calendar-types';

// A fixed, deliberately non-today date: on today the current-time marker
// renders into the same gutter and can collide with an asserted time.
const DAY = new Date(2027, 2, 10, 0, 0, 0, 0);
const OTHER_DAY = new Date(2027, 2, 11, 0, 0, 0, 0);

const attendee = (id: string): CalendarEventAttendee => ({
  id,
  eventId: 'evt-1',
  userId: `user-${id}`,
  status: 'ACCEPTED',
  responseNote: null,
  isOrganizer: false,
  isOptional: false,
  invitedAt: DAY.toISOString(),
  respondedAt: null,
  user: { id: `user-${id}`, name: `Person ${id}`, image: null },
});

const event = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'evt-1',
  driveId: 'drive-1',
  createdById: 'user-1',
  pageId: null,
  title: 'Design review',
  description: null,
  location: null,
  startAt: new Date(2027, 2, 10, 10, 0).toISOString(),
  endAt: new Date(2027, 2, 10, 11, 0).toISOString(),
  allDay: false,
  timezone: 'UTC',
  recurrenceRule: null,
  visibility: 'DRIVE',
  color: 'blue',
  syncedFromGoogle: false,
  googleSyncReadOnly: null,
  createdAt: DAY.toISOString(),
  updatedAt: DAY.toISOString(),
  createdBy: { id: 'user-1', name: 'Owner', image: null },
  attendees: [],
  ...overrides,
});

const handlers = (): CalendarHandlers => ({
  onEventClick: vi.fn(),
  onEventCreate: vi.fn(),
  onEventUpdate: vi.fn(),
  onEventDelete: vi.fn(),
  onDateChange: vi.fn(),
  onViewChange: vi.fn(),
});

const renderAgenda = (events: CalendarEvent[], pinnedDate: Date | null = null) =>
  render(
    <MobileAgenda
      days={[DAY, OTHER_DAY]}
      selectedDate={DAY}
      pinnedDate={pinnedDate}
      events={events}
      tasks={[]}
      handlers={handlers()}
      showTasks={false}
      onCreateEvent={vi.fn()}
      onVisibleDateChange={vi.fn()}
    />
  );

describe('MobileAgenda row density', () => {
  test('the description does not reach the row', () => {
    renderAgenda([event({ description: 'Walk the agenda density proposal.' })]);

    assert({
      given: 'an event with a description',
      should: 'keep the description in the modal, not the row',
      actual: screen.queryByText(/Walk the agenda density proposal/) === null,
      expected: true,
    });
  });

  test('attendees collapse to a count, with no avatars', () => {
    const { container } = renderAgenda([
      event({ attendees: [attendee('a'), attendee('b'), attendee('c')] }),
    ]);

    assert({
      given: 'an event with three attendees',
      should: 'render a guest count',
      actual: screen.getByText(/3 guests/) !== null,
      expected: true,
    });

    assert({
      given: 'an event with three attendees',
      should: 'render no avatar images in the row',
      actual: container.querySelectorAll('img').length,
      expected: 0,
    });
  });

  test('a timed event states its start and end exactly once each', () => {
    renderAgenda([event()]);

    assert({
      given: 'a timed event',
      should: 'render its start time once, not twice as before',
      actual: screen.getAllByText('10:00').length,
      expected: 1,
    });

    assert({
      given: 'a timed event',
      should: 'render its end time in the gutter',
      actual: screen.getAllByText('11:00').length,
      expected: 1,
    });
  });

  test('a timed event spanning days is a banner, not a repeated timed row', () => {
    // Runs 10 Mar 22:00 -> 11 Mar 08:00, so it lands in both days of the window.
    renderAgenda([
      event({
        title: 'Overnight migration',
        startAt: new Date(2027, 2, 10, 22, 0).toISOString(),
        endAt: new Date(2027, 2, 11, 8, 0).toISOString(),
      }),
    ]);

    assert({
      given: 'a timed event crossing a day boundary',
      should: 'appear on both days it covers',
      actual: screen.getAllByText('Overnight migration').length,
      expected: 2,
    });

    assert({
      given: 'a timed event crossing a day boundary',
      should: 'not print its absolute start time into either day gutter',
      actual: screen.queryByText('22:00') === null,
      expected: true,
    });
  });

  test('an all-day event is a chip, not a timed row', () => {
    renderAgenda([event({ allDay: true, title: 'Q3 close' })]);

    assert({
      given: 'an all-day event',
      should: 'render its title',
      actual: screen.getByText('Q3 close') !== null,
      expected: true,
    });

    assert({
      given: 'an all-day event',
      should: 'not print a start time for it',
      actual: screen.queryByText('10:00') === null,
      expected: true,
    });
  });
});

describe('MobileAgenda day sections', () => {
  test('an empty day is skipped unless it was picked', () => {
    renderAgenda([event({ startAt: new Date(2027, 2, 11, 9, 0).toISOString(), endAt: new Date(2027, 2, 11, 10, 0).toISOString() })]);

    assert({
      given: 'a day in the window with nothing on it and no pick',
      should: 'not render a header for it',
      actual: screen.queryByText('Wed 10') === null,
      expected: true,
    });
  });

  test('a picked empty day stays in the list so the pick lands', () => {
    renderAgenda(
      [event({ startAt: new Date(2027, 2, 11, 9, 0).toISOString(), endAt: new Date(2027, 2, 11, 10, 0).toISOString() })],
      DAY
    );

    assert({
      given: 'an empty day the user picked',
      should: 'render its header',
      actual: screen.getByText('Wed 10') !== null,
      expected: true,
    });

    assert({
      given: 'an empty day the user picked',
      should: 'say it is empty on one line rather than filling the screen',
      actual: screen.getByText('Nothing scheduled') !== null,
      expected: true,
    });
  });
});

describe('MobileAgenda scroll container', () => {
  test('the list owns a bounded scroller', () => {
    const { container } = renderAgenda([event()]);
    const scroller = container.querySelector('.overflow-y-auto');

    assert({
      given: 'the agenda with events',
      should: 'give the scroller min-h-0 so it can shrink below its content',
      actual: scroller?.className.includes('min-h-0'),
      expected: true,
    });

    assert({
      given: 'the agenda with events',
      should: 'give the scroller flex-1 so it fills the column',
      actual: scroller?.className.includes('flex-1'),
      expected: true,
    });
  });
});
