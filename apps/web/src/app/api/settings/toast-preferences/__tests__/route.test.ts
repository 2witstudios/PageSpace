import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, PATCH } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

const mockFindFirst = vi.hoisted(() => vi.fn());
const mockInsert = vi.hoisted(() => vi.fn());
const mockValues = vi.hoisted(() => vi.fn());
const mockOnConflictDoUpdate = vi.hoisted(() => vi.fn());
const mockReturning = vi.hoisted(() => vi.fn());

vi.mock('@pagespace/db/db', () => ({
  db: {
    insert: mockInsert,
    query: {
      userToastNotificationPreferences: {
        findFirst: mockFindFirst,
      },
    },
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a, b) => ({ field: a, value: b })),
}));
vi.mock('@pagespace/db/schema/toast-notification-preferences', () => ({
  userToastNotificationPreferences: { userId: 'userId', level: 'level' },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result) => 'error' in result),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const mockSessionAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

describe('GET /api/settings/toast-preferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockSessionAuth('user-1'));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  it('given no stored preference, defaults to level all', async () => {
    mockFindFirst.mockResolvedValue(null);

    const request = new Request('https://example.com/api/settings/toast-preferences');
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.level).toBe('all');
  });

  it('given a stored preference, returns its level', async () => {
    mockFindFirst.mockResolvedValue({ id: 'pref-1', userId: 'user-1', level: 'mentions' });

    const request = new Request('https://example.com/api/settings/toast-preferences');
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.level).toBe('mentions');
  });

  it('given unauthenticated request, returns 401', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));
    vi.mocked(isAuthError).mockReturnValue(true);

    const request = new Request('https://example.com/api/settings/toast-preferences');
    const response = await GET(request);

    expect(response.status).toBe(401);
  });
});

describe('PATCH /api/settings/toast-preferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsert.mockReturnValue({ values: mockValues });
    mockValues.mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
    mockOnConflictDoUpdate.mockReturnValue({ returning: mockReturning });

    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockSessionAuth('user-1'));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  it('upserts atomically via a single insert...onConflictDoUpdate call (no separate lookup)', async () => {
    mockReturning.mockResolvedValue([{ userId: 'user-1', level: 'mentions' }]);

    const request = new Request('https://example.com/api/settings/toast-preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'mentions' }),
    });

    const response = await PATCH(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockOnConflictDoUpdate).toHaveBeenCalledTimes(1);
    expect(mockOnConflictDoUpdate.mock.calls[0][0]).toMatchObject({
      target: 'userId',
      set: { level: 'mentions' },
    });
    // No get-then-write race: the route never reads the row before writing it.
    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(body.preference.level).toBe('mentions');
  });

  it('handles a concurrent-write conflict via the same atomic call (no separate update path)', async () => {
    // Simulates two requests racing on the same userId: onConflictDoUpdate is
    // the DB's own atomic resolution, so from the route's perspective this is
    // just another successful upsert call, not a distinct code path.
    mockReturning.mockResolvedValue([{ userId: 'user-1', level: 'off' }]);

    const request = new Request('https://example.com/api/settings/toast-preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'off' }),
    });

    const response = await PATCH(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.preference.level).toBe('off');
  });

  it('given an invalid level, returns 400', async () => {
    const request = new Request('https://example.com/api/settings/toast-preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'everything' }),
    });

    const response = await PATCH(request);

    expect(response.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('given a missing level, returns 400', async () => {
    const request = new Request('https://example.com/api/settings/toast-preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const response = await PATCH(request);

    expect(response.status).toBe(400);
  });

  it('given unauthenticated request, returns 401', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));
    vi.mocked(isAuthError).mockReturnValue(true);

    const request = new Request('https://example.com/api/settings/toast-preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'all' }),
    });

    const response = await PATCH(request);

    expect(response.status).toBe(401);
  });
});
