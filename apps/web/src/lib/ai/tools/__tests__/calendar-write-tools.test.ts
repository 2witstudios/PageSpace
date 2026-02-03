import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assert } from './riteway';

// Mock database and dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    query: {
      calendarEvents: { findFirst: vi.fn() },
      eventAttendees: { findFirst: vi.fn() },
    },
  },
  calendarEvents: {
    id: 'id',
    driveId: 'driveId',
    createdById: 'createdById',
    visibility: 'visibility',
    isTrashed: 'isTrashed',
    startAt: 'startAt',
    endAt: 'endAt',
  },
  eventAttendees: {
    id: 'id',
    eventId: 'eventId',
    userId: 'userId',
    status: 'status',
    isOrganizer: 'isOrganizer',
  },
  eq: vi.fn(),
  and: vi.fn(),
  ne: vi.fn(),
}));

vi.mock('@pagespace/lib', () => ({
  isUserDriveMember: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  getDriveMemberUserIds: vi.fn(),
  loggers: {
    ai: {
      child: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      })),
    },
  },
}));

vi.mock('@/lib/websocket/calendar-events', () => ({
  broadcastCalendarEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id) => `***${id?.slice(-4) || ''}`),
}));

// Mock chrono-node - helper to parse time from string
const parseTimeFromString = (input: string): { hours: number; minutes: number } => {
  const timeMatch = input.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1], 10);
    const minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const ampm = timeMatch[3]?.toLowerCase();
    if (ampm === 'pm' && hours !== 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
    return { hours, minutes };
  }
  return { hours: 9, minutes: 0 }; // default
};

vi.mock('chrono-node', () => ({
  default: {
    parseDate: vi.fn((input: string) => {
      if (input.toLowerCase().includes('tomorrow')) {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const { hours, minutes } = parseTimeFromString(input);
        tomorrow.setHours(hours, minutes, 0, 0);
        return tomorrow;
      }
      if (input.toLowerCase().includes('next monday')) {
        const nextMonday = new Date();
        const daysUntilMonday = (8 - nextMonday.getDay()) % 7 || 7;
        nextMonday.setDate(nextMonday.getDate() + daysUntilMonday);
        const { hours, minutes } = parseTimeFromString(input);
        nextMonday.setHours(hours, minutes, 0, 0);
        return nextMonday;
      }
      return null;
    }),
  },
  parseDate: vi.fn((input: string) => {
    if (input.toLowerCase().includes('tomorrow')) {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const { hours, minutes } = parseTimeFromString(input);
      tomorrow.setHours(hours, minutes, 0, 0);
      return tomorrow;
    }
    if (input.toLowerCase().includes('next monday')) {
      const nextMonday = new Date();
      const daysUntilMonday = (8 - nextMonday.getDay()) % 7 || 7;
      nextMonday.setDate(nextMonday.getDate() + daysUntilMonday);
      const { hours, minutes } = parseTimeFromString(input);
      nextMonday.setHours(hours, minutes, 0, 0);
      return nextMonday;
    }
    return null;
  }),
}));

import { calendarWriteTools } from '../calendar-write-tools';
import { db } from '@pagespace/db';
import { isUserDriveMember } from '@pagespace/lib';
import { getDriveMemberUserIds } from '@pagespace/lib/server';
import { broadcastCalendarEvent } from '@/lib/websocket/calendar-events';
import type { ToolExecutionContext } from '../../core';

const mockDb = vi.mocked(db);
const mockIsUserDriveMember = vi.mocked(isUserDriveMember);
const mockGetDriveMemberUserIds = vi.mocked(getDriveMemberUserIds);
const mockBroadcastCalendarEvent = vi.mocked(broadcastCalendarEvent);

const createMockEvent = (overrides = {}) => ({
  id: 'event-1',
  title: 'Test Event',
  description: 'Test description',
  location: 'Test location',
  startAt: new Date('2024-01-15T10:00:00Z'),
  endAt: new Date('2024-01-15T11:00:00Z'),
  allDay: false,
  timezone: 'UTC',
  visibility: 'DRIVE',
  color: 'default',
  recurrenceRule: null,
  driveId: 'drive-1',
  createdById: 'user-123',
  isTrashed: false,
  ...overrides,
});

const createAuthContext = (userId = 'user-123') => ({
  toolCallId: '1',
  messages: [],
  experimental_context: { userId } as ToolExecutionContext,
});

describe('calendar-write-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('create_calendar_event', () => {
    it('has correct tool definition', () => {
      assert({
        given: 'create_calendar_event tool',
        should: 'be defined',
        actual: calendarWriteTools.create_calendar_event !== undefined,
        expected: true,
      });

      assert({
        given: 'create_calendar_event tool',
        should: 'have description mentioning natural language dates',
        actual: calendarWriteTools.create_calendar_event.description?.toLowerCase().includes('natural language'),
        expected: true,
      });
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };
      const input = {
        title: 'Test Event',
        startAt: '2024-01-15T10:00:00Z',
        endAt: '2024-01-15T11:00:00Z',
      };

      await expect(
        calendarWriteTools.create_calendar_event.execute!(input, context)
      ).rejects.toThrow('User authentication required');
    });

    it('creates event with ISO 8601 dates', async () => {
      const newEvent = createMockEvent();
      (mockDb.insert as ReturnType<typeof vi.fn>).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([newEvent]),
        }),
      });

      const input = {
        title: 'Test Event',
        startAt: '2024-01-15T10:00:00Z',
        endAt: '2024-01-15T11:00:00Z',
      };

      const result = await calendarWriteTools.create_calendar_event.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'valid ISO 8601 dates',
        should: 'return success',
        actual: (result as { success: boolean }).success,
        expected: true,
      });

      assert({
        given: 'successful event creation',
        should: 'return event id',
        actual: typeof (result as { data: { id: string } }).data.id,
        expected: 'string',
      });
    });

    it('creates event with natural language dates', async () => {
      const newEvent = createMockEvent();
      (mockDb.insert as ReturnType<typeof vi.fn>).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([newEvent]),
        }),
      });

      const input = {
        title: 'Team Meeting',
        startAt: 'tomorrow at 3pm',
        endAt: 'tomorrow at 4pm',
      };

      const result = await calendarWriteTools.create_calendar_event.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'natural language dates',
        should: 'return success',
        actual: (result as { success: boolean }).success,
        expected: true,
      });
    });

    it('returns error when endDate before startDate', async () => {
      const input = {
        title: 'Test Event',
        startAt: '2024-01-15T15:00:00Z',
        endAt: '2024-01-15T10:00:00Z',
      };

      const result = await calendarWriteTools.create_calendar_event.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'endDate before startDate',
        should: 'return error',
        actual: (result as { success: boolean }).success,
        expected: false,
      });

      assert({
        given: 'endDate before startDate',
        should: 'include error message',
        actual: (result as { error?: string }).error?.toLowerCase().includes('after'),
        expected: true,
      });
    });

    it('returns error when user lacks drive access', async () => {
      mockIsUserDriveMember.mockResolvedValue(false);

      const input = {
        title: 'Test Event',
        startAt: '2024-01-15T10:00:00Z',
        endAt: '2024-01-15T11:00:00Z',
        driveId: 'drive-1',
      };

      const result = await calendarWriteTools.create_calendar_event.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'user without drive access',
        should: 'return error',
        actual: (result as { success: boolean }).success,
        expected: false,
      });

      assert({
        given: 'user without drive access',
        should: 'include access error',
        actual: (result as { error?: string }).error?.toLowerCase().includes('access'),
        expected: true,
      });
    });

    it('returns error when PRIVATE event has attendees', async () => {
      mockIsUserDriveMember.mockResolvedValue(true);

      const input = {
        title: 'Test Event',
        startAt: '2024-01-15T10:00:00Z',
        endAt: '2024-01-15T11:00:00Z',
        visibility: 'PRIVATE' as const,
        attendeeIds: ['other-user'],
      };

      const result = await calendarWriteTools.create_calendar_event.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'PRIVATE event with attendees',
        should: 'return error',
        actual: (result as { success: boolean }).success,
        expected: false,
      });

      assert({
        given: 'PRIVATE event with attendees',
        should: 'include error about private events',
        actual: (result as { error?: string }).error?.toLowerCase().includes('private'),
        expected: true,
      });
    });

    it('returns error when attendees are not drive members', async () => {
      mockIsUserDriveMember.mockResolvedValue(true);
      mockGetDriveMemberUserIds.mockResolvedValue(['user-123', 'user-456']);

      const input = {
        title: 'Test Event',
        startAt: '2024-01-15T10:00:00Z',
        endAt: '2024-01-15T11:00:00Z',
        driveId: 'drive-1',
        attendeeIds: ['non-member'],
      };

      const result = await calendarWriteTools.create_calendar_event.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'attendee not in drive',
        should: 'return error',
        actual: (result as { success: boolean }).success,
        expected: false,
      });

      assert({
        given: 'attendee not in drive',
        should: 'include error about drive members',
        actual: (result as { error?: string }).error?.toLowerCase().includes('member'),
        expected: true,
      });
    });

    it('broadcasts event after creation', async () => {
      const newEvent = createMockEvent();
      (mockDb.insert as ReturnType<typeof vi.fn>).mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([newEvent]),
        }),
      });

      const input = {
        title: 'Test Event',
        startAt: '2024-01-15T10:00:00Z',
        endAt: '2024-01-15T11:00:00Z',
      };

      await calendarWriteTools.create_calendar_event.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'successful event creation',
        should: 'broadcast event',
        actual: mockBroadcastCalendarEvent.mock.calls.length,
        expected: 1,
      });

      assert({
        given: 'broadcast call',
        should: 'include correct operation',
        actual: mockBroadcastCalendarEvent.mock.calls[0][0].operation,
        expected: 'created',
      });
    });
  });

  describe('update_calendar_event', () => {
    it('has correct tool definition', () => {
      assert({
        given: 'update_calendar_event tool',
        should: 'be defined',
        actual: calendarWriteTools.update_calendar_event !== undefined,
        expected: true,
      });
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };
      const input = { eventId: 'event-1', title: 'Updated Title' };

      await expect(
        calendarWriteTools.update_calendar_event.execute!(input, context)
      ).rejects.toThrow('User authentication required');
    });

    it('returns error when event not found', async () => {
      mockDb.query.calendarEvents.findFirst = vi.fn().mockResolvedValue(null);
      const input = { eventId: 'non-existent', title: 'Updated Title' };

      const result = await calendarWriteTools.update_calendar_event.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'non-existent event',
        should: 'return error',
        actual: (result as { success: boolean }).success,
        expected: false,
      });

      assert({
        given: 'non-existent event',
        should: 'include not found error',
        actual: (result as { error?: string }).error?.toLowerCase().includes('not found'),
        expected: true,
      });
    });

    it('returns error when user is not the creator', async () => {
      const event = createMockEvent({ createdById: 'other-user' });
      mockDb.query.calendarEvents.findFirst = vi.fn().mockResolvedValue(event);
      const input = { eventId: 'event-1', title: 'Updated Title' };

      const result = await calendarWriteTools.update_calendar_event.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'user is not event creator',
        should: 'return error',
        actual: (result as { success: boolean }).success,
        expected: false,
      });

      assert({
        given: 'user is not event creator',
        should: 'include creator error',
        actual: (result as { error?: string }).error?.toLowerCase().includes('creator'),
        expected: true,
      });
    });

    it('updates event when user is creator', async () => {
      const event = createMockEvent({ createdById: 'user-123' });
      mockDb.query.calendarEvents.findFirst = vi.fn().mockResolvedValue(event);
      (mockDb.update as ReturnType<typeof vi.fn>).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ ...event, title: 'Updated Title' }]),
          }),
        }),
      });
      // Mock attendees query for broadcast
      (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ userId: 'user-123' }]),
        }),
      });

      const input = { eventId: 'event-1', title: 'Updated Title' };

      const result = await calendarWriteTools.update_calendar_event.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'user is event creator',
        should: 'return success',
        actual: (result as { success: boolean }).success,
        expected: true,
      });
    });

    it('broadcasts update after modification', async () => {
      const event = createMockEvent({ createdById: 'user-123' });
      mockDb.query.calendarEvents.findFirst = vi.fn().mockResolvedValue(event);
      (mockDb.update as ReturnType<typeof vi.fn>).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([event]),
          }),
        }),
      });
      (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ userId: 'user-123' }]),
        }),
      });

      const input = { eventId: 'event-1', title: 'Updated Title' };

      await calendarWriteTools.update_calendar_event.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'successful update',
        should: 'broadcast event',
        actual: mockBroadcastCalendarEvent.mock.calls.length,
        expected: 1,
      });

      assert({
        given: 'broadcast call',
        should: 'include updated operation',
        actual: mockBroadcastCalendarEvent.mock.calls[0][0].operation,
        expected: 'updated',
      });
    });

    it('removes attendees when visibility changes to PRIVATE', async () => {
      // Existing event with DRIVE visibility
      mockDb.query.calendarEvents.findFirst = vi.fn().mockResolvedValue({
        id: 'event-1',
        title: 'Team Meeting',
        createdById: 'user-123',
        driveId: 'drive-1',
        visibility: 'DRIVE',
        startAt: new Date('2024-01-15T10:00:00Z'),
        endAt: new Date('2024-01-15T11:00:00Z'),
        isTrashed: false,
      });

      // Mock update returning updated event
      (mockDb.update as ReturnType<typeof vi.fn>).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([
              {
                id: 'event-1',
                title: 'Team Meeting',
                driveId: 'drive-1',
                visibility: 'PRIVATE',
                startAt: new Date('2024-01-15T10:00:00Z'),
                endAt: new Date('2024-01-15T11:00:00Z'),
              },
            ]),
          }),
        }),
      });

      // Mock delete returning removed attendees
      (mockDb.delete as ReturnType<typeof vi.fn>).mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([
            { userId: 'attendee-1' },
            { userId: 'attendee-2' },
          ]),
        }),
      });

      // Mock select for getting attendee IDs
      (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ userId: 'user-123' }]),
        }),
      });

      const input = { eventId: 'event-1', visibility: 'PRIVATE' as const };

      const result = await calendarWriteTools.update_calendar_event.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'visibility change to PRIVATE',
        should: 'return success with attendee removal info',
        actual: result.success,
        expected: true,
      });

      assert({
        given: 'visibility change to PRIVATE with attendees',
        should: 'include attendeesRemoved in stats',
        actual: (result.stats as { attendeesRemoved?: number }).attendeesRemoved,
        expected: 2,
      });

      assert({
        given: 'visibility change to PRIVATE',
        should: 'mention removed attendees in summary',
        actual: result.summary?.includes('removed'),
        expected: true,
      });
    });
  });

  describe('delete_calendar_event', () => {
    it('has correct tool definition', () => {
      assert({
        given: 'delete_calendar_event tool',
        should: 'be defined',
        actual: calendarWriteTools.delete_calendar_event !== undefined,
        expected: true,
      });
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };
      const input = { eventId: 'event-1' };

      await expect(
        calendarWriteTools.delete_calendar_event.execute!(input, context)
      ).rejects.toThrow('User authentication required');
    });

    it('returns error when event not found', async () => {
      mockDb.query.calendarEvents.findFirst = vi.fn().mockResolvedValue(null);
      const input = { eventId: 'non-existent' };

      const result = await calendarWriteTools.delete_calendar_event.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'non-existent event',
        should: 'return error',
        actual: (result as { success: boolean }).success,
        expected: false,
      });
    });

    it('returns error when user is not the creator', async () => {
      const event = createMockEvent({ createdById: 'other-user' });
      mockDb.query.calendarEvents.findFirst = vi.fn().mockResolvedValue(event);
      const input = { eventId: 'event-1' };

      const result = await calendarWriteTools.delete_calendar_event.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'user is not event creator',
        should: 'return error',
        actual: (result as { success: boolean }).success,
        expected: false,
      });

      assert({
        given: 'user is not event creator',
        should: 'include creator error',
        actual: (result as { error?: string }).error?.toLowerCase().includes('creator'),
        expected: true,
      });
    });

    it('soft deletes event when user is creator', async () => {
      const event = createMockEvent({ createdById: 'user-123' });
      mockDb.query.calendarEvents.findFirst = vi.fn().mockResolvedValue(event);
      (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ userId: 'user-123' }]),
        }),
      });
      (mockDb.update as ReturnType<typeof vi.fn>).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      const input = { eventId: 'event-1' };

      const result = await calendarWriteTools.delete_calendar_event.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'user is event creator',
        should: 'return success',
        actual: (result as { success: boolean }).success,
        expected: true,
      });

      assert({
        given: 'successful deletion',
        should: 'return event title in data',
        actual: (result as { data: { title: string } }).data.title,
        expected: 'Test Event',
      });
    });

    it('broadcasts deletion after soft delete', async () => {
      const event = createMockEvent({ createdById: 'user-123' });
      mockDb.query.calendarEvents.findFirst = vi.fn().mockResolvedValue(event);
      (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ userId: 'user-123' }]),
        }),
      });
      (mockDb.update as ReturnType<typeof vi.fn>).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      });

      const input = { eventId: 'event-1' };

      await calendarWriteTools.delete_calendar_event.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'successful deletion',
        should: 'broadcast event',
        actual: mockBroadcastCalendarEvent.mock.calls.length,
        expected: 1,
      });

      assert({
        given: 'broadcast call',
        should: 'include deleted operation',
        actual: mockBroadcastCalendarEvent.mock.calls[0][0].operation,
        expected: 'deleted',
      });
    });
  });

  describe('rsvp_calendar_event', () => {
    it('has correct tool definition', () => {
      assert({
        given: 'rsvp_calendar_event tool',
        should: 'be defined',
        actual: calendarWriteTools.rsvp_calendar_event !== undefined,
        expected: true,
      });
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };
      const input = { eventId: 'event-1', status: 'ACCEPTED' as const };

      await expect(
        calendarWriteTools.rsvp_calendar_event.execute!(input, context)
      ).rejects.toThrow('User authentication required');
    });

    it('returns error when event not found', async () => {
      mockDb.query.calendarEvents.findFirst = vi.fn().mockResolvedValue(null);
      const input = { eventId: 'non-existent', status: 'ACCEPTED' as const };

      const result = await calendarWriteTools.rsvp_calendar_event.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'non-existent event',
        should: 'return error',
        actual: (result as { success: boolean }).success,
        expected: false,
      });
    });

    it('returns error when user is not an attendee', async () => {
      const event = createMockEvent();
      mockDb.query.calendarEvents.findFirst = vi.fn().mockResolvedValue(event);
      mockDb.query.eventAttendees.findFirst = vi.fn().mockResolvedValue(null);
      const input = { eventId: 'event-1', status: 'ACCEPTED' as const };

      const result = await calendarWriteTools.rsvp_calendar_event.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'user not an attendee',
        should: 'return error',
        actual: (result as { success: boolean }).success,
        expected: false,
      });

      assert({
        given: 'user not an attendee',
        should: 'include attendee error',
        actual: (result as { error?: string }).error?.toLowerCase().includes('attendee'),
        expected: true,
      });
    });

    it('updates RSVP status when user is attendee', async () => {
      const event = createMockEvent();
      mockDb.query.calendarEvents.findFirst = vi.fn().mockResolvedValue(event);
      mockDb.query.eventAttendees.findFirst = vi.fn().mockResolvedValue({
        id: 'att-1',
        eventId: 'event-1',
        userId: 'user-123',
        status: 'PENDING',
      });
      (mockDb.update as ReturnType<typeof vi.fn>).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 'att-1',
              eventId: 'event-1',
              userId: 'user-123',
              status: 'ACCEPTED' as const,
              responseNote: null,
            }]),
          }),
        }),
      });
      (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ userId: 'user-123' }]),
        }),
      });

      const input = { eventId: 'event-1', status: 'ACCEPTED' as const };

      const result = await calendarWriteTools.rsvp_calendar_event.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'user is attendee',
        should: 'return success',
        actual: (result as { success: boolean }).success,
        expected: true,
      });

      assert({
        given: 'successful RSVP',
        should: 'return new status',
        actual: (result as { data: { status: string } }).data.status,
        expected: 'ACCEPTED',
      });
    });

    it('broadcasts RSVP update', async () => {
      const event = createMockEvent();
      mockDb.query.calendarEvents.findFirst = vi.fn().mockResolvedValue(event);
      mockDb.query.eventAttendees.findFirst = vi.fn().mockResolvedValue({
        id: 'att-1',
        eventId: 'event-1',
        userId: 'user-123',
        status: 'PENDING',
      });
      (mockDb.update as ReturnType<typeof vi.fn>).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              id: 'att-1',
              status: 'DECLINED' as const,
              responseNote: 'Cannot attend',
            }]),
          }),
        }),
      });
      (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ userId: 'user-123' }]),
        }),
      });

      const input = { eventId: 'event-1', status: 'DECLINED' as const, responseNote: 'Cannot attend' };

      await calendarWriteTools.rsvp_calendar_event.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'successful RSVP',
        should: 'broadcast event',
        actual: mockBroadcastCalendarEvent.mock.calls.length,
        expected: 1,
      });

      assert({
        given: 'broadcast call',
        should: 'include rsvp_updated operation',
        actual: mockBroadcastCalendarEvent.mock.calls[0][0].operation,
        expected: 'rsvp_updated',
      });
    });
  });

  describe('invite_calendar_attendees', () => {
    it('has correct tool definition', () => {
      assert({
        given: 'invite_calendar_attendees tool',
        should: 'be defined',
        actual: calendarWriteTools.invite_calendar_attendees !== undefined,
        expected: true,
      });
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };
      const input = { eventId: 'event-1', userIds: ['user-456'] };

      await expect(
        calendarWriteTools.invite_calendar_attendees.execute!(input, context)
      ).rejects.toThrow('User authentication required');
    });

    it('returns error when event not found', async () => {
      mockDb.query.calendarEvents.findFirst = vi.fn().mockResolvedValue(null);
      const input = { eventId: 'non-existent', userIds: ['user-456'] };

      const result = await calendarWriteTools.invite_calendar_attendees.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'non-existent event',
        should: 'return error',
        actual: (result as { success: boolean }).success,
        expected: false,
      });
    });

    it('returns error when user is not the creator', async () => {
      const event = createMockEvent({ createdById: 'other-user' });
      mockDb.query.calendarEvents.findFirst = vi.fn().mockResolvedValue(event);
      const input = { eventId: 'event-1', userIds: ['user-456'] };

      const result = await calendarWriteTools.invite_calendar_attendees.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'user is not event creator',
        should: 'return error',
        actual: (result as { success: boolean }).success,
        expected: false,
      });

      assert({
        given: 'user is not event creator',
        should: 'include creator error',
        actual: (result as { error?: string }).error?.toLowerCase().includes('creator'),
        expected: true,
      });
    });

    it('returns error when event is PRIVATE', async () => {
      const event = createMockEvent({ createdById: 'user-123', visibility: 'PRIVATE' as const });
      mockDb.query.calendarEvents.findFirst = vi.fn().mockResolvedValue(event);
      const input = { eventId: 'event-1', userIds: ['user-456'] };

      const result = await calendarWriteTools.invite_calendar_attendees.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'PRIVATE event',
        should: 'return error',
        actual: (result as { success: boolean }).success,
        expected: false,
      });

      assert({
        given: 'PRIVATE event',
        should: 'include private error',
        actual: (result as { error?: string }).error?.toLowerCase().includes('private'),
        expected: true,
      });
    });

    it('returns error when attendees are not drive members', async () => {
      const event = createMockEvent({ createdById: 'user-123', driveId: 'drive-1' });
      mockDb.query.calendarEvents.findFirst = vi.fn().mockResolvedValue(event);
      mockGetDriveMemberUserIds.mockResolvedValue(['user-123', 'user-456']);
      const input = { eventId: 'event-1', userIds: ['non-member'] };

      const result = await calendarWriteTools.invite_calendar_attendees.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'non-drive-member attendee',
        should: 'return error',
        actual: (result as { success: boolean }).success,
        expected: false,
      });

      assert({
        given: 'non-drive-member attendee',
        should: 'include member error',
        actual: (result as { error?: string }).error?.toLowerCase().includes('member'),
        expected: true,
      });
    });

    it('adds attendees when user is creator', async () => {
      const event = createMockEvent({ createdById: 'user-123', driveId: null });
      mockDb.query.calendarEvents.findFirst = vi.fn().mockResolvedValue(event);
      // Mock existing attendees query
      (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });
      (mockDb.insert as ReturnType<typeof vi.fn>).mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      });

      const input = { eventId: 'event-1', userIds: ['user-456', 'user-789'] };

      const result = await calendarWriteTools.invite_calendar_attendees.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'user is creator with valid attendees',
        should: 'return success',
        actual: (result as { success: boolean }).success,
        expected: true,
      });

      assert({
        given: 'successful invite',
        should: 'return count of invited users',
        actual: (result as { data: { newlyInvited: number } }).data.newlyInvited,
        expected: 2,
      });
    });

    it('skips already existing attendees', async () => {
      const event = createMockEvent({ createdById: 'user-123', driveId: null });
      mockDb.query.calendarEvents.findFirst = vi.fn().mockResolvedValue(event);
      // User-456 is already an attendee
      (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ userId: 'user-456' }]),
        }),
      });
      (mockDb.insert as ReturnType<typeof vi.fn>).mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      });

      const input = { eventId: 'event-1', userIds: ['user-456', 'user-789'] };

      const result = await calendarWriteTools.invite_calendar_attendees.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'some users already attendees',
        should: 'return success',
        actual: (result as { success: boolean }).success,
        expected: true,
      });

      assert({
        given: 'one existing and one new attendee',
        should: 'return newlyInvited count of 1',
        actual: (result as { data: { newlyInvited: number } }).data.newlyInvited,
        expected: 1,
      });

      assert({
        given: 'one existing attendee',
        should: 'return skippedExisting count of 1',
        actual: (result as { data: { skippedExisting: number } }).data.skippedExisting,
        expected: 1,
      });
    });
  });

  describe('remove_calendar_attendee', () => {
    it('has correct tool definition', () => {
      assert({
        given: 'remove_calendar_attendee tool',
        should: 'be defined',
        actual: calendarWriteTools.remove_calendar_attendee !== undefined,
        expected: true,
      });
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };
      const input = { eventId: 'event-1' };

      await expect(
        calendarWriteTools.remove_calendar_attendee.execute!(input, context)
      ).rejects.toThrow('User authentication required');
    });

    it('returns error when event not found', async () => {
      mockDb.query.calendarEvents.findFirst = vi.fn().mockResolvedValue(null);
      const input = { eventId: 'non-existent' };

      const result = await calendarWriteTools.remove_calendar_attendee.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'non-existent event',
        should: 'return error',
        actual: (result as { success: boolean }).success,
        expected: false,
      });
    });

    it('returns error when non-creator tries to remove another user', async () => {
      const event = createMockEvent({ createdById: 'other-user' });
      mockDb.query.calendarEvents.findFirst = vi.fn().mockResolvedValue(event);
      const input = { eventId: 'event-1', targetUserId: 'user-456' };

      const result = await calendarWriteTools.remove_calendar_attendee.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'non-creator trying to remove another user',
        should: 'return error',
        actual: (result as { success: boolean }).success,
        expected: false,
      });

      assert({
        given: 'non-creator trying to remove another user',
        should: 'include creator error',
        actual: (result as { error?: string }).error?.toLowerCase().includes('creator'),
        expected: true,
      });
    });

    it('returns error when target is not an attendee', async () => {
      const event = createMockEvent({ createdById: 'user-123' });
      mockDb.query.calendarEvents.findFirst = vi.fn().mockResolvedValue(event);
      mockDb.query.eventAttendees.findFirst = vi.fn().mockResolvedValue(null);
      const input = { eventId: 'event-1', targetUserId: 'user-456' };

      const result = await calendarWriteTools.remove_calendar_attendee.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'target not an attendee',
        should: 'return error',
        actual: (result as { success: boolean }).success,
        expected: false,
      });

      assert({
        given: 'target not an attendee',
        should: 'include attendee error',
        actual: (result as { error?: string }).error?.toLowerCase().includes('attendee'),
        expected: true,
      });
    });

    it('returns error when trying to remove organizer', async () => {
      const event = createMockEvent({ createdById: 'user-123' });
      mockDb.query.calendarEvents.findFirst = vi.fn().mockResolvedValue(event);
      mockDb.query.eventAttendees.findFirst = vi.fn().mockResolvedValue({
        id: 'att-1',
        eventId: 'event-1',
        userId: 'user-456',
        isOrganizer: true,
      });
      const input = { eventId: 'event-1', targetUserId: 'user-456' };

      const result = await calendarWriteTools.remove_calendar_attendee.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'trying to remove organizer',
        should: 'return error',
        actual: (result as { success: boolean }).success,
        expected: false,
      });

      assert({
        given: 'trying to remove organizer',
        should: 'include organizer error',
        actual: (result as { error?: string }).error?.toLowerCase().includes('organizer'),
        expected: true,
      });
    });

    it('removes attendee when user is creator', async () => {
      const event = createMockEvent({ createdById: 'user-123' });
      mockDb.query.calendarEvents.findFirst = vi.fn().mockResolvedValue(event);
      mockDb.query.eventAttendees.findFirst = vi.fn().mockResolvedValue({
        id: 'att-1',
        eventId: 'event-1',
        userId: 'user-456',
        isOrganizer: false,
      });
      (mockDb.delete as ReturnType<typeof vi.fn>).mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });

      const input = { eventId: 'event-1', targetUserId: 'user-456' };

      const result = await calendarWriteTools.remove_calendar_attendee.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'creator removing attendee',
        should: 'return success',
        actual: (result as { success: boolean }).success,
        expected: true,
      });

      assert({
        given: 'successful removal',
        should: 'return removed user id',
        actual: (result as { data: { removedUserId: string } }).data.removedUserId,
        expected: 'user-456',
      });
    });

    it('allows user to remove themselves', async () => {
      const event = createMockEvent({ createdById: 'other-user' });
      mockDb.query.calendarEvents.findFirst = vi.fn().mockResolvedValue(event);
      mockDb.query.eventAttendees.findFirst = vi.fn().mockResolvedValue({
        id: 'att-1',
        eventId: 'event-1',
        userId: 'user-123',
        isOrganizer: false,
      });
      (mockDb.delete as ReturnType<typeof vi.fn>).mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      });

      const input = { eventId: 'event-1' }; // No targetUserId = remove self

      const result = await calendarWriteTools.remove_calendar_attendee.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'user removing themselves',
        should: 'return success',
        actual: (result as { success: boolean }).success,
        expected: true,
      });

      assert({
        given: 'self removal',
        should: 'include self in summary',
        actual: (result as { summary: string }).summary.toLowerCase().includes('you'),
        expected: true,
      });
    });
  });
});
