import { describe, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { assert } from '@/stores/__tests__/riteway';
import { MobileAgenda } from '../MobileAgenda';
import type {
  CalendarEvent,
  CalendarEventAttendee,
  CalendarHandlers,
  TaskWithDueDate,
} from '../calendar-types';

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

const task = (overrides: Partial<TaskWithDueDate> = {}): TaskWithDueDate => ({
  id: 'task-1',
  title: 'Ship the agenda',
  dueDate: new Date(2027, 2, 10, 18, 0).toISOString(),
  status: 'pending',
  priority: 'high',
  taskListPageId: 'page-1',
  driveId: 'drive-1',
  ...overrides,
});

const renderAgenda = (
  events: CalendarEvent[],
  pinnedDate: Date | null = null,
  { tasks = [], showTasks = false }: { tasks?: TaskWithDueDate[]; showTasks?: boolean } = {}
) =>
  render(
    <MobileAgenda
      days={[DAY, OTHER_DAY]}
      selectedDate={DAY}
      pinnedDate={pinnedDate}
      events={events}
      tasks={tasks}
      handlers={handlers()}
      showTasks={showTasks}
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
      actual: screen.getAllByText('10:00 AM').length,
      expected: 1,
    });

    assert({
      given: 'a timed event',
      should: 'render its end time in the gutter',
      actual: screen.getAllByText('11:00 AM').length,
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
      actual: screen.queryByText('10:00 PM') === null,
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
      actual: screen.queryByText('10:00 AM') === null,
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

describe('MobileAgenda secondary line', () => {
  test('location and guest count share one line', () => {
    renderAgenda([
      event({ location: 'Studio B', attendees: [attendee('a'), attendee('b')] }),
    ]);

    assert({
      given: 'an event with both a location and attendees',
      should: 'join them into a single secondary line',
      actual: screen.getByText('Studio B · 2 guests') !== null,
      expected: true,
    });
  });

  test('a bare event says nothing beyond its title and times', () => {
    renderAgenda([event({ title: 'Design review' })]);

    assert({
      given: 'an event with no location and no attendees',
      should: 'render no secondary line for it',
      actual: [
        screen.queryByText(/guests/),
        screen.queryByText(/·/),
      ].every((node) => node === null),
      expected: true,
    });
  });
});

describe('MobileAgenda tasks', () => {
  test('tasks appear only when they are switched on', () => {
    renderAgenda([event()], null, { tasks: [task()] });

    assert({
      given: 'tasks that are switched off',
      should: 'not render them',
      actual: screen.queryByText('Ship the agenda') === null,
      expected: true,
    });
  });

  test('a task shares the row geometry and shows its status and priority', () => {
    renderAgenda([event()], null, { tasks: [task()], showTasks: true });

    assert({
      given: 'a task due on the day',
      should: 'render its title',
      actual: screen.getByText('Ship the agenda') !== null,
      expected: true,
    });

    assert({
      given: 'a task due at 6pm',
      should: 'put the due time in the same gutter the events use',
      actual: screen.getByText('6:00 PM') !== null,
      expected: true,
    });

    assert({
      given: 'a high priority task',
      should: 'name the priority',
      actual: screen.getByText('high') !== null,
      expected: true,
    });
  });

  test('a completed task is struck through', () => {
    renderAgenda([event()], null, {
      tasks: [task({ status: 'completed' })],
      showTasks: true,
    });

    assert({
      given: 'a completed task',
      should: 'strike the title through',
      actual: screen.getByText('Ship the agenda').className.includes('line-through'),
      expected: true,
    });
  });
});

describe('MobileAgenda empty window', () => {
  test('a window with nothing in it offers to create something', () => {
    renderAgenda([]);

    assert({
      given: 'a window with no events or tasks at all',
      should: 'offer to create an event rather than showing an empty list',
      actual: screen.getByRole('button', { name: /Create Event/ }) !== null,
      expected: true,
    });
  });
});
