/**
 * Contract tests for /api/cron/calendar-sync
 * Verifies security audit logging on successful calendar sync.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockAudit, mockLoggers } = vi.hoisted(() => ({
  mockAudit: vi.fn(),
  mockLoggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      googleCalendarConnections: { findMany: vi.fn().mockResolvedValue([]) },
    },
  },
  googleCalendarConnections: {
    status: 'status',
    lastSyncAt: 'lastSyncAt',
    syncFrequencyMinutes: 'syncFrequencyMinutes',
  },
  eq: vi.fn(),
  and: vi.fn(),
  or: vi.fn(),
  lt: vi.fn(),
  isNull: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
}));

vi.mock('@/lib/integrations/google-calendar/sync-service', () => ({
  syncGoogleCalendar: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: mockLoggers,

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: mockAudit,
}));

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: ResponseInit) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  },
}));

import { GET } from '../route';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { db } from '@pagespace/db';
import { syncGoogleCalendar } from '@/lib/integrations/google-calendar/sync-service';

function makeRequest(): Request {
  return new Request('http://localhost:3000/api/cron/calendar-sync');
}

describe('/api/cron/calendar-sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateSignedCronRequest).mockReturnValue(null);
  });

  it('logs audit event after sync completes with no connections', async () => {
    await GET(makeRequest());

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'data.write', resourceType: 'cron_job', resourceId: 'calendar_sync', details: { synced: 0, failed: 0 } })
    );
  });

  it('logs audit event with sync counts after processing connections', async () => {
    vi.mocked(db.query.googleCalendarConnections.findMany).mockResolvedValue([
      { userId: 'user_1', syncFrequencyMinutes: 5, lastSyncAt: null },
      { userId: 'user_2', syncFrequencyMinutes: 5, lastSyncAt: null },
    ] as never);
    vi.mocked(syncGoogleCalendar)
      .mockResolvedValueOnce({ success: true } as never)
      .mockResolvedValueOnce({ success: false, error: 'Token expired' } as never);

    await GET(makeRequest());

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'data.write', resourceType: 'cron_job', resourceId: 'calendar_sync', details: { synced: 1, failed: 1 } })
    );
  });

  it('does not log audit event when auth fails', async () => {
    const authResponse = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
    vi.mocked(validateSignedCronRequest).mockReturnValue(authResponse as never);

    await GET(makeRequest());

    expect(mockAudit).not.toHaveBeenCalled();
  });
});
