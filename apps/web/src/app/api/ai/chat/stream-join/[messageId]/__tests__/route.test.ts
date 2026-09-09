import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import { StreamChannelRegistry } from '@/lib/ai/core/stream-channel-registry';
import { openStreamChannel } from '@/lib/ai/core/stream-channel';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// Fresh registry per test — module-level let, updated in beforeEach
let testRegistry: StreamChannelRegistry;

vi.mock('@/lib/ai/core/stream-channel-registry', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ai/core/stream-channel-registry')>(
    '@/lib/ai/core/stream-channel-registry',
  );
  return {
    ...actual,
    get streamChannelRegistry() {
      return testRegistry;
    },
  };
});

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserViewPage: vi.fn(),
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

/**
 * The session row `stream-join-context` falls back to on a registry miss.
 *
 * Defaults to "no row", so every pre-existing case keeps exercising exactly the path it did:
 * the registry answers, or nothing does. The cross-instance cases opt in.
 */
const mockSessionRow = vi.fn<() => Promise<unknown[]>>();

/**
 * The remote follower, mocked at its module boundary.
 *
 * The route's job is to acquire one, hand its channel to the SAME subscribe/SSE code a local
 * channel goes through, and release it on every teardown path. The follower's own polling and
 * terminal classification live in `remote-frame-follower.test.ts`.
 */
const mockRemoteRelease = vi.fn();
const mockAcquireRemoteChannel = vi.fn();
vi.mock('@/lib/ai/core/remote-frame-follower', () => ({
  acquireRemoteChannel: (messageId: string) => mockAcquireRemoteChannel(messageId),
}));
vi.mock('@pagespace/db/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => mockSessionRow() }),
      }),
    }),
  },
}));

import { GET } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const mockPageId = 'page-test-123';
const mockCanSubscribeToStream = vi.fn();
vi.mock('@/lib/ai/core/stream-subscription-authz', () => ({
  canSubscribeToStream: (args: unknown) => mockCanSubscribeToStream(args),
}));

const mockUserId = 'user-test-456';
const mockMessageId = 'msg-test-789';
const mockConversationId = 'conv-test-321';
const mockBrowserSessionId = 'session-test-654';
const mockDisplayName = 'Test User';
const mockMeta = {
  pageId: mockPageId,
  userId: mockUserId,
  displayName: mockDisplayName,
  conversationId: mockConversationId,
  browserSessionId: mockBrowserSessionId,
};

const mockSessionAuth = (userId = mockUserId): SessionAuthResult => ({
  userId,
  tokenType: 'session',
  sessionId: 'sess-abc',
  role: 'user',
  tokenVersion: 0,
  adminRoleVersion: 0,
});

const mockAuthFailure = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const makeRequest = (signal?: AbortSignal) => {
  // Avoid passing `signal` through RequestInit: the test runtime's Request
  // (undici realm) rejects AbortSignal instances created from the global
  // AbortController. The route only reads `request.signal`, so attach it
  // directly instead.
  const request = new Request(`http://test.local/api/ai/chat/stream-join/${mockMessageId}`);
  if (signal) {
    Object.defineProperty(request, 'signal', { value: signal });
  }
  return request;
};

/**
 * Append a raw frame to the channel this messageId owns.
 *
 * The wire carries `UIMessageChunk`s now, not the `chunkToPart` projection — so these are
 * SDK frames (`text-delta` with a `delta`) rather than rendered parts (`text` with a `text`).
 * Folding them back into parts is the CLIENT's job, and is covered in stream-join-client.test.ts.
 */
const appendTo = (messageId: string, chunk: unknown) => {
  testRegistry.get(messageId)?.append(chunk as never);
};

const textChunk = (delta: string) => ({ type: 'text-delta', id: 't1', delta });

const makeContext = (messageId: string) => ({
  params: Promise.resolve({ messageId }),
});

const readSSEBody = async (response: Response): Promise<string> => response.text();

describe('GET /api/ai/chat/stream-join/[messageId]', () => {
  beforeEach(() => {
    testRegistry = new StreamChannelRegistry();
    vi.clearAllMocks();

    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockSessionAuth());
    vi.mocked(isAuthError).mockReturnValue(false);
    // Default: the caller owns the stream (canSubscribeToStream short-circuits on that).
    mockCanSubscribeToStream.mockResolvedValue(true);
    vi.mocked(canUserViewPage).mockResolvedValue(true);
    mockSessionRow.mockResolvedValue([]);
    // Default: a follower that yields an already-finished, empty channel, so a case that does
    // not care about the remote path still terminates promptly.
    mockAcquireRemoteChannel.mockImplementation((id: string) => {
      const channel = openStreamChannel({ messageId: id });
      channel.finish(false);
      return { channel, release: mockRemoteRelease };
    });
  });

  describe('authentication', () => {
    it('given unauthenticated request, should return 401', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthFailure(401));
      vi.mocked(isAuthError).mockReturnValue(true);

      const response = await GET(makeRequest(), makeContext(mockMessageId));

      expect(response.status).toBe(401);
    });

    it('given unauthenticated request, should emit authz.access.denied audit event', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthFailure(401));
      vi.mocked(isAuthError).mockReturnValue(true);

      await GET(makeRequest(), makeContext(mockMessageId));

      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({
          eventType: 'authz.access.denied',
          resourceType: 'ai_stream',
          details: expect.objectContaining({ reason: 'auth_failed' }),
        }),
      );
    });
  });

  describe('stream lookup', () => {
    it('given an unknown messageId, should return 404', async () => {
      // No registry entry AND no session row — the only honest 404.
      const response = await GET(makeRequest(), makeContext(mockMessageId));

      expect(response.status).toBe(404);
    });

    it('given an already-finished messageId, should return 404', async () => {
      testRegistry.open(mockMessageId, mockMeta);
      testRegistry.close(mockMessageId);
      // Entry is deleted — subscribe() returns null

      const response = await GET(makeRequest(), makeContext(mockMessageId));

      expect(response.status).toBe(404);
    });
  });

  /**
   * THE ORDERING THIS LEAF EXISTS TO FIX.
   *
   * The registry lookup used to sit AHEAD of the authz block — structurally, because the authz
   * inputs (pageId, conversationId, the stream's owner) lived in the same in-memory entry as
   * the frames. At N>1 a registry miss is the ORDINARY case, so an entire class of live streams
   * 404'd before anyone asked who the caller was. These pin that a DB-sourced context runs the
   * SAME authz block, verbatim, over the SAME `StreamMeta` shape.
   */
  describe('cross-instance authorization (registry miss, session row present)', () => {
    const remoteRow = (over: Record<string, unknown> = {}) => [{
      channelId: mockPageId,
      userId: 'user-other',
      displayName: 'Someone Else',
      conversationId: mockConversationId,
      browserSessionId: 'session-other',
      status: 'streaming',
      ...over,
    }];

    it('runs canUserViewPage against the pageId the ROW carries, not an in-memory entry', async () => {
      mockSessionRow.mockResolvedValue(remoteRow());

      await GET(makeRequest(), makeContext(mockMessageId));

      expect(canUserViewPage).toHaveBeenCalledWith(mockUserId, mockPageId);
    });

    it('runs canSubscribeToStream with the row\'s OWNER, so a co-member\'s private conversation is still private', async () => {
      mockSessionRow.mockResolvedValue(remoteRow());

      await GET(makeRequest(), makeContext(mockMessageId));

      expect(mockCanSubscribeToStream).toHaveBeenCalledWith({
        userId: mockUserId,
        streamOwnerId: 'user-other',
        conversationId: mockConversationId,
      });
    });

    it('given no page access to a remote stream, 403s — the same audited denial a local one gets', async () => {
      mockSessionRow.mockResolvedValue(remoteRow());
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      const response = await GET(makeRequest(), makeContext(mockMessageId));

      expect(response.status).toBe(403);
    });

    it('given page access but no conversation access, 404s without an audit denial', async () => {
      // Deliberately NOT an audited 403: a member asking for a co-member's private stream is
      // the ordinary consequence of a page-wide broadcast, and auditing it would write a row
      // per member per assistant message.
      mockSessionRow.mockResolvedValue(remoteRow());
      mockCanSubscribeToStream.mockResolvedValue(false);

      const response = await GET(makeRequest(), makeContext(mockMessageId));

      expect(response.status).toBe(404);
      expect(auditRequest).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ eventType: 'authz.access.denied' }),
      );
    });

    it('given a global-assistant channel owned by someone else, 403s on the synthetic channel id', async () => {
      // `parseGlobalChannelId` short-circuits page access for `user:<id>:global` channels, and
      // it now runs over a channelId that came from the DB. A row belonging to another user's
      // global assistant must not be joinable.
      mockSessionRow.mockResolvedValue(remoteRow({ channelId: 'user:user-other:global' }));

      const response = await GET(makeRequest(), makeContext(mockMessageId));

      expect(response.status).toBe(403);
    });

    it('given a locally-owned channel, never reads the session row at all', async () => {
      testRegistry.open(mockMessageId, mockMeta);

      await GET(makeRequest(), makeContext(mockMessageId));

      expect(mockSessionRow).not.toHaveBeenCalled();
    });
  });

  /**
   * SERVING a remote stream.
   *
   * The route body is deliberately NOT forked here: a follower tails the durable frame log and
   * presents it as an ordinary `StreamChannel`, so the SSE framing, the ping, the recheck, the
   * teardown and the overflow semantics below are one code path for both sources. These cases
   * pin that the follower is wired in and released, not the follower's own behaviour
   * (`remote-frame-follower.test.ts` covers that).
   */
  describe('serving a remote stream through the follower', () => {
    const remoteRow = () => [{
      channelId: mockPageId,
      userId: mockUserId,
      displayName: mockDisplayName,
      conversationId: mockConversationId,
      browserSessionId: mockBrowserSessionId,
      status: 'streaming',
    }];

    it('given a remote stream, serves its frames instead of 404ing', async () => {
      mockSessionRow.mockResolvedValue(remoteRow());
      mockAcquireRemoteChannel.mockImplementation((id: string) => {
        const channel = openStreamChannel({ messageId: id });
        channel.append(textChunk('from the durable log') as never);
        channel.finish(false);
        return { channel, release: mockRemoteRelease };
      });

      const response = await GET(makeRequest(), makeContext(mockMessageId));
      const body = await readSSEBody(response);

      expect(response.status).toBe(200);
      expect(body).toContain(`data: ${JSON.stringify({ seq: 0, chunk: textChunk('from the durable log') })}\n\n`);
    });

    it('labels the response with where the frames came from', async () => {
      mockSessionRow.mockResolvedValue(remoteRow());

      const response = await GET(makeRequest(), makeContext(mockMessageId));

      // An N=2 smoke test has no other way to PROVE it exercised the follower rather than
      // getting lucky with the load balancer; in production the remote share should sit near
      // (N-1)/N.
      expect(response.headers.get('X-Stream-Join-Source')).toBe('remote');
    });

    it('labels a locally-owned join as local', async () => {
      testRegistry.open(mockMessageId, mockMeta);

      const response = await GET(makeRequest(), makeContext(mockMessageId));

      expect(response.headers.get('X-Stream-Join-Source')).toBe('local');
    });

    it('labels a terminal join as terminal, and follows it rather than 404ing', async () => {
      // Frames are deleted on the terminal write, so a terminal row is exactly the case where
      // the follower's honest-answer logic is needed — not a case to short-circuit.
      mockSessionRow.mockResolvedValue([{ ...remoteRow()[0], status: 'complete' }]);

      const response = await GET(makeRequest(), makeContext(mockMessageId));

      expect(response.status).toBe(200);
      expect(response.headers.get('X-Stream-Join-Source')).toBe('terminal');
    });

    it('given a truncated end, tells the client to RELOAD rather than sending a bare done', async () => {
      mockSessionRow.mockResolvedValue(remoteRow());
      mockAcquireRemoteChannel.mockImplementation((id: string) => {
        const channel = openStreamChannel({ messageId: id });
        channel.append(textChunk('a prefix') as never);
        channel.finish(false, { truncated: true });
        return { channel, release: mockRemoteRelease };
      });

      const body = await readSSEBody(await GET(makeRequest(), makeContext(mockMessageId)));

      // A bare `done` would leave a short reply on screen looking whole. `reload` is a different
      // answer from `resumeFromSeq`: there is no seq to resume from, only a durable message to
      // re-read.
      expect(body).toContain('data: {"done":true,"aborted":false,"reload":true}\n\n');
    });

    it('releases the follower reference when the stream ends', async () => {
      mockSessionRow.mockResolvedValue(remoteRow());
      mockAcquireRemoteChannel.mockImplementation((id: string) => {
        const channel = openStreamChannel({ messageId: id });
        channel.finish(false);
        return { channel, release: mockRemoteRelease };
      });

      await readSSEBody(await GET(makeRequest(), makeContext(mockMessageId)));

      // A leaked reference keeps a poller hitting Postgres for a reader that has already gone.
      expect(mockRemoteRelease).toHaveBeenCalled();
    });

    it('releases the follower reference when the client disconnects', async () => {
      mockSessionRow.mockResolvedValue(remoteRow());
      const controller = new AbortController();
      mockAcquireRemoteChannel.mockImplementation((id: string) => ({
        channel: openStreamChannel({ messageId: id }),
        release: mockRemoteRelease,
      }));

      const response = await GET(makeRequest(controller.signal), makeContext(mockMessageId));
      const reader = response.body!.getReader();
      controller.abort();
      await reader.read().catch(() => undefined);

      expect(mockRemoteRelease).toHaveBeenCalled();
    });

    it('never acquires a follower for a locally-owned stream', async () => {
      testRegistry.open(mockMessageId, mockMeta);

      await GET(makeRequest(), makeContext(mockMessageId));

      expect(mockAcquireRemoteChannel).not.toHaveBeenCalled();
    });

    it('never acquires a follower for a caller who may not subscribe', async () => {
      mockSessionRow.mockResolvedValue(remoteRow());
      mockCanSubscribeToStream.mockResolvedValue(false);

      await GET(makeRequest(), makeContext(mockMessageId));

      // Acquiring first would start a poller — and a DB read loop over another member's private
      // conversation — for a request that is about to 404.
      expect(mockAcquireRemoteChannel).not.toHaveBeenCalled();
    });

    it('given the success-path audit throws, releases the subscription and the follower before the error propagates', async () => {
      mockSessionRow.mockResolvedValue(remoteRow());
      let followedChannel: ReturnType<typeof openStreamChannel> | null = null;
      mockAcquireRemoteChannel.mockImplementation((id: string) => {
        followedChannel = openStreamChannel({ messageId: id });
        return { channel: followedChannel, release: mockRemoteRelease };
      });
      // auditRequest is synchronous up to its DB write, so its failure is a thrown error on
      // the success path — the last point where BOTH holds (the subscription and this
      // reader's follower reference) are live and nothing else will release them.
      vi.mocked(auditRequest).mockImplementation((_request, event) => {
        if (event.eventType === 'authz.access.granted') throw new Error('audit pipeline exploded');
      });

      await expect(GET(makeRequest(), makeContext(mockMessageId)))
        .rejects.toThrow('audit pipeline exploded');

      // "Dropped in EVERY exit, not only the happy one" — an exception is an exit too.
      expect(mockRemoteRelease).toHaveBeenCalledTimes(1);
      expect(followedChannel!.subscriberCount).toBe(0);
      // clearAllMocks does not undo mockImplementation, and a throwing audit left behind
      // would fail every case that runs after this one.
      vi.mocked(auditRequest).mockReset();
    });
  });

  describe('authorization', () => {
    it('given a user without view access, should return 403', async () => {
      testRegistry.open(mockMessageId, mockMeta);
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      const response = await GET(makeRequest(), makeContext(mockMessageId));

      expect(response.status).toBe(403);
    });

    it('given a user without view access, should emit authz.access.denied audit event', async () => {
      testRegistry.open(mockMessageId, mockMeta);
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      await GET(makeRequest(), makeContext(mockMessageId));

      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({
          eventType: 'authz.access.denied',
          resourceType: 'ai_stream',
          resourceId: mockMessageId,
          details: expect.objectContaining({ reason: 'insufficient_permissions', pageId: mockPageId }),
        }),
      );
    });

    it('should check permission against the pageId from stream metadata', async () => {
      testRegistry.open(mockMessageId, mockMeta);

      await GET(makeRequest(), makeContext(mockMessageId));
      testRegistry.close(mockMessageId);

      expect(canUserViewPage).toHaveBeenCalledWith(mockUserId, mockPageId);
    });

    it('given a global channel pageId owned by the requesting user, should allow without calling canUserViewPage', async () => {
      const globalMeta = { ...mockMeta, pageId: `user:${mockUserId}:global` };
      testRegistry.open(mockMessageId, globalMeta);

      const response = await GET(makeRequest(), makeContext(mockMessageId));
      testRegistry.close(mockMessageId);

      expect(response.status).toBe(200);
      expect(canUserViewPage).not.toHaveBeenCalled();
    });

    it('given a global channel pageId owned by a different user, should return 403', async () => {
      const globalMeta = { ...mockMeta, pageId: `user:other-user-999:global` };
      testRegistry.open(mockMessageId, globalMeta);

      const response = await GET(makeRequest(), makeContext(mockMessageId));

      expect(response.status).toBe(403);
      expect(canUserViewPage).not.toHaveBeenCalled();
    });
  });

  // Page access is NOT conversation access. A page room holds every member of the page,
  // but conversations are private by default — `listConversations` shows you only
  // `userId = you OR isShared`. Stream subscription now follows the same rule, so these
  // are the two paths that matter and neither had route-level coverage before.
  describe('conversation-scoped subscription', () => {
    beforeEach(() => {
      testRegistry.open(mockMessageId, mockMeta);
    });

    it("given another member's stream in an explicitly SHARED conversation, should still join (multiplayer must not regress)", async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockSessionAuth('user-other'));
      vi.mocked(canUserViewPage).mockResolvedValue(true);
      mockCanSubscribeToStream.mockResolvedValue(true);

      const response = await GET(makeRequest(), makeContext(mockMessageId));

      expect(response.status).toBe(200);
      expect(mockCanSubscribeToStream).toHaveBeenCalledWith({
        userId: 'user-other',
        streamOwnerId: mockUserId,
        conversationId: mockConversationId,
      });
    });

    it("given another member's stream in a PRIVATE conversation, should NOT serve it", async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockSessionAuth('user-other'));
      vi.mocked(canUserViewPage).mockResolvedValue(true);
      mockCanSubscribeToStream.mockResolvedValue(false);

      const response = await GET(makeRequest(), makeContext(mockMessageId));

      expect(response.status).toBe(404);
    });

    // Deliberately a 404, not an audited 403. A member asking for a co-member's private
    // stream is the ordinary consequence of a page-wide broadcast, not an attack —
    // auditing it would write an authz-denial row per member per assistant message and
    // bury real signal. A genuine page-access violation still 403s and still audits.
    it('given a non-subscribable stream, should NOT write an authz-denial audit row', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockSessionAuth('user-other'));
      vi.mocked(canUserViewPage).mockResolvedValue(true);
      mockCanSubscribeToStream.mockResolvedValue(false);

      await GET(makeRequest(), makeContext(mockMessageId));

      expect(vi.mocked(auditRequest)).not.toHaveBeenCalled();
    });

    it('given the caller has no page access at all, should still 403 AND audit', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockSessionAuth('user-other'));
      vi.mocked(canUserViewPage).mockResolvedValue(false);
      mockCanSubscribeToStream.mockResolvedValue(true);

      const response = await GET(makeRequest(), makeContext(mockMessageId));

      expect(response.status).toBe(403);
      expect(vi.mocked(auditRequest)).toHaveBeenCalled();
    });
  });

  describe('SSE streaming', () => {
    it('given a valid messageId and authorized viewer, should return SSE response headers', async () => {
      testRegistry.open(mockMessageId, mockMeta);

      const response = await GET(makeRequest(), makeContext(mockMessageId));
      testRegistry.close(mockMessageId);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
      expect(response.headers.get('Cache-Control')).toBe('no-cache');
      expect(response.headers.get('X-Accel-Buffering')).toBe('no');
    });

    it('given a successful stream join, should emit an authz.access.granted audit event', async () => {
      testRegistry.open(mockMessageId, mockMeta);

      await GET(makeRequest(), makeContext(mockMessageId));
      testRegistry.close(mockMessageId);

      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({
          eventType: 'authz.access.granted',
          resourceType: 'ai_stream',
          resourceId: mockMessageId,
          details: expect.objectContaining({ pageId: mockPageId }),
        }),
      );
    });

    it('given buffered frames, should stream them as seq-addressed SSE frames', async () => {
      testRegistry.open(mockMessageId, mockMeta);
      appendTo(mockMessageId, textChunk('hello'));
      appendTo(mockMessageId, textChunk(' world'));

      const response = await GET(makeRequest(), makeContext(mockMessageId));
      testRegistry.close(mockMessageId);

      const body = await readSSEBody(response);

      // seq-addressed raw frames, not rendered parts — and the seq is what lets a rejoining
      // client say exactly where to resume instead of being told how many frames to skip.
      expect(body).toContain(`data: ${JSON.stringify({ seq: 0, chunk: textChunk('hello') })}\n\n`);
      expect(body).toContain(`data: ${JSON.stringify({ seq: 1, chunk: textChunk(' world') })}\n\n`);
    });

    it('given a tool frame, should stream it verbatim, preserving the full shape', async () => {
      testRegistry.open(mockMessageId, mockMeta);
      const toolChunk = {
        type: 'tool-output-available',
        toolCallId: 'tc1',
        output: { pages: [] },
      } as const;
      appendTo(mockMessageId, toolChunk as never);

      const response = await GET(makeRequest(), makeContext(mockMessageId));
      testRegistry.close(mockMessageId);

      const body = await readSSEBody(response);

      expect(body).toContain(`data: ${JSON.stringify({ seq: 0, chunk: toolChunk })}\n\n`);
    });

    it('given stream completion, should send [DONE] sentinel and close', async () => {
      testRegistry.open(mockMessageId, mockMeta);

      const response = await GET(makeRequest(), makeContext(mockMessageId));
      testRegistry.close(mockMessageId);

      const body = await readSSEBody(response);

      expect(body).toContain('data: {"done":true,"aborted":false}\n\n');
    });

    it('given stream aborted, should send done sentinel with aborted=true', async () => {
      testRegistry.open(mockMessageId, mockMeta);

      const response = await GET(makeRequest(), makeContext(mockMessageId));
      testRegistry.close(mockMessageId, true);

      const body = await readSSEBody(response);

      expect(body).toContain('data: {"done":true,"aborted":true}\n\n');
    });

    it('given live parts pushed after subscribe, should stream them in order', async () => {
      testRegistry.open(mockMessageId, mockMeta);
      appendTo(mockMessageId, textChunk('buffered'));

      const response = await GET(makeRequest(), makeContext(mockMessageId));

      appendTo(mockMessageId, textChunk('live'));
      testRegistry.close(mockMessageId);

      const body = await readSSEBody(response);

      expect(body).toContain(`data: ${JSON.stringify({ seq: 0, chunk: textChunk('buffered') })}\n\n`);
      expect(body).toContain(`data: ${JSON.stringify({ seq: 1, chunk: textChunk('live') })}\n\n`);
      expect(body).toContain('data: {"done":true,"aborted":false}\n\n');
    });

    it('given the channel is closed between the meta lookup and the subscribe, should 404', async () => {
      // The narrow race the route has to survive: `getMeta` answers (the stream was known) but
      // the channel is gone by the time we ask for it. Under the old registry this surfaced as
      // `subscribe` returning null; the channel registry makes it a plain absent entry, so the
      // route's own `if (!channel) 404` covers it without a special case.
      const spyRegistry = new StreamChannelRegistry();
      spyRegistry.open(mockMessageId, mockMeta);
      const getMetaSpy = vi.spyOn(spyRegistry, 'getMeta').mockReturnValue(mockMeta);
      spyRegistry.close(mockMessageId);

      testRegistry = spyRegistry;

      const response = await GET(makeRequest(), makeContext(mockMessageId));

      expect(response.status).toBe(404);
      getMetaSpy.mockRestore();
    });
  });

  describe('permission recheck (revocation backstop)', () => {
    const RECHECK_INTERVAL_MS = 5000;

    afterEach(() => {
      vi.useRealTimers();
    });

    it('given permission is revoked before the first recheck tick, should send a done+aborted frame and stop pushing further chunks', async () => {
      vi.useFakeTimers();
      let allowed = true;
      vi.mocked(canUserViewPage).mockImplementation(async () => allowed);
      testRegistry.open(mockMessageId, mockMeta);

      const response = await GET(makeRequest(), makeContext(mockMessageId));
      expect(response.status).toBe(200);

      allowed = false;
      await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS);

      // Further pushes after revocation must not reach the (already-closed) response body.
      appendTo(mockMessageId, textChunk('after-revoke'));

      const body = await readSSEBody(response);

      expect(body).toContain('data: {"done":true,"aborted":true}\n\n');
      expect(body).not.toContain('after-revoke');
    });

    // THE OTHER HALF OF THE BACKSTOP. `hasViewAccess()` is `pageOk && canSubscribe()`, and every
    // test in this block only ever varied canUserViewPage — canSubscribeToStream was pinned true
    // in beforeEach and never flipped. So `return canSubscribe();` could be deleted from
    // hasViewAccess and the whole suite stayed green, while a conversation UN-SHARED mid-stream
    // kept streaming, token by token, to someone who may no longer read it. Page access and
    // conversation access are revoked independently; both halves must hold, on every tick.
    it('given the conversation is UN-SHARED mid-stream, should abort the join even though page access still holds', async () => {
      vi.useFakeTimers();
      vi.mocked(canUserViewPage).mockResolvedValue(true); // page access never lapses
      let subscribable = true;
      mockCanSubscribeToStream.mockImplementation(async () => subscribable);
      testRegistry.open(mockMessageId, mockMeta);

      const response = await GET(makeRequest(), makeContext(mockMessageId));
      expect(response.status).toBe(200);

      // The owner flips the conversation back to private while this subscriber is mid-stream.
      subscribable = false;
      await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS);

      appendTo(mockMessageId, textChunk('after-unshare'));

      const body = await readSSEBody(response);

      expect(body).toContain('data: {"done":true,"aborted":true}\n\n');
      expect(body).not.toContain('after-unshare');
    });

    it('given permission is revoked mid-stream, should unsubscribe from the registry', async () => {
      vi.useFakeTimers();
      let allowed = true;
      vi.mocked(canUserViewPage).mockImplementation(async () => allowed);
      testRegistry.open(mockMessageId, mockMeta);

      await GET(makeRequest(), makeContext(mockMessageId));

      allowed = false;
      await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS);

      // finish() notifies subscribers via onComplete; if the route already unsubscribed,
      // this must not throw and must not double-close the (already-closed) controller.
      expect(() => testRegistry.close(mockMessageId)).not.toThrow();
    });

    it('given permission remains granted at recheck time, should keep the stream open and continue delivering chunks', async () => {
      vi.useFakeTimers();
      vi.mocked(canUserViewPage).mockResolvedValue(true);
      testRegistry.open(mockMessageId, mockMeta);

      const response = await GET(makeRequest(), makeContext(mockMessageId));

      await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS);

      appendTo(mockMessageId, textChunk('still-allowed'));
      testRegistry.close(mockMessageId);

      const body = await readSSEBody(response);

      expect(body).toContain(`data: ${JSON.stringify({ seq: 0, chunk: textChunk('still-allowed') })}\n\n`);
      expect(body).toContain('data: {"done":true,"aborted":false}\n\n');
    });

    it('given the stream finishes naturally before any recheck fires, should clear the recheck interval', async () => {
      vi.useFakeTimers();
      vi.mocked(canUserViewPage).mockResolvedValue(true);
      testRegistry.open(mockMessageId, mockMeta);

      await GET(makeRequest(), makeContext(mockMessageId));
      testRegistry.close(mockMessageId);

      vi.mocked(canUserViewPage).mockClear();
      await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS * 3);

      // No leaked interval still polling after the stream naturally finished.
      expect(canUserViewPage).not.toHaveBeenCalled();
    });

    it('given a slow permission check, should not start a second overlapping check before the first resolves', async () => {
      vi.useFakeTimers();
      let resolveRecheck!: (allowed: boolean) => void;
      let callCount = 0;
      vi.mocked(canUserViewPage).mockImplementation(() => {
        callCount += 1;
        // Call #1 is the initial join-time gate check — resolve it immediately
        // so the stream actually starts; only the recheck ticks are made slow.
        if (callCount === 1) return Promise.resolve(true);
        return new Promise((res) => { resolveRecheck = res; });
      });
      testRegistry.open(mockMessageId, mockMeta);

      const response = await GET(makeRequest(), makeContext(mockMessageId));

      // First recheck tick fires; canUserViewPage is now pending (not yet resolved).
      await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS);
      expect(canUserViewPage).toHaveBeenCalledTimes(2);

      // Advancing well past another interval must not start a second recheck —
      // the next one is only scheduled once the pending check resolves.
      await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS * 3);
      expect(canUserViewPage).toHaveBeenCalledTimes(2);

      resolveRecheck(true);
      await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS);
      expect(canUserViewPage).toHaveBeenCalledTimes(3);

      testRegistry.close(mockMessageId);
      await readSSEBody(response);
    });

    it('given the permission recheck throws (e.g. a transient DB error), should fail closed: close the stream and emit a denial audit event', async () => {
      vi.useFakeTimers();
      vi.mocked(canUserViewPage)
        .mockResolvedValueOnce(true) // initial join-time gate check
        .mockRejectedValueOnce(new Error('DB connection lost')); // first recheck tick
      testRegistry.open(mockMessageId, mockMeta);

      const response = await GET(makeRequest(), makeContext(mockMessageId));

      await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS);

      const body = await readSSEBody(response);

      expect(body).toContain('data: {"done":true,"aborted":true}\n\n');
      expect(auditRequest).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({
          eventType: 'authz.access.denied',
          resourceType: 'ai_stream',
          resourceId: mockMessageId,
          details: expect.objectContaining({ reason: 'permission_recheck_failed', pageId: mockPageId }),
        }),
      );
    });

    it('given the permission recheck throws, should not schedule a further recheck (no leaked timer)', async () => {
      vi.useFakeTimers();
      vi.mocked(canUserViewPage)
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(new Error('DB connection lost'));
      testRegistry.open(mockMessageId, mockMeta);

      await GET(makeRequest(), makeContext(mockMessageId));
      await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS);

      vi.mocked(canUserViewPage).mockClear();
      await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS * 3);

      expect(canUserViewPage).not.toHaveBeenCalled();
    });
  });

  describe('client disconnect', () => {
    it('given client disconnect, should unsubscribe without leaking resources', async () => {
      const abortController = new AbortController();
      testRegistry.open(mockMessageId, mockMeta);

      const response = await GET(makeRequest(abortController.signal), makeContext(mockMessageId));
      expect(response.status).toBe(200);

      // Abort the connection — should call unsubscribe() on the registry subscriber
      abortController.abort();

      // Allow event loop to process the abort event
      await Promise.resolve();

      // Registry finish should not error even though route subscriber was removed
      expect(() => testRegistry.close(mockMessageId)).not.toThrow();
    });

    it('given already-aborted signal, should close the stream eagerly without leaking the subscriber', async () => {
      const abortController = new AbortController();
      abortController.abort(); // aborted BEFORE GET is called
      testRegistry.open(mockMessageId, mockMeta);

      const response = await GET(makeRequest(abortController.signal), makeContext(mockMessageId));

      // start() detects signal.aborted immediately, calls unsubscribe() + controller.close()
      // so response.text() resolves to empty body without needing a finish() call
      const body = await response.text();
      expect(body).toBe('');
    });

    it('given stream completes then client disconnects, should not attempt to double-close the controller', async () => {
      const abortController = new AbortController();
      testRegistry.open(mockMessageId, mockMeta);

      const response = await GET(makeRequest(abortController.signal), makeContext(mockMessageId));
      expect(response.status).toBe(200);

      // Complete the stream first
      testRegistry.close(mockMessageId);

      // Then abort — should be a no-op, not throw
      expect(() => abortController.abort()).not.toThrow();
      await Promise.resolve();
      // No error thrown from double-close
    });
  });

  // Leaf 5.3: this connection survives today only because tokens flow continuously (route.ts
  // sends no heartbeat frames at all). A silent gap — a long tool call, deep research, an MCP
  // round-trip with no output for minutes — leaves an idle HTTP connection that any
  // intermediary (load balancer, reverse proxy, corporate network appliance) is entitled to
  // reap. `: ping` comment frames keep it alive without touching any application state.
  describe('SSE keepalive ping frames', () => {
    const PING_INTERVAL_MS = 20 * 1000;

    afterEach(() => {
      vi.useRealTimers();
    });

    it('given the stream stays open past one ping interval with no other traffic, should send a `: ping` comment frame', async () => {
      vi.useFakeTimers();
      testRegistry.open(mockMessageId, mockMeta);

      const response = await GET(makeRequest(), makeContext(mockMessageId));
      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
      testRegistry.close(mockMessageId);

      const body = await readSSEBody(response);
      expect(body).toContain(': ping\n\n');
    });

    it('given a silent multi-minute tool call, should send a ping on every tick, not just once', async () => {
      vi.useFakeTimers();
      testRegistry.open(mockMessageId, mockMeta);

      const response = await GET(makeRequest(), makeContext(mockMessageId));
      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 3);
      testRegistry.close(mockMessageId);

      const body = await readSSEBody(response);
      const pingCount = body.split(': ping\n\n').length - 1;
      expect(pingCount).toBe(3);
    });

    it('given real part traffic arrives after a ping tick, both should appear in order', async () => {
      vi.useFakeTimers();
      testRegistry.open(mockMessageId, mockMeta);

      const response = await GET(makeRequest(), makeContext(mockMessageId));
      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
      appendTo(mockMessageId, textChunk('after-ping'));
      testRegistry.close(mockMessageId);

      const body = await readSSEBody(response);
      const pingIndex = body.indexOf(': ping\n\n');
      const partIndex = body.indexOf('after-ping');
      expect(pingIndex).toBeGreaterThanOrEqual(0);
      expect(partIndex).toBeGreaterThan(pingIndex);
    });

    it('given the stream finishes naturally, should clear the ping interval (no leaked timer)', async () => {
      vi.useFakeTimers();
      testRegistry.open(mockMessageId, mockMeta);

      await GET(makeRequest(), makeContext(mockMessageId));
      // Route-level timers (the 5s recheck + 20s ping) are both pending at this point,
      // alongside the registry's own unrelated per-entry cleanup timer.
      const beforeFinish = vi.getTimerCount();
      testRegistry.close(mockMessageId);

      // finish() clears the registry's own cleanup timer too — assert only that the route's
      // two timers (recheck + ping) are gone, not the absolute count.
      expect(vi.getTimerCount()).toBeLessThanOrEqual(beforeFinish - 2);
    });

    it('given the client disconnects, should clear the ping interval (no leaked timer)', async () => {
      vi.useFakeTimers();
      const abortController = new AbortController();
      testRegistry.open(mockMessageId, mockMeta);

      await GET(makeRequest(abortController.signal), makeContext(mockMessageId));
      const beforeAbort = vi.getTimerCount();
      abortController.abort();

      // The registry's own per-entry cleanup timer is untouched by an abort (only the route's
      // subscriber unsubscribes) — assert the route's own two timers (recheck + ping) are gone.
      expect(vi.getTimerCount()).toBe(beforeAbort - 2);
    });

    it('given permission is revoked mid-stream, should clear the ping interval too, not just the recheck timer', async () => {
      vi.useFakeTimers();
      let allowed = true;
      vi.mocked(canUserViewPage).mockImplementation(async () => allowed);
      testRegistry.open(mockMessageId, mockMeta);

      await GET(makeRequest(), makeContext(mockMessageId));
      const beforeRevoke = vi.getTimerCount();
      allowed = false;
      await vi.advanceTimersByTimeAsync(5000);

      // The recheck tick that just fired consumed its own timer (already gone from the count
      // before this assertion); revocation must additionally clear the ping interval, so the
      // count should drop by at least one more beyond the recheck tick's own consumption.
      expect(vi.getTimerCount()).toBeLessThan(beforeRevoke - 1);
    });

    it('given an already-aborted signal (eager close path), should never start a ping interval', async () => {
      vi.useFakeTimers();
      const abortController = new AbortController();
      abortController.abort();
      testRegistry.open(mockMessageId, mockMeta);
      // Only the registry's own (pre-existing, unrelated) per-entry cleanup timer is pending.
      const beforeGet = vi.getTimerCount();

      await GET(makeRequest(abortController.signal), makeContext(mockMessageId));

      // The route must not have scheduled either the recheck timer or the ping interval on
      // this eager-close path — the count must not have grown at all.
      expect(vi.getTimerCount()).toBe(beforeGet);
    });
  });
});
