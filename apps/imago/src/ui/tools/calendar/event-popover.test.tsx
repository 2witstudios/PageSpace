// @vitest-environment jsdom
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, unmountAll } from '../../test-support/dom';
import type { CalendarEvent } from '@/retained/components/calendar/calendar-types';
import { attendeeRoleLabel, eventTimeLabel, minutesBefore } from './event-popover';

vi.mock('swr', () => ({ default: () => ({ data: undefined, error: undefined }) }));

afterEach(unmountAll);

const event = {
  id: 'evt_1',
  title: 'Pricing review',
  startAt: '2026-10-13T14:00:00.000Z',
  endAt: '2026-10-13T15:00:00.000Z',
  allDay: false,
  location: null,
  visibility: 'DRIVE',
  page: null,
} as unknown as CalendarEvent;

describe('EventPopover helpers (IMC-6.2)', () => {
  test('the time range', () => {
    assert({
      given: 'a timed event',
      should: 'read as a weekday, date and a time range',
      actual: eventTimeLabel({ ...event, startAt: '2026-10-13T14:00:00', endAt: '2026-10-13T15:00:00' }),
      expected: 'Tue, Oct 13 · 2:00 – 3:00 PM',
    });
  });

  test('all-day events have no time range', () => {
    assert({
      given: 'an all-day event',
      should: 'say All day',
      actual: eventTimeLabel({ ...event, allDay: true }),
      expected: 'All day',
    });
  });

  test('the trigger’s lead time', () => {
    assert({
      given: 'a trigger 15 minutes before the start',
      should: 'count 15 minutes before',
      actual: minutesBefore('2026-10-13T14:00:00.000Z', '2026-10-13T13:45:00.000Z'),
      expected: 15,
    });
  });

  test('attendee roles', () => {
    assert({
      given: 'an organizer and two invitees',
      should: 'label the organizer first, then each reply status',
      actual: [
        attendeeRoleLabel({ isOrganizer: true, status: 'ACCEPTED' }),
        attendeeRoleLabel({ isOrganizer: false, status: 'TENTATIVE' }),
        attendeeRoleLabel({ isOrganizer: false, status: 'PENDING' }),
      ],
      expected: ['Organizer', 'Tentative', 'Pending'],
    });
  });
});

describe('EventPopover (IMC-6.2)', () => {
  test('a dialog named by the event title with a Close event control', async () => {
    const { EventPopover } = await import('./event-popover');
    const onClose = vi.fn();
    const root = mount(
      <EventPopover event={event} onClose={onClose} onEdit={vi.fn()} onGoing={vi.fn(async () => undefined)} />,
    );
    const dialog = root.querySelector('[role="dialog"]');
    const close = root.querySelector<HTMLButtonElement>('button[aria-label="Close event"]');
    if (close) click(close);
    assert({
      given: 'an open event popover',
      should: 'be a dialog named by the title and close through Close event',
      actual: [dialog?.getAttribute('aria-label'), onClose.mock.calls.length],
      expected: ['Pricing review', 1],
    });
  });
});
