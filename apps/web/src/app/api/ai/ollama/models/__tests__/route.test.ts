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
  getUserOllamaSettings: vi.fn(),
}));

import { loggers } from '@pagespace/lib/server';
import { authenticateWebRequest, isAuthError } from '@/lib/auth';
import { getUserOllamaSettings } from '@/lib/ai/core';

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

describe('GET /api/ai/ollama/models', () => {
  const mockUserId = 'user_123';
  const mockBaseUrl = 'http://localhost:11434';

  beforeEach(() => {
    vi.clearAllMocks();

    // Default auth success
    vi.mocked(authenticateWebRequest).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: no settings configured
    vi.mocked(getUserOllamaSettings).mockResolvedValue(null);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateWebRequest).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/ai/ollama/models', {
        method: 'GET',
      });

      const response = await GET(request);
      expect(response.status).toBe(401);
    });
  });

  describe('configuration validation', () => {
    it('should return 400 when Ollama is not configured', async () => {
      vi.mocked(getUserOllamaSettings).mockResolvedValue(null);

      const request = new Request('https://example.com/api/ai/ollama/models', {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Ollama not configured');
      expect(body.models).toEqual([]);
    });

    // Contract note: When settings are null, the route returns 400 with "Ollama not configured".
    // This covers all "not configured" states; implementation details of how settings become null are irrelevant.
  });

  describe('successful model discovery', () => {
    it('should return models from Ollama instance', async () => {
      vi.mocked(getUserOllamaSettings).mockResolvedValue({
        isConfigured: true,
        baseUrl: mockBaseUrl,
      });

      const mockOllamaModels = {
        models: [
          { name: 'llama3.2:latest' },
          { name: 'mistral:7b' },
          { name: 'codellama:13b' },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockOllamaModels),
      });

      const request = new Request('https://example.com/api/ai/ollama/models', {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.models).toHaveProperty('llama3.2:latest');
      expect(body.models).toHaveProperty('mistral:7b');
      expect(body.models).toHaveProperty('codellama:13b');
      expect(body.baseUrl).toBe(mockBaseUrl);
      expect(body.modelCount).toBe(3);

      expect(global.fetch).toHaveBeenCalledWith(
        `${mockBaseUrl}/api/tags`,
        expect.objectContaining({
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });

    it('should clean up model display names', async () => {
      vi.mocked(getUserOllamaSettings).mockResolvedValue({
        isConfigured: true,
        baseUrl: mockBaseUrl,
      });

      const mockOllamaModels = {
        models: [
          { name: 'llama3.2:latest' },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockOllamaModels),
      });

      const request = new Request('https://example.com/api/ai/ollama/models', {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      // Should remove :latest suffix and capitalize
      expect(body.models['llama3.2:latest']).toBe('Llama3.2');
    });

    it('should handle empty models array', async () => {
      vi.mocked(getUserOllamaSettings).mockResolvedValue({
        isConfigured: true,
        baseUrl: mockBaseUrl,
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ models: [] }),
      });

      const request = new Request('https://example.com/api/ai/ollama/models', {
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
      vi.mocked(getUserOllamaSettings).mockResolvedValue({
        isConfigured: true,
        baseUrl: mockBaseUrl,
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ models: [{ name: 'test:model' }] }),
      });

      const request = new Request('https://example.com/api/ai/ollama/models', {
        method: 'GET',
      });

      await GET(request);

      expect(loggers.ai.info).toHaveBeenCalledWith(
        'Successfully fetched Ollama models',
        expect.objectContaining({
          userId: mockUserId,
          baseUrl: mockBaseUrl,
          modelCount: 1,
        })
      );
    });
  });

  describe('Ollama connection failures', () => {
    it('should return fallback models when Ollama is unreachable', async () => {
      vi.mocked(getUserOllamaSettings).mockResolvedValue({
        isConfigured: true,
        baseUrl: mockBaseUrl,
      });

      global.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

      const request = new Request('https://example.com/api/ai/ollama/models', {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      // Should return 200 with fallback models
      expect(response.status).toBe(200);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Could not connect to Ollama');
      expect(body.isFallback).toBe(true);
      expect(body.models).toHaveProperty('llama3.2:latest');
      expect(body.models).toHaveProperty('mistral:latest');
      expect(body.baseUrl).toBe(mockBaseUrl);
    });

    it('should return fallback models when Ollama returns non-OK status', async () => {
      vi.mocked(getUserOllamaSettings).mockResolvedValue({
        isConfigured: true,
        baseUrl: mockBaseUrl,
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      const request = new Request('https://example.com/api/ai/ollama/models', {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(false);
      expect(body.isFallback).toBe(true);
    });

    it('should log errors when Ollama fetch fails', async () => {
      vi.mocked(getUserOllamaSettings).mockResolvedValue({
        isConfigured: true,
        baseUrl: mockBaseUrl,
      });

      const error = new Error('Network timeout');
      global.fetch = vi.fn().mockRejectedValue(error);

      const request = new Request('https://example.com/api/ai/ollama/models', {
        method: 'GET',
      });

      await GET(request);

      expect(loggers.ai.error).toHaveBeenCalledWith(
        'Failed to fetch models from Ollama',
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
      vi.mocked(getUserOllamaSettings).mockRejectedValue(new Error('Database error'));

      const request = new Request('https://example.com/api/ai/ollama/models', {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.error).toBe('Failed to discover Ollama models');
      expect(body.models).toEqual({});
      expect(loggers.ai.error).toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    it('should handle models without name property', async () => {
      vi.mocked(getUserOllamaSettings).mockResolvedValue({
        isConfigured: true,
        baseUrl: mockBaseUrl,
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          models: [
            { name: 'valid:model' },
            { /* missing name */ },
            { name: '' },
            { name: 'another:model' },
          ],
        }),
      });

      const request = new Request('https://example.com/api/ai/ollama/models', {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(Object.keys(body.models).length).toBe(2);
      expect(body.models).toHaveProperty('valid:model');
      expect(body.models).toHaveProperty('another:model');
    });

    it('should handle missing models array in response', async () => {
      vi.mocked(getUserOllamaSettings).mockResolvedValue({
        isConfigured: true,
        baseUrl: mockBaseUrl,
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });

      const request = new Request('https://example.com/api/ai/ollama/models', {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.models).toEqual({});
    });
  });
});
