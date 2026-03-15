/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/voice/synthesize
//
// Tests the POST handler that converts text to speech via OpenAI TTS API.
// ============================================================================

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@/lib/ai/core/ai-utils', () => ({
  getUserOpenAISettings: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    ai: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { getUserOpenAISettings } from '@/lib/ai/core/ai-utils';
import { POST } from '../route';

// ============================================================================
// Test Helpers
// ============================================================================

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session',
  adminRoleVersion: 0,
  role: 'user',
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createRequest = (body: Record<string, unknown> = { text: 'Hello world' }) =>
  new Request('https://example.com/api/voice/synthesize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const mockFetch = vi.fn();
global.fetch = mockFetch;

// ============================================================================
// Tests
// ============================================================================

describe('POST /api/voice/synthesize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth('user_1'));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(getUserOpenAISettings).mockResolvedValue({ apiKey: 'sk-test-key' } as any);
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(1000)),
    });
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const response = await POST(createRequest());

      expect(response.status).toBe(401);
    });
  });

  describe('OpenAI API key validation', () => {
    it('should return 400 when no OpenAI API key configured', async () => {
      vi.mocked(getUserOpenAISettings).mockResolvedValue(null);

      const response = await POST(createRequest());

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('OpenAI API key required');
    });

    it('should return 400 when apiKey is empty', async () => {
      vi.mocked(getUserOpenAISettings).mockResolvedValue({ apiKey: '' } as any);

      const response = await POST(createRequest());

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('OpenAI API key required');
    });
  });

  describe('input validation', () => {
    it('should return 400 when text is missing', async () => {
      const response = await POST(createRequest({}));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Text is required');
    });

    it('should return 400 when text is not a string', async () => {
      const response = await POST(createRequest({ text: 42 }));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Text is required');
    });

    it('should return 400 when text exceeds 4096 characters', async () => {
      const longText = 'a'.repeat(4097);
      const response = await POST(createRequest({ text: longText }));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Text too long');
    });

    it('should return 400 for invalid voice', async () => {
      const response = await POST(createRequest({ text: 'Hello', voice: 'invalid_voice' }));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Invalid voice');
    });

    it('should return 400 for invalid model', async () => {
      const response = await POST(createRequest({ text: 'Hello', model: 'gpt-4' }));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Invalid model');
    });

    it('should return 400 for non-finite speed', async () => {
      const response = await POST(createRequest({ text: 'Hello', speed: 'fast' }));

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Invalid speed');
    });
  });

  describe('success path', () => {
    it('should call OpenAI TTS API with correct parameters', async () => {
      await POST(createRequest({ text: 'Hello world', voice: 'alloy', model: 'tts-1-hd', speed: 1.5 }));

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/audio/speech',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer sk-test-key',
          }),
        })
      );

      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(fetchBody.model).toBe('tts-1-hd');
      expect(fetchBody.voice).toBe('alloy');
      expect(fetchBody.input).toBe('Hello world');
      expect(fetchBody.speed).toBe(1.5);
      expect(fetchBody.response_format).toBe('mp3');
    });

    it('should return audio/mpeg response on success', async () => {
      const response = await POST(createRequest());

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('audio/mpeg');
      expect(response.headers.get('Cache-Control')).toBe('no-cache');
    });

    it('should use default voice and model when not specified', async () => {
      await POST(createRequest({ text: 'Hello' }));

      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(fetchBody.voice).toBe('nova');
      expect(fetchBody.model).toBe('tts-1');
    });

    it('should clamp speed to valid range', async () => {
      await POST(createRequest({ text: 'Hello', speed: 10 }));
      const fetchBody1 = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(fetchBody1.speed).toBe(4.0);

      mockFetch.mockClear();
      mockFetch.mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)),
      });

      await POST(createRequest({ text: 'Hello', speed: 0.01 }));
      const fetchBody2 = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(fetchBody2.speed).toBe(0.25);
    });
  });

  describe('OpenAI API error handling', () => {
    it('should return 401 when OpenAI returns 401 (invalid key)', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: { message: 'Invalid API key' } }),
      });

      const response = await POST(createRequest());

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('Invalid OpenAI API key');
    });

    it('should pass through non-401 OpenAI error status', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 429,
        json: () => Promise.resolve({ error: { message: 'Rate limit exceeded' } }),
      });

      const response = await POST(createRequest());

      expect(response.status).toBe(429);
      const body = await response.json();
      expect(body.error).toBe('Speech synthesis failed');
      expect(body.message).toBe('Rate limit exceeded');
    });

    it('should handle OpenAI error with non-JSON response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error('Not JSON')),
      });

      const response = await POST(createRequest());

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('Speech synthesis failed');
    });
  });

  describe('error handling', () => {
    it('should return 500 on unexpected error', async () => {
      vi.mocked(getUserOpenAISettings).mockRejectedValue(new Error('DB down'));

      const response = await POST(createRequest());

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('Failed to synthesize speech');
    });
  });
});
