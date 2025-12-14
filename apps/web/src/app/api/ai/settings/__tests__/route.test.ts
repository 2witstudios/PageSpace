/**
 * Contract tests for GET/POST/PATCH/DELETE /api/ai/settings
 *
 * These tests verify the Request → Response contract and boundary obligations.
 * Database operations are mocked at the repository seam.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, POST, PATCH, DELETE } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock the repository seam (boundary)
vi.mock('@/lib/repositories/ai-settings-repository', () => ({
  aiSettingsRepository: {
    getUserSettings: vi.fn(),
    updateProviderSettings: vi.fn(),
  },
}));

// Mock auth (boundary)
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

// Mock logging (boundary)
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

// Mock AI provider settings functions (boundary)
vi.mock('@/lib/ai/core', () => ({
  getDefaultPageSpaceSettings: vi.fn(),
  getUserOpenRouterSettings: vi.fn(),
  createOpenRouterSettings: vi.fn(),
  deleteOpenRouterSettings: vi.fn(),
  getUserGoogleSettings: vi.fn(),
  createGoogleSettings: vi.fn(),
  deleteGoogleSettings: vi.fn(),
  getUserOpenAISettings: vi.fn(),
  createOpenAISettings: vi.fn(),
  deleteOpenAISettings: vi.fn(),
  getUserAnthropicSettings: vi.fn(),
  createAnthropicSettings: vi.fn(),
  deleteAnthropicSettings: vi.fn(),
  getUserXAISettings: vi.fn(),
  createXAISettings: vi.fn(),
  deleteXAISettings: vi.fn(),
  getUserOllamaSettings: vi.fn(),
  createOllamaSettings: vi.fn(),
  deleteOllamaSettings: vi.fn(),
  getUserLMStudioSettings: vi.fn(),
  createLMStudioSettings: vi.fn(),
  deleteLMStudioSettings: vi.fn(),
  getUserGLMSettings: vi.fn(),
  createGLMSettings: vi.fn(),
  deleteGLMSettings: vi.fn(),
  getUserMiniMaxSettings: vi.fn(),
  createMiniMaxSettings: vi.fn(),
  deleteMiniMaxSettings: vi.fn(),
}));

// Mock subscription middleware (boundary)
vi.mock('@/lib/subscription/rate-limit-middleware', () => ({
  requiresProSubscription: vi.fn(),
}));

import { aiSettingsRepository } from '@/lib/repositories/ai-settings-repository';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';
import {
  getDefaultPageSpaceSettings,
  getUserOpenRouterSettings,
  createOpenRouterSettings,
  deleteOpenRouterSettings,
  getUserGoogleSettings,
  createGoogleSettings,
  deleteGoogleSettings,
  getUserOpenAISettings,
  createOpenAISettings,
  deleteOpenAISettings,
  getUserAnthropicSettings,
  createAnthropicSettings,
  deleteAnthropicSettings,
  getUserXAISettings,
  createXAISettings,
  deleteXAISettings,
  getUserOllamaSettings,
  createOllamaSettings,
  deleteOllamaSettings,
  getUserLMStudioSettings,
  createLMStudioSettings,
  deleteLMStudioSettings,
  getUserGLMSettings,
  createGLMSettings,
  deleteGLMSettings,
  getUserMiniMaxSettings,
  createMiniMaxSettings,
  deleteMiniMaxSettings,
} from '@/lib/ai/core';
import { requiresProSubscription } from '@/lib/subscription/rate-limit-middleware';

// Test fixtures
const mockUserId = 'user_123';

const mockWebAuth = (userId: string): WebAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'jwt',
  source: 'cookie',
  role: 'user',
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const mockUserSettings = (overrides: Partial<{
  id: string;
  currentAiProvider: string | null;
  currentAiModel: string | null;
  subscriptionTier: string | null;
}> = {}) => ({
  id: overrides.id ?? mockUserId,
  currentAiProvider: overrides.currentAiProvider ?? 'pagespace',
  currentAiModel: overrides.currentAiModel ?? 'glm-4.5-air',
  subscriptionTier: overrides.subscriptionTier ?? 'free',
});

const createGetRequest = () =>
  new Request('https://example.com/api/ai/settings', { method: 'GET' });

const createPostRequest = (body: Record<string, unknown>) =>
  new Request('https://example.com/api/ai/settings', {
    method: 'POST',
    body: JSON.stringify(body),
  });

const createPatchRequest = (body: Record<string, unknown>) =>
  new Request('https://example.com/api/ai/settings', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });

const createDeleteRequest = (body: Record<string, unknown>) =>
  new Request('https://example.com/api/ai/settings', {
    method: 'DELETE',
    body: JSON.stringify(body),
  });

describe('GET /api/ai/settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: user exists
    vi.mocked(aiSettingsRepository.getUserSettings).mockResolvedValue(mockUserSettings());

    // Default: no provider settings configured
    vi.mocked(getDefaultPageSpaceSettings).mockResolvedValue(null);
    vi.mocked(getUserOpenRouterSettings).mockResolvedValue(null);
    vi.mocked(getUserGoogleSettings).mockResolvedValue(null);
    vi.mocked(getUserOpenAISettings).mockResolvedValue(null);
    vi.mocked(getUserAnthropicSettings).mockResolvedValue(null);
    vi.mocked(getUserXAISettings).mockResolvedValue(null);
    vi.mocked(getUserOllamaSettings).mockResolvedValue(null);
    vi.mocked(getUserLMStudioSettings).mockResolvedValue(null);
    vi.mocked(getUserGLMSettings).mockResolvedValue(null);
    vi.mocked(getUserMiniMaxSettings).mockResolvedValue(null);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = createGetRequest();

      const response = await GET(request);

      expect(response.status).toBe(401);
    });
  });

  describe('successful retrieval', () => {
    it('should return current AI settings for authenticated user', async () => {
      const request = createGetRequest();

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.currentProvider).toBe('pagespace');
      expect(body.currentModel).toBe('glm-4.5-air');
      expect(body.userSubscriptionTier).toBe('free');
      expect(body.providers).toBeDefined();
      expect(body.isAnyProviderConfigured).toBe(false);
    });

    it('should return provider configuration status', async () => {
      vi.mocked(getDefaultPageSpaceSettings).mockResolvedValue({
        isConfigured: true,
        apiKey: 'test-key',
      });
      vi.mocked(getUserOpenRouterSettings).mockResolvedValue({
        isConfigured: true,
        apiKey: 'openrouter-key',
      });

      const request = createGetRequest();

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.providers.pagespace.isConfigured).toBe(true);
      expect(body.providers.pagespace.hasApiKey).toBe(true);
      expect(body.providers.openrouter.isConfigured).toBe(true);
      expect(body.providers.openrouter.hasApiKey).toBe(true);
      expect(body.isAnyProviderConfigured).toBe(true);
    });

    it('should return ollama and lmstudio with baseUrl check', async () => {
      vi.mocked(getUserOllamaSettings).mockResolvedValue({
        isConfigured: true,
        baseUrl: 'http://localhost:11434',
      });

      const request = createGetRequest();

      const response = await GET(request);
      const body = await response.json();

      expect(body.providers.ollama.isConfigured).toBe(true);
      expect(body.providers.ollama.hasBaseUrl).toBe(true);
    });

    it('should call repository with userId', async () => {
      const request = createGetRequest();

      await GET(request);

      expect(aiSettingsRepository.getUserSettings).toHaveBeenCalledWith(mockUserId);
    });
  });

  describe('error handling', () => {
    it('should return 500 when repository throws', async () => {
      vi.mocked(aiSettingsRepository.getUserSettings).mockRejectedValue(
        new Error('Database error')
      );

      const request = createGetRequest();

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to retrieve settings');
      expect(loggers.ai.error).toHaveBeenCalled();
    });
  });
});

describe('POST /api/ai/settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = createPostRequest({ provider: 'openrouter', apiKey: 'test-key' });

      const response = await POST(request);

      expect(response.status).toBe(401);
    });
  });

  describe('validation', () => {
    it('should reject invalid provider', async () => {
      const request = createPostRequest({ provider: 'invalid-provider', apiKey: 'test-key' });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('Invalid provider');
    });

    it('should reject missing API key for API-key providers', async () => {
      const request = createPostRequest({ provider: 'openrouter', apiKey: '' });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('API key is required');
    });

    it('should reject missing base URL for Ollama', async () => {
      const request = createPostRequest({ provider: 'ollama', baseUrl: '' });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Base URL is required for Ollama');
    });

    it('should reject missing base URL for LM Studio', async () => {
      const request = createPostRequest({ provider: 'lmstudio', baseUrl: '' });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Base URL is required for LM Studio');
    });
  });

  describe('successful creation', () => {
    it('should save OpenRouter API key successfully', async () => {
      vi.mocked(createOpenRouterSettings).mockResolvedValue(undefined);

      const request = createPostRequest({ provider: 'openrouter', apiKey: '  test-api-key  ' });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.success).toBe(true);
      expect(body.provider).toBe('openrouter');
      expect(body.message).toContain('OpenRouter');
      expect(createOpenRouterSettings).toHaveBeenCalledWith(mockUserId, 'test-api-key');
    });

    it('should save Google API key successfully', async () => {
      vi.mocked(createGoogleSettings).mockResolvedValue(undefined);

      const request = createPostRequest({ provider: 'google', apiKey: 'google-key' });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.success).toBe(true);
      expect(createGoogleSettings).toHaveBeenCalledWith(mockUserId, 'google-key');
    });

    it('should save OpenAI API key successfully', async () => {
      vi.mocked(createOpenAISettings).mockResolvedValue(undefined);

      const request = createPostRequest({ provider: 'openai', apiKey: 'openai-key' });

      const response = await POST(request);

      expect(response.status).toBe(201);
      expect(createOpenAISettings).toHaveBeenCalledWith(mockUserId, 'openai-key');
    });

    it('should save Anthropic API key successfully', async () => {
      vi.mocked(createAnthropicSettings).mockResolvedValue(undefined);

      const request = createPostRequest({ provider: 'anthropic', apiKey: 'anthropic-key' });

      const response = await POST(request);

      expect(response.status).toBe(201);
      expect(createAnthropicSettings).toHaveBeenCalledWith(mockUserId, 'anthropic-key');
    });

    it('should save xAI API key successfully', async () => {
      vi.mocked(createXAISettings).mockResolvedValue(undefined);

      const request = createPostRequest({ provider: 'xai', apiKey: 'xai-key' });

      const response = await POST(request);

      expect(response.status).toBe(201);
      expect(createXAISettings).toHaveBeenCalledWith(mockUserId, 'xai-key');
    });

    it('should save Ollama base URL successfully', async () => {
      vi.mocked(createOllamaSettings).mockResolvedValue(undefined);

      const request = createPostRequest({ provider: 'ollama', baseUrl: 'http://localhost:11434' });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.success).toBe(true);
      expect(createOllamaSettings).toHaveBeenCalledWith(mockUserId, 'http://localhost:11434');
    });

    it('should save LM Studio base URL successfully', async () => {
      vi.mocked(createLMStudioSettings).mockResolvedValue(undefined);

      const request = createPostRequest({ provider: 'lmstudio', baseUrl: 'http://localhost:1234/v1' });

      const response = await POST(request);

      expect(response.status).toBe(201);
      expect(createLMStudioSettings).toHaveBeenCalledWith(mockUserId, 'http://localhost:1234/v1');
    });

    it('should save GLM API key successfully', async () => {
      vi.mocked(createGLMSettings).mockResolvedValue(undefined);

      const request = createPostRequest({ provider: 'glm', apiKey: 'glm-key' });

      const response = await POST(request);

      expect(response.status).toBe(201);
      expect(createGLMSettings).toHaveBeenCalledWith(mockUserId, 'glm-key');
    });

    it('should save MiniMax API key successfully', async () => {
      vi.mocked(createMiniMaxSettings).mockResolvedValue(undefined);

      const request = createPostRequest({ provider: 'minimax', apiKey: 'minimax-key' });

      const response = await POST(request);

      expect(response.status).toBe(201);
      expect(createMiniMaxSettings).toHaveBeenCalledWith(mockUserId, 'minimax-key');
    });
  });

  describe('error handling', () => {
    it('should return 500 when save throws', async () => {
      vi.mocked(createOpenRouterSettings).mockRejectedValue(new Error('Save failed'));

      const request = createPostRequest({ provider: 'openrouter', apiKey: 'test-key' });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toContain('Failed to save');
      expect(loggers.ai.error).toHaveBeenCalled();
    });
  });
});

describe('PATCH /api/ai/settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default: user exists
    vi.mocked(aiSettingsRepository.getUserSettings).mockResolvedValue(mockUserSettings());

    // Default: no subscription required
    vi.mocked(requiresProSubscription).mockReturnValue(false);

    // Default: update succeeds
    vi.mocked(aiSettingsRepository.updateProviderSettings).mockResolvedValue(undefined);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = createPatchRequest({ provider: 'pagespace', model: 'glm-4.5-air' });

      const response = await PATCH(request);

      expect(response.status).toBe(401);
    });
  });

  describe('validation', () => {
    it('should reject invalid provider', async () => {
      const request = createPatchRequest({ provider: 'invalid', model: 'test-model' });

      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('Invalid provider');
    });

    it('should reject missing model', async () => {
      const request = createPatchRequest({ provider: 'pagespace' });

      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Model is required');
    });
  });

  describe('user not found', () => {
    it('should return 404 when user not found', async () => {
      vi.mocked(aiSettingsRepository.getUserSettings).mockResolvedValue(null);

      const request = createPatchRequest({ provider: 'pagespace', model: 'glm-4.5-air' });

      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('User not found');
    });
  });

  describe('subscription checks', () => {
    it('should reject pro model for free tier user', async () => {
      vi.mocked(aiSettingsRepository.getUserSettings).mockResolvedValue(
        mockUserSettings({ subscriptionTier: 'free' })
      );
      vi.mocked(requiresProSubscription).mockReturnValue(true);

      const request = createPatchRequest({ provider: 'pagespace', model: 'pro-model' });

      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Subscription required');
      expect(body.upgradeUrl).toBe('/settings/billing');
    });
  });

  describe('successful update', () => {
    it('should update model selection successfully', async () => {
      vi.mocked(aiSettingsRepository.getUserSettings).mockResolvedValue(
        mockUserSettings({ subscriptionTier: 'pro' })
      );

      const request = createPatchRequest({ provider: 'openrouter', model: 'anthropic/claude-3-opus' });

      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.provider).toBe('openrouter');
      expect(body.model).toBe('anthropic/claude-3-opus');
    });

    it('should accept pagespace provider', async () => {
      const request = createPatchRequest({ provider: 'pagespace', model: 'glm-4.5-air' });

      const response = await PATCH(request);

      expect(response.status).toBe(200);
    });

    it('should accept openrouter_free provider', async () => {
      const request = createPatchRequest({ provider: 'openrouter_free', model: 'meta-llama/llama-3.2-3b' });

      const response = await PATCH(request);

      expect(response.status).toBe(200);
    });

    it('should call repository with correct params', async () => {
      const request = createPatchRequest({ provider: 'openrouter', model: 'test-model' });

      await PATCH(request);

      expect(aiSettingsRepository.updateProviderSettings).toHaveBeenCalledWith(
        mockUserId,
        { provider: 'openrouter', model: 'test-model' }
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 when update throws', async () => {
      vi.mocked(aiSettingsRepository.updateProviderSettings).mockRejectedValue(
        new Error('Update failed')
      );

      const request = createPatchRequest({ provider: 'pagespace', model: 'glm-4.5-air' });

      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to update model selection');
      expect(loggers.ai.error).toHaveBeenCalled();
    });
  });
});

describe('DELETE /api/ai/settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: authenticated user
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = createDeleteRequest({ provider: 'openrouter' });

      const response = await DELETE(request);

      expect(response.status).toBe(401);
    });
  });

  describe('validation', () => {
    it('should reject invalid provider', async () => {
      const request = createDeleteRequest({ provider: 'invalid' });

      const response = await DELETE(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('Invalid provider');
    });
  });

  describe('successful deletion', () => {
    it('should delete OpenRouter settings successfully', async () => {
      vi.mocked(deleteOpenRouterSettings).mockResolvedValue(undefined);

      const request = createDeleteRequest({ provider: 'openrouter' });

      const response = await DELETE(request);

      expect(response.status).toBe(204);
      expect(deleteOpenRouterSettings).toHaveBeenCalledWith(mockUserId);
    });

    it('should delete Google settings successfully', async () => {
      vi.mocked(deleteGoogleSettings).mockResolvedValue(undefined);

      const request = createDeleteRequest({ provider: 'google' });

      const response = await DELETE(request);

      expect(response.status).toBe(204);
      expect(deleteGoogleSettings).toHaveBeenCalledWith(mockUserId);
    });

    it('should delete OpenAI settings successfully', async () => {
      vi.mocked(deleteOpenAISettings).mockResolvedValue(undefined);

      const request = createDeleteRequest({ provider: 'openai' });

      const response = await DELETE(request);

      expect(response.status).toBe(204);
      expect(deleteOpenAISettings).toHaveBeenCalledWith(mockUserId);
    });

    it('should delete Anthropic settings successfully', async () => {
      vi.mocked(deleteAnthropicSettings).mockResolvedValue(undefined);

      const request = createDeleteRequest({ provider: 'anthropic' });

      const response = await DELETE(request);

      expect(response.status).toBe(204);
      expect(deleteAnthropicSettings).toHaveBeenCalledWith(mockUserId);
    });

    it('should delete xAI settings successfully', async () => {
      vi.mocked(deleteXAISettings).mockResolvedValue(undefined);

      const request = createDeleteRequest({ provider: 'xai' });

      const response = await DELETE(request);

      expect(response.status).toBe(204);
      expect(deleteXAISettings).toHaveBeenCalledWith(mockUserId);
    });

    it('should delete Ollama settings successfully', async () => {
      vi.mocked(deleteOllamaSettings).mockResolvedValue(undefined);

      const request = createDeleteRequest({ provider: 'ollama' });

      const response = await DELETE(request);

      expect(response.status).toBe(204);
      expect(deleteOllamaSettings).toHaveBeenCalledWith(mockUserId);
    });

    it('should delete LM Studio settings successfully', async () => {
      vi.mocked(deleteLMStudioSettings).mockResolvedValue(undefined);

      const request = createDeleteRequest({ provider: 'lmstudio' });

      const response = await DELETE(request);

      expect(response.status).toBe(204);
      expect(deleteLMStudioSettings).toHaveBeenCalledWith(mockUserId);
    });

    it('should delete GLM settings successfully', async () => {
      vi.mocked(deleteGLMSettings).mockResolvedValue(undefined);

      const request = createDeleteRequest({ provider: 'glm' });

      const response = await DELETE(request);

      expect(response.status).toBe(204);
      expect(deleteGLMSettings).toHaveBeenCalledWith(mockUserId);
    });

    it('should delete MiniMax settings successfully', async () => {
      vi.mocked(deleteMiniMaxSettings).mockResolvedValue(undefined);

      const request = createDeleteRequest({ provider: 'minimax' });

      const response = await DELETE(request);

      expect(response.status).toBe(204);
      expect(deleteMiniMaxSettings).toHaveBeenCalledWith(mockUserId);
    });
  });

  describe('error handling', () => {
    it('should return 500 when delete throws', async () => {
      vi.mocked(deleteOpenRouterSettings).mockRejectedValue(new Error('Delete failed'));

      const request = createDeleteRequest({ provider: 'openrouter' });

      const response = await DELETE(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toContain('Failed to delete');
      expect(loggers.ai.error).toHaveBeenCalled();
    });
  });
});
