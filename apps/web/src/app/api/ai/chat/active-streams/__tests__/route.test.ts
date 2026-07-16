import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
const { mockOrderBy, mockWhere, mockMaterializeInterruptedStream } = vi.hoisted(() => ({
  mockOrderBy: vi.fn(),
  mockWhere: vi.fn(),
  mockMaterializeInterruptedStream: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: mockWhere.mockReturnValue({
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
    rawPartsCount: 'rawPartsCount',
    channelId: 'channelId',
    status: 'status',
    startedAt: 'startedAt',
    lastHeartbeatAt: 'lastHeartbeatAt',
  },
}));

vi.mock('@/lib/auth/request-auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
}));
vi.mock('@/lib/auth/auth-core', () => ({
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

// Materialization is its own unit with its own tests (materialize-interrupted-stream.test.ts).
// Stubbed here so these tests exercise the lazy sweep's DECISION (which rows get reaped), not
// how a row is turned into an interrupted message.
vi.mock('@/lib/ai/core/materialize-interrupted-stream', () => ({
  materializeInterruptedStream: mockMaterializeInterruptedStream,
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
        rawPartsCount: 4,
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
        // The RAW pushed-chunk count, distinct from parts.length (parts may already be
        // merged) — the client's live-replay skip depends on this, not on parts.length.
        rawPartsCount: 4,
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

  // The lazy sweep: this query already reads every 'streaming' row on the channel, so a row
  // that is not live AND is provably dead (not mere staleness) is reaped here instead of
  // waiting on a cron or the next send's takeover.
  describe('the lazy materialization sweep', () => {
    it('given a provably-dead row (crashed process), materializes it as interrupted', async () => {
      const parts = [{ type: 'text', text: 'partial before crash' }];
      const longAgo = new Date(Date.now() - 5 * 60 * 1000);
      mockOrderBy.mockResolvedValueOnce([
        {
          messageId: 'msg-dead',
          conversationId: 'conv-1',
          userId: 'user-2',
          displayName: 'Alice',
          browserSessionId: 'session-2',
          parts,
          startedAt: longAgo,
          lastHeartbeatAt: longAgo,
        },
      ]);

      await GET(makeRequest());

      expect(mockMaterializeInterruptedStream).toHaveBeenCalledWith({
        messageId: 'msg-dead',
        channelId: mockChannelId,
        conversationId: 'conv-1',
        userId: 'user-2',
        parts,
        startedAt: longAgo,
      });
    });

    // A page channel carries EVERY conversation on it, including other members' PRIVATE ones.
    // Without this gate, any user with mere page-view access could trigger a reap side effect
    // (a DB write + broadcast) for a conversation whose content they can never see returned —
    // the same authorization gap the response payload itself already closes via
    // filterSubscribableStreams.
    it("given a provably-dead row in a conversation the caller may NOT subscribe to (another member's private conversation), does not materialize it", async () => {
      const longAgo = new Date(Date.now() - 5 * 60 * 1000);
      mockOrderBy.mockResolvedValueOnce([
        {
          messageId: 'msg-not-mine',
          conversationId: 'their-private-conv',
          userId: 'user-other',
          displayName: 'Alice',
          browserSessionId: 'session-2',
          parts: [{ type: 'text', text: 'private content' }],
          startedAt: longAgo,
          lastHeartbeatAt: longAgo,
        },
      ]);
      // Conversation-scoped authorization drops it, exactly as it does for the response payload.
      mockFilterSubscribableStreams.mockResolvedValueOnce([]);

      await GET(makeRequest());

      expect(mockMaterializeInterruptedStream).not.toHaveBeenCalled();
    });

    it('given a live, checkpointing row, does not materialize it', async () => {
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

      await GET(makeRequest());

      expect(mockMaterializeInterruptedStream).not.toHaveBeenCalled();
    });

    // A long-running generation whose heartbeat rode all the way to the cap is ambiguous, not
    // dead — isProvablyDead refuses to judge it (see stream-liveness.ts). Reaping it here would
    // destroy a still-generating stream's only crash-recovery snapshot.
    it('given a long-lived stream whose heartbeat is silent by DESIGN (rode to the cap), does not materialize it', async () => {
      const startedAt = new Date(Date.now() - 65 * 60 * 1000);
      mockOrderBy.mockResolvedValueOnce([
        {
          messageId: 'msg-long-silent',
          conversationId: 'conv-1',
          userId: 'user-1',
          displayName: 'Me',
          browserSessionId: 'session-1',
          parts: [],
          startedAt,
          // Beat stopped almost exactly at the 60-minute cap — ambiguous, not proof of death.
          lastHeartbeatAt: new Date(startedAt.getTime() + 60 * 60 * 1000 - 1_000),
        },
      ]);

      await GET(makeRequest());

      expect(mockMaterializeInterruptedStream).not.toHaveBeenCalled();
    });
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

// Leaf 5.1: cross-channel discovery of the CALLER's own in-flight streams, for the history
// tab's streaming badge. Ownership is the authz — ai_stream_sessions.userId IS the stream's
// owner column — so this mode never runs a page-access or conversation-sharing check.
describe('GET /api/ai/chat/active-streams?scope=user', () => {
  const makeScopeUserRequest = () => new Request('http://test.local/api/ai/chat/active-streams?scope=user');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockSessionAuth());
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  it('given no channelId, should NOT 400 — channelId is not required in this mode', async () => {
    mockOrderBy.mockResolvedValueOnce([]);

    const response = await GET(makeScopeUserRequest());

    expect(response.status).toBe(200);
  });

  it('should query filtered to the CALLER\'s own userId and status=streaming — no channelId predicate', async () => {
    mockOrderBy.mockResolvedValueOnce([]);

    await GET(makeScopeUserRequest());

    expect(mockWhere).toHaveBeenCalledTimes(1);
    const condition = mockWhere.mock.calls[0][0] as { and: unknown[] };
    expect(condition.and).toEqual([
      { eq: ['userId', mockUserId] },
      { eq: ['status', 'streaming'] },
    ]);
  });

  it('should never call canUserViewPage or filterSubscribableStreams — ownership alone is the authz', async () => {
    mockOrderBy.mockResolvedValueOnce([
      {
        messageId: 'msg-1',
        conversationId: 'conv-1',
        channelId: 'page-other',
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
      },
    ]);

    await GET(makeScopeUserRequest());

    expect(canUserViewPage).not.toHaveBeenCalled();
    expect(mockFilterSubscribableStreams).not.toHaveBeenCalled();
  });

  it('given own streaming rows across multiple channels, should return them WITHOUT parts/rawPartsCount/triggeredBy', async () => {
    mockOrderBy.mockResolvedValueOnce([
      {
        messageId: 'msg-1',
        conversationId: 'conv-1',
        channelId: 'page-a',
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        lastHeartbeatAt: new Date(),
      },
      {
        messageId: 'msg-2',
        conversationId: 'conv-2',
        channelId: 'page-b',
        startedAt: new Date('2024-01-02T00:00:00.000Z'),
        lastHeartbeatAt: new Date(),
      },
    ]);

    const response = await GET(makeScopeUserRequest());
    const body = await response.json();

    expect(body.streams).toEqual([
      { messageId: 'msg-1', conversationId: 'conv-1', channelId: 'page-a', startedAt: '2024-01-01T00:00:00.000Z' },
      { messageId: 'msg-2', conversationId: 'conv-2', channelId: 'page-b', startedAt: '2024-01-02T00:00:00.000Z' },
    ]);
    for (const stream of body.streams) {
      expect(stream).not.toHaveProperty('parts');
      expect(stream).not.toHaveProperty('rawPartsCount');
      expect(stream).not.toHaveProperty('triggeredBy');
    }
  });

  it('given a row whose heartbeat is stale (crashed process), should NOT include it', async () => {
    mockOrderBy.mockResolvedValueOnce([
      {
        messageId: 'msg-dead',
        conversationId: 'conv-1',
        channelId: 'page-a',
        startedAt: new Date(Date.now() - 5 * 60 * 1000),
        lastHeartbeatAt: new Date(Date.now() - 5 * 60 * 1000),
      },
    ]);

    const response = await GET(makeScopeUserRequest());
    const body = await response.json();

    expect(body.streams).toEqual([]);
  });

  it('given no own streams, should return an empty streams array', async () => {
    mockOrderBy.mockResolvedValueOnce([]);

    const response = await GET(makeScopeUserRequest());
    const body = await response.json();

    expect(body.streams).toEqual([]);
  });

  it('given auth fails, should return the auth error response without querying', async () => {
    vi.mocked(isAuthError).mockReturnValue(true);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthFailure(401));

    const response = await GET(makeScopeUserRequest());

    expect(response.status).toBe(401);
    expect(mockOrderBy).not.toHaveBeenCalled();
  });
});
