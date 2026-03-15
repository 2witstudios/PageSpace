import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  broadcastCalendarEvent,
  createCalendarEventPayload,
  type CalendarEventPayload,
  type CalendarOperation,
} from '../calendar-events';

// Mock all external dependencies
vi.mock('@pagespace/lib/broadcast-auth', () => ({
  createSignedBroadcastHeaders: vi.fn((body: string) => ({
    'Content-Type': 'application/json',
    'X-Broadcast-Signature': `sig-${body.length}`,
  })),
}));

vi.mock('@pagespace/lib/logger-browser', () => ({
  browserLoggers: {
    realtime: {
      child: vi.fn(() => ({
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      })),
    },
  },
}));

vi.mock('@pagespace/lib/utils/environment', () => ({
  isNodeEnvironment: vi.fn(() => true),
}));

vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id?: string | null) => id ? `${id.slice(0, 4)}...` : undefined),
}));

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

import { createSignedBroadcastHeaders } from '@pagespace/lib/broadcast-auth';

describe('calendar-events', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    mockFetch.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('createCalendarEventPayload', () => {
    it('should create a payload with all provided fields', () => {
      const payload = createCalendarEventPayload(
        'event-123',
        'drive-456',
        'created',
        'user-789',
        ['attendee-1', 'attendee-2']
      );

      expect(payload).toEqual({
        eventId: 'event-123',
        driveId: 'drive-456',
        operation: 'created',
        userId: 'user-789',
        attendeeIds: ['attendee-1', 'attendee-2'],
      });
    });

    it('should accept null driveId for personal calendar events', () => {
      const payload = createCalendarEventPayload('evt-1', null, 'updated', 'usr-1', []);

      expect(payload.driveId).toBeNull();
    });

    it('should accept an empty attendeeIds array', () => {
      const payload = createCalendarEventPayload('evt-1', 'drv-1', 'deleted', 'usr-1', []);

      expect(payload.attendeeIds).toEqual([]);
    });

    it('should create payload for each CalendarOperation type', () => {
      const operations: CalendarOperation[] = ['created', 'updated', 'deleted', 'rsvp_updated'];

      for (const operation of operations) {
        const payload = createCalendarEventPayload('e1', 'd1', operation, 'u1', []);
        expect(payload.operation).toBe(operation);
      }
    });
  });

  describe('broadcastCalendarEvent', () => {
    const basePayload: CalendarEventPayload = {
      eventId: 'event-abc',
      driveId: 'drive-xyz',
      operation: 'created',
      userId: 'user-111',
      attendeeIds: ['attendee-222', 'attendee-333'],
    };

    describe('when INTERNAL_REALTIME_URL is not configured', () => {
      it('should return early without calling fetch', async () => {
        delete process.env.INTERNAL_REALTIME_URL;

        await broadcastCalendarEvent(basePayload);

        expect(mockFetch).not.toHaveBeenCalled();
      });

      it('should not throw when realtime URL is missing', async () => {
        delete process.env.INTERNAL_REALTIME_URL;

        await expect(broadcastCalendarEvent(basePayload)).resolves.not.toThrow();
      });
    });

    describe('when INTERNAL_REALTIME_URL is configured', () => {
      beforeEach(() => {
        process.env.INTERNAL_REALTIME_URL = 'http://realtime:3001';
      });

      it('should broadcast to the drive channel when driveId is set', async () => {
        await broadcastCalendarEvent(basePayload);

        const driveBroadcastCall = mockFetch.mock.calls.find(
          (call) => call[0] === 'http://realtime:3001/api/broadcast' &&
            JSON.parse(call[1].body).channelId === 'drive:drive-xyz:calendar'
        );
        expect(driveBroadcastCall).toBeDefined();
      });

      it('should set the correct event name for the drive channel', async () => {
        await broadcastCalendarEvent(basePayload);

        const driveCall = mockFetch.mock.calls.find(
          (call) => JSON.parse(call[1].body).channelId === 'drive:drive-xyz:calendar'
        );
        expect(JSON.parse(driveCall[1].body).event).toBe('calendar:created');
      });

      it('should broadcast to each attendee channel', async () => {
        await broadcastCalendarEvent(basePayload);

        const attendee1Call = mockFetch.mock.calls.find(
          (call) => JSON.parse(call[1].body)?.channelId === 'user:attendee-222:calendar'
        );
        const attendee2Call = mockFetch.mock.calls.find(
          (call) => JSON.parse(call[1].body)?.channelId === 'user:attendee-333:calendar'
        );

        expect(attendee1Call).toBeDefined();
        expect(attendee2Call).toBeDefined();
      });

      it('should make 3 fetch calls total: 1 drive + 2 attendees', async () => {
        await broadcastCalendarEvent(basePayload);
        expect(mockFetch).toHaveBeenCalledTimes(3);
      });

      it('should not broadcast to drive channel when driveId is null', async () => {
        const personalPayload = { ...basePayload, driveId: null };

        await broadcastCalendarEvent(personalPayload);

        const driveCall = mockFetch.mock.calls.find(
          (call) => JSON.parse(call[1].body)?.channelId?.startsWith('drive:')
        );
        expect(driveCall).toBeUndefined();
      });

      it('should make 2 fetch calls when driveId is null (one per attendee)', async () => {
        const personalPayload = { ...basePayload, driveId: null };
        await broadcastCalendarEvent(personalPayload);
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      it('should make 0 fetch calls when driveId is null and attendeeIds is empty', async () => {
        const noAudiencePayload = { ...basePayload, driveId: null, attendeeIds: [] };
        await broadcastCalendarEvent(noAudiencePayload);
        expect(mockFetch).toHaveBeenCalledTimes(0);
      });

      it('should use POST method for all broadcast calls', async () => {
        await broadcastCalendarEvent(basePayload);

        for (const call of mockFetch.mock.calls) {
          expect(call[1].method).toBe('POST');
        }
      });

      it('should include signed broadcast headers in requests', async () => {
        await broadcastCalendarEvent(basePayload);

        expect(createSignedBroadcastHeaders).toHaveBeenCalled();
        for (const call of mockFetch.mock.calls) {
          expect(call[1].headers).toBeDefined();
        }
      });

      it('should include the full payload in the request body', async () => {
        await broadcastCalendarEvent(basePayload);

        const driveCall = mockFetch.mock.calls.find(
          (call) => JSON.parse(call[1].body)?.channelId === 'drive:drive-xyz:calendar'
        );
        const body = JSON.parse(driveCall[1].body);
        expect(body.payload).toEqual(basePayload);
      });

      it('should not throw when fetch fails (graceful degradation)', async () => {
        mockFetch.mockRejectedValue(new Error('Network error'));

        await expect(broadcastCalendarEvent(basePayload)).resolves.not.toThrow();
      });

      it('should broadcast the correct event type for rsvp_updated operation', async () => {
        const rsvpPayload = { ...basePayload, operation: 'rsvp_updated' as CalendarOperation };
        await broadcastCalendarEvent(rsvpPayload);

        const driveCall = mockFetch.mock.calls.find(
          (call) => JSON.parse(call[1].body)?.channelId === 'drive:drive-xyz:calendar'
        );
        expect(JSON.parse(driveCall[1].body).event).toBe('calendar:rsvp_updated');
      });

      it('should use the correct attendee channel format user:<id>:calendar', async () => {
        const singleAttendeePayload = { ...basePayload, driveId: null, attendeeIds: ['user-999'] };
        await broadcastCalendarEvent(singleAttendeePayload);

        const call = mockFetch.mock.calls[0];
        const body = JSON.parse(call[1].body);
        expect(body.channelId).toBe('user:user-999:calendar');
      });

      it('should target the /api/broadcast endpoint on the realtime URL', async () => {
        await broadcastCalendarEvent(basePayload);

        for (const call of mockFetch.mock.calls) {
          expect(call[0]).toBe('http://realtime:3001/api/broadcast');
        }
      });
    });
  });
});
