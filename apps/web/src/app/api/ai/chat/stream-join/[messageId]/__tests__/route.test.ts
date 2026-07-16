import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import { StreamMulticastRegistry } from '@/lib/ai/core/stream-multicast-registry';
// Fresh registry per test — module-level let, updated in beforeEach
let testRegistry: StreamMulticastRegistry;

vi.mock('@/lib/ai/core/stream-multicast-registry', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ai/core/stream-multicast-registry')>(
    '@/lib/ai/core/stream-multicast-registry',
  );
  return {
    ...actual,
    get streamMulticastRegistry() {
      return testRegistry;
    },
  };
});

vi.mock('@/lib/auth/request-auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
}));
vi.mock('@/lib/auth/auth-core', () => ({
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserViewPage: vi.fn(),
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

import { GET } from '../route';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import type { SessionAuthResult, AuthError } from '@/lib/auth/auth-types';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError } from '@/lib/auth/auth-core';

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

const makeContext = (messageId: string) => ({
  params: Promise.resolve({ messageId }),
});

const readSSEBody = async (response: Response): Promise<string> => response.text();

describe('GET /api/ai/chat/stream-join/[messageId]', () => {
  beforeEach(() => {
    testRegistry = new StreamMulticastRegistry();
    vi.clearAllMocks();

    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockSessionAuth());
    vi.mocked(isAuthError).mockReturnValue(false);
    // Default: the caller owns the stream (canSubscribeToStream short-circuits on that).
    mockCanSubscribeToStream.mockResolvedValue(true);
    vi.mocked(canUserViewPage).mockResolvedValue(true);
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
      // Registry has no entry for mockMessageId
      const response = await GET(makeRequest(), makeContext(mockMessageId));

      expect(response.status).toBe(404);
    });

    it('given an already-finished messageId, should return 404', async () => {
      testRegistry.register(mockMessageId, mockMeta);
      testRegistry.finish(mockMessageId);
      // Entry is deleted — subscribe() returns null

      const response = await GET(makeRequest(), makeContext(mockMessageId));

      expect(response.status).toBe(404);
    });
  });

  describe('authorization', () => {
    it('given a user without view access, should return 403', async () => {
      testRegistry.register(mockMessageId, mockMeta);
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      const response = await GET(makeRequest(), makeContext(mockMessageId));

      expect(response.status).toBe(403);
    });

    it('given a user without view access, should emit authz.access.denied audit event', async () => {
      testRegistry.register(mockMessageId, mockMeta);
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
      testRegistry.register(mockMessageId, mockMeta);

      await GET(makeRequest(), makeContext(mockMessageId));
      testRegistry.finish(mockMessageId);

      expect(canUserViewPage).toHaveBeenCalledWith(mockUserId, mockPageId);
    });

    it('given a global channel pageId owned by the requesting user, should allow without calling canUserViewPage', async () => {
      const globalMeta = { ...mockMeta, pageId: `user:${mockUserId}:global` };
      testRegistry.register(mockMessageId, globalMeta);

      const response = await GET(makeRequest(), makeContext(mockMessageId));
      testRegistry.finish(mockMessageId);

      expect(response.status).toBe(200);
      expect(canUserViewPage).not.toHaveBeenCalled();
    });

    it('given a global channel pageId owned by a different user, should return 403', async () => {
      const globalMeta = { ...mockMeta, pageId: `user:other-user-999:global` };
      testRegistry.register(mockMessageId, globalMeta);

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
      testRegistry.register(mockMessageId, mockMeta);
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
      testRegistry.register(mockMessageId, mockMeta);

      const response = await GET(makeRequest(), makeContext(mockMessageId));
      testRegistry.finish(mockMessageId);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
      expect(response.headers.get('Cache-Control')).toBe('no-cache');
      expect(response.headers.get('X-Accel-Buffering')).toBe('no');
    });

    it('given a successful stream join, should emit an authz.access.granted audit event', async () => {
      testRegistry.register(mockMessageId, mockMeta);

      await GET(makeRequest(), makeContext(mockMessageId));
      testRegistry.finish(mockMessageId);

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

    it('given buffered parts, should stream them as SSE part frames', async () => {
      testRegistry.register(mockMessageId, mockMeta);
      testRegistry.push(mockMessageId, { type: 'text', text: 'hello' });
      testRegistry.push(mockMessageId, { type: 'text', text: ' world' });

      const response = await GET(makeRequest(), makeContext(mockMessageId));
      testRegistry.finish(mockMessageId);

      const body = await readSSEBody(response);

      expect(body).toContain('data: {"part":{"type":"text","text":"hello"}}\n\n');
      expect(body).toContain('data: {"part":{"type":"text","text":" world"}}\n\n');
    });

    it('given a tool part, should stream it as an SSE part frame preserving the full tool shape', async () => {
      testRegistry.register(mockMessageId, mockMeta);
      const toolPart = {
        type: 'tool-list_pages',
        toolCallId: 'tc1',
        toolName: 'list_pages',
        state: 'output-available',
        input: { driveId: 'd1' },
        output: { pages: [] },
      } as const;
      testRegistry.push(mockMessageId, toolPart as never);

      const response = await GET(makeRequest(), makeContext(mockMessageId));
      testRegistry.finish(mockMessageId);

      const body = await readSSEBody(response);

      expect(body).toContain(`data: ${JSON.stringify({ part: toolPart })}\n\n`);
    });

    it('given stream completion, should send [DONE] sentinel and close', async () => {
      testRegistry.register(mockMessageId, mockMeta);

      const response = await GET(makeRequest(), makeContext(mockMessageId));
      testRegistry.finish(mockMessageId);

      const body = await readSSEBody(response);

      expect(body).toContain('data: {"done":true,"aborted":false}\n\n');
    });

    it('given stream aborted, should send done sentinel with aborted=true', async () => {
      testRegistry.register(mockMessageId, mockMeta);

      const response = await GET(makeRequest(), makeContext(mockMessageId));
      testRegistry.finish(mockMessageId, true);

      const body = await readSSEBody(response);

      expect(body).toContain('data: {"done":true,"aborted":true}\n\n');
    });

    it('given live parts pushed after subscribe, should stream them in order', async () => {
      testRegistry.register(mockMessageId, mockMeta);
      testRegistry.push(mockMessageId, { type: 'text', text: 'buffered' });

      const response = await GET(makeRequest(), makeContext(mockMessageId));

      testRegistry.push(mockMessageId, { type: 'text', text: 'live' });
      testRegistry.finish(mockMessageId);

      const body = await readSSEBody(response);

      expect(body).toContain('data: {"part":{"type":"text","text":"buffered"}}\n\n');
      expect(body).toContain('data: {"part":{"type":"text","text":"live"}}\n\n');
      expect(body).toContain('data: {"done":true,"aborted":false}\n\n');
    });

    it('given a race where subscribe returns null, should return 404', async () => {
      // getMeta succeeds (stream registered) but subscribe returns null
      // Simulate by registering, getting meta, then finishing before route subscribes.
      // We achieve this by overriding getMeta to return meta while subscribe sees finished state.
      // Simplest: use the registry — register, finish, re-set getMeta via spy.
      const spyRegistry = new StreamMulticastRegistry();
      spyRegistry.register(mockMessageId, mockMeta);

      // getMeta returns meta even after finish by using a spy
      const getMetaSpy = vi.spyOn(spyRegistry, 'getMeta').mockReturnValue(mockMeta);
      spyRegistry.finish(mockMessageId); // subscribe will now return null

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
      testRegistry.register(mockMessageId, mockMeta);

      const response = await GET(makeRequest(), makeContext(mockMessageId));
      expect(response.status).toBe(200);

      allowed = false;
      await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS);

      // Further pushes after revocation must not reach the (already-closed) response body.
      testRegistry.push(mockMessageId, { type: 'text', text: 'after-revoke' });

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
      testRegistry.register(mockMessageId, mockMeta);

      const response = await GET(makeRequest(), makeContext(mockMessageId));
      expect(response.status).toBe(200);

      // The owner flips the conversation back to private while this subscriber is mid-stream.
      subscribable = false;
      await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS);

      testRegistry.push(mockMessageId, { type: 'text', text: 'after-unshare' });

      const body = await readSSEBody(response);

      expect(body).toContain('data: {"done":true,"aborted":true}\n\n');
      expect(body).not.toContain('after-unshare');
    });

    it('given permission is revoked mid-stream, should unsubscribe from the registry', async () => {
      vi.useFakeTimers();
      let allowed = true;
      vi.mocked(canUserViewPage).mockImplementation(async () => allowed);
      testRegistry.register(mockMessageId, mockMeta);

      await GET(makeRequest(), makeContext(mockMessageId));

      allowed = false;
      await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS);

      // finish() notifies subscribers via onComplete; if the route already unsubscribed,
      // this must not throw and must not double-close the (already-closed) controller.
      expect(() => testRegistry.finish(mockMessageId)).not.toThrow();
    });

    it('given permission remains granted at recheck time, should keep the stream open and continue delivering chunks', async () => {
      vi.useFakeTimers();
      vi.mocked(canUserViewPage).mockResolvedValue(true);
      testRegistry.register(mockMessageId, mockMeta);

      const response = await GET(makeRequest(), makeContext(mockMessageId));

      await vi.advanceTimersByTimeAsync(RECHECK_INTERVAL_MS);

      testRegistry.push(mockMessageId, { type: 'text', text: 'still-allowed' });
      testRegistry.finish(mockMessageId);

      const body = await readSSEBody(response);

      expect(body).toContain('data: {"part":{"type":"text","text":"still-allowed"}}\n\n');
      expect(body).toContain('data: {"done":true,"aborted":false}\n\n');
    });

    it('given the stream finishes naturally before any recheck fires, should clear the recheck interval', async () => {
      vi.useFakeTimers();
      vi.mocked(canUserViewPage).mockResolvedValue(true);
      testRegistry.register(mockMessageId, mockMeta);

      await GET(makeRequest(), makeContext(mockMessageId));
      testRegistry.finish(mockMessageId);

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
      testRegistry.register(mockMessageId, mockMeta);

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

      testRegistry.finish(mockMessageId);
      await readSSEBody(response);
    });

    it('given the permission recheck throws (e.g. a transient DB error), should fail closed: close the stream and emit a denial audit event', async () => {
      vi.useFakeTimers();
      vi.mocked(canUserViewPage)
        .mockResolvedValueOnce(true) // initial join-time gate check
        .mockRejectedValueOnce(new Error('DB connection lost')); // first recheck tick
      testRegistry.register(mockMessageId, mockMeta);

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
      testRegistry.register(mockMessageId, mockMeta);

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
      testRegistry.register(mockMessageId, mockMeta);

      const response = await GET(makeRequest(abortController.signal), makeContext(mockMessageId));
      expect(response.status).toBe(200);

      // Abort the connection — should call unsubscribe() on the registry subscriber
      abortController.abort();

      // Allow event loop to process the abort event
      await Promise.resolve();

      // Registry finish should not error even though route subscriber was removed
      expect(() => testRegistry.finish(mockMessageId)).not.toThrow();
    });

    it('given already-aborted signal, should close the stream eagerly without leaking the subscriber', async () => {
      const abortController = new AbortController();
      abortController.abort(); // aborted BEFORE GET is called
      testRegistry.register(mockMessageId, mockMeta);

      const response = await GET(makeRequest(abortController.signal), makeContext(mockMessageId));

      // start() detects signal.aborted immediately, calls unsubscribe() + controller.close()
      // so response.text() resolves to empty body without needing a finish() call
      const body = await response.text();
      expect(body).toBe('');
    });

    it('given stream completes then client disconnects, should not attempt to double-close the controller', async () => {
      const abortController = new AbortController();
      testRegistry.register(mockMessageId, mockMeta);

      const response = await GET(makeRequest(abortController.signal), makeContext(mockMessageId));
      expect(response.status).toBe(200);

      // Complete the stream first
      testRegistry.finish(mockMessageId);

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
      testRegistry.register(mockMessageId, mockMeta);

      const response = await GET(makeRequest(), makeContext(mockMessageId));
      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
      testRegistry.finish(mockMessageId);

      const body = await readSSEBody(response);
      expect(body).toContain(': ping\n\n');
    });

    it('given a silent multi-minute tool call, should send a ping on every tick, not just once', async () => {
      vi.useFakeTimers();
      testRegistry.register(mockMessageId, mockMeta);

      const response = await GET(makeRequest(), makeContext(mockMessageId));
      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 3);
      testRegistry.finish(mockMessageId);

      const body = await readSSEBody(response);
      const pingCount = body.split(': ping\n\n').length - 1;
      expect(pingCount).toBe(3);
    });

    it('given real part traffic arrives after a ping tick, both should appear in order', async () => {
      vi.useFakeTimers();
      testRegistry.register(mockMessageId, mockMeta);

      const response = await GET(makeRequest(), makeContext(mockMessageId));
      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
      testRegistry.push(mockMessageId, { type: 'text', text: 'after-ping' });
      testRegistry.finish(mockMessageId);

      const body = await readSSEBody(response);
      const pingIndex = body.indexOf(': ping\n\n');
      const partIndex = body.indexOf('after-ping');
      expect(pingIndex).toBeGreaterThanOrEqual(0);
      expect(partIndex).toBeGreaterThan(pingIndex);
    });

    it('given the stream finishes naturally, should clear the ping interval (no leaked timer)', async () => {
      vi.useFakeTimers();
      testRegistry.register(mockMessageId, mockMeta);

      await GET(makeRequest(), makeContext(mockMessageId));
      // Route-level timers (the 5s recheck + 20s ping) are both pending at this point,
      // alongside the registry's own unrelated per-entry cleanup timer.
      const beforeFinish = vi.getTimerCount();
      testRegistry.finish(mockMessageId);

      // finish() clears the registry's own cleanup timer too — assert only that the route's
      // two timers (recheck + ping) are gone, not the absolute count.
      expect(vi.getTimerCount()).toBeLessThanOrEqual(beforeFinish - 2);
    });

    it('given the client disconnects, should clear the ping interval (no leaked timer)', async () => {
      vi.useFakeTimers();
      const abortController = new AbortController();
      testRegistry.register(mockMessageId, mockMeta);

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
      testRegistry.register(mockMessageId, mockMeta);

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
      testRegistry.register(mockMessageId, mockMeta);
      // Only the registry's own (pre-existing, unrelated) per-entry cleanup timer is pending.
      const beforeGet = vi.getTimerCount();

      await GET(makeRequest(abortController.signal), makeContext(mockMessageId));

      // The route must not have scheduled either the recheck timer or the ping interval on
      // this eager-close path — the count must not have grown at all.
      expect(vi.getTimerCount()).toBe(beforeGet);
    });
  });
});
