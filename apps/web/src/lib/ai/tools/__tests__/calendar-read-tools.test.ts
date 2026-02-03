import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assert } from './riteway';

// Mock database and dependencies
vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    query: {
      calendarEvents: { findFirst: vi.fn(), findMany: vi.fn() },
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
  },
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  gte: vi.fn(),
  lte: vi.fn(),
  inArray: vi.fn(),
  isNull: vi.fn(),
  desc: vi.fn(),
  not: vi.fn(),
}));

vi.mock('@pagespace/lib', () => ({
  isUserDriveMember: vi.fn(),
  getDriveIdsForUser: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
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

vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id) => `***${id?.slice(-4) || ''}`),
}));

import { calendarReadTools } from '../calendar-read-tools';
import { db } from '@pagespace/db';
import { isUserDriveMember, getDriveIdsForUser } from '@pagespace/lib';
import type { ToolExecutionContext } from '../../core';

const mockDb = vi.mocked(db);
const mockIsUserDriveMember = vi.mocked(isUserDriveMember);
const mockGetDriveIdsForUser = vi.mocked(getDriveIdsForUser);

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
  createdBy: { id: 'user-123', name: 'Test User', image: null },
  attendees: [],
  page: null,
  drive: { id: 'drive-1', name: 'Test Drive', slug: 'test-drive' },
  ...overrides,
});

const createAuthContext = (userId = 'user-123') => ({
  toolCallId: '1',
  messages: [],
  experimental_context: { userId } as ToolExecutionContext,
});

describe('calendar-read-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('list_calendar_events', () => {
    it('has correct tool definition', () => {
      assert({
        given: 'list_calendar_events tool',
        should: 'be defined',
        actual: calendarReadTools.list_calendar_events !== undefined,
        expected: true,
      });

      assert({
        given: 'list_calendar_events tool',
        should: 'have description mentioning calendar events',
        actual: calendarReadTools.list_calendar_events.description?.toLowerCase().includes('calendar'),
        expected: true,
      });
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };
      const input = {
        startDate: '2024-01-01',
        endDate: '2024-01-31',
      };

      await expect(
        calendarReadTools.list_calendar_events.execute!(input, context)
      ).rejects.toThrow('User authentication required');
    });

    it('returns error for invalid date format', async () => {
      const input = {
        startDate: 'invalid-date',
        endDate: '2024-01-31',
      };

      const result = await calendarReadTools.list_calendar_events.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'invalid startDate',
        should: 'return error',
        actual: (result as { success: boolean }).success,
        expected: false,
      });

      assert({
        given: 'invalid startDate',
        should: 'include error message about date format',
        actual: (result as { error?: string }).error?.toLowerCase().includes('date'),
        expected: true,
      });
    });

    it('returns error when endDate is before startDate', async () => {
      const input = {
        startDate: '2024-01-31',
        endDate: '2024-01-01',
      };

      const result = await calendarReadTools.list_calendar_events.execute!(
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

    describe('drive context', () => {
      it('returns error when driveId missing for drive context', async () => {
        const input = {
          startDate: '2024-01-01',
          endDate: '2024-01-31',
          context: 'drive' as const,
        };

        const result = await calendarReadTools.list_calendar_events.execute!(
          input,
          createAuthContext()
        );

        assert({
          given: 'drive context without driveId',
          should: 'return error',
          actual: (result as { success: boolean }).success,
          expected: false,
        });

        assert({
          given: 'drive context without driveId',
          should: 'include error message about driveId',
          actual: (result as { error?: string }).error?.toLowerCase().includes('driveid'),
          expected: true,
        });
      });

      it('returns error when user lacks drive access', async () => {
        mockIsUserDriveMember.mockResolvedValue(false);

        const input = {
          startDate: '2024-01-01',
          endDate: '2024-01-31',
          context: 'drive' as const,
          driveId: 'drive-1',
        };

        const result = await calendarReadTools.list_calendar_events.execute!(
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
          should: 'include error message about access',
          actual: (result as { error?: string }).error?.toLowerCase().includes('access'),
          expected: true,
        });
      });

      it('returns events for drive context with access', async () => {
        mockIsUserDriveMember.mockResolvedValue(true);
        // Mock attendee events query
        (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([]),
            }),
          }),
        });
        mockDb.query.calendarEvents.findMany = vi.fn().mockResolvedValue([
          createMockEvent(),
        ]);

        const input = {
          startDate: '2024-01-01',
          endDate: '2024-01-31',
          context: 'drive' as const,
          driveId: 'drive-1',
        };

        const result = await calendarReadTools.list_calendar_events.execute!(
          input,
          createAuthContext()
        );

        assert({
          given: 'drive context with access',
          should: 'return success',
          actual: (result as { success: boolean }).success,
          expected: true,
        });

        assert({
          given: 'drive with events',
          should: 'return events array',
          actual: Array.isArray((result as { data: { events: unknown[] } }).data.events),
          expected: true,
        });
      });
    });

    describe('user context', () => {
      it('returns empty array when no events found', async () => {
        mockGetDriveIdsForUser.mockResolvedValue([]);
        // Mock attendee events query
        (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        });

        const input = {
          startDate: '2024-01-01',
          endDate: '2024-01-31',
          context: 'user' as const,
          includePersonal: false,
        };

        const result = await calendarReadTools.list_calendar_events.execute!(
          input,
          createAuthContext()
        );

        assert({
          given: 'user with no accessible events',
          should: 'return success',
          actual: (result as { success: boolean }).success,
          expected: true,
        });

        assert({
          given: 'user with no accessible events',
          should: 'return empty events array',
          actual: (result as { data: { events: unknown[] } }).data.events,
          expected: [],
        });
      });

      it('returns events from accessible drives', async () => {
        mockGetDriveIdsForUser.mockResolvedValue(['drive-1', 'drive-2']);
        // Mock attendee events query
        (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        });
        mockDb.query.calendarEvents.findMany = vi.fn().mockResolvedValue([
          createMockEvent(),
          createMockEvent({ id: 'event-2', title: 'Event 2', driveId: 'drive-2' }),
        ]);

        const input = {
          startDate: '2024-01-01',
          endDate: '2024-01-31',
          context: 'user' as const,
        };

        const result = await calendarReadTools.list_calendar_events.execute!(
          input,
          createAuthContext()
        );

        assert({
          given: 'user with multiple accessible drives',
          should: 'return success',
          actual: (result as { success: boolean }).success,
          expected: true,
        });

        assert({
          given: 'user with events in accessible drives',
          should: 'return events',
          actual: (result as { data: { events: unknown[] } }).data.events.length,
          expected: 2,
        });
      });
    });
  });

  describe('get_calendar_event', () => {
    it('has correct tool definition', () => {
      assert({
        given: 'get_calendar_event tool',
        should: 'be defined',
        actual: calendarReadTools.get_calendar_event !== undefined,
        expected: true,
      });
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };
      const input = { eventId: 'event-1' };

      await expect(
        calendarReadTools.get_calendar_event.execute!(input, context)
      ).rejects.toThrow('User authentication required');
    });

    it('returns error when event not found', async () => {
      mockDb.query.calendarEvents.findFirst = vi.fn().mockResolvedValue(null);
      const input = { eventId: 'non-existent' };

      const result = await calendarReadTools.get_calendar_event.execute!(
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
        should: 'include error message',
        actual: (result as { error?: string }).error?.toLowerCase().includes('not found'),
        expected: true,
      });
    });

    it('returns error when user lacks access to event', async () => {
      const event = createMockEvent({
        createdById: 'other-user',
        visibility: 'PRIVATE',
      });
      mockDb.query.calendarEvents.findFirst = vi.fn().mockResolvedValue(event);
      mockDb.query.eventAttendees.findFirst = vi.fn().mockResolvedValue(null);
      const input = { eventId: 'event-1' };

      const result = await calendarReadTools.get_calendar_event.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'private event owned by another user',
        should: 'return error',
        actual: (result as { success: boolean }).success,
        expected: false,
      });

      assert({
        given: 'user without access',
        should: 'include permission error',
        actual: (result as { error?: string }).error?.toLowerCase().includes('permission'),
        expected: true,
      });
    });

    it('returns event when user is the creator', async () => {
      const event = createMockEvent({
        createdById: 'user-123',
        attendees: [
          { id: 'att-1', status: 'ACCEPTED', isOrganizer: true, isOptional: false, user: { id: 'user-123', name: 'Test User', image: null } },
        ],
      });
      mockDb.query.calendarEvents.findFirst = vi.fn().mockResolvedValue(event);
      const input = { eventId: 'event-1', includeAttendees: true };

      const result = await calendarReadTools.get_calendar_event.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'event created by user',
        should: 'return success',
        actual: (result as { success: boolean }).success,
        expected: true,
      });

      assert({
        given: 'includeAttendees=true',
        should: 'include attendees in data',
        actual: Array.isArray((result as { data: { event: { attendees: unknown[] } } }).data.event.attendees),
        expected: true,
      });
    });

    it('returns event when user is an attendee', async () => {
      const event = createMockEvent({
        createdById: 'other-user',
        visibility: 'ATTENDEES_ONLY',
      });
      mockDb.query.calendarEvents.findFirst = vi.fn().mockResolvedValue(event);
      mockDb.query.eventAttendees.findFirst = vi.fn().mockResolvedValue({
        id: 'att-1',
        eventId: 'event-1',
        userId: 'user-123',
        status: 'PENDING',
      });
      const input = { eventId: 'event-1' };

      const result = await calendarReadTools.get_calendar_event.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'user is an attendee of ATTENDEES_ONLY event',
        should: 'return success',
        actual: (result as { success: boolean }).success,
        expected: true,
      });
    });

    it('returns event when user is drive member for DRIVE visibility', async () => {
      const event = createMockEvent({
        createdById: 'other-user',
        visibility: 'DRIVE',
        driveId: 'drive-1',
      });
      mockDb.query.calendarEvents.findFirst = vi.fn().mockResolvedValue(event);
      mockDb.query.eventAttendees.findFirst = vi.fn().mockResolvedValue(null);
      mockIsUserDriveMember.mockResolvedValue(true);
      const input = { eventId: 'event-1' };

      const result = await calendarReadTools.get_calendar_event.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'user is drive member for DRIVE visibility event',
        should: 'return success',
        actual: (result as { success: boolean }).success,
        expected: true,
      });
    });
  });

  describe('check_calendar_availability', () => {
    it('has correct tool definition', () => {
      assert({
        given: 'check_calendar_availability tool',
        should: 'be defined',
        actual: calendarReadTools.check_calendar_availability !== undefined,
        expected: true,
      });

      assert({
        given: 'check_calendar_availability tool',
        should: 'have description about availability',
        actual: calendarReadTools.check_calendar_availability.description?.toLowerCase().includes('available'),
        expected: true,
      });
    });

    it('requires user authentication', async () => {
      const context = { toolCallId: '1', messages: [], experimental_context: {} };
      const input = {
        startDate: '2024-01-15',
        endDate: '2024-01-16',
        durationMinutes: 60,
      };

      await expect(
        calendarReadTools.check_calendar_availability.execute!(input, context)
      ).rejects.toThrow('User authentication required');
    });

    it('returns error for invalid date format', async () => {
      const input = {
        startDate: 'invalid',
        endDate: '2024-01-16',
        durationMinutes: 60,
      };

      const result = await calendarReadTools.check_calendar_availability.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'invalid date format',
        should: 'return error',
        actual: (result as { success: boolean }).success,
        expected: false,
      });
    });

    it('returns error when endDate is before startDate', async () => {
      const input = {
        startDate: '2024-01-20',
        endDate: '2024-01-15',
        durationMinutes: 60,
      };

      const result = await calendarReadTools.check_calendar_availability.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'endDate before startDate',
        should: 'return error',
        actual: (result as { success: boolean }).success,
        expected: false,
      });
    });

    it('returns error when user lacks drive access', async () => {
      mockIsUserDriveMember.mockResolvedValue(false);

      const input = {
        startDate: '2024-01-15',
        endDate: '2024-01-16',
        durationMinutes: 60,
        driveId: 'drive-1',
      };

      const result = await calendarReadTools.check_calendar_availability.execute!(
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

    it('returns free slots when calendar is empty', async () => {
      mockGetDriveIdsForUser.mockResolvedValue([]);
      // Mock attendee events query
      (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });
      mockDb.query.calendarEvents.findMany = vi.fn().mockResolvedValue([]);

      const input = {
        startDate: '2024-01-15T09:00:00Z',
        endDate: '2024-01-15T17:00:00Z',
        durationMinutes: 60,
        workingHoursStart: 9,
        workingHoursEnd: 17,
      };

      const result = await calendarReadTools.check_calendar_availability.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'empty calendar',
        should: 'return success',
        actual: (result as { success: boolean }).success,
        expected: true,
      });

      assert({
        given: 'empty calendar',
        should: 'return free slots',
        actual: (result as { data: { freeSlots: unknown[] } }).data.freeSlots.length > 0,
        expected: true,
      });
    });

    it('returns no slots when calendar is fully booked', async () => {
      mockGetDriveIdsForUser.mockResolvedValue([]);
      // Mock attendee events query
      (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });
      // One long event covering the entire search window
      mockDb.query.calendarEvents.findMany = vi.fn().mockResolvedValue([
        {
          id: 'event-1',
          title: 'All-day meeting',
          startAt: new Date('2024-01-15T09:00:00Z'),
          endAt: new Date('2024-01-15T17:00:00Z'),
          allDay: false,
        },
      ]);

      const input = {
        startDate: '2024-01-15T09:00:00Z',
        endDate: '2024-01-15T17:00:00Z',
        durationMinutes: 60,
        workingHoursStart: 9,
        workingHoursEnd: 17,
      };

      const result = await calendarReadTools.check_calendar_availability.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'fully booked calendar',
        should: 'return success',
        actual: (result as { success: boolean }).success,
        expected: true,
      });

      assert({
        given: 'fully booked calendar',
        should: 'return no free slots',
        actual: (result as { data: { freeSlots: unknown[] } }).data.freeSlots.length,
        expected: 0,
      });
    });

    it('finds gaps between meetings', async () => {
      mockGetDriveIdsForUser.mockResolvedValue([]);
      (mockDb.select as ReturnType<typeof vi.fn>).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });
      // Two meetings with a 2-hour gap
      mockDb.query.calendarEvents.findMany = vi.fn().mockResolvedValue([
        {
          id: 'event-1',
          title: 'Morning meeting',
          startAt: new Date('2024-01-15T09:00:00Z'),
          endAt: new Date('2024-01-15T10:00:00Z'),
          allDay: false,
        },
        {
          id: 'event-2',
          title: 'Afternoon meeting',
          startAt: new Date('2024-01-15T14:00:00Z'),
          endAt: new Date('2024-01-15T15:00:00Z'),
          allDay: false,
        },
      ]);

      const input = {
        startDate: '2024-01-15T09:00:00Z',
        endDate: '2024-01-15T17:00:00Z',
        durationMinutes: 60,
        workingHoursStart: 9,
        workingHoursEnd: 17,
      };

      const result = await calendarReadTools.check_calendar_availability.execute!(
        input,
        createAuthContext()
      );

      assert({
        given: 'calendar with gaps between meetings',
        should: 'return success',
        actual: (result as { success: boolean }).success,
        expected: true,
      });

      assert({
        given: 'calendar with gaps',
        should: 'find free slots',
        actual: (result as { data: { freeSlots: unknown[] } }).data.freeSlots.length > 0,
        expected: true,
      });
    });
  });
});
