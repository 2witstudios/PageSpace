import { describe, test, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { assert } from '@/stores/__tests__/riteway';
import { MobileCalendarView } from '../MobileCalendarView';
import type { CalendarEvent, CalendarHandlers } from '../calendar-types';

// A day with nothing on it, in a month that does have events elsewhere.
const SELECTED = new Date(2027, 2, 10, 0, 0, 0, 0);

const handlers = (): CalendarHandlers => ({
  onEventClick: vi.fn(),
  onEventCreate: vi.fn(),
  onEventUpdate: vi.fn(),
  onEventDelete: vi.fn(),
  onDateChange: vi.fn(),
  onViewChange: vi.fn(),
});

const eventOn = (day: number): CalendarEvent => ({
  id: `evt-${day}`,
  driveId: 'drive-1',
  createdById: 'user-1',
  pageId: null,
  title: `Event on the ${day}th`,
  description: null,
  location: null,
  startAt: new Date(2027, 2, day, 9, 0).toISOString(),
  endAt: new Date(2027, 2, day, 10, 0).toISOString(),
  allDay: false,
  timezone: 'UTC',
  recurrenceRule: null,
  visibility: 'DRIVE',
  color: 'blue',
  syncedFromGoogle: false,
  googleSyncReadOnly: null,
  createdAt: SELECTED.toISOString(),
  updatedAt: SELECTED.toISOString(),
  createdBy: { id: 'user-1', name: 'Owner', image: null },
  attendees: [],
});

describe('MobileCalendarView initial date', () => {
  test('an empty starting date is still in the list', () => {
    render(
      <MobileCalendarView
        events={[eventOn(3), eventOn(21)]}
        tasks={[]}
        handlers={handlers()}
        showTasks={false}
        onShowTasksChange={vi.fn()}
        currentDate={SELECTED}
      />
    );

    assert({
      given: 'a starting date with no events, in a month that has some',
      should: 'still render that day, so the agenda does not open elsewhere',
      actual: screen.getByText('Wed 10') !== null,
      expected: true,
    });

    assert({
      given: 'a starting date with no events',
      should: 'say so on one line',
      actual: screen.getByText('Nothing scheduled') !== null,
      expected: true,
    });
  });
});

describe('MobileCalendarView event creation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('creating an event late at night stays on the day in view', () => {
    // 23:17: "the next hour" is tomorrow, and setHours(24) has already rolled the
    // date over -- clamping the rolled-over value lands 23:00 on the WRONG day.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2027, 2, 10, 23, 17, 0));

    const h = handlers();
    render(
      <MobileCalendarView
        events={[]}
        tasks={[]}
        handlers={h}
        showTasks={false}
        onShowTasksChange={vi.fn()}
        currentDate={new Date(2027, 2, 10)}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'New event' }));

    const start = (h.onEventCreate as unknown as { mock: { calls: Date[][] } }).mock.calls[0][0];

    assert({
      given: 'the create button tapped at 23:17 on the day in view',
      should: 'keep the event on that day, not roll it into tomorrow',
      actual: start.getDate(),
      expected: 10,
    });

    assert({
      given: 'the create button tapped at 23:17 on the day in view',
      should: 'start it at 23:00 rather than 23:00 tomorrow',
      actual: start.getHours(),
      expected: 23,
    });
  });

  test('creating an event earlier in the day still uses the next hour', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2027, 2, 10, 9, 30, 0));

    const h = handlers();
    render(
      <MobileCalendarView
        events={[]}
        tasks={[]}
        handlers={h}
        showTasks={false}
        onShowTasksChange={vi.fn()}
        currentDate={new Date(2027, 2, 10)}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'New event' }));

    const start = (h.onEventCreate as unknown as { mock: { calls: Date[][] } }).mock.calls[0][0];

    assert({
      given: 'the create button tapped at 09:30',
      should: 'start the event on the next hour',
      actual: `${start.getDate()}@${start.getHours()}`,
      expected: '10@10',
    });
  });
});
