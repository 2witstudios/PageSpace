import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import { StreamMulticastRegistry } from '@/lib/ai/core/stream-multicast-registry';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

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

import { GET } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';

const mockPageId = 'page-test-123';
const mockUserId = 'user-test-456';
const mockMessageId = 'msg-test-789';

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

const makeRequest = (signal?: AbortSignal) =>
  new Request(`http://test.local/api/ai/chat/stream-join/${mockMessageId}`, { signal });

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
    vi.mocked(canUserViewPage).mockResolvedValue(true);
  });

  describe('authentication', () => {
    it('given unauthenticated request, should return 401', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthFailure(401));
      vi.mocked(isAuthError).mockReturnValue(true);

      const response = await GET(makeRequest(), makeContext(mockMessageId));

      expect(response.status).toBe(401);
    });
  });

  describe('stream lookup', () => {
    it('given an unknown messageId, should return 404', async () => {
      // Registry has no entry for mockMessageId
      const response = await GET(makeRequest(), makeContext(mockMessageId));

      expect(response.status).toBe(404);
    });

    it('given an already-finished messageId, should return 404', async () => {
      testRegistry.register(mockMessageId, { pageId: mockPageId, userId: mockUserId });
      testRegistry.finish(mockMessageId);
      // Entry is deleted — subscribe() returns null

      const response = await GET(makeRequest(), makeContext(mockMessageId));

      expect(response.status).toBe(404);
    });
  });

  describe('authorization', () => {
    it('given a user without view access, should return 403', async () => {
      testRegistry.register(mockMessageId, { pageId: mockPageId, userId: mockUserId });
      vi.mocked(canUserViewPage).mockResolvedValue(false);

      const response = await GET(makeRequest(), makeContext(mockMessageId));

      expect(response.status).toBe(403);
    });

    it('should check permission against the pageId from stream metadata', async () => {
      testRegistry.register(mockMessageId, { pageId: mockPageId, userId: mockUserId });
      testRegistry.finish(mockMessageId); // Make subscribe return null (404 before perm check)
      // Actually: getMeta returns undefined after finish — so we never reach perm check
      // Let's use a live stream
      testRegistry = new StreamMulticastRegistry();
      testRegistry.register(mockMessageId, { pageId: mockPageId, userId: mockUserId });

      await GET(makeRequest(), makeContext(mockMessageId));

      // Finish to unblock any lingering streams
      testRegistry.finish(mockMessageId);

      expect(canUserViewPage).toHaveBeenCalledWith(mockUserId, mockPageId);
    });
  });

  describe('SSE streaming', () => {
    it('given a valid messageId and authorized viewer, should return SSE response headers', async () => {
      testRegistry.register(mockMessageId, { pageId: mockPageId, userId: mockUserId });

      const response = await GET(makeRequest(), makeContext(mockMessageId));
      testRegistry.finish(mockMessageId);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/event-stream');
      expect(response.headers.get('Cache-Control')).toBe('no-cache');
      expect(response.headers.get('X-Accel-Buffering')).toBe('no');
    });

    it('given buffered chunks, should stream them as SSE data events', async () => {
      testRegistry.register(mockMessageId, { pageId: mockPageId, userId: mockUserId });
      testRegistry.push(mockMessageId, 'hello');
      testRegistry.push(mockMessageId, ' world');

      const response = await GET(makeRequest(), makeContext(mockMessageId));
      testRegistry.finish(mockMessageId);

      const body = await readSSEBody(response);

      expect(body).toContain('data: {"text":"hello"}\n\n');
      expect(body).toContain('data: {"text":" world"}\n\n');
    });

    it('given stream completion, should send [DONE] sentinel and close', async () => {
      testRegistry.register(mockMessageId, { pageId: mockPageId, userId: mockUserId });

      const response = await GET(makeRequest(), makeContext(mockMessageId));
      testRegistry.finish(mockMessageId);

      const body = await readSSEBody(response);

      expect(body).toContain('data: [DONE]\n\n');
    });

    it('given live chunks pushed after subscribe, should stream them in order', async () => {
      testRegistry.register(mockMessageId, { pageId: mockPageId, userId: mockUserId });
      testRegistry.push(mockMessageId, 'buffered');

      const response = await GET(makeRequest(), makeContext(mockMessageId));

      testRegistry.push(mockMessageId, 'live');
      testRegistry.finish(mockMessageId);

      const body = await readSSEBody(response);

      expect(body).toContain('data: {"text":"buffered"}\n\n');
      expect(body).toContain('data: {"text":"live"}\n\n');
      expect(body).toContain('data: [DONE]\n\n');
    });

    it('given a race where subscribe returns null, should return 404', async () => {
      // getMeta succeeds (stream registered) but subscribe returns null
      // Simulate by registering, getting meta, then finishing before route subscribes.
      // We achieve this by overriding getMeta to return meta while subscribe sees finished state.
      // Simplest: use the registry — register, finish, re-set getMeta via spy.
      const spyRegistry = new StreamMulticastRegistry();
      spyRegistry.register(mockMessageId, { pageId: mockPageId, userId: mockUserId });

      // getMeta returns meta even after finish by using a spy
      const getMetaSpy = vi.spyOn(spyRegistry, 'getMeta').mockReturnValue({
        pageId: mockPageId,
        userId: mockUserId,
      });
      spyRegistry.finish(mockMessageId); // subscribe will now return null

      testRegistry = spyRegistry;

      const response = await GET(makeRequest(), makeContext(mockMessageId));

      expect(response.status).toBe(404);
      getMetaSpy.mockRestore();
    });
  });

  describe('client disconnect', () => {
    it('given client disconnect, should unsubscribe without leaking resources', async () => {
      const abortController = new AbortController();
      testRegistry.register(mockMessageId, { pageId: mockPageId, userId: mockUserId });

      const response = await GET(makeRequest(abortController.signal), makeContext(mockMessageId));
      expect(response.status).toBe(200);

      // Abort the connection — should call unsubscribe() on the registry subscriber
      abortController.abort();

      // Allow event loop to process the abort event
      await Promise.resolve();

      // Registry finish should not error even though route subscriber was removed
      expect(() => testRegistry.finish(mockMessageId)).not.toThrow();
    });
  });
});
