import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
const { mockOrderBy } = vi.hoisted(() => ({ mockOrderBy: vi.fn() }));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: mockOrderBy,
        }),
      }),
    }),
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  asc: vi.fn((col: unknown) => ({ asc: col })),
  eq: vi.fn((col: unknown, val: unknown) => ({ eq: [col, val] })),
  gte: vi.fn((col: unknown, val: unknown) => ({ gte: [col, val] })),
}));

vi.mock('@pagespace/db/schema/ai-streams', () => ({
  aiStreamSessions: {
    messageId: 'messageId',
    conversationId: 'conversationId',
    userId: 'userId',
    displayName: 'displayName',
    browserSessionId: 'browserSessionId',
    parts: 'parts',
    channelId: 'channelId',
    status: 'status',
    startedAt: 'startedAt',
  },
}));

vi.mock('@/lib/auth/request-auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
}));
vi.mock('@/lib/auth/auth-core', () => ({
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserViewPage: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { error: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/ai/global-channel-id', () => ({
  parseGlobalChannelId: vi.fn(() => null),
}));

import { GET } from '../route';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import type { SessionAuthResult, AuthError } from '@/lib/auth/auth-types';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError } from '@/lib/auth/auth-core';

const mockUserId = 'user-test-1';
const mockChannelId = 'page-test-1';

const mockSessionAuth = (userId = mockUserId): SessionAuthResult => ({
  userId,
  tokenType: 'session',
  sessionId: 'sess-1',
  role: 'user',
  tokenVersion: 0,
  adminRoleVersion: 0,
});

const mockAuthFailure = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const makeRequest = (channelId = mockChannelId) =>
  new Request(`http://test.local/api/ai/chat/active-streams?channelId=${encodeURIComponent(channelId)}`);

describe('GET /api/ai/chat/active-streams', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockSessionAuth());
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(canUserViewPage).mockResolvedValue(true);
  });

  it('given rows with a persisted parts snapshot, should pass them through on each stream', async () => {
    const parts = [{ type: 'text', text: 'partial content' }];
    mockOrderBy.mockResolvedValueOnce([
      {
        messageId: 'msg-1',
        conversationId: 'conv-1',
        userId: 'user-2',
        displayName: 'Alice',
        browserSessionId: 'session-2',
        parts,
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
      },
    ]);

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(body.streams).toEqual([
      {
        messageId: 'msg-1',
        conversationId: 'conv-1',
        startedAt: '2024-01-01T00:00:00.000Z',
        parts,
        triggeredBy: {
          userId: 'user-2',
          displayName: 'Alice',
          browserSessionId: 'session-2',
        },
      },
    ]);
  });

  it('given a row with a null/undefined parts column, should default to an empty array', async () => {
    mockOrderBy.mockResolvedValueOnce([
      {
        messageId: 'msg-1',
        conversationId: 'conv-1',
        userId: 'user-2',
        displayName: 'Alice',
        browserSessionId: 'session-2',
        parts: null,
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
      },
    ]);

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(body.streams[0].parts).toEqual([]);
  });

  it('given no active streams, should return an empty streams array', async () => {
    mockOrderBy.mockResolvedValueOnce([]);

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(body.streams).toEqual([]);
  });

  it('given channelId is missing, should return 400 before querying the DB', async () => {
    const request = new Request('http://test.local/api/ai/chat/active-streams');
    const response = await GET(request);

    expect(response.status).toBe(400);
    expect(mockOrderBy).not.toHaveBeenCalled();
  });

  it('given auth fails, should return the auth error response', async () => {
    vi.mocked(isAuthError).mockReturnValue(true);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthFailure(401));

    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
  });

  it('given the user cannot view the page, should return 403 without querying streams', async () => {
    vi.mocked(canUserViewPage).mockResolvedValue(false);

    const response = await GET(makeRequest());

    expect(response.status).toBe(403);
    expect(mockOrderBy).not.toHaveBeenCalled();
  });
});
