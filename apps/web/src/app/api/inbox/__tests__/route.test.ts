/**
 * Tests for /api/inbox ?type filter (dm | channel | all).
 * Asserts the route only fetches the requested feed kind so cursor pagination
 * stays correct per-feed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result && typeof result === 'object' && 'error' in result),
}));

vi.mock('@pagespace/db/db', () => ({
  db: { execute: vi.fn() },
}));

vi.mock('@pagespace/db/operators', () => {
  // Capture the literal text chunks so tests can identify which CTE ran.
  const sql = (strings: TemplateStringsArray, ..._values: unknown[]) => ({
    __sqlText: strings.join('?'),
  });
  return { sql };
});

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  getBatchPagePermissions: vi.fn(),
}));

import { GET } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { getBatchPagePermissions } from '@pagespace/lib/permissions/permissions';

const mockUserId = 'user_123';

const mockAuth = () => {
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
    userId: mockUserId,
    tokenVersion: 0,
    tokenType: 'session' as const,
    sessionId: 'test-session',
    role: 'user' as const,
    adminRoleVersion: 0,
  });
};

const dmRow = {
  id: 'dm_1',
  last_message_at: '2026-05-03T00:00:00.000Z',
  last_message: 'hi',
  other_user_name: 'Alice',
  other_user_display_name: 'Alice',
  other_user_avatar_url: null,
  other_user_image: '/api/avatar/alice/avatar.png?t=1',
  unread_count: '0',
};

const channelRow = {
  id: 'ch_1',
  name: 'general',
  drive_id: 'drv_1',
  drive_name: 'Workspace',
  last_message: 'hello',
  last_message_at: '2026-05-02T00:00:00.000Z',
  sender_name: 'Bob',
  unread_count: '0',
};

const isDmQuery = (arg: unknown) =>
  typeof arg === 'object' && arg !== null && '__sqlText' in arg &&
  String((arg as { __sqlText: string }).__sqlText).includes('dm_conversations');

const isChannelQuery = (arg: unknown) =>
  typeof arg === 'object' && arg !== null && '__sqlText' in arg &&
  String((arg as { __sqlText: string }).__sqlText).includes("p.type = 'CHANNEL'");

const setupDb = () => {
  // db.execute returns a complex Drizzle PgRaw type — for these tests we only need rows.
  (db.execute as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (arg: unknown) => {
    if (isDmQuery(arg)) return { rows: [dmRow] };
    if (isChannelQuery(arg)) return { rows: [channelRow] };
    return { rows: [] };
  });
  (getBatchPagePermissions as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
    new Map([['ch_1', { canView: true, canEdit: false, canShare: false, canDelete: false }]])
  );
};

describe('GET /api/inbox ?type filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
    setupDb();
  });

  it('returns DMs and channels when type is omitted (default=all)', async () => {
    const res = await GET(new Request('http://localhost/api/inbox?limit=20'));
    expect(res.status).toBe(200);
    const body = await res.json();
    const types = body.items.map((i: { type: string }) => i.type).sort();
    expect(types).toEqual(['channel', 'dm']);
    expect(vi.mocked(db.execute)).toHaveBeenCalledTimes(2);
  });

  it('returns only DMs when type=dm', async () => {
    const res = await GET(new Request('http://localhost/api/inbox?type=dm&limit=20'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].type).toBe('dm');
    // Only the DM CTE runs — the channel CTE must be skipped.
    expect(vi.mocked(db.execute)).toHaveBeenCalledTimes(1);
    const sqlArg = vi.mocked(db.execute).mock.calls[0][0];
    expect(isDmQuery(sqlArg)).toBe(true);
  });

  it('uses users.image as the DM avatar when the profile avatar is blank', async () => {
    const res = await GET(new Request('http://localhost/api/inbox?type=dm&limit=20'));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.items[0].avatarUrl).toBe('/api/avatar/alice/avatar.png?t=1');
  });

  it('returns only channels when type=channel', async () => {
    const res = await GET(new Request('http://localhost/api/inbox?type=channel&limit=20'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].type).toBe('channel');
    expect(vi.mocked(db.execute)).toHaveBeenCalledTimes(1);
    const sqlArg = vi.mocked(db.execute).mock.calls[0][0];
    expect(isChannelQuery(sqlArg)).toBe(true);
  });

  it('rejects type=dm combined with driveId (DMs are user-scoped)', async () => {
    const res = await GET(new Request('http://localhost/api/inbox?type=dm&driveId=drv_1'));
    expect(res.status).toBe(400);
    expect(vi.mocked(db.execute)).not.toHaveBeenCalled();
  });

  it('ignores unknown type values and falls back to all', async () => {
    const res = await GET(new Request('http://localhost/api/inbox?type=bogus'));
    expect(res.status).toBe(200);
    const body = await res.json();
    const types = body.items.map((i: { type: string }) => i.type).sort();
    expect(types).toEqual(['channel', 'dm']);
  });
});
