/**
 * Contract tests for GET/POST/DELETE /api/calendar/events/[eventId]/drives
 *
 * Covers:
 * - GET: lists drives, 404 on missing event
 * - POST: shares event with a new drive, 400 on home drive, 409 on duplicate, 400 on personal event
 * - DELETE: unshares event from a drive, 400 on home drive, 404 when not shared
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
vi.mock('@pagespace/db/db', () => {
  const db = {
    select: vi.fn(),
  };
  return { db };
});

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ({ type: 'eq', val })),
  and: vi.fn((...args: unknown[]) => args),
}));

vi.mock('@pagespace/db/schema/calendar', () => ({
  calendarEvents: {
    id: 'calendarEvents.id',
    driveId: 'calendarEvents.driveId',
    createdById: 'calendarEvents.createdById',
    isTrashed: 'calendarEvents.isTrashed',
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

vi.mock('@/lib/auth/request-auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
}));
vi.mock('@/lib/auth/auth-core', () => ({
  isAuthError: vi.fn((result: unknown) =>
    typeof result === 'object' && result !== null && 'error' in result,
  ),
  checkMCPDriveScope: vi.fn(() => null),
}));

vi.mock('@pagespace/lib/services/calendar-event-drive-service', () => ({
  isUserMemberOfAnyEventDrive: vi.fn(),
  shareEventWithDrive: vi.fn(),
  unshareEventFromDrive: vi.fn(),
  listEventDrives: vi.fn(),
}));

import { GET, POST, DELETE } from '../route';
import { db } from '@pagespace/db/db';
import {
  isUserMemberOfAnyEventDrive,
  shareEventWithDrive,
  unshareEventFromDrive,
  listEventDrives,
} from '@pagespace/lib/services/calendar-event-drive-service';
import type { SessionAuthResult } from '@/lib/auth/auth-types';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { checkMCPDriveScope } from '@/lib/auth/auth-core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_ID = 'user_actor';
const EVENT_ID = 'event_abc';
const HOME_DRIVE_ID = 'drive_home';
const OTHER_DRIVE_ID = 'drive_other';

const mockAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'sid',
  role: 'user',
  adminRoleVersion: 0,
});

function makeRequest(method: string, url: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function stubEventSelect(event: { driveId: string | null; createdById?: string } | null) {
  const row = event ? { id: EVENT_ID, createdById: USER_ID, ...event } : null;
  (db.select as Mock).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(row ? [row] : []),
      }),
    }),
  });
}

// ---------------------------------------------------------------------------
// beforeEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  (authenticateRequestWithOptions as Mock).mockResolvedValue(mockAuth(USER_ID));
  (checkMCPDriveScope as Mock).mockReturnValue(null);
  (isUserMemberOfAnyEventDrive as Mock).mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// GET /api/calendar/events/[eventId]/drives
// ---------------------------------------------------------------------------

describe('GET', () => {
  it('returns drive list for a found event', async () => {
    stubEventSelect({ driveId: HOME_DRIVE_ID });
    (listEventDrives as Mock).mockResolvedValue([
      { driveId: HOME_DRIVE_ID, driveName: 'Home', driveSlug: 'home', isHome: true, sharedAt: null, sharedBy: null },
    ]);

    const res = await GET(
      makeRequest('GET', `http://host/api/calendar/events/${EVENT_ID}/drives`),
      { params: Promise.resolve({ eventId: EVENT_ID }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.drives).toHaveLength(1);
    expect(body.drives[0].isHome).toBe(true);
  });

  it('returns 404 when event does not exist', async () => {
    stubEventSelect(null);

    const res = await GET(
      makeRequest('GET', `http://host/api/calendar/events/missing/drives`),
      { params: Promise.resolve({ eventId: 'missing' }) },
    );

    expect(res.status).toBe(404);
  });

  it('returns 401 when not authenticated', async () => {
    (authenticateRequestWithOptions as Mock).mockResolvedValue({
      error: new Response('Unauthorized', { status: 401 }),
    });

    const res = await GET(
      makeRequest('GET', `http://host/api/calendar/events/${EVENT_ID}/drives`),
      { params: Promise.resolve({ eventId: EVENT_ID }) },
    );

    expect(res.status).toBe(401);
  });

  it('returns 403 when caller cannot access the event', async () => {
    stubEventSelect({ driveId: HOME_DRIVE_ID, createdById: 'other_user' });
    (isUserMemberOfAnyEventDrive as Mock).mockResolvedValue(false);

    const res = await GET(
      makeRequest('GET', `http://host/api/calendar/events/${EVENT_ID}/drives`),
      { params: Promise.resolve({ eventId: EVENT_ID }) },
    );

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST /api/calendar/events/[eventId]/drives
// ---------------------------------------------------------------------------

describe('POST', () => {
  it('201: shares event with a new drive', async () => {
    stubEventSelect({ driveId: HOME_DRIVE_ID });
    (shareEventWithDrive as Mock).mockResolvedValue({
      ok: true,
      status: 201,
      row: { id: 'ced_1', eventId: EVENT_ID, driveId: OTHER_DRIVE_ID, sharedBy: USER_ID, sharedAt: new Date() },
    });

    const res = await POST(
      makeRequest('POST', `http://host/api/calendar/events/${EVENT_ID}/drives`, { driveId: OTHER_DRIVE_ID }),
      { params: Promise.resolve({ eventId: EVENT_ID }) },
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.row.driveId).toBe(OTHER_DRIVE_ID);
  });

  it('400: rejects sharing with the home drive', async () => {
    stubEventSelect({ driveId: HOME_DRIVE_ID });
    (shareEventWithDrive as Mock).mockResolvedValue({
      ok: false,
      status: 400,
      error: 'Cannot share event with its home drive',
    });

    const res = await POST(
      makeRequest('POST', `http://host/api/calendar/events/${EVENT_ID}/drives`, { driveId: HOME_DRIVE_ID }),
      { params: Promise.resolve({ eventId: EVENT_ID }) },
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/home drive/i);
  });

  it('400: rejects sharing a personal event', async () => {
    stubEventSelect({ driveId: null });
    (shareEventWithDrive as Mock).mockResolvedValue({
      ok: false,
      status: 400,
      error: 'Personal events cannot be shared with drives',
    });

    const res = await POST(
      makeRequest('POST', `http://host/api/calendar/events/${EVENT_ID}/drives`, { driveId: OTHER_DRIVE_ID }),
      { params: Promise.resolve({ eventId: EVENT_ID }) },
    );

    expect(res.status).toBe(400);
  });

  it('409: returns conflict when already shared', async () => {
    stubEventSelect({ driveId: HOME_DRIVE_ID });
    (shareEventWithDrive as Mock).mockResolvedValue({
      ok: false,
      status: 409,
      error: 'Event is already shared with this drive',
    });

    const res = await POST(
      makeRequest('POST', `http://host/api/calendar/events/${EVENT_ID}/drives`, { driveId: OTHER_DRIVE_ID }),
      { params: Promise.resolve({ eventId: EVENT_ID }) },
    );

    expect(res.status).toBe(409);
  });

  it('400: rejects missing body driveId', async () => {
    stubEventSelect({ driveId: HOME_DRIVE_ID });

    const res = await POST(
      makeRequest('POST', `http://host/api/calendar/events/${EVENT_ID}/drives`, {}),
      { params: Promise.resolve({ eventId: EVENT_ID }) },
    );

    expect(res.status).toBe(400);
  });

  it('404: returns not found when event is missing', async () => {
    stubEventSelect(null);

    const res = await POST(
      makeRequest('POST', `http://host/api/calendar/events/missing/drives`, { driveId: OTHER_DRIVE_ID }),
      { params: Promise.resolve({ eventId: 'missing' }) },
    );

    expect(res.status).toBe(404);
  });

  it('403: returns forbidden when caller lacks permission', async () => {
    stubEventSelect({ driveId: HOME_DRIVE_ID });
    (shareEventWithDrive as Mock).mockResolvedValue({
      ok: false,
      status: 403,
      error: 'You do not have permission to share this event',
    });

    const res = await POST(
      makeRequest('POST', `http://host/api/calendar/events/${EVENT_ID}/drives`, { driveId: OTHER_DRIVE_ID }),
      { params: Promise.resolve({ eventId: EVENT_ID }) },
    );

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/calendar/events/[eventId]/drives
// ---------------------------------------------------------------------------

describe('DELETE', () => {
  it('200: unshares event from a drive', async () => {
    stubEventSelect({ driveId: HOME_DRIVE_ID });
    (unshareEventFromDrive as Mock).mockResolvedValue({ ok: true, status: 200 });

    const res = await DELETE(
      makeRequest('DELETE', `http://host/api/calendar/events/${EVENT_ID}/drives?driveId=${OTHER_DRIVE_ID}`),
      { params: Promise.resolve({ eventId: EVENT_ID }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('400: rejects removing the home drive', async () => {
    stubEventSelect({ driveId: HOME_DRIVE_ID });
    (unshareEventFromDrive as Mock).mockResolvedValue({
      ok: false,
      status: 400,
      error: 'Cannot remove the home drive from an event',
    });

    const res = await DELETE(
      makeRequest('DELETE', `http://host/api/calendar/events/${EVENT_ID}/drives?driveId=${HOME_DRIVE_ID}`),
      { params: Promise.resolve({ eventId: EVENT_ID }) },
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/home drive/i);
  });

  it('404: returns not found when event not shared with drive', async () => {
    stubEventSelect({ driveId: HOME_DRIVE_ID });
    (unshareEventFromDrive as Mock).mockResolvedValue({
      ok: false,
      status: 404,
      error: 'Event is not shared with this drive',
    });

    const res = await DELETE(
      makeRequest('DELETE', `http://host/api/calendar/events/${EVENT_ID}/drives?driveId=${OTHER_DRIVE_ID}`),
      { params: Promise.resolve({ eventId: EVENT_ID }) },
    );

    expect(res.status).toBe(404);
  });

  it('400: rejects missing driveId query param', async () => {
    const res = await DELETE(
      makeRequest('DELETE', `http://host/api/calendar/events/${EVENT_ID}/drives`),
      { params: Promise.resolve({ eventId: EVENT_ID }) },
    );

    expect(res.status).toBe(400);
  });

  it('403: returns forbidden when caller lacks permission', async () => {
    stubEventSelect({ driveId: HOME_DRIVE_ID });
    (unshareEventFromDrive as Mock).mockResolvedValue({
      ok: false,
      status: 403,
      error: 'You do not have permission to remove this drive share',
    });

    const res = await DELETE(
      makeRequest('DELETE', `http://host/api/calendar/events/${EVENT_ID}/drives?driveId=${OTHER_DRIVE_ID}`),
      { params: Promise.resolve({ eventId: EVENT_ID }) },
    );

    expect(res.status).toBe(403);
  });
});
