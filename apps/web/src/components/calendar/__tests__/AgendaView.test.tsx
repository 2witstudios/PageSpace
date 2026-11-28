/**
 * Agent Signup Phase 2c — the agenda's attendee tooltip names an AI agent
 * account with its plain-text marker; a human's tooltip is unchanged.
 */
import { describe, test, vi } from 'vitest';
import { render } from '@testing-library/react';
import { assert } from '@/test/riteway';
import { AgendaView } from '../AgendaView';
import type { CalendarEvent, CalendarEventAttendee, CalendarHandlers } from '../calendar-types';

const DAY = new Date(2027, 2, 10, 0, 0, 0, 0);

const attendee = (id: string, name: string | null, accountType: string): CalendarEventAttendee => ({
  id, eventId: 'evt-1', userId: `user-${id}`, status: 'ACCEPTED', responseNote: null,
  isOrganizer: false, isOptional: false, invitedAt: DAY.toISOString(), respondedAt: null,
  user: { id: `user-${id}`, name, image: null, accountType },
});

const event = (attendees: CalendarEventAttendee[]): CalendarEvent => ({
  id: 'evt-1', driveId: 'drive-1', createdById: 'user-1', pageId: null, title: 'Design review',
  description: null, location: null,
  startAt: new Date(2027, 2, 10, 10, 0).toISOString(), endAt: new Date(2027, 2, 10, 11, 0).toISOString(),
  allDay: false, timezone: 'UTC', recurrenceRule: null, visibility: 'DRIVE', color: 'blue',
  syncedFromGoogle: false, googleSyncReadOnly: null, createdAt: DAY.toISOString(), updatedAt: DAY.toISOString(),
  createdBy: { id: 'user-1', name: 'Owner', image: null }, attendees,
});

const handlers = (): CalendarHandlers => ({
  onEventClick: vi.fn(), onEventCreate: vi.fn(), onEventUpdate: vi.fn(), onEventDelete: vi.fn(),
  onDateChange: vi.fn(), onViewChange: vi.fn(),
});

describe('AgendaView — attendee tooltip agent marker', () => {
  test('marks an agent account and leaves a human (and a missing name) unchanged', () => {
    const { container } = render(
      <AgendaView
        currentDate={DAY}
        events={[event([attendee('h', 'Ada', 'human'), attendee('a', 'Helper', 'agent'), attendee('n', null, 'human')])]}
        tasks={[]}
        handlers={handlers()}
        showGoogleCalendarHint={false}
      />,
    );
    const titles = Array.from(container.querySelectorAll('[title$=" - Accepted"]')).map((el) => el.getAttribute('title'));
    assert({
      given: 'a human, an agent-account and a nameless attendee',
      should: 'mark only the agent account in its tooltip',
      actual: titles,
      expected: ['Ada - Accepted', 'Helper (AI agent) - Accepted', 'null - Accepted'],
    });
  });
});
