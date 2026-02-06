/**
 * Socket.IO utilities for broadcasting calendar events
 */

import { createSignedBroadcastHeaders } from '@pagespace/lib/broadcast-auth';
import { browserLoggers } from '@pagespace/lib/logger-browser';
import { isNodeEnvironment } from '@pagespace/lib/utils/environment';
import { maskIdentifier } from '@/lib/logging/mask';

const loggers = browserLoggers;

export type CalendarOperation = 'created' | 'updated' | 'deleted' | 'rsvp_updated';

export interface CalendarEventPayload {
  eventId: string;
  driveId: string | null;
  operation: CalendarOperation;
  userId: string; // User who triggered this event
  attendeeIds: string[]; // Users who should be notified
}

const realtimeLogger = loggers.realtime.child({ module: 'calendar-events' });

// Safely access environment variables
const getEnvVar = (name: string, fallback = '') => {
  if (isNodeEnvironment()) {
    return process.env[name] || fallback;
  }
  return fallback;
};

const verboseRealtimeLogging = getEnvVar('NODE_ENV') !== 'production';

/**
 * Broadcasts a calendar event to the realtime server
 *
 * Calendar events are broadcast to:
 * 1. Drive channel (if driveId is set) - for drive members viewing the drive calendar
 * 2. Individual user channels - for attendees viewing their personal calendar
 *
 * @param payload - The calendar event payload to broadcast
 */
export async function broadcastCalendarEvent(payload: CalendarEventPayload): Promise<void> {
  const realtimeUrl = getEnvVar('INTERNAL_REALTIME_URL');
  if (!realtimeUrl) {
    realtimeLogger.warn('Realtime URL not configured, skipping calendar event broadcast', {
      event: 'calendar',
      eventId: maskIdentifier(payload.eventId),
    });
    return;
  }

  try {
    // Broadcast to drive channel if this is a drive event
    if (payload.driveId) {
      const driveRequestBody = JSON.stringify({
        channelId: `drive:${payload.driveId}:calendar`,
        event: `calendar:${payload.operation}`,
        payload,
      });

      await fetch(`${realtimeUrl}/api/broadcast`, {
        method: 'POST',
        headers: createSignedBroadcastHeaders(driveRequestBody),
        body: driveRequestBody,
      });

      if (verboseRealtimeLogging) {
        realtimeLogger.debug('Calendar event broadcasted to drive', {
          operation: payload.operation,
          driveId: maskIdentifier(payload.driveId),
          eventId: maskIdentifier(payload.eventId),
        });
      }
    }

    // Broadcast to individual attendee channels (for personal calendar views)
    for (const attendeeId of payload.attendeeIds) {
      const userRequestBody = JSON.stringify({
        channelId: `user:${attendeeId}:calendar`,
        event: `calendar:${payload.operation}`,
        payload,
      });

      await fetch(`${realtimeUrl}/api/broadcast`, {
        method: 'POST',
        headers: createSignedBroadcastHeaders(userRequestBody),
        body: userRequestBody,
      });
    }

    if (verboseRealtimeLogging) {
      realtimeLogger.debug('Calendar event broadcasted to attendees', {
        operation: payload.operation,
        eventId: maskIdentifier(payload.eventId),
        attendeeCount: payload.attendeeIds.length,
      });
    }
  } catch (error) {
    realtimeLogger.error(
      'Failed to broadcast calendar event',
      error instanceof Error ? error : undefined,
      {
        event: 'calendar',
        operation: payload.operation,
        eventId: maskIdentifier(payload.eventId),
      }
    );
  }
}
