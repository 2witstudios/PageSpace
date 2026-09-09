import { describe, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
