/**
 * Contract tests for DELETE /api/calendar/events/[eventId]/attendees
 *
 * Regression coverage for #1775: the route used to default the removal
 * target to the caller when `?userId=` was absent, so removing attendee B
 * as caller A would silently remove A instead. The target must now be
 * explicit and required.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';

vi.mock('@pagespace/db/db', () => {
  const db = {
    query: {
      calendarEvents: { findFirst: vi.fn() },
      eventAttendees: { findFirst: vi.fn(), findMany: vi.fn() },
    },
    delete: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
  };
  return { db };
});

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ type: 'eq', col, val })),
  and: vi.fn((...args: unknown[]) => args),
}));

vi.mock('@pagespace/db/schema/calendar', () => ({
  calendarEvents: {
    id: 'calendarEvents.id',
    driveId: 'calendarEvents.driveId',
    createdById: 'calendarEvents.createdById',
    isTrashed: 'calendarEvents.isTrashed',
  },
  eventAttendees: {
    eventId: 'eventAttendees.eventId',
    userId: 'eventAttendees.userId',
  },
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/services/calendar-event-drive-service', () => ({
  getAllMemberUserIdsForEvent: vi.fn(),
  isUserMemberOfAnyEventDrive: vi.fn(),
  getAllDriveIdsForEvent: vi.fn(),
}));

vi.mock('../../../../../../../lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) =>
    typeof result === 'object' && result !== null && 'error' in result,
  ),
  getAllowedDriveIds: vi.fn(() => []),
}));

vi.mock('../../../../../../../lib/websocket/calendar-events', () => ({
  broadcastCalendarEvent: vi.fn().mockResolvedValue(undefined),
}));

import { DELETE } from '../route';
import { db } from '@pagespace/db/db';
import { authenticateRequestWithOptions } from '../../../../../../../lib/auth';

const CALLER_ID = 'user_caller_A';
const TARGET_ID = 'user_target_B';
const EVENT_ID = 'event_abc';

const mockAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'sid',
  role: 'user',
  adminRoleVersion: 0,
});

function stubEvent(overrides: Partial<{ driveId: string | null; createdById: string }> = {}) {
  (db.query.calendarEvents.findFirst as Mock).mockResolvedValue({
    id: EVENT_ID,
    driveId: null,
    createdById: CALLER_ID,
    isTrashed: false,
    visibility: 'DRIVE',
    ...overrides,
  });
}

function stubAttendee(userId: string, overrides: Partial<{ isOrganizer: boolean }> = {}) {
  (db.query.eventAttendees.findFirst as Mock).mockResolvedValue({
    eventId: EVENT_ID,
    userId,
    isOrganizer: false,
    ...overrides,
  });
}

function makeRequest(url: string): Request {
  return new Request(url, { method: 'DELETE' });
}

const ctx = () => ({ params: Promise.resolve({ eventId: EVENT_ID }) });

beforeEach(() => {
  vi.clearAllMocks();
  (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuth(CALLER_ID));
});

describe('DELETE /api/calendar/events/[eventId]/attendees', () => {
  it('400: rejects the request when the userId query param is missing (no silent fallback to caller)', async () => {
    stubEvent({ createdById: CALLER_ID });

    const res = await DELETE(
      makeRequest(`http://host/api/calendar/events/${EVENT_ID}/attendees`),
      ctx(),
    );

    expect(res.status).toBe(400);
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('200: removes the specified attendee (target B), not the caller (A)', async () => {
    stubEvent({ createdById: CALLER_ID });
    stubAttendee(TARGET_ID);

    const res = await DELETE(
      makeRequest(`http://host/api/calendar/events/${EVENT_ID}/attendees?userId=${TARGET_ID}`),
      ctx(),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    // The delete query must have been scoped to the target, not the caller.
    const deleteWhereCall = (db.delete as Mock).mock.results[0].value.where as Mock;
    expect(deleteWhereCall).toHaveBeenCalled();
    const whereArgs = deleteWhereCall.mock.calls[0][0];
    expect(JSON.stringify(whereArgs)).toContain(TARGET_ID);
    expect(JSON.stringify(whereArgs)).not.toContain(CALLER_ID);
  });

  it('404: returns not found when the target is not an attendee', async () => {
    stubEvent({ createdById: CALLER_ID });
    (db.query.eventAttendees.findFirst as Mock).mockResolvedValue(undefined);

    const res = await DELETE(
      makeRequest(`http://host/api/calendar/events/${EVENT_ID}/attendees?userId=${TARGET_ID}`),
      ctx(),
    );

    expect(res.status).toBe(404);
  });
});
