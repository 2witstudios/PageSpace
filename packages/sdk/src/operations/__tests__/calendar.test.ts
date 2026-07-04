import { describe, expect, it } from 'vitest';
import { buildRequest } from '../../transport/build-request.js';
import { parseResponse } from '../../transport/parse-response.js';
import { HttpError, ResponseValidationError } from '../../errors.js';
import {
  computeFreeSlots,
  createCalendarEvent,
  deleteCalendarEvent,
  deleteCalendarTrigger,
  getCalendarEvent,
  inviteCalendarAttendees,
  listCalendarEvents,
  removeCalendarAttendee,
  rsvpCalendarEvent,
  setCalendarTrigger,
  updateCalendarEvent,
} from '../calendar.js';

const config = { baseUrl: 'https://pagespace.ai' };

/** Nested-user shape (id/name/image, no email) used inside event.attendees (route: `attendees.with.user.columns`). */
const nestedUser = { id: 'u1abc', name: 'Ada', image: null };

/** Shape verified against apps/web/src/app/api/calendar/events/[eventId]/route.ts GET (§2.10 get_calendar_event). */
const eventFixture = {
  id: 'ev1abc',
  driveId: 'd1abc',
  createdById: 'u1abc',
  pageId: null,
  title: 'Standup',
  description: null,
  location: null,
  startAt: '2026-02-19T19:00:00.000Z',
  endAt: '2026-02-19T19:30:00.000Z',
  allDay: false,
  timezone: 'America/Chicago',
  recurrenceRule: null,
  recurrenceExceptions: [],
  recurringEventId: null,
  originalStartAt: null,
  visibility: 'DRIVE',
  color: 'default',
  metadata: null,
  isTrashed: false,
  trashedAt: null,
  googleEventId: null,
  googleCalendarId: null,
  syncedFromGoogle: false,
  googleSyncReadOnly: null,
  lastGoogleSync: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  createdBy: nestedUser,
  attendees: [
    {
      id: 'att1',
      eventId: 'ev1abc',
      userId: 'u1abc',
      status: 'ACCEPTED',
      responseNote: null,
      isOrganizer: true,
      isOptional: false,
      invitedAt: '2026-01-01T00:00:00.000Z',
      respondedAt: '2026-01-01T00:00:00.000Z',
      user: nestedUser,
    },
  ],
  page: null,
  drive: { id: 'd1abc', name: 'Engineering', slug: 'engineering' },
};

describe('calendar.list — request shape', () => {
  it('sends startDate/endDate as query params with no path params', () => {
    const request = buildRequest(
      listCalendarEvents,
      { startDate: '2026-02-01T00:00:00Z', endDate: '2026-02-28T00:00:00Z' },
      config,
    );
    expect(request.method).toBe('GET');
    expect(request.url).toBe(
      'https://pagespace.ai/api/calendar/events?endDate=2026-02-28T00%3A00%3A00Z&startDate=2026-02-01T00%3A00%3A00Z',
    );
  });

  it('sends context/driveId/includePersonal as additional query params', () => {
    const request = buildRequest(
      listCalendarEvents,
      {
        startDate: '2026-02-01',
        endDate: '2026-02-28',
        context: 'drive',
        driveId: 'd1abc',
        includePersonal: false,
      },
      config,
    );
    expect(request.url).toBe(
      'https://pagespace.ai/api/calendar/events?context=drive&driveId=d1abc&endDate=2026-02-28&includePersonal=false&startDate=2026-02-01',
    );
  });
});

describe('calendar.list — input refinements', () => {
  it('accepts date-only ISO strings', () => {
    expect(listCalendarEvents.inputSchema.safeParse({ startDate: '2026-02-01', endDate: '2026-02-28' }).success).toBe(true);
  });

  it('accepts naive (no timezone indicator) ISO datetimes', () => {
    const result = listCalendarEvents.inputSchema.safeParse({
      startDate: '2026-02-01T09:00:00',
      endDate: '2026-02-01T17:00:00',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a bare garbage startDate', () => {
    const result = listCalendarEvents.inputSchema.safeParse({ startDate: 'not-a-date', endDate: '2026-02-28' });
    expect(result.success).toBe(false);
  });

  it('rejects a calendrically invalid date (month 13)', () => {
    const result = listCalendarEvents.inputSchema.safeParse({ startDate: '2026-13-01', endDate: '2026-02-28' });
    expect(result.success).toBe(false);
  });

  it('rejects natural-language input ("tomorrow")', () => {
    const result = listCalendarEvents.inputSchema.safeParse({ startDate: 'tomorrow', endDate: '2026-02-28' });
    expect(result.success).toBe(false);
  });

  it('rejects context "drive" with no driveId (route 400: "driveId is required for drive context")', () => {
    const result = listCalendarEvents.inputSchema.safeParse({
      startDate: '2026-02-01',
      endDate: '2026-02-28',
      context: 'drive',
    });
    expect(result.success).toBe(false);
  });

  it('accepts context "user" with no driveId', () => {
    const result = listCalendarEvents.inputSchema.safeParse({
      startDate: '2026-02-01',
      endDate: '2026-02-28',
      context: 'user',
    });
    expect(result.success).toBe(true);
  });
});

describe('calendar.list — response contract', () => {
  it('parses { events, workflowEvents } (route truth, §2.10/D4 — never a bare array)', () => {
    const fixture = {
      events: [{ ...eventFixture, hasAgentTrigger: true }],
      workflowEvents: [
        {
          id: 'workflow-run-r1',
          title: 'Workflow: Nightly digest',
          startAt: '2026-02-19T06:00:00.000Z',
          endAt: '2026-02-19T06:05:00.000Z',
          allDay: false,
          source: 'workflow',
          workflowId: 'wf1abc',
          driveId: 'd1abc',
          color: 'amber',
          triggerType: 'cron',
        },
      ],
    };
    const result = parseResponse(listCalendarEvents, 200, new Headers(), JSON.stringify(fixture));
    expect(result).toEqual(fixture);
  });

  it('parses an empty result set', () => {
    const empty = { events: [], workflowEvents: [] };
    const result = parseResponse(listCalendarEvents, 200, new Headers(), JSON.stringify(empty));
    expect(result).toEqual(empty);
  });

  it('parses a recurring-event occurrence carrying recurringBaseStartAt/EndAt', () => {
    const withRecurrence = {
      events: [
        {
          ...eventFixture,
          hasAgentTrigger: false,
          recurrenceRule: { frequency: 'WEEKLY', interval: 1, byDay: ['MO', 'WE'] },
          recurringBaseStartAt: '2026-01-05T19:00:00.000Z',
          recurringBaseEndAt: '2026-01-05T19:30:00.000Z',
        },
      ],
      workflowEvents: [],
    };
    const result = parseResponse(listCalendarEvents, 200, new Headers(), JSON.stringify(withRecurrence));
    expect(result).not.toBeInstanceOf(ResponseValidationError);
  });

  it('rejects a bare array response (the D4 bug the old handler relied on)', () => {
    const result = parseResponse(listCalendarEvents, 200, new Headers(), JSON.stringify([eventFixture]));
    expect(result).toBeInstanceOf(ResponseValidationError);
  });

  it('parses an event missing the drive relation (drive-context list omits it)', () => {
    const { drive: _drive, ...withoutDrive } = eventFixture;
    const fixture = { events: [{ ...withoutDrive, hasAgentTrigger: false }], workflowEvents: [] };
    const result = parseResponse(listCalendarEvents, 200, new Headers(), JSON.stringify(fixture));
    expect(result).not.toBeInstanceOf(ResponseValidationError);
  });
});

describe('calendar.get — request shape and response', () => {
  it('interpolates :eventId with no query/body', () => {
    const request = buildRequest(getCalendarEvent, { eventId: 'ev1abc' }, config);
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://pagespace.ai/api/calendar/events/ev1abc');
    expect(request.body).toBeUndefined();
  });

  it('parses the bare event object (route truth, §2.10 get_calendar_event)', () => {
    const result = parseResponse(getCalendarEvent, 200, new Headers(), JSON.stringify(eventFixture));
    expect(result).toEqual(eventFixture);
  });

  it('classifies a 404 as NotFoundError, not a schema mismatch', () => {
    const result = parseResponse(getCalendarEvent, 404, new Headers(), JSON.stringify({ error: 'Event not found' }));
    expect(result).not.toBeInstanceOf(ResponseValidationError);
    expect((result as { code: string }).code).toBe('NOT_FOUND');
  });

  it('classifies a 403 as PermissionDeniedError (canAccessEvent fail-closed)', () => {
    const result = parseResponse(getCalendarEvent, 403, new Headers(), JSON.stringify({ error: 'Access denied' }));
    expect((result as { code: string }).code).toBe('PERMISSION_DENIED');
  });
});

describe('calendar.create — request shape', () => {
  it('sends the full field set as a JSON body with no path params', () => {
    const request = buildRequest(
      createCalendarEvent,
      { title: 'Standup', startAt: '2026-02-19T19:00:00Z', endAt: '2026-02-19T19:30:00Z', driveId: 'd1abc' },
      config,
    );
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://pagespace.ai/api/calendar/events');
    const body = JSON.parse(request.body!);
    expect(body).toEqual({
      driveId: 'd1abc',
      endAt: '2026-02-19T19:30:00Z',
      startAt: '2026-02-19T19:00:00Z',
      title: 'Standup',
    });
  });

  it('uses attendeeIds, not userIds (D5 fix — the old handler field silently dropped invitees)', () => {
    const request = buildRequest(
      createCalendarEvent,
      {
        title: 'Standup',
        startAt: '2026-02-19T19:00:00Z',
        endAt: '2026-02-19T19:30:00Z',
        attendeeIds: ['u2abc', 'u3abc'],
      },
      config,
    );
    const body = JSON.parse(request.body!);
    expect(body.attendeeIds).toEqual(['u2abc', 'u3abc']);
    expect(body.userIds).toBeUndefined();
  });

  it('serializes a nested recurrenceRule without dropping fields', () => {
    const request = buildRequest(
      createCalendarEvent,
      {
        title: 'Sprint planning',
        startAt: '2026-02-19T19:00:00Z',
        endAt: '2026-02-19T19:30:00Z',
        recurrenceRule: { frequency: 'WEEKLY', interval: 2, byDay: ['MO'] },
      },
      config,
    );
    const body = JSON.parse(request.body!);
    expect(body.recurrenceRule).toEqual({ frequency: 'WEEKLY', interval: 2, byDay: ['MO'] });
  });
});

describe('calendar.create — input refinements', () => {
  it('accepts a minimal valid event', () => {
    const result = createCalendarEvent.inputSchema.safeParse({
      title: 'Standup',
      startAt: '2026-02-19T19:00:00Z',
      endAt: '2026-02-19T19:30:00Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing title', () => {
    const result = createCalendarEvent.inputSchema.safeParse({
      startAt: '2026-02-19T19:00:00Z',
      endAt: '2026-02-19T19:30:00Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a bare-garbage startAt', () => {
    const result = createCalendarEvent.inputSchema.safeParse({
      title: 'Standup',
      startAt: 'whenever',
      endAt: '2026-02-19T19:30:00Z',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an agentTrigger with no driveId (route 400: "Agent triggers require a drive event")', () => {
    const result = createCalendarEvent.inputSchema.safeParse({
      title: 'Standup',
      startAt: '2026-02-19T19:00:00Z',
      endAt: '2026-02-19T19:30:00Z',
      agentTrigger: { agentPageId: 'ag1', prompt: 'Summarize' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts an agentTrigger paired with a driveId', () => {
    const result = createCalendarEvent.inputSchema.safeParse({
      title: 'Standup',
      startAt: '2026-02-19T19:00:00Z',
      endAt: '2026-02-19T19:30:00Z',
      driveId: 'd1abc',
      agentTrigger: { agentPageId: 'ag1', prompt: 'Summarize' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects an agentTrigger with neither prompt nor instructionPageId', () => {
    const result = createCalendarEvent.inputSchema.safeParse({
      title: 'Standup',
      startAt: '2026-02-19T19:00:00Z',
      endAt: '2026-02-19T19:30:00Z',
      driveId: 'd1abc',
      agentTrigger: { agentPageId: 'ag1' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects recurrenceRule.byMonthDay values outside 1-31', () => {
    const result = createCalendarEvent.inputSchema.safeParse({
      title: 'Standup',
      startAt: '2026-02-19T19:00:00Z',
      endAt: '2026-02-19T19:30:00Z',
      recurrenceRule: { frequency: 'MONTHLY', interval: 1, byMonthDay: [32] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown visibility value', () => {
    const result = createCalendarEvent.inputSchema.safeParse({
      title: 'Standup',
      startAt: '2026-02-19T19:00:00Z',
      endAt: '2026-02-19T19:30:00Z',
      visibility: 'PUBLIC',
    });
    expect(result.success).toBe(false);
  });
});

describe('calendar.create — response contract', () => {
  it('parses the created event (201, route truth §2.10 create_calendar_event)', () => {
    const result = parseResponse(createCalendarEvent, 201, new Headers(), JSON.stringify(eventFixture));
    expect(result).toEqual(eventFixture);
  });

  it('classifies a 400 (end before start) as ValidationError', () => {
    const result = parseResponse(createCalendarEvent, 400, new Headers(), JSON.stringify({ error: 'End date must be after start date' }));
    expect((result as { code: string }).code).toBe('VALIDATION_ERROR');
  });
});

describe('calendar.update — request shape', () => {
  it('interpolates :eventId and sends only the changed fields', () => {
    const request = buildRequest(updateCalendarEvent, { eventId: 'ev1abc', title: 'Renamed standup' }, config);
    expect(request.method).toBe('PATCH');
    expect(request.url).toBe('https://pagespace.ai/api/calendar/events/ev1abc');
    expect(request.body).toBe(JSON.stringify({ title: 'Renamed standup' }));
  });

  it('forwards an explicit-null agentTrigger to clear it (3-state field, not a default)', () => {
    const request = buildRequest(updateCalendarEvent, { eventId: 'ev1abc', agentTrigger: null }, config);
    const body = JSON.parse(request.body!);
    expect(body).toEqual({ agentTrigger: null });
  });
});

describe('calendar.update — input refinements', () => {
  it('accepts a partial update with no required fields beyond eventId', () => {
    expect(updateCalendarEvent.inputSchema.safeParse({ eventId: 'ev1abc' }).success).toBe(true);
  });

  it('rejects a bare-garbage endAt', () => {
    const result = updateCalendarEvent.inputSchema.safeParse({ eventId: 'ev1abc', endAt: 'soon' });
    expect(result.success).toBe(false);
  });

  it('accepts a null agentTrigger (clears the trigger)', () => {
    const result = updateCalendarEvent.inputSchema.safeParse({ eventId: 'ev1abc', agentTrigger: null });
    expect(result.success).toBe(true);
  });

  it('rejects an agentTrigger object with neither prompt nor instructionPageId', () => {
    const result = updateCalendarEvent.inputSchema.safeParse({
      eventId: 'ev1abc',
      agentTrigger: { agentPageId: 'ag1' },
    });
    expect(result.success).toBe(false);
  });
});

describe('calendar.update — response contract', () => {
  it('parses the updated event', () => {
    const result = parseResponse(updateCalendarEvent, 200, new Headers(), JSON.stringify(eventFixture));
    expect(result).toEqual(eventFixture);
  });

  it('classifies a 403 (not creator/admin) as PermissionDeniedError', () => {
    const result = parseResponse(updateCalendarEvent, 403, new Headers(), JSON.stringify({ error: 'You do not have permission to edit this event' }));
    expect((result as { code: string }).code).toBe('PERMISSION_DENIED');
  });
});

describe('calendar.delete — request shape and response', () => {
  it('DELETEs the event route with no body', () => {
    const request = buildRequest(deleteCalendarEvent, { eventId: 'ev1abc' }, config);
    expect(request.method).toBe('DELETE');
    expect(request.url).toBe('https://pagespace.ai/api/calendar/events/ev1abc');
    expect(request.body).toBeUndefined();
  });

  it('parses { success: true }', () => {
    const result = parseResponse(deleteCalendarEvent, 200, new Headers(), JSON.stringify({ success: true }));
    expect(result).toEqual({ success: true });
  });
});

describe('calendar.rsvp — request shape, refinements, response', () => {
  it('interpolates :eventId and sends status as body', () => {
    const request = buildRequest(rsvpCalendarEvent, { eventId: 'ev1abc', status: 'ACCEPTED' }, config);
    expect(request.method).toBe('PATCH');
    expect(request.url).toBe('https://pagespace.ai/api/calendar/events/ev1abc/attendees');
    expect(request.body).toBe(JSON.stringify({ status: 'ACCEPTED' }));
  });

  it('accepts the full route enum including PENDING (old tool only exposed ACCEPTED/DECLINED/TENTATIVE)', () => {
    const result = rsvpCalendarEvent.inputSchema.safeParse({ eventId: 'ev1abc', status: 'PENDING' });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown status', () => {
    const result = rsvpCalendarEvent.inputSchema.safeParse({ eventId: 'ev1abc', status: 'MAYBE' });
    expect(result.success).toBe(false);
  });

  it('rejects a responseNote over 500 chars', () => {
    const result = rsvpCalendarEvent.inputSchema.safeParse({
      eventId: 'ev1abc',
      status: 'ACCEPTED',
      responseNote: 'x'.repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it('parses the bare updated attendee row (no nested user — route .returning())', () => {
    const attendeeRow = {
      id: 'att1',
      eventId: 'ev1abc',
      userId: 'u1abc',
      status: 'ACCEPTED',
      responseNote: null,
      isOrganizer: false,
      isOptional: false,
      invitedAt: '2026-01-01T00:00:00.000Z',
      respondedAt: '2026-01-02T00:00:00.000Z',
    };
    const result = parseResponse(rsvpCalendarEvent, 200, new Headers(), JSON.stringify(attendeeRow));
    expect(result).toEqual(attendeeRow);
  });
});

describe('calendar.inviteAttendees — request shape, refinements, response', () => {
  it('interpolates :eventId and sends userIds/isOptional as body', () => {
    const request = buildRequest(
      inviteCalendarAttendees,
      { eventId: 'ev1abc', userIds: ['u2abc', 'u3abc'], isOptional: true },
      config,
    );
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://pagespace.ai/api/calendar/events/ev1abc/attendees');
    expect(JSON.parse(request.body!)).toEqual({ isOptional: true, userIds: ['u2abc', 'u3abc'] });
  });

  it('rejects an empty userIds array', () => {
    const result = inviteCalendarAttendees.inputSchema.safeParse({ eventId: 'ev1abc', userIds: [] });
    expect(result.success).toBe(false);
  });

  it('parses { attendees } with the email-bearing user shape (route truth, attendees endpoint)', () => {
    const fixture = {
      attendees: [
        {
          id: 'att2',
          eventId: 'ev1abc',
          userId: 'u2abc',
          status: 'PENDING',
          responseNote: null,
          isOrganizer: false,
          isOptional: true,
          invitedAt: '2026-01-01T00:00:00.000Z',
          respondedAt: null,
          user: { id: 'u2abc', name: 'Bo', email: 'bo@example.com', image: null },
        },
      ],
    };
    const result = parseResponse(inviteCalendarAttendees, 200, new Headers(), JSON.stringify(fixture));
    expect(result).toEqual(fixture);
  });

  it('parses the "all users already attendees" short-circuit shape ({ message })', () => {
    const fixture = { message: 'All users are already attendees' };
    const result = parseResponse(inviteCalendarAttendees, 200, new Headers(), JSON.stringify(fixture));
    expect(result).toEqual(fixture);
  });
});

describe('calendar.removeAttendee — request shape (D6 fix) and response', () => {
  it('sends userId as a query param on DELETE, never a JSON body', () => {
    const request = buildRequest(removeCalendarAttendee, { eventId: 'ev1abc', userId: 'u2abc' }, config);
    expect(request.method).toBe('DELETE');
    expect(request.url).toBe('https://pagespace.ai/api/calendar/events/ev1abc/attendees?userId=u2abc');
    expect(request.body).toBeUndefined();
  });

  it('URL-encodes a userId containing reserved characters', () => {
    const request = buildRequest(removeCalendarAttendee, { eventId: 'ev1abc', userId: 'u2/abc' }, config);
    expect(request.url).toBe('https://pagespace.ai/api/calendar/events/ev1abc/attendees?userId=u2%2Fabc');
  });

  it('parses { success: true }', () => {
    const result = parseResponse(removeCalendarAttendee, 200, new Headers(), JSON.stringify({ success: true }));
    expect(result).toEqual({ success: true });
  });

  it('classifies a 400 (organizer removal blocked) as ValidationError', () => {
    const result = parseResponse(removeCalendarAttendee, 400, new Headers(), JSON.stringify({ error: 'Cannot remove the event organizer' }));
    expect((result as { code: string }).code).toBe('VALIDATION_ERROR');
  });
});

describe('calendar.setTrigger — request shape, refinements, response', () => {
  it('interpolates :eventId and sends trigger fields as body', () => {
    const request = buildRequest(
      setCalendarTrigger,
      { eventId: 'ev1abc', agentPageId: 'ag1', prompt: 'Summarize the meeting' },
      config,
    );
    expect(request.method).toBe('PUT');
    expect(request.url).toBe('https://pagespace.ai/api/calendar/events/ev1abc/triggers');
    expect(JSON.parse(request.body!)).toEqual({ agentPageId: 'ag1', prompt: 'Summarize the meeting' });
  });

  it('rejects a trigger with neither prompt nor instructionPageId (route .strict().refine())', () => {
    const result = setCalendarTrigger.inputSchema.safeParse({ eventId: 'ev1abc', agentPageId: 'ag1' });
    expect(result.success).toBe(false);
  });

  it('accepts a trigger with only instructionPageId', () => {
    const result = setCalendarTrigger.inputSchema.safeParse({
      eventId: 'ev1abc',
      agentPageId: 'ag1',
      instructionPageId: 'instr1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects contextPageIds beyond the 10-item cap', () => {
    const result = setCalendarTrigger.inputSchema.safeParse({
      eventId: 'ev1abc',
      agentPageId: 'ag1',
      prompt: 'Summarize',
      contextPageIds: Array.from({ length: 11 }, (_, i) => `p${i}`),
    });
    expect(result.success).toBe(false);
  });

  it('parses { success: true }', () => {
    const result = parseResponse(setCalendarTrigger, 200, new Headers(), JSON.stringify({ success: true }));
    expect(result).toEqual({ success: true });
  });

  it('classifies a 400 (personal event, "Agent triggers require a drive event") as ValidationError', () => {
    const result = parseResponse(setCalendarTrigger, 400, new Headers(), JSON.stringify({ error: 'Agent triggers require a drive event' }));
    expect((result as { code: string }).code).toBe('VALIDATION_ERROR');
  });
});

describe('calendar.deleteTrigger — request shape and response', () => {
  it('interpolates :eventId with no body', () => {
    const request = buildRequest(deleteCalendarTrigger, { eventId: 'ev1abc' }, config);
    expect(request.method).toBe('DELETE');
    expect(request.url).toBe('https://pagespace.ai/api/calendar/events/ev1abc/triggers');
    expect(request.body).toBeUndefined();
  });

  it('parses { success: true } (idempotent — succeeds even with no existing trigger)', () => {
    const result = parseResponse(deleteCalendarTrigger, 200, new Headers(), JSON.stringify({ success: true }));
    expect(result).toEqual({ success: true });
  });
});

describe('computeFreeSlots — pure availability computation (check_calendar_availability, D4 resolution)', () => {
  it('returns the whole range as free when there are no events', () => {
    const slots = computeFreeSlots([], { startAt: '2026-02-01T00:00:00.000Z', endAt: '2026-02-01T10:00:00.000Z' });
    expect(slots).toEqual([{ startAt: '2026-02-01T00:00:00.000Z', endAt: '2026-02-01T10:00:00.000Z' }]);
  });

  it('computes the gap before, between, and after two events', () => {
    const slots = computeFreeSlots(
      [
        { startAt: '2026-02-01T02:00:00.000Z', endAt: '2026-02-01T03:00:00.000Z' },
        { startAt: '2026-02-01T05:00:00.000Z', endAt: '2026-02-01T06:00:00.000Z' },
      ],
      { startAt: '2026-02-01T00:00:00.000Z', endAt: '2026-02-01T10:00:00.000Z' },
    );
    expect(slots).toEqual([
      { startAt: '2026-02-01T00:00:00.000Z', endAt: '2026-02-01T02:00:00.000Z' },
      { startAt: '2026-02-01T03:00:00.000Z', endAt: '2026-02-01T05:00:00.000Z' },
      { startAt: '2026-02-01T06:00:00.000Z', endAt: '2026-02-01T10:00:00.000Z' },
    ]);
  });

  it('returns no slots when a single event spans the entire range', () => {
    const slots = computeFreeSlots(
      [{ startAt: '2026-01-31T00:00:00.000Z', endAt: '2026-02-02T00:00:00.000Z' }],
      { startAt: '2026-02-01T00:00:00.000Z', endAt: '2026-02-01T10:00:00.000Z' },
    );
    expect(slots).toEqual([]);
  });

  it('merges overlapping events into a single busy block (mirrors the old handler\'s running-current-pointer algorithm)', () => {
    const slots = computeFreeSlots(
      [
        { startAt: '2026-02-01T01:00:00.000Z', endAt: '2026-02-01T04:00:00.000Z' },
        { startAt: '2026-02-01T02:00:00.000Z', endAt: '2026-02-01T03:00:00.000Z' },
      ],
      { startAt: '2026-02-01T00:00:00.000Z', endAt: '2026-02-01T05:00:00.000Z' },
    );
    expect(slots).toEqual([
      { startAt: '2026-02-01T00:00:00.000Z', endAt: '2026-02-01T01:00:00.000Z' },
      { startAt: '2026-02-01T04:00:00.000Z', endAt: '2026-02-01T05:00:00.000Z' },
    ]);
  });

  it('clamps a free-slot end to the range end when an event starts after the range (overruns end)', () => {
    const slots = computeFreeSlots(
      [{ startAt: '2026-02-01T18:00:00.000Z', endAt: '2026-02-01T19:00:00.000Z' }],
      { startAt: '2026-02-01T09:00:00.000Z', endAt: '2026-02-01T17:00:00.000Z' },
    );
    expect(slots).toEqual([{ startAt: '2026-02-01T09:00:00.000Z', endAt: '2026-02-01T17:00:00.000Z' }]);
  });

  it('is order-independent — unsorted input events produce the same result as sorted input', () => {
    const events = [
      { startAt: '2026-02-01T05:00:00.000Z', endAt: '2026-02-01T06:00:00.000Z' },
      { startAt: '2026-02-01T02:00:00.000Z', endAt: '2026-02-01T03:00:00.000Z' },
    ];
    const range = { startAt: '2026-02-01T00:00:00.000Z', endAt: '2026-02-01T10:00:00.000Z' };
    expect(computeFreeSlots(events, range)).toEqual(computeFreeSlots([...events].reverse(), range));
  });
});

describe('calendar operations — metadata', () => {
  it('every operation is named, described, and MCP/CLI derivable', () => {
    const ops = [
      listCalendarEvents,
      getCalendarEvent,
      createCalendarEvent,
      updateCalendarEvent,
      deleteCalendarEvent,
      rsvpCalendarEvent,
      inviteCalendarAttendees,
      removeCalendarAttendee,
      setCalendarTrigger,
      deleteCalendarTrigger,
    ];
    for (const op of ops) {
      expect(op.name.startsWith('calendar.')).toBe(true);
      expect(op.description.length).toBeGreaterThan(0);
    }
  });
});
