/**
 * Contract tests for POST /api/ai/abort
 *
 * These tests verify the Request → Response contract and security obligations.
 * The abort machinery is mocked at the boundary: this route's own job is auth, rate limiting,
 * validation, and NAMING PRECEDENCE. Whether a named stream can actually be stopped — including
 * on another web instance — is `abortStreamAnywhere`'s job, and is tested where it lives
 * (stream-abort-mark.test.ts, stream-abort-watcher.test.ts, stream-abort-decisions.test.ts).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockAbortStreamAnywhere = vi.hoisted(() => vi.fn());

import { NextResponse } from 'next/server';
import { POST } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// Mock auth (boundary)
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

// Mock the abort orchestrator (boundary)
vi.mock('@/lib/ai/core/abort-stream-anywhere', () => ({
  abortStreamAnywhere: mockAbortStreamAnywhere,
}));

// Mock logger (boundary)
vi.mock('@pagespace/lib/logging/logger-config', () => ({
    loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
    auditRequest: vi.fn(),
}));

vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn(),
}));

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { checkDistributedRateLimit } from '@pagespace/lib/security/distributed-rate-limit';

// Test fixtures
const mockUserId = 'user-123';
const mockStreamId = 'stream-456';
const mockMessageId = 'msg-789';

const ABORTED = { aborted: true, code: 'aborted', reason: 'Stream aborted by user request' };
const NOT_FOUND = { aborted: false, code: 'not_found', reason: 'No in-flight stream on this conversation' };

const mockWebAuth = (userId: string): SessionAuthResult => ({
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

const createRequest = (body: unknown) => {
  return new Request('http://localhost:3000/api/ai/abort', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
};

const authed = () => {
  vi.mocked(authenticateRequestWithOptions).mockResolvedValueOnce(mockWebAuth(mockUserId));
  vi.mocked(isAuthError).mockReturnValueOnce(false);
};

describe('POST /api/ai/abort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: rate limit allowed
    vi.mocked(checkDistributedRateLimit).mockResolvedValue({ allowed: true, attemptsRemaining: 9 });
    mockAbortStreamAnywhere.mockResolvedValue(NOT_FOUND);
  });

  describe('Authentication', () => {
    it('returns 401 without session', async () => {
      const authError = mockAuthError(401);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValueOnce(authError);
      vi.mocked(isAuthError).mockReturnValueOnce(true);

      const request = createRequest({ streamId: mockStreamId });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe('Unauthorized');
      expect(mockAbortStreamAnywhere).not.toHaveBeenCalled();
    });
  });

  // THE WINDOW STOP COULD NOT NAME.
  //
  // streamId and messageId are BOTH minted server-side, and the client learns neither until the
  // response headers land. A real agent send spends 0.5-3s before that (auth, rate limit, DB
  // reads, context assembly, provider connect). Press Stop in that window — exactly when a user
  // who spotted a typo presses it — and the client had nothing to name: the abort was a
  // guaranteed no-op, the fetch was cancelled, and the button flipped back to Send.
  //
  // Cancelling the fetch stops NOTHING: streams are deliberately server-owned and survive a
  // client disconnect. The generation kept running, kept calling write tools, and kept BILLING,
  // while the UI said it had stopped. conversationId is the one name the client holds from t=0.
  describe('abort by conversationId (the pre-headers window)', () => {
    it('accepts conversationId alone and aborts the conversation\'s in-flight stream', async () => {
      authed();
      mockAbortStreamAnywhere.mockResolvedValueOnce(ABORTED);

      const response = await POST(createRequest({ conversationId: 'conv-1' }));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(mockAbortStreamAnywhere).toHaveBeenCalledWith({
        messageId: undefined,
        streamId: undefined,
        conversationId: 'conv-1',
        userId: mockUserId,
      });
      expect(body.aborted).toBe(true);
    });

    it('given nothing was in flight, reports honestly rather than claiming success', async () => {
      authed();
      mockAbortStreamAnywhere.mockResolvedValueOnce(NOT_FOUND);

      const body = await (await POST(createRequest({ conversationId: 'conv-1' }))).json();

      expect(body.aborted).toBe(false);
      // The client uses this to stay SILENT: nothing was running, so there is nothing to warn about.
      expect(body.code).toBe('not_found');
    });

    // The route forwards every name it was given; the PRECEDENCE between them (messageId, then
    // streamId, then conversationId) is applied in abortStreamAnywhere, and asserted there.
    it('forwards every name the client supplied', async () => {
      authed();

      await POST(createRequest({ messageId: 'msg-precise', conversationId: 'conv-1' }));

      expect(mockAbortStreamAnywhere).toHaveBeenCalledWith({
        messageId: 'msg-precise',
        streamId: undefined,
        conversationId: 'conv-1',
        userId: mockUserId,
      });
    });
  });

  describe('Input Validation', () => {
    it('returns 400 when neither streamId nor messageId provided', async () => {
      authed();

      const request = createRequest({});
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('streamId, messageId or conversationId is required');
      expect(mockAbortStreamAnywhere).not.toHaveBeenCalled();
    });

    it('returns 400 when streamId is not a string and no messageId', async () => {
      authed();

      const request = createRequest({ streamId: 12345 });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('streamId, messageId or conversationId is required');
    });

    it('returns 400 when streamId is empty string and no messageId', async () => {
      authed();

      const request = createRequest({ streamId: '' });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('streamId, messageId or conversationId is required');
    });

    it('returns 400 when streamId is whitespace only and no messageId', async () => {
      authed();

      const request = createRequest({ streamId: '   ' });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('streamId, messageId or conversationId is required');
      expect(mockAbortStreamAnywhere).not.toHaveBeenCalled();
    });
  });

  describe('Successful Abort', () => {
    it('returns success when stream is aborted', async () => {
      authed();
      mockAbortStreamAnywhere.mockResolvedValueOnce(ABORTED);

      const request = createRequest({ streamId: mockStreamId });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.aborted).toBe(true);
      expect(data.reason).toBe('Stream aborted by user request');

      // The caller's userId rides along — every abort is authorized against the stream's owner.
      expect(mockAbortStreamAnywhere).toHaveBeenCalledWith(
        expect.objectContaining({ streamId: mockStreamId, userId: mockUserId }),
      );
    });

    it('logs abort request with userId', async () => {
      authed();
      mockAbortStreamAnywhere.mockResolvedValueOnce(ABORTED);

      const request = createRequest({ streamId: mockStreamId });
      await POST(request);

      expect(loggers.api.info).toHaveBeenCalledWith(
        'AI stream abort requested',
        {
          streamId: mockStreamId,
          messageId: undefined,
          userId: mockUserId,
          aborted: true,
          code: 'aborted',
          reason: 'Stream aborted by user request',
        }
      );
    });
  });

  describe('Abort by messageId', () => {
    it('names the stream by messageId when one is provided', async () => {
      authed();
      mockAbortStreamAnywhere.mockResolvedValueOnce(ABORTED);

      const request = createRequest({ messageId: mockMessageId });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.aborted).toBe(true);
      expect(mockAbortStreamAnywhere).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: mockMessageId, streamId: undefined, userId: mockUserId }),
      );
    });

    it('forwards both names when both are provided', async () => {
      authed();
      mockAbortStreamAnywhere.mockResolvedValueOnce(ABORTED);

      const request = createRequest({ streamId: mockStreamId, messageId: mockMessageId });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.aborted).toBe(true);
      expect(mockAbortStreamAnywhere).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: mockMessageId, streamId: mockStreamId }),
      );
    });

    it('returns 400 when messageId is empty string and no streamId', async () => {
      authed();

      const request = createRequest({ messageId: '' });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('streamId, messageId or conversationId is required');
    });
  });

  describe('Failed Abort - Stream Not Found', () => {
    it('returns failure when stream does not exist', async () => {
      authed();
      mockAbortStreamAnywhere.mockResolvedValueOnce(NOT_FOUND);

      const request = createRequest({ streamId: 'non-existent-stream' });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200); // Still 200, just with aborted: false
      expect(data.aborted).toBe(false);
      expect(data.code).toBe('not_found');
    });
  });

  // The stream is genuinely still generating on an instance that has not consumed the abort — the
  // one outcome the user must actually be told about, because they are still being billed for it.
  describe('Failed Abort - could not be confirmed stopped', () => {
    it('reports unconfirmed so the client can warn the user', async () => {
      authed();
      mockAbortStreamAnywhere.mockResolvedValueOnce({
        aborted: false,
        code: 'unconfirmed',
        reason: 'The stream could not be confirmed stopped and may still be running',
      });

      const response = await POST(createRequest({ streamId: mockStreamId }));
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.aborted).toBe(false);
      expect(data.code).toBe('unconfirmed');
    });
  });

  // IDOR. A user naming another user's stream must learn NOTHING about it — including whether it
  // exists. The mark's WHERE clause carries the caller's user_id, so it matches zero rows, and the
  // response is indistinguishable from "there was nothing in flight".
  describe('Failed Abort - Unauthorized (IDOR Protection)', () => {
    it('returns not_found when a user names a stream they do not own', async () => {
      authed();
      mockAbortStreamAnywhere.mockResolvedValueOnce(NOT_FOUND);

      const request = createRequest({ streamId: mockStreamId });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.aborted).toBe(false);
      expect(data.code).toBe('not_found');
    });
  });

  describe('Rate Limiting', () => {
    it('returns 429 when rate limited', async () => {
      authed();
      vi.mocked(checkDistributedRateLimit).mockResolvedValueOnce({ allowed: false, retryAfter: 60 });

      const request = createRequest({ streamId: mockStreamId });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(429);
      expect(data.error).toBe('Too many requests. Please try again later.');
      expect(response.headers.get('Retry-After')).toBe('60');
      expect(mockAbortStreamAnywhere).not.toHaveBeenCalled();
    });

    it('logs rate limit warning', async () => {
      authed();
      vi.mocked(checkDistributedRateLimit).mockResolvedValueOnce({ allowed: false, retryAfter: 30 });

      const request = createRequest({ streamId: mockStreamId });
      await POST(request);

      expect(loggers.api.warn).toHaveBeenCalledWith(
        'AI abort rate limited',
        { userId: mockUserId, retryAfter: 30 }
      );
    });
  });

  describe('Error Handling', () => {
    it('returns 500 on unexpected error', async () => {
      authed();
      mockAbortStreamAnywhere.mockRejectedValueOnce(new Error('Unexpected error'));

      const request = createRequest({ streamId: mockStreamId });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe('Failed to abort stream');
      const errorCallArgs = vi.mocked(loggers.api.error).mock.calls[0];
      expect(errorCallArgs[0]).toBe('Error aborting AI stream');
      const errorPayload = errorCallArgs[1] as { error: Error };
      expect(errorPayload.error).toBeInstanceOf(Error);
      expect(errorPayload.error.message).toBe('Unexpected error');
    });

    it('returns 500 on JSON parse error', async () => {
      authed();

      const request = new Request('http://localhost:3000/api/ai/abort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid json',
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe('Failed to abort stream');
    });
  });
});
