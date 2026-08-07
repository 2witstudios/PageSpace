import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

/**
 * `POST /api/ai/conversations/revs` — the reconnect watermark check.
 *
 * Two things are load-bearing and both are pinned here: it answers in ONE
 * round-trip for many ids, and it filters every id through the SHARED
 * `canAccessConversation` predicate rather than trusting the caller's list.
 */

const { mockLimit } = vi.hoisted(() => ({ mockLimit: vi.fn() }));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: mockLimit }),
      }),
    }),
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  inArray: vi.fn((col: unknown, vals: unknown) => ({ inArray: [col, vals] })),
}));

vi.mock('@pagespace/db/schema/conversations', () => ({
  conversations: {
    id: 'id',
    rev: 'rev',
    userId: 'userId',
    isShared: 'isShared',
    type: 'type',
    contextId: 'contextId',
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { error: vi.fn() } } }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

const mockCanAccessConversation = vi.fn();
vi.mock('@pagespace/lib/permissions/conversation-access', () => ({
  canAccessConversation: (userId: string, row: unknown) => mockCanAccessConversation(userId, row),
}));

import { POST } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const USER = 'user-1';

const mockSessionAuth = (userId = USER): SessionAuthResult => ({
  userId,
  tokenType: 'session',
  sessionId: 'sess-1',
  role: 'user',
  tokenVersion: 0,
  adminRoleVersion: 0,
});

const mockAuthFailure = (): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
});

const makeRequest = (body: unknown) =>
  new Request('http://test.local/api/ai/conversations/revs', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const row = (id: string, rev: number, overrides: Partial<{ userId: string; isShared: boolean }> = {}) => ({
  id,
  rev,
  userId: USER,
  isShared: false,
  type: 'page',
  contextId: 'page-1',
  ...overrides,
});

describe('POST /api/ai/conversations/revs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockSessionAuth());
    vi.mocked(isAuthError).mockReturnValue(false);
    mockCanAccessConversation.mockResolvedValue(true);
  });

  it('given several ids, should answer all of them from ONE query', async () => {
    mockLimit.mockResolvedValueOnce([row('c1', 4), row('c2', 11)]);

    const response = await POST(makeRequest({ ids: ['c1', 'c2'] }));
    const body = await response.json();

    expect(body).toEqual({ revs: { c1: 4, c2: 11 } });
    expect(mockLimit).toHaveBeenCalledTimes(1);
  });

  // Absence, not 403: a client asking about a conversation that was un-shared out
  // from under it is an expected state, and one stale id must not blind it to the rest.
  it('given an id the caller may not access, should omit it rather than fail the batch', async () => {
    mockLimit.mockResolvedValueOnce([row('c1', 4), row('c2', 11, { userId: 'someone-else' })]);
    mockCanAccessConversation.mockImplementation(async (_userId: string, r: { userId: string }) => r.userId === USER);

    const response = await POST(makeRequest({ ids: ['c1', 'c2'] }));
    const body = await response.json();

    expect(body).toEqual({ revs: { c1: 4 } });
  });

  it('given an id with no row, should simply omit it (indistinguishable from forbidden — not an oracle)', async () => {
    mockLimit.mockResolvedValueOnce([row('c1', 4)]);

    const response = await POST(makeRequest({ ids: ['c1', 'c-does-not-exist'] }));
    const body = await response.json();

    expect(body).toEqual({ revs: { c1: 4 } });
  });

  it('given duplicate ids, should de-duplicate before querying', async () => {
    mockLimit.mockResolvedValueOnce([row('c1', 4)]);

    await POST(makeRequest({ ids: ['c1', 'c1', 'c1'] }));

    const inArrayArg = vi.mocked(mockLimit).mock.calls.length;
    expect(inArrayArg).toBe(1);
  });

  it('given an empty id list, should answer empty without querying', async () => {
    const response = await POST(makeRequest({ ids: [] }));
    const body = await response.json();

    expect(body).toEqual({ revs: {} });
    expect(mockLimit).not.toHaveBeenCalled();
  });

  it('given non-string entries, should filter them out rather than pass them to the query', async () => {
    mockLimit.mockResolvedValueOnce([row('c1', 4)]);

    const response = await POST(makeRequest({ ids: ['c1', 42, null, { id: 'nope' }, ''] }));
    const body = await response.json();

    expect(body).toEqual({ revs: { c1: 4 } });
  });

  it('given `ids` that is not an array, should 400', async () => {
    const response = await POST(makeRequest({ ids: 'c1' }));

    expect(response.status).toBe(400);
    expect(mockLimit).not.toHaveBeenCalled();
  });

  it('given invalid JSON, should 400', async () => {
    const response = await POST(makeRequest('{not json'));

    expect(response.status).toBe(400);
  });

  it('given more ids than the ceiling, should 400 rather than run an unbounded IN', async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `c${i}`);

    const response = await POST(makeRequest({ ids }));

    expect(response.status).toBe(400);
    expect(mockLimit).not.toHaveBeenCalled();
  });

  it('given auth fails, should return the auth error without querying', async () => {
    vi.mocked(isAuthError).mockReturnValue(true);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthFailure());

    const response = await POST(makeRequest({ ids: ['c1'] }));

    expect(response.status).toBe(401);
    expect(mockLimit).not.toHaveBeenCalled();
  });

  it('given the query throws, should 500 rather than leak the error', async () => {
    mockLimit.mockRejectedValueOnce(new Error('db down'));

    const response = await POST(makeRequest({ ids: ['c1'] }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe('Failed to check conversation revs');
  });
});
