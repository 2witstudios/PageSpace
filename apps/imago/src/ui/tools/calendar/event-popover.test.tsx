// @vitest-environment jsdom
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { click, mount, unmountAll } from '../../test-support/dom';
import type { CalendarEvent } from '@/retained/components/calendar/calendar-types';
import { attendeeRoleLabel, eventTimeLabel, minutesBefore } from './event-popover';

const swrData = vi.hoisted(() => new Map<string, unknown>());
vi.mock('swr', () => ({ default: (key: string) => ({ data: swrData.get(key), error: undefined }) }));

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

describe('EventPopover — AI agent account attendees (Agent Signup 2c)', () => {
  test('marks only the agent account', async () => {
    const { EventPopover } = await import('./event-popover');
    const attendee = (id: string, name: string, accountType: string) => ({
      id, eventId: 'evt_1', userId: id, status: 'ACCEPTED', responseNote: null, isOrganizer: false, isOptional: false,
      invitedAt: '2026-10-01T00:00:00.000Z', respondedAt: null, user: { id, name, image: null, accountType },
    });
    swrData.set('/api/calendar/events/evt_1/attendees', {
      attendees: [attendee('u-ada', 'Ada', 'human'), attendee('u-bot', 'Helper', 'agent')],
    });
    const root = mount(
      <EventPopover event={event} onClose={vi.fn()} onEdit={vi.fn()} onGoing={vi.fn(async () => undefined)} />,
    );
    swrData.clear();
    const rowOf = (name: string) => [...root.querySelectorAll('li')].find((li) => li.textContent?.includes(name));
    assert({
      given: 'an event with a human and an AI agent account attending',
      should: 'show the agent marker beside the agent account only',
      actual: [
        rowOf('Helper')?.querySelector('[aria-label="AI agent account"]')?.textContent,
        rowOf('Ada') === undefined,
        rowOf('Ada')?.querySelector('[aria-label="AI agent account"]') ?? null,
      ],
      expected: ['Agent', false, null],
    });
  });
});
