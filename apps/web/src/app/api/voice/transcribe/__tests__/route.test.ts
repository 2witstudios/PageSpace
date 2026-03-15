/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/voice/transcribe
//
// Tests the POST handler that transcribes audio via OpenAI Whisper API.
// Uses mocked Request.formData() since jsdom doesn't support real multipart.
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

/**
 * Creates a Request with a mocked formData() method that returns
 * the given entries. This avoids jsdom's broken multipart support.
 */
const createMockFormDataRequest = (
  entries: Record<string, File | string | null>
): Request => {
  const request = new Request('https://example.com/api/voice/transcribe', {
    method: 'POST',
  });

  const formData = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    if (value !== null) {
      formData.append(key, value);
    }
  }

  // Override formData() to return our constructed FormData
  vi.spyOn(request, 'formData').mockResolvedValue(formData);
  return request;
};

const createAudioFile = (type = 'audio/webm', size = 1024): File => {
  const buffer = new ArrayBuffer(size);
  return new File([buffer], 'recording.webm', { type });
};

const mockFetch = vi.fn();
global.fetch = mockFetch;

// ============================================================================
// Tests
// ============================================================================

describe('POST /api/voice/transcribe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth('user_1'));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(getUserOpenAISettings).mockResolvedValue({ apiKey: 'sk-test-key' } as any);
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ text: 'Hello world', duration: 2.5 }),
    });
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = createMockFormDataRequest({ audio: createAudioFile() });
      const response = await POST(request);

      expect(response.status).toBe(401);
    });
  });

  describe('OpenAI API key validation', () => {
    it('should return 400 when no OpenAI API key configured', async () => {
      vi.mocked(getUserOpenAISettings).mockResolvedValue(null);

      const request = createMockFormDataRequest({ audio: createAudioFile() });
      const response = await POST(request);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('OpenAI API key required');
    });

    it('should return 400 when apiKey is empty', async () => {
      vi.mocked(getUserOpenAISettings).mockResolvedValue({ apiKey: '' } as any);

      const request = createMockFormDataRequest({ audio: createAudioFile() });
      const response = await POST(request);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('OpenAI API key required');
    });
  });

  describe('input validation', () => {
    it('should return 400 when no audio file is provided', async () => {
      const request = createMockFormDataRequest({});
      const response = await POST(request);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('No audio file provided');
    });

    it('should return 400 for unsupported audio format', async () => {
      const file = new File([new ArrayBuffer(100)], 'test.txt', { type: 'text/plain' });
      const request = createMockFormDataRequest({ audio: file });
      const response = await POST(request);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('Unsupported audio format');
    });

    it('should return 400 when file exceeds 25MB', async () => {
      const largeFile = createAudioFile('audio/webm', 26 * 1024 * 1024);
      const request = createMockFormDataRequest({ audio: largeFile });
      const response = await POST(request);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe('File too large');
    });

    it('should accept standard audio formats', async () => {
      const formats = ['audio/mp3', 'audio/wav', 'audio/webm', 'audio/ogg', 'audio/mpeg'];

      for (const format of formats) {
        mockFetch.mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ text: 'test', duration: 1 }),
        });

        const file = new File([new ArrayBuffer(100)], 'test', { type: format });
        const request = createMockFormDataRequest({ audio: file });
        const response = await POST(request);

        expect(response.status).toBe(200);
      }
    });
  });

  describe('success path', () => {
    it('should call Whisper API with correct endpoint and auth', async () => {
      const request = createMockFormDataRequest({ audio: createAudioFile() });
      await POST(request);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/audio/transcriptions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer sk-test-key',
          }),
        })
      );
    });

    it('should return transcription text and duration', async () => {
      const request = createMockFormDataRequest({ audio: createAudioFile() });
      const response = await POST(request);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.text).toBe('Hello world');
      expect(body.duration).toBe(2.5);
    });

    it('should include language parameter when provided', async () => {
      const request = createMockFormDataRequest({
        audio: createAudioFile(),
        language: 'en' as any,
      });
      await POST(request);

      const fetchCall = mockFetch.mock.calls[0];
      const formBody = fetchCall[1].body as FormData;
      expect(formBody.get('language')).toBe('en');
    });

    it('should not include language when not provided', async () => {
      const request = createMockFormDataRequest({ audio: createAudioFile() });
      await POST(request);

      const fetchCall = mockFetch.mock.calls[0];
      const formBody = fetchCall[1].body as FormData;
      expect(formBody.get('language')).toBeNull();
    });

    it('should send model as whisper-1', async () => {
      const request = createMockFormDataRequest({ audio: createAudioFile() });
      await POST(request);

      const fetchCall = mockFetch.mock.calls[0];
      const formBody = fetchCall[1].body as FormData;
      expect(formBody.get('model')).toBe('whisper-1');
    });
  });

  describe('OpenAI API error handling', () => {
    it('should return 401 when Whisper returns 401', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: { message: 'Invalid API key' } }),
      });

      const request = createMockFormDataRequest({ audio: createAudioFile() });
      const response = await POST(request);

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('Invalid OpenAI API key');
    });

    it('should pass through non-401 Whisper error status', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 429,
        json: () => Promise.resolve({ error: { message: 'Rate limited' } }),
      });

      const request = createMockFormDataRequest({ audio: createAudioFile() });
      const response = await POST(request);

      expect(response.status).toBe(429);
      const body = await response.json();
      expect(body.error).toBe('Transcription failed');
      expect(body.message).toBe('Rate limited');
    });

    it('should handle non-JSON Whisper error response', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error('Not JSON')),
      });

      const request = createMockFormDataRequest({ audio: createAudioFile() });
      const response = await POST(request);

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('Transcription failed');
    });
  });

  describe('error handling', () => {
    it('should return 500 on unexpected error', async () => {
      vi.mocked(getUserOpenAISettings).mockRejectedValue(new Error('Crash'));

      const request = createMockFormDataRequest({ audio: createAudioFile() });
      const response = await POST(request);

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBe('Failed to transcribe audio');
    });
  });
});
