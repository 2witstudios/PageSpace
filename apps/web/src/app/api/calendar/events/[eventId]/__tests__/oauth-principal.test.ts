/**
 * Phase 2 cluster test — calendar (inline scope branch).
 *
 * `canAccessEvent` withholds the owning user's IDENTITY powers (attendee of
 * someone else's personal event) from a drive-scoped credential inline. Written
 * against `isScopedMCPAuth`, an OAuth drive grant fell through to the
 * attendee check and read another user's personal event. Real scope/principal
 * helpers; authentication and DB stubbed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      calendarEvents: { findFirst: vi.fn() },
      eventAttendees: { findFirst: vi.fn() },
    },
  },
}));
vi.mock('@pagespace/lib/services/calendar-event-drive-service', () => ({
  isUserMemberOfAnyEventDrive: vi.fn().mockResolvedValue(true),
  getAllDriveIdsForEvent: vi.fn().mockResolvedValue([]),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  logSecurityEvent: vi.fn(),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@/lib/websocket/calendar-events', () => ({ broadcastCalendarEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/integrations/google-calendar/push-service', () => ({
  pushEventUpdateToGoogle: vi.fn().mockResolvedValue(undefined),
  pushEventDeleteToGoogle: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, authenticateRequestWithOptions: vi.fn() };
});

import { GET } from '../route';
import { db } from '@pagespace/db/db';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { PARITY_USER_ID, mcpDriveKey, oauthDriveGrant, profileOnlyGrant } from '@/lib/auth/__tests__/oauth-principal-fixture';

const DRIVE_X = 'drivex';
const DRIVE_Y = 'drivey';
const OTHER_USER = 'someone-else';

function event(overrides: { driveId: string | null; createdById: string; visibility?: 'DRIVE' | 'ATTENDEES_ONLY' | 'PRIVATE' }) {
  return { id: 'evt', title: 'Event', isTrashed: false, visibility: 'ATTENDEES_ONLY', ...overrides };
}

const get = () => GET(new Request('https://example.com/api/calendar/events/evt'), { params: Promise.resolve({ eventId: 'evt' }) });

beforeEach(() => {
  vi.clearAllMocks();
  // The owning user IS an attendee of every event below.
  vi.mocked(db.query.eventAttendees.findFirst).mockResolvedValue({ eventId: 'evt', userId: PARITY_USER_ID } as never);
});

describe('GET /api/calendar/events/[eventId] — OAuth principals', () => {
  it("denies a drive:X OAuth grant another user's personal event the owning user attends", async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(oauthDriveGrant(DRIVE_X, 'admin'));
    vi.mocked(db.query.calendarEvents.findFirst).mockResolvedValue(event({ driveId: null, createdById: OTHER_USER }) as never);
    const res = await get();
    expect(res.status).toBe(403);
  });

  it('gives the same answer as a drive-scoped mcp_ key (parity)', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mcpDriveKey(DRIVE_X));
    vi.mocked(db.query.calendarEvents.findFirst).mockResolvedValue(event({ driveId: null, createdById: OTHER_USER }) as never);
    const res = await get();
    expect(res.status).toBe(403);
  });

  it('admits the grant to an event in X the user attends (positive control)', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(oauthDriveGrant(DRIVE_X, 'admin'));
    vi.mocked(db.query.calendarEvents.findFirst).mockResolvedValue(event({ driveId: DRIVE_X, createdById: OTHER_USER }) as never);
    const res = await get();
    expect(res.status).toBe(200);
  });

  it('denies the grant an event in drive Y the user attends', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(oauthDriveGrant(DRIVE_X, 'admin'));
    vi.mocked(db.query.calendarEvents.findFirst).mockResolvedValue(event({ driveId: DRIVE_Y, createdById: OTHER_USER }) as never);
    const res = await get();
    expect(res.status).toBe(403);
  });

  it("denies a profile-only token drive events and other users' personal events", async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(profileOnlyGrant());
    for (const e of [event({ driveId: DRIVE_X, createdById: OTHER_USER }), event({ driveId: null, createdById: OTHER_USER })]) {
      vi.mocked(db.query.calendarEvents.findFirst).mockResolvedValue(e as never);
      const res = await get();
      expect(res.status).toBe(403);
    }
  });
});
