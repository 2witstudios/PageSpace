import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock dependencies
vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    ai: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

vi.mock('@/lib/auth', () => ({
  authenticateWebRequest: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@/lib/ai/core', () => ({
  getUserLMStudioSettings: vi.fn(),
}));

import { loggers } from '@pagespace/lib/server';
import { authenticateWebRequest, isAuthError } from '@/lib/auth';
import { getUserLMStudioSettings } from '@/lib/ai/core';

// Helper to create mock WebAuthResult
const mockWebAuth = (userId: string, tokenVersion = 0): WebAuthResult => ({
  userId,
  tokenVersion,
  tokenType: 'jwt',
  source: 'cookie',
  role: 'user',
});

// Helper to create mock AuthError
const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

describe('GET /api/ai/lmstudio/models', () => {
  const mockUserId = 'user_123';
  const mockBaseUrl = 'http://localhost:1234/v1';

  beforeEach(() => {
    vi.clearAllMocks();

    // Default auth success
    vi.mocked(authenticateWebRequest).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: no settings configured
    vi.mocked(getUserLMStudioSettings).mockResolvedValue(null);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateWebRequest).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/ai/lmstudio/models', {
        method: 'GET',
      });

      const response = await GET(request);
      expect(response.status).toBe(401);
    });
  });

  describe('configuration validation', () => {
    it('should return 400 when LM Studio is not configured', async () => {
      vi.mocked(getUserLMStudioSettings).mockResolvedValue(null);

      const request = new Request('https://example.com/api/ai/lmstudio/models', {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('LM Studio not configured');
      expect(body.models).toEqual({});
    });

    it('should return 400 when LM Studio settings exist but baseUrl is empty', async () => {
      vi.mocked(getUserLMStudioSettings).mockResolvedValue({
        isConfigured: true,
        baseUrl: '',
      });

      const request = new Request('https://example.com/api/ai/lmstudio/models', {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('LM Studio not configured');
    });
  });

  describe('successful model discovery', () => {
    it('should return models from LM Studio instance', async () => {
      vi.mocked(getUserLMStudioSettings).mockResolvedValue({
        isConfigured: true,
        baseUrl: mockBaseUrl,
      });

      // LM Studio uses OpenAI-compatible API format
      const mockLMStudioModels = {
        data: [
          { id: 'llama-3.2-3b' },
          { id: 'mistral-7b-instruct' },
          { id: 'codellama-13b' },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockLMStudioModels),
      });

      const request = new Request('https://example.com/api/ai/lmstudio/models', {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.models).toHaveProperty('llama-3.2-3b');
      expect(body.models).toHaveProperty('mistral-7b-instruct');
      expect(body.models).toHaveProperty('codellama-13b');
      expect(body.baseUrl).toBe(mockBaseUrl);
      expect(body.modelCount).toBe(3);

      // LM Studio uses /models endpoint (OpenAI-compatible)
      expect(global.fetch).toHaveBeenCalledWith(
        `${mockBaseUrl}/models`,
        expect.objectContaining({
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });

    it('should clean up model display names', async () => {
      vi.mocked(getUserLMStudioSettings).mockResolvedValue({
        isConfigured: true,
        baseUrl: mockBaseUrl,
      });

      const mockLMStudioModels = {
        data: [
          { id: 'llama-3_2-3b_instruct' },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockLMStudioModels),
      });

      const request = new Request('https://example.com/api/ai/lmstudio/models', {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      // Should replace underscores and hyphens with spaces, capitalize words
      expect(body.models['llama-3_2-3b_instruct']).toBe('Llama 3 2 3b Instruct');
    });

    it('should handle empty models array', async () => {
      vi.mocked(getUserLMStudioSettings).mockResolvedValue({
        isConfigured: true,
        baseUrl: mockBaseUrl,
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [] }),
      });

      const request = new Request('https://example.com/api/ai/lmstudio/models', {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.models).toEqual({});
      expect(body.modelCount).toBe(0);
    });

    it('should log successful model fetch', async () => {
      vi.mocked(getUserLMStudioSettings).mockResolvedValue({
        isConfigured: true,
        baseUrl: mockBaseUrl,
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: 'test-model' }] }),
      });

      const request = new Request('https://example.com/api/ai/lmstudio/models', {
        method: 'GET',
      });

      await GET(request);

      expect(loggers.ai.info).toHaveBeenCalledWith(
        'Successfully fetched LM Studio models',
        expect.objectContaining({
          userId: mockUserId,
          baseUrl: mockBaseUrl,
          modelCount: 1,
        })
      );
    });
  });

  describe('LM Studio connection failures', () => {
    it('should return empty models with error when LM Studio is unreachable', async () => {
      vi.mocked(getUserLMStudioSettings).mockResolvedValue({
        isConfigured: true,
        baseUrl: mockBaseUrl,
      });

      global.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

      const request = new Request('https://example.com/api/ai/lmstudio/models', {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      // Should return 200 with empty models (no fallbacks per user preference)
      expect(response.status).toBe(200);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Could not connect to LM Studio');
      expect(body.error).toContain('Please ensure LM Studio server is running');
      expect(body.models).toEqual({});
      expect(body.baseUrl).toBe(mockBaseUrl);
    });

    it('should return empty models when LM Studio returns non-OK status', async () => {
      vi.mocked(getUserLMStudioSettings).mockResolvedValue({
        isConfigured: true,
        baseUrl: mockBaseUrl,
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      const request = new Request('https://example.com/api/ai/lmstudio/models', {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(false);
      expect(body.models).toEqual({});
    });

    it('should log errors when LM Studio fetch fails', async () => {
      vi.mocked(getUserLMStudioSettings).mockResolvedValue({
        isConfigured: true,
        baseUrl: mockBaseUrl,
      });

      const error = new Error('Network timeout');
      global.fetch = vi.fn().mockRejectedValue(error);

      const request = new Request('https://example.com/api/ai/lmstudio/models', {
        method: 'GET',
      });

      await GET(request);

      expect(loggers.ai.error).toHaveBeenCalledWith(
        'Failed to fetch models from LM Studio',
        error,
        expect.objectContaining({
          userId: mockUserId,
          baseUrl: mockBaseUrl,
        })
      );
    });
  });

  describe('error handling', () => {
    it('should handle unexpected errors gracefully', async () => {
      vi.mocked(getUserLMStudioSettings).mockRejectedValue(new Error('Database error'));

      const request = new Request('https://example.com/api/ai/lmstudio/models', {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toBe('Failed to discover LM Studio models');
      expect(body.models).toEqual({});
      expect(loggers.ai.error).toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    it('should handle models without id property', async () => {
      vi.mocked(getUserLMStudioSettings).mockResolvedValue({
        isConfigured: true,
        baseUrl: mockBaseUrl,
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          data: [
            { id: 'valid-model' },
            { /* missing id */ },
            { id: '' },
            { id: 'another-model' },
          ],
        }),
      });

      const request = new Request('https://example.com/api/ai/lmstudio/models', {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(Object.keys(body.models).length).toBe(2);
      expect(body.models).toHaveProperty('valid-model');
      expect(body.models).toHaveProperty('another-model');
    });

    it('should handle missing data array in response', async () => {
      vi.mocked(getUserLMStudioSettings).mockResolvedValue({
        isConfigured: true,
        baseUrl: mockBaseUrl,
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const request = new Request('https://example.com/api/ai/lmstudio/models', {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.models).toEqual({});
    });

    it('should handle various base URL formats', async () => {
      const testCases = [
        'http://localhost:1234/v1',
        'http://192.168.1.100:1234/v1',
        'http://lmstudio.local:1234/v1',
      ];

      for (const baseUrl of testCases) {
        vi.mocked(getUserLMStudioSettings).mockResolvedValue({
          isConfigured: true,
          baseUrl,
        });

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ data: [{ id: 'test-model' }] }),
        });

        const request = new Request('https://example.com/api/ai/lmstudio/models', {
          method: 'GET',
        });

        const response = await GET(request);
        expect(response.status).toBe(200);
        expect(global.fetch).toHaveBeenCalledWith(
          `${baseUrl}/models`,
          expect.any(Object)
        );
      }
    });
  });
});
