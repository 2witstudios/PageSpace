/**
 * Scope escape fixed for ALL drive-scoped principals (mcp_ keys and OAuth
 * grants alike): a drive-scoped credential has no identity power over ANOTHER
 * user's personal (driveless) event — the rule `canAccessEvent` in
 * ../../route.ts already applies. The attendees sub-route checked scope only for
 * drive events, then fell back to the owning user's identity (attendee), so a
 * `drive:X` credential could read the attendee list of, or RSVP to, someone
 * else's personal event. Sessions are unchanged; an mcp_ key keeps its user's own
 * personal events (#1846), while an OAuth application reaches no personal event at
 * all (personal-event-scope.ts).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      calendarEvents: { findFirst: vi.fn() },
      eventAttendees: { findFirst: vi.fn(), findMany: vi.fn() },
    },
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => [{ status: 'ACCEPTED' }]) })) })) })),
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(async () => []) })) })),
  },
}));
vi.mock('@pagespace/lib/services/calendar-event-drive-service', () => ({
  getAllMemberUserIdsForEvent: vi.fn(async () => new Set()),
  isUserMemberOfAnyEventDrive: vi.fn(async () => false),
  getAllDriveIdsForEvent: vi.fn(async () => []),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  logSecurityEvent: vi.fn(),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@/lib/websocket/calendar-events', () => ({ broadcastCalendarEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, authenticateRequestWithOptions: vi.fn() };
});

import { GET, PATCH } from '../route';
import { db } from '@pagespace/db/db';
import { authenticateRequestWithOptions, type AuthResult } from '@/lib/auth';
import { PARITY_USER_ID, mcpDriveKey, oauthDriveGrant } from '@/lib/auth/__tests__/oauth-principal-fixture';

const session: AuthResult = { tokenType: 'session', sessionId: 's', userId: PARITY_USER_ID, role: 'user', tokenVersion: 0, adminRoleVersion: 0 };
const personalEvent = (createdById: string) => ({ id: 'evt', driveId: null, createdById, isTrashed: false, visibility: 'ATTENDEES_ONLY' });
const ctx = { params: Promise.resolve({ eventId: 'evt' }) };

const getAttendees = () => GET(new Request('https://example.com/api/calendar/events/evt/attendees'), ctx);
const rsvp = () =>
  PATCH(new Request('https://example.com/api/calendar/events/evt/attendees', { method: 'PATCH', body: JSON.stringify({ status: 'ACCEPTED' }) }), ctx);

beforeEach(() => {
  vi.clearAllMocks();
  // The owning user IS an attendee of the event.
  vi.mocked(db.query.eventAttendees.findFirst).mockResolvedValue({ eventId: 'evt', userId: PARITY_USER_ID } as never);
  vi.mocked(db.query.eventAttendees.findMany).mockResolvedValue([] as never);
});

describe('calendar attendees — drive-scoped principals on personal events', () => {
  for (const [label, principal] of [
    ['a drive:X OAuth grant', oauthDriveGrant('drivex', 'admin')],
    ['a drive-scoped mcp_ key', mcpDriveKey('drivex')],
  ] as const) {
    it(`refuses ${label} the attendee list of another user's personal event`, async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(principal);
      vi.mocked(db.query.calendarEvents.findFirst).mockResolvedValue(personalEvent('someone-else') as never);
      const res = await getAttendees();
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'This token does not have access to this event' });
    });

    it(`refuses ${label} an RSVP to another user's personal event — nothing written`, async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(principal);
      vi.mocked(db.query.calendarEvents.findFirst).mockResolvedValue(personalEvent('someone-else') as never);
      const res = await rsvp();
      expect(res.status).toBe(403);
      expect(db.update).not.toHaveBeenCalled();
    });

  }

  it("still lets a drive-scoped mcp_ key reach the user's OWN personal event (#1846)", async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mcpDriveKey('drivex'));
    vi.mocked(db.query.calendarEvents.findFirst).mockResolvedValue(personalEvent(PARITY_USER_ID) as never);
    expect((await getAttendees()).status).toBe(200);
  });

  it("refuses an OAuth grant even the user's OWN personal event — consent never named the personal calendar", async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(oauthDriveGrant('drivex', 'admin'));
    vi.mocked(db.query.calendarEvents.findFirst).mockResolvedValue(personalEvent(PARITY_USER_ID) as never);
    const res = await getAttendees();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'This token does not have access to this event' });
  });

  it("leaves a session attendee's access to another user's personal event unchanged", async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session);
    vi.mocked(db.query.calendarEvents.findFirst).mockResolvedValue(personalEvent('someone-else') as never);
    expect((await getAttendees()).status).toBe(200);
    expect((await rsvp()).status).toBe(200);
  });
});
