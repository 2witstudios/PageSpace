/**
 * Contract tests for POST /api/ai/abort
 *
 * These tests verify the Request → Response contract and security obligations.
 * The stream abort registry is mocked at the boundary.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { POST } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// Mock auth (boundary)
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

// Mock stream abort registry (boundary)
vi.mock('@/lib/ai/core/stream-abort-registry', () => ({
  abortStream: vi.fn(),
}));

// Mock logger (boundary)
vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
  },
}));

// Mock rate limit (boundary) - note: checkRateLimit is exported from @pagespace/lib/auth
vi.mock('@pagespace/lib/auth', async () => {
  const actual = await vi.importActual('@pagespace/lib/auth');
  return {
    ...actual,
    checkRateLimit: vi.fn(),
  };
});

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { abortStream } from '@/lib/ai/core/stream-abort-registry';
import { loggers } from '@pagespace/lib/server';
import { checkRateLimit } from '@pagespace/lib/auth';

// Test fixtures
const mockUserId = 'user-123';
const mockStreamId = 'stream-456';

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

describe('POST /api/ai/abort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: rate limit allowed
    vi.mocked(checkRateLimit).mockReturnValue({ allowed: true, attemptsRemaining: 9 });
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
      expect(abortStream).not.toHaveBeenCalled();
    });
  });

  describe('Input Validation', () => {
    it('returns 400 without streamId', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValueOnce(mockWebAuth(mockUserId));
      vi.mocked(isAuthError).mockReturnValueOnce(false);

      const request = createRequest({});
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('streamId is required');
      expect(abortStream).not.toHaveBeenCalled();
    });

    it('returns 400 when streamId is not a string', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValueOnce(mockWebAuth(mockUserId));
      vi.mocked(isAuthError).mockReturnValueOnce(false);

      const request = createRequest({ streamId: 12345 });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('streamId is required');
    });

    it('returns 400 when streamId is empty string', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValueOnce(mockWebAuth(mockUserId));
      vi.mocked(isAuthError).mockReturnValueOnce(false);

      const request = createRequest({ streamId: '' });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('streamId is required');
    });

    it('returns 400 when streamId is whitespace only', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValueOnce(mockWebAuth(mockUserId));
      vi.mocked(isAuthError).mockReturnValueOnce(false);

      const request = createRequest({ streamId: '   ' });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('streamId is required');
      expect(abortStream).not.toHaveBeenCalled();
    });
  });

  describe('Successful Abort', () => {
    it('returns success when stream is aborted', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValueOnce(mockWebAuth(mockUserId));
      vi.mocked(isAuthError).mockReturnValueOnce(false);
      vi.mocked(abortStream).mockReturnValueOnce({
        aborted: true,
        reason: 'Stream aborted by user request',
      });

      const request = createRequest({ streamId: mockStreamId });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.aborted).toBe(true);
      expect(data.reason).toBe('Stream aborted by user request');

      // Verify abortStream was called with userId for ownership verification
      expect(abortStream).toHaveBeenCalledWith({
        streamId: mockStreamId,
        userId: mockUserId,
      });
    });

    it('logs abort request with userId', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValueOnce(mockWebAuth(mockUserId));
      vi.mocked(isAuthError).mockReturnValueOnce(false);
      vi.mocked(abortStream).mockReturnValueOnce({
        aborted: true,
        reason: 'Stream aborted by user request',
      });

      const request = createRequest({ streamId: mockStreamId });
      await POST(request);

      expect(loggers.api.info).toHaveBeenCalledWith(
        'AI stream abort requested',
        expect.objectContaining({
          streamId: mockStreamId,
          userId: mockUserId,
          aborted: true,
        })
      );
    });
  });

  describe('Failed Abort - Stream Not Found', () => {
    it('returns failure when stream does not exist', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValueOnce(mockWebAuth(mockUserId));
      vi.mocked(isAuthError).mockReturnValueOnce(false);
      vi.mocked(abortStream).mockReturnValueOnce({
        aborted: false,
        reason: 'Stream not found or already completed',
      });

      const request = createRequest({ streamId: 'non-existent-stream' });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200); // Still 200, just with aborted: false
      expect(data.aborted).toBe(false);
      expect(data.reason).toBe('Stream not found or already completed');
    });
  });

  describe('Failed Abort - Unauthorized (IDOR Protection)', () => {
    it('returns failure when user tries to abort another users stream', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValueOnce(mockWebAuth(mockUserId));
      vi.mocked(isAuthError).mockReturnValueOnce(false);
      vi.mocked(abortStream).mockReturnValueOnce({
        aborted: false,
        reason: 'Unauthorized to abort this stream',
      });

      const request = createRequest({ streamId: mockStreamId });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200); // Registry handles authorization, returns failure result
      expect(data.aborted).toBe(false);
      expect(data.reason).toBe('Unauthorized to abort this stream');
    });
  });

  describe('Rate Limiting', () => {
    it('returns 429 when rate limited', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValueOnce(mockWebAuth(mockUserId));
      vi.mocked(isAuthError).mockReturnValueOnce(false);
      vi.mocked(checkRateLimit).mockReturnValueOnce({ allowed: false, retryAfter: 60 });

      const request = createRequest({ streamId: mockStreamId });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(429);
      expect(data.error).toBe('Too many requests. Please try again later.');
      expect(response.headers.get('Retry-After')).toBe('60');
      expect(abortStream).not.toHaveBeenCalled();
    });

    it('logs rate limit warning', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValueOnce(mockWebAuth(mockUserId));
      vi.mocked(isAuthError).mockReturnValueOnce(false);
      vi.mocked(checkRateLimit).mockReturnValueOnce({ allowed: false, retryAfter: 30 });

      const request = createRequest({ streamId: mockStreamId });
      await POST(request);

      expect(loggers.api.warn).toHaveBeenCalledWith(
        'AI abort rate limited',
        expect.objectContaining({ userId: mockUserId, retryAfter: 30 })
      );
    });
  });

  describe('Error Handling', () => {
    it('returns 500 on unexpected error', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValueOnce(mockWebAuth(mockUserId));
      vi.mocked(isAuthError).mockReturnValueOnce(false);
      vi.mocked(abortStream).mockImplementationOnce(() => {
        throw new Error('Unexpected error');
      });

      const request = createRequest({ streamId: mockStreamId });
      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe('Failed to abort stream');
      expect(loggers.api.error).toHaveBeenCalled();
    });

    it('returns 500 on JSON parse error', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValueOnce(mockWebAuth(mockUserId));
      vi.mocked(isAuthError).mockReturnValueOnce(false);

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
