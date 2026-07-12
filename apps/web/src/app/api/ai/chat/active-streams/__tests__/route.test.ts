import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

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
    lastHeartbeatAt: 'lastHeartbeatAt',
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

// Conversation-scoped subscription authorization. Page access alone would hand another
// member's PRIVATE conversation (and its buffered parts snapshot) to anyone who can view
// the page — see stream-subscription-authz.ts, which is unit-tested separately.
const mockFilterSubscribableStreams = vi.fn();
vi.mock('@/lib/ai/core/stream-subscription-authz', () => ({
  filterSubscribableStreams: (args: { rows: unknown[] }) => mockFilterSubscribableStreams(args),
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
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';

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
    // Default: everything the liveness filter kept is subscribable (the caller's own).
    mockFilterSubscribableStreams.mockImplementation(async ({ rows }: { rows: unknown[] }) => rows);
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
        lastHeartbeatAt: new Date(),
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
        lastHeartbeatAt: new Date(),
      },
    ]);

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(body.streams[0].parts).toEqual([]);
  });

  // A crashed generation leaves status='streaming' forever — the terminal write is
  // fire-and-forget and dies with the process. Serving that row would give every
  // subscriber a phantom in-progress bubble, with a Stop button, for a dead stream.
  it('given a streaming row whose heartbeat is stale (crashed process), should NOT serve it as an active stream', async () => {
    mockOrderBy.mockResolvedValueOnce([
      {
        messageId: 'msg-dead',
        conversationId: 'conv-1',
        userId: 'user-2',
        displayName: 'Alice',
        browserSessionId: 'session-2',
        parts: [],
        startedAt: new Date(Date.now() - 5 * 60 * 1000),
        lastHeartbeatAt: new Date(Date.now() - 5 * 60 * 1000),
      },
    ]);

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(body.streams).toEqual([]);
  });

  // The endpoint used to also cap on `startedAt >= now-10min`. That cap had to go: this
  // response is the authoritative answer to "what is still running on this channel"
  // (consumers release their Stop-slot claims against it), and the cap made it LIE about
  // exactly the streams where Stop matters most — a deep-research or long tool-loop run is
  // still very much alive at minute 12. Dropping it here told every subscriber it had
  // ended, killing the Stop button on a stream that kept generating and kept billing.
  it('given a stream that started LONG ago but is still beating, should serve it (liveness is the heartbeat, not age)', async () => {
    mockOrderBy.mockResolvedValueOnce([
      {
        messageId: 'msg-long-run',
        conversationId: 'conv-1',
        userId: 'user-1',
        displayName: 'Me',
        browserSessionId: 'session-1',
        parts: [],
        startedAt: new Date(Date.now() - 45 * 60 * 1000),
        lastHeartbeatAt: new Date(),
      },
    ]);

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(body.streams.map((s: { messageId: string }) => s.messageId)).toEqual(['msg-long-run']);
  });

  it('given a streaming row that is still checkpointing, should serve it', async () => {
    mockOrderBy.mockResolvedValueOnce([
      {
        messageId: 'msg-live',
        conversationId: 'conv-1',
        userId: 'user-2',
        displayName: 'Alice',
        browserSessionId: 'session-2',
        parts: [],
        startedAt: new Date(Date.now() - 5 * 60 * 1000),
        lastHeartbeatAt: new Date(Date.now() - 10 * 1000),
      },
    ]);

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(body.streams.map((s: { messageId: string }) => s.messageId)).toEqual(['msg-live']);
  });

  it("given a live stream the caller may not subscribe to (another member's PRIVATE conversation), should not return it", async () => {
    mockOrderBy.mockResolvedValueOnce([
      {
        messageId: 'msg-theirs',
        conversationId: 'their-private-conv',
        userId: 'user-other',
        displayName: 'Alice',
        browserSessionId: 'session-2',
        parts: [{ type: 'text', text: 'private content' }],
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
      },
    ]);
    // Conversation-scoped authorization drops it: page access is not enough.
    mockFilterSubscribableStreams.mockResolvedValueOnce([]);

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(body.streams).toEqual([]);
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
