import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, POST, PATCH, DELETE } from '../route';
import type { WebAuthResult, AuthError } from '@/lib/auth';

// Mock dependencies
vi.mock('@pagespace/db', () => {
  const whereMock = vi.fn().mockResolvedValue([]);
  const setMock = vi.fn().mockReturnValue({ where: whereMock });
  const fromMock = vi.fn().mockReturnValue({ where: whereMock });
  const selectMock = vi.fn().mockReturnValue({ from: fromMock });
  const updateMock = vi.fn().mockReturnValue({ set: setMock });

  return {
    db: {
      select: selectMock,
      update: updateMock,
    },
    users: {},
    eq: vi.fn((field: unknown, value: unknown) => ({ field, value, type: 'eq' })),
  };
});

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
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@/lib/ai/core', () => ({
  getUserOpenRouterSettings: vi.fn(),
  createOpenRouterSettings: vi.fn(),
  deleteOpenRouterSettings: vi.fn(),
  getUserGoogleSettings: vi.fn(),
  createGoogleSettings: vi.fn(),
  deleteGoogleSettings: vi.fn(),
  getDefaultPageSpaceSettings: vi.fn(),
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

vi.mock('@/lib/subscription/rate-limit-middleware', () => ({
  requiresProSubscription: vi.fn(),
}));

import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import {
  getUserOpenRouterSettings,
  createOpenRouterSettings,
  deleteOpenRouterSettings,
  getUserGoogleSettings,
  createGoogleSettings,
  deleteGoogleSettings,
  getDefaultPageSpaceSettings,
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

// Helper to create mock user
const mockUser = (overrides: Partial<{
  id: string;
  currentAiProvider: string;
  currentAiModel: string;
  subscriptionTier: string;
}> = {}) => ({
  id: overrides.id || 'user_123',
  name: 'Test User',
  email: 'test@example.com',
  currentAiProvider: overrides.currentAiProvider || 'pagespace',
  currentAiModel: overrides.currentAiModel || 'glm-4.5-air',
  subscriptionTier: overrides.subscriptionTier || 'free',
});

describe('AI Settings API Routes', () => {
  const mockUserId = 'user_123';

  // Helper to setup select mock for users
  const setupUserSelectMock = (user: ReturnType<typeof mockUser> | undefined) => {
    const whereMock = vi.fn().mockResolvedValue(user ? [user] : []);
    const fromMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.select).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);
  };

  // Helper to setup update mock for users
  const setupUpdateMock = () => {
    const whereMock = vi.fn().mockResolvedValue([mockUser()]);
    const setMock = vi.fn().mockReturnValue({ where: whereMock });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as unknown as ReturnType<typeof db.update>);
    return { setMock, whereMock };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default auth success
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Default user setup
    setupUserSelectMock(mockUser());

    // Default provider settings (none configured)
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

  describe('GET /api/ai/settings', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/ai/settings', {
        method: 'GET',
      });

      const response = await GET(request);
      expect(response.status).toBe(401);
    });

    it('should return current AI settings for authenticated user', async () => {
      const request = new Request('https://example.com/api/ai/settings', {
        method: 'GET',
      });

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

      const request = new Request('https://example.com/api/ai/settings', {
        method: 'GET',
      });

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

      const request = new Request('https://example.com/api/ai/settings', {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      expect(body.providers.ollama.isConfigured).toBe(true);
      expect(body.providers.ollama.hasBaseUrl).toBe(true);
    });

    it('should handle database errors gracefully', async () => {
      const whereMock = vi.fn().mockRejectedValue(new Error('Database connection lost'));
      const fromMock = vi.fn().mockReturnValue({ where: whereMock });
      vi.mocked(db.select).mockReturnValue({ from: fromMock } as unknown as ReturnType<typeof db.select>);

      const request = new Request('https://example.com/api/ai/settings', {
        method: 'GET',
      });

      const response = await GET(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to retrieve settings');
      expect(loggers.ai.error).toHaveBeenCalled();
    });
  });

  describe('POST /api/ai/settings', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/ai/settings', {
        method: 'POST',
        body: JSON.stringify({ provider: 'openrouter', apiKey: 'test-key' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(401);
    });

    it('should reject invalid provider', async () => {
      const request = new Request('https://example.com/api/ai/settings', {
        method: 'POST',
        body: JSON.stringify({ provider: 'invalid-provider', apiKey: 'test-key' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('Invalid provider');
    });

    it('should reject missing API key for API-key providers', async () => {
      const request = new Request('https://example.com/api/ai/settings', {
        method: 'POST',
        body: JSON.stringify({ provider: 'openrouter', apiKey: '' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('API key is required');
    });

    it('should reject missing base URL for Ollama', async () => {
      const request = new Request('https://example.com/api/ai/settings', {
        method: 'POST',
        body: JSON.stringify({ provider: 'ollama', baseUrl: '' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Base URL is required for Ollama');
    });

    it('should reject missing base URL for LM Studio', async () => {
      const request = new Request('https://example.com/api/ai/settings', {
        method: 'POST',
        body: JSON.stringify({ provider: 'lmstudio', baseUrl: '' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Base URL is required for LM Studio');
    });

    it('should save OpenRouter API key successfully', async () => {
      vi.mocked(createOpenRouterSettings).mockResolvedValue(undefined);

      const request = new Request('https://example.com/api/ai/settings', {
        method: 'POST',
        body: JSON.stringify({ provider: 'openrouter', apiKey: '  test-api-key  ' }),
      });

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

      const request = new Request('https://example.com/api/ai/settings', {
        method: 'POST',
        body: JSON.stringify({ provider: 'google', apiKey: 'google-key' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.success).toBe(true);
      expect(createGoogleSettings).toHaveBeenCalledWith(mockUserId, 'google-key');
    });

    it('should save OpenAI API key successfully', async () => {
      vi.mocked(createOpenAISettings).mockResolvedValue(undefined);

      const request = new Request('https://example.com/api/ai/settings', {
        method: 'POST',
        body: JSON.stringify({ provider: 'openai', apiKey: 'openai-key' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(201);
      expect(createOpenAISettings).toHaveBeenCalledWith(mockUserId, 'openai-key');
    });

    it('should save Anthropic API key successfully', async () => {
      vi.mocked(createAnthropicSettings).mockResolvedValue(undefined);

      const request = new Request('https://example.com/api/ai/settings', {
        method: 'POST',
        body: JSON.stringify({ provider: 'anthropic', apiKey: 'anthropic-key' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(201);
      expect(createAnthropicSettings).toHaveBeenCalledWith(mockUserId, 'anthropic-key');
    });

    it('should save xAI API key successfully', async () => {
      vi.mocked(createXAISettings).mockResolvedValue(undefined);

      const request = new Request('https://example.com/api/ai/settings', {
        method: 'POST',
        body: JSON.stringify({ provider: 'xai', apiKey: 'xai-key' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(201);
      expect(createXAISettings).toHaveBeenCalledWith(mockUserId, 'xai-key');
    });

    it('should save Ollama base URL successfully', async () => {
      vi.mocked(createOllamaSettings).mockResolvedValue(undefined);

      const request = new Request('https://example.com/api/ai/settings', {
        method: 'POST',
        body: JSON.stringify({ provider: 'ollama', baseUrl: 'http://localhost:11434' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.success).toBe(true);
      expect(createOllamaSettings).toHaveBeenCalledWith(mockUserId, 'http://localhost:11434');
    });

    it('should save LM Studio base URL successfully', async () => {
      vi.mocked(createLMStudioSettings).mockResolvedValue(undefined);

      const request = new Request('https://example.com/api/ai/settings', {
        method: 'POST',
        body: JSON.stringify({ provider: 'lmstudio', baseUrl: 'http://localhost:1234/v1' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(201);
      expect(createLMStudioSettings).toHaveBeenCalledWith(mockUserId, 'http://localhost:1234/v1');
    });

    it('should save GLM API key successfully', async () => {
      vi.mocked(createGLMSettings).mockResolvedValue(undefined);

      const request = new Request('https://example.com/api/ai/settings', {
        method: 'POST',
        body: JSON.stringify({ provider: 'glm', apiKey: 'glm-key' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(201);
      expect(createGLMSettings).toHaveBeenCalledWith(mockUserId, 'glm-key');
    });

    it('should save MiniMax API key successfully', async () => {
      vi.mocked(createMiniMaxSettings).mockResolvedValue(undefined);

      const request = new Request('https://example.com/api/ai/settings', {
        method: 'POST',
        body: JSON.stringify({ provider: 'minimax', apiKey: 'minimax-key' }),
      });

      const response = await POST(request);
      expect(response.status).toBe(201);
      expect(createMiniMaxSettings).toHaveBeenCalledWith(mockUserId, 'minimax-key');
    });

    it('should handle save errors gracefully', async () => {
      vi.mocked(createOpenRouterSettings).mockRejectedValue(new Error('Save failed'));

      const request = new Request('https://example.com/api/ai/settings', {
        method: 'POST',
        body: JSON.stringify({ provider: 'openrouter', apiKey: 'test-key' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toContain('Failed to save');
      expect(loggers.ai.error).toHaveBeenCalled();
    });
  });

  describe('PATCH /api/ai/settings', () => {
    beforeEach(() => {
      setupUpdateMock();
    });

    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/ai/settings', {
        method: 'PATCH',
        body: JSON.stringify({ provider: 'pagespace', model: 'glm-4.5-air' }),
      });

      const response = await PATCH(request);
      expect(response.status).toBe(401);
    });

    it('should reject invalid provider', async () => {
      const request = new Request('https://example.com/api/ai/settings', {
        method: 'PATCH',
        body: JSON.stringify({ provider: 'invalid', model: 'test-model' }),
      });

      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('Invalid provider');
    });

    it('should reject missing model', async () => {
      const request = new Request('https://example.com/api/ai/settings', {
        method: 'PATCH',
        body: JSON.stringify({ provider: 'pagespace' }),
      });

      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toBe('Model is required');
    });

    it('should return 404 when user not found', async () => {
      setupUserSelectMock(undefined);

      const request = new Request('https://example.com/api/ai/settings', {
        method: 'PATCH',
        body: JSON.stringify({ provider: 'pagespace', model: 'glm-4.5-air' }),
      });

      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('User not found');
    });

    it('should reject pro model for free tier user', async () => {
      setupUserSelectMock(mockUser({ subscriptionTier: 'free' }));
      vi.mocked(requiresProSubscription).mockReturnValue(true);

      const request = new Request('https://example.com/api/ai/settings', {
        method: 'PATCH',
        body: JSON.stringify({ provider: 'pagespace', model: 'pro-model' }),
      });

      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toBe('Subscription required');
      expect(body.upgradeUrl).toBe('/settings/billing');
    });

    it('should update model selection successfully', async () => {
      setupUserSelectMock(mockUser({ subscriptionTier: 'pro' }));
      vi.mocked(requiresProSubscription).mockReturnValue(false);

      const request = new Request('https://example.com/api/ai/settings', {
        method: 'PATCH',
        body: JSON.stringify({ provider: 'openrouter', model: 'anthropic/claude-3-opus' }),
      });

      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.provider).toBe('openrouter');
      expect(body.model).toBe('anthropic/claude-3-opus');
    });

    it('should accept pagespace provider', async () => {
      vi.mocked(requiresProSubscription).mockReturnValue(false);

      const request = new Request('https://example.com/api/ai/settings', {
        method: 'PATCH',
        body: JSON.stringify({ provider: 'pagespace', model: 'glm-4.5-air' }),
      });

      const response = await PATCH(request);
      expect(response.status).toBe(200);
    });

    it('should accept openrouter_free provider', async () => {
      vi.mocked(requiresProSubscription).mockReturnValue(false);

      const request = new Request('https://example.com/api/ai/settings', {
        method: 'PATCH',
        body: JSON.stringify({ provider: 'openrouter_free', model: 'meta-llama/llama-3.2-3b' }),
      });

      const response = await PATCH(request);
      expect(response.status).toBe(200);
    });

    it('should handle update errors gracefully', async () => {
      vi.mocked(requiresProSubscription).mockReturnValue(false);
      const whereMock = vi.fn().mockRejectedValue(new Error('Update failed'));
      const setMock = vi.fn().mockReturnValue({ where: whereMock });
      vi.mocked(db.update).mockReturnValue({ set: setMock } as unknown as ReturnType<typeof db.update>);

      const request = new Request('https://example.com/api/ai/settings', {
        method: 'PATCH',
        body: JSON.stringify({ provider: 'pagespace', model: 'glm-4.5-air' }),
      });

      const response = await PATCH(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Failed to update model selection');
    });
  });

  describe('DELETE /api/ai/settings', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/ai/settings', {
        method: 'DELETE',
        body: JSON.stringify({ provider: 'openrouter' }),
      });

      const response = await DELETE(request);
      expect(response.status).toBe(401);
    });

    it('should reject invalid provider', async () => {
      const request = new Request('https://example.com/api/ai/settings', {
        method: 'DELETE',
        body: JSON.stringify({ provider: 'invalid' }),
      });

      const response = await DELETE(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('Invalid provider');
    });

    it('should delete OpenRouter settings successfully', async () => {
      vi.mocked(deleteOpenRouterSettings).mockResolvedValue(undefined);

      const request = new Request('https://example.com/api/ai/settings', {
        method: 'DELETE',
        body: JSON.stringify({ provider: 'openrouter' }),
      });

      const response = await DELETE(request);
      expect(response.status).toBe(204);
      expect(deleteOpenRouterSettings).toHaveBeenCalledWith(mockUserId);
    });

    it('should delete Google settings successfully', async () => {
      vi.mocked(deleteGoogleSettings).mockResolvedValue(undefined);

      const request = new Request('https://example.com/api/ai/settings', {
        method: 'DELETE',
        body: JSON.stringify({ provider: 'google' }),
      });

      const response = await DELETE(request);
      expect(response.status).toBe(204);
      expect(deleteGoogleSettings).toHaveBeenCalledWith(mockUserId);
    });

    it('should delete OpenAI settings successfully', async () => {
      vi.mocked(deleteOpenAISettings).mockResolvedValue(undefined);

      const request = new Request('https://example.com/api/ai/settings', {
        method: 'DELETE',
        body: JSON.stringify({ provider: 'openai' }),
      });

      const response = await DELETE(request);
      expect(response.status).toBe(204);
      expect(deleteOpenAISettings).toHaveBeenCalledWith(mockUserId);
    });

    it('should delete Anthropic settings successfully', async () => {
      vi.mocked(deleteAnthropicSettings).mockResolvedValue(undefined);

      const request = new Request('https://example.com/api/ai/settings', {
        method: 'DELETE',
        body: JSON.stringify({ provider: 'anthropic' }),
      });

      const response = await DELETE(request);
      expect(response.status).toBe(204);
      expect(deleteAnthropicSettings).toHaveBeenCalledWith(mockUserId);
    });

    it('should delete xAI settings successfully', async () => {
      vi.mocked(deleteXAISettings).mockResolvedValue(undefined);

      const request = new Request('https://example.com/api/ai/settings', {
        method: 'DELETE',
        body: JSON.stringify({ provider: 'xai' }),
      });

      const response = await DELETE(request);
      expect(response.status).toBe(204);
      expect(deleteXAISettings).toHaveBeenCalledWith(mockUserId);
    });

    it('should delete Ollama settings successfully', async () => {
      vi.mocked(deleteOllamaSettings).mockResolvedValue(undefined);

      const request = new Request('https://example.com/api/ai/settings', {
        method: 'DELETE',
        body: JSON.stringify({ provider: 'ollama' }),
      });

      const response = await DELETE(request);
      expect(response.status).toBe(204);
      expect(deleteOllamaSettings).toHaveBeenCalledWith(mockUserId);
    });

    it('should delete LM Studio settings successfully', async () => {
      vi.mocked(deleteLMStudioSettings).mockResolvedValue(undefined);

      const request = new Request('https://example.com/api/ai/settings', {
        method: 'DELETE',
        body: JSON.stringify({ provider: 'lmstudio' }),
      });

      const response = await DELETE(request);
      expect(response.status).toBe(204);
      expect(deleteLMStudioSettings).toHaveBeenCalledWith(mockUserId);
    });

    it('should delete GLM settings successfully', async () => {
      vi.mocked(deleteGLMSettings).mockResolvedValue(undefined);

      const request = new Request('https://example.com/api/ai/settings', {
        method: 'DELETE',
        body: JSON.stringify({ provider: 'glm' }),
      });

      const response = await DELETE(request);
      expect(response.status).toBe(204);
      expect(deleteGLMSettings).toHaveBeenCalledWith(mockUserId);
    });

    it('should delete MiniMax settings successfully', async () => {
      vi.mocked(deleteMiniMaxSettings).mockResolvedValue(undefined);

      const request = new Request('https://example.com/api/ai/settings', {
        method: 'DELETE',
        body: JSON.stringify({ provider: 'minimax' }),
      });

      const response = await DELETE(request);
      expect(response.status).toBe(204);
      expect(deleteMiniMaxSettings).toHaveBeenCalledWith(mockUserId);
    });

    it('should handle delete errors gracefully', async () => {
      vi.mocked(deleteOpenRouterSettings).mockRejectedValue(new Error('Delete failed'));

      const request = new Request('https://example.com/api/ai/settings', {
        method: 'DELETE',
        body: JSON.stringify({ provider: 'openrouter' }),
      });

      const response = await DELETE(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toContain('Failed to delete');
      expect(loggers.ai.error).toHaveBeenCalled();
    });
  });
});
