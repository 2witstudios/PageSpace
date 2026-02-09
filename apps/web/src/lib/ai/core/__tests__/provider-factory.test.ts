import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock next/server - create a mock class so instanceof checks work
vi.mock('next/server', () => {
  class MockNextResponse {
    status: number;
    _body: unknown;
    constructor(body: unknown, init?: { status?: number }) {
      this._body = body;
      this.status = init?.status || 200;
    }
    async json() { return this._body; }
    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init);
    }
  }
  return { NextResponse: MockNextResponse };
});

import { NextResponse } from 'next/server';

// Mock database
vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  },
  users: { id: 'id', currentAiProvider: 'currentAiProvider', currentAiModel: 'currentAiModel' },
  eq: vi.fn((a, b) => ({ a, b })),
}));

// Mock AI providers
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: vi.fn(() => ({
    chat: vi.fn(() => ({ modelId: 'openrouter-model' })),
  })),
}));

vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: vi.fn(() => vi.fn(() => ({ modelId: 'google-model' }))),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => vi.fn(() => ({ modelId: 'openai-model' }))),
}));

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: vi.fn(() => vi.fn(() => ({ modelId: 'openai-compatible-model' }))),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => vi.fn(() => ({ modelId: 'anthropic-model' }))),
}));

vi.mock('@ai-sdk/xai', () => ({
  createXai: vi.fn(() => vi.fn(() => ({ modelId: 'xai-model' }))),
}));

vi.mock('ollama-ai-provider-v2', () => ({
  createOllama: vi.fn(() => vi.fn(() => ({ modelId: 'ollama-model' }))),
}));

// Mock security validation
vi.mock('@pagespace/lib/security', () => ({
  validateLocalProviderURL: vi.fn(),
}));

// Mock ai-providers-config - provide real resolvePageSpaceModel + mockable requiresConsent
vi.mock('../ai-providers-config', () => ({
  resolvePageSpaceModel: vi.fn((m: string) => {
    const aliases: Record<string, string> = { standard: 'glm-4.5-air', pro: 'glm-4.7' };
    return aliases[m?.toLowerCase()] || m;
  }),
  requiresConsent: vi.fn(),
}));

// Mock consent repository (dynamically imported by provider-factory)
vi.mock('@/lib/repositories/ai-consent-repository', () => ({
  aiConsentRepository: {
    hasConsent: vi.fn(),
  },
}));

// Mock ai-utils
vi.mock('../ai-utils', () => ({
  getUserOpenRouterSettings: vi.fn(),
  createOpenRouterSettings: vi.fn(),
  getUserGoogleSettings: vi.fn(),
  createGoogleSettings: vi.fn(),
  getDefaultPageSpaceSettings: vi.fn(),
  getUserOpenAISettings: vi.fn(),
  createOpenAISettings: vi.fn(),
  getUserAnthropicSettings: vi.fn(),
  createAnthropicSettings: vi.fn(),
  getUserXAISettings: vi.fn(),
  createXAISettings: vi.fn(),
  getUserOllamaSettings: vi.fn(),
  createOllamaSettings: vi.fn(),
  getUserLMStudioSettings: vi.fn(),
  createLMStudioSettings: vi.fn(),
  getUserGLMSettings: vi.fn(),
  createGLMSettings: vi.fn(),
  getUserMiniMaxSettings: vi.fn(),
  createMiniMaxSettings: vi.fn(),
}));

import { type LanguageModel } from 'ai';
import {
  createProviderErrorResponse,
  isProviderError,
  type ProviderResult,
  createAIProvider,
  updateUserProviderSettings,
} from '../provider-factory';
import { db } from '@pagespace/db';
import {
  getUserOpenRouterSettings,
  createOpenRouterSettings,
  getUserGoogleSettings,
  getDefaultPageSpaceSettings,
  getUserOpenAISettings,
  getUserAnthropicSettings,
  getUserXAISettings,
  getUserOllamaSettings,
  getUserLMStudioSettings,
  getUserGLMSettings,
  getUserMiniMaxSettings,
} from '../ai-utils';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createXai } from '@ai-sdk/xai';
import { createOllama } from 'ollama-ai-provider-v2';
import { validateLocalProviderURL } from '@pagespace/lib/security';
import { requiresConsent } from '../ai-providers-config';
import { aiConsentRepository } from '@/lib/repositories/ai-consent-repository';

const mockDb = vi.mocked(db);
const mockDbMock = mockDb as unknown as MockDb;
const mockGetUserOpenRouterSettings = vi.mocked(getUserOpenRouterSettings);
const mockGetUserGoogleSettings = vi.mocked(getUserGoogleSettings);
const mockGetDefaultPageSpaceSettings = vi.mocked(getDefaultPageSpaceSettings);
const mockGetUserOpenAISettings = vi.mocked(getUserOpenAISettings);
const mockGetUserAnthropicSettings = vi.mocked(getUserAnthropicSettings);
const mockGetUserXAISettings = vi.mocked(getUserXAISettings);
const mockGetUserOllamaSettings = vi.mocked(getUserOllamaSettings);
const mockGetUserLMStudioSettings = vi.mocked(getUserLMStudioSettings);
const mockGetUserGLMSettings = vi.mocked(getUserGLMSettings);
const mockGetUserMiniMaxSettings = vi.mocked(getUserMiniMaxSettings);

type MockFn = ReturnType<typeof vi.fn>;

interface MockDb {
  select: MockFn;
  from: MockFn;
  where: MockFn;
  update: MockFn;
  set: MockFn;
}

describe('provider-factory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock: return user with no provider set
    mockDbMock.where.mockResolvedValue([
      { id: 'user-123', currentAiProvider: null, currentAiModel: null },
    ]);
    // Default mock: URL validation passes (for ollama/lmstudio tests)
    vi.mocked(validateLocalProviderURL).mockResolvedValue({
      valid: true,
      url: new URL('http://localhost:11434'),
      resolvedIPs: ['127.0.0.1'],
    });
    // Default mock: no consent required (so existing tests are unaffected)
    vi.mocked(requiresConsent).mockReturnValue(false);
  });

  describe('createAIProvider', () => {
    describe('pagespace provider', () => {
      it('uses GLM backend when default settings have GLM provider', async () => {
        mockGetDefaultPageSpaceSettings.mockResolvedValue({
          provider: 'glm',
          apiKey: 'glm-api-key',
          isConfigured: true,
        });

        const result = await createAIProvider('user-123', {});

        expect(isProviderError(result)).toBe(false);
        if (!isProviderError(result)) {
          expect(result.provider).toBe('pagespace');
          expect(createOpenAICompatible).toHaveBeenCalledWith({
            name: 'glm',
            apiKey: 'glm-api-key',
            baseURL: 'https://api.z.ai/api/coding/paas/v4',
          });
        }
      });

      it('uses Google backend when default settings have Google provider', async () => {
        mockGetDefaultPageSpaceSettings.mockResolvedValue({
          provider: 'google',
          apiKey: 'google-api-key',
          isConfigured: true,
        });

        const result = await createAIProvider('user-123', {});

        expect(isProviderError(result)).toBe(false);
        if (!isProviderError(result)) {
          expect(result.provider).toBe('pagespace');
          expect(createGoogleGenerativeAI).toHaveBeenCalledWith({
            apiKey: 'google-api-key',
          });
        }
      });

      it('falls back to user Google settings when no default key', async () => {
        mockGetDefaultPageSpaceSettings.mockResolvedValue(null);
        mockGetUserGoogleSettings.mockResolvedValue({
          apiKey: 'user-google-key',
          isConfigured: true,
        });

        const result = await createAIProvider('user-123', {});

        expect(isProviderError(result)).toBe(false);
        if (!isProviderError(result)) {
          expect(result.provider).toBe('pagespace');
        }
      });

      it('returns error when no default key and no user Google settings', async () => {
        mockGetDefaultPageSpaceSettings.mockResolvedValue(null);
        mockGetUserGoogleSettings.mockResolvedValue(null);

        const result = await createAIProvider('user-123', {});

        expect(isProviderError(result)).toBe(true);
        if (isProviderError(result)) {
          expect(result.error).toContain('No default API key configured');
          expect(result.status).toBe(400);
        }
      });

      it('returns error for unsupported pagespace provider type', async () => {
        mockGetDefaultPageSpaceSettings.mockResolvedValue({
          provider: 'unsupported',
          apiKey: 'key',
        } as never);

        const result = await createAIProvider('user-123', {});

        expect(isProviderError(result)).toBe(true);
        if (isProviderError(result)) {
          expect(result.error).toContain('Unsupported PageSpace provider');
        }
      });
    });

    describe('openrouter provider', () => {
      it('creates OpenRouter provider with existing settings', async () => {
        mockGetUserOpenRouterSettings.mockResolvedValue({
          apiKey: 'openrouter-key',
          isConfigured: true,
        });

        const result = await createAIProvider('user-123', {
          selectedProvider: 'openrouter',
          selectedModel: 'anthropic/claude-3-sonnet',
        });

        expect(isProviderError(result)).toBe(false);
        if (!isProviderError(result)) {
          expect(result.provider).toBe('openrouter');
          expect(createOpenRouter).toHaveBeenCalledWith({ apiKey: 'openrouter-key' });
        }
      });

      it('creates settings with new API key and returns valid provider', async () => {
        // First call returns null, subsequent calls return the new settings
        mockGetUserOpenRouterSettings
          .mockResolvedValueOnce(null)
          .mockResolvedValue({ apiKey: 'new-openrouter-key', isConfigured: true });

        const result = await createAIProvider('user-123', {
          selectedProvider: 'openrouter',
          selectedModel: 'anthropic/claude-3-sonnet',
          openRouterApiKey: 'new-openrouter-key',
        });

        expect(createOpenRouterSettings).toHaveBeenCalledWith('user-123', 'new-openrouter-key');
        expect(isProviderError(result)).toBe(false);
        if (!isProviderError(result)) {
          expect(result.provider).toBe('openrouter');
        }
      });

      it('returns error when no OpenRouter key configured', async () => {
        mockGetUserOpenRouterSettings.mockResolvedValue(null);

        const result = await createAIProvider('user-123', {
          selectedProvider: 'openrouter',
        });

        expect(isProviderError(result)).toBe(true);
        if (isProviderError(result)) {
          expect(result.error).toContain('OpenRouter API key not configured');
        }
      });
    });

    describe('openrouter_free provider', () => {
      it('uses same OpenRouter settings as regular OpenRouter', async () => {
        mockGetUserOpenRouterSettings.mockResolvedValue({
          apiKey: 'openrouter-key',
          isConfigured: true,
        });

        const result = await createAIProvider('user-123', {
          selectedProvider: 'openrouter_free',
          selectedModel: 'meta-llama/llama-3-8b:free',
        });

        expect(isProviderError(result)).toBe(false);
        if (!isProviderError(result)) {
          expect(result.provider).toBe('openrouter_free');
        }
      });
    });

    describe('google provider', () => {
      it('creates Google provider with existing settings', async () => {
        mockGetUserGoogleSettings.mockResolvedValue({
          apiKey: 'google-key',
          isConfigured: true,
        });

        const result = await createAIProvider('user-123', {
          selectedProvider: 'google',
          selectedModel: 'gemini-2.5-flash',
        });

        expect(isProviderError(result)).toBe(false);
        if (!isProviderError(result)) {
          expect(result.provider).toBe('google');
          expect(createGoogleGenerativeAI).toHaveBeenCalledWith({ apiKey: 'google-key' });
        }
      });

      it('returns error when no Google key configured', async () => {
        mockGetUserGoogleSettings.mockResolvedValue(null);

        const result = await createAIProvider('user-123', {
          selectedProvider: 'google',
        });

        expect(isProviderError(result)).toBe(true);
        if (isProviderError(result)) {
          expect(result.error).toContain('Google AI API key not configured');
        }
      });
    });

    describe('openai provider', () => {
      it('creates OpenAI provider with existing settings', async () => {
        mockGetUserOpenAISettings.mockResolvedValue({
          apiKey: 'openai-key',
          isConfigured: true,
        });

        const result = await createAIProvider('user-123', {
          selectedProvider: 'openai',
          selectedModel: 'gpt-4',
        });

        expect(isProviderError(result)).toBe(false);
        if (!isProviderError(result)) {
          expect(result.provider).toBe('openai');
          expect(createOpenAI).toHaveBeenCalledWith({ apiKey: 'openai-key' });
        }
      });

      it('returns error when no OpenAI key configured', async () => {
        mockGetUserOpenAISettings.mockResolvedValue(null);

        const result = await createAIProvider('user-123', {
          selectedProvider: 'openai',
        });

        expect(isProviderError(result)).toBe(true);
        if (isProviderError(result)) {
          expect(result.error).toContain('OpenAI API key not configured');
        }
      });
    });

    describe('anthropic provider', () => {
      it('creates Anthropic provider with existing settings', async () => {
        mockGetUserAnthropicSettings.mockResolvedValue({
          apiKey: 'anthropic-key',
          isConfigured: true,
        });

        const result = await createAIProvider('user-123', {
          selectedProvider: 'anthropic',
          selectedModel: 'claude-3-sonnet',
        });

        expect(isProviderError(result)).toBe(false);
        if (!isProviderError(result)) {
          expect(result.provider).toBe('anthropic');
          expect(createAnthropic).toHaveBeenCalledWith({ apiKey: 'anthropic-key' });
        }
      });

      it('returns error when no Anthropic key configured', async () => {
        mockGetUserAnthropicSettings.mockResolvedValue(null);

        const result = await createAIProvider('user-123', {
          selectedProvider: 'anthropic',
        });

        expect(isProviderError(result)).toBe(true);
        if (isProviderError(result)) {
          expect(result.error).toContain('Anthropic API key not configured');
        }
      });
    });

    describe('xai provider', () => {
      it('creates xAI provider with existing settings', async () => {
        mockGetUserXAISettings.mockResolvedValue({
          apiKey: 'xai-key',
          isConfigured: true,
        });

        const result = await createAIProvider('user-123', {
          selectedProvider: 'xai',
          selectedModel: 'grok-1',
        });

        expect(isProviderError(result)).toBe(false);
        if (!isProviderError(result)) {
          expect(result.provider).toBe('xai');
          expect(createXai).toHaveBeenCalledWith({ apiKey: 'xai-key' });
        }
      });

      it('returns error when no xAI key configured', async () => {
        mockGetUserXAISettings.mockResolvedValue(null);

        const result = await createAIProvider('user-123', {
          selectedProvider: 'xai',
        });

        expect(isProviderError(result)).toBe(true);
        if (isProviderError(result)) {
          expect(result.error).toContain('xAI API key not configured');
        }
      });
    });

    describe('ollama provider', () => {
      it('creates Ollama provider with existing settings', async () => {
        mockGetUserOllamaSettings.mockResolvedValue({
          baseUrl: 'http://localhost:11434',
          isConfigured: true,
        });

        const result = await createAIProvider('user-123', {
          selectedProvider: 'ollama',
          selectedModel: 'llama2',
        });

        expect(isProviderError(result)).toBe(false);
        if (!isProviderError(result)) {
          expect(result.provider).toBe('ollama');
          expect(createOllama).toHaveBeenCalledWith({
            baseURL: 'http://localhost:11434/api',
          });
        }
      });

      it('returns error when no Ollama URL configured', async () => {
        mockGetUserOllamaSettings.mockResolvedValue(null);

        const result = await createAIProvider('user-123', {
          selectedProvider: 'ollama',
        });

        expect(isProviderError(result)).toBe(true);
        if (isProviderError(result)) {
          expect(result.error).toContain('Ollama base URL not configured');
        }
      });
    });

    describe('lmstudio provider', () => {
      it('creates LM Studio provider with existing settings', async () => {
        mockGetUserLMStudioSettings.mockResolvedValue({
          baseUrl: 'http://localhost:1234/v1',
          isConfigured: true,
        });

        const result = await createAIProvider('user-123', {
          selectedProvider: 'lmstudio',
          selectedModel: 'local-model',
        });

        expect(isProviderError(result)).toBe(false);
        if (!isProviderError(result)) {
          expect(result.provider).toBe('lmstudio');
          expect(createOpenAICompatible).toHaveBeenCalledWith({
            name: 'lmstudio',
            baseURL: 'http://localhost:1234/v1',
          });
        }
      });

      it('returns error when no LM Studio URL configured', async () => {
        mockGetUserLMStudioSettings.mockResolvedValue(null);

        const result = await createAIProvider('user-123', {
          selectedProvider: 'lmstudio',
        });

        expect(isProviderError(result)).toBe(true);
        if (isProviderError(result)) {
          expect(result.error).toContain('LM Studio base URL not configured');
        }
      });
    });

    describe('glm provider', () => {
      it('creates GLM provider with existing settings', async () => {
        mockGetUserGLMSettings.mockResolvedValue({
          apiKey: 'glm-key',
          isConfigured: true,
        });

        const result = await createAIProvider('user-123', {
          selectedProvider: 'glm',
          selectedModel: 'glm-4-flash',
        });

        expect(isProviderError(result)).toBe(false);
        if (!isProviderError(result)) {
          expect(result.provider).toBe('glm');
          expect(createOpenAICompatible).toHaveBeenCalledWith({
            name: 'glm',
            apiKey: 'glm-key',
            baseURL: 'https://api.z.ai/api/coding/paas/v4',
          });
        }
      });

      it('returns error when no GLM key configured', async () => {
        mockGetUserGLMSettings.mockResolvedValue(null);

        const result = await createAIProvider('user-123', {
          selectedProvider: 'glm',
        });

        expect(isProviderError(result)).toBe(true);
        if (isProviderError(result)) {
          expect(result.error).toContain('GLM API key not configured');
        }
      });
    });

    describe('minimax provider', () => {
      it('creates MiniMax provider with existing settings', async () => {
        mockGetUserMiniMaxSettings.mockResolvedValue({
          apiKey: 'minimax-key',
          isConfigured: true,
        });

        const result = await createAIProvider('user-123', {
          selectedProvider: 'minimax',
          selectedModel: 'abab5.5-chat',
        });

        expect(isProviderError(result)).toBe(false);
        if (!isProviderError(result)) {
          expect(result.provider).toBe('minimax');
          expect(createAnthropic).toHaveBeenCalledWith({
            apiKey: 'minimax-key',
            baseURL: 'https://api.minimax.io/anthropic/v1',
          });
        }
      });

      it('returns error when no MiniMax key configured', async () => {
        mockGetUserMiniMaxSettings.mockResolvedValue(null);

        const result = await createAIProvider('user-123', {
          selectedProvider: 'minimax',
        });

        expect(isProviderError(result)).toBe(true);
        if (isProviderError(result)) {
          expect(result.error).toContain('MiniMax API key not configured');
        }
      });
    });

    describe('unsupported provider', () => {
      it('returns error for unknown provider', async () => {
        const result = await createAIProvider('user-123', {
          selectedProvider: 'unknown-provider',
        });

        expect(isProviderError(result)).toBe(true);
        if (isProviderError(result)) {
          expect(result.error).toContain('Unsupported AI provider: unknown-provider');
          expect(result.status).toBe(400);
        }
      });
    });

    describe('user provider defaults', () => {
      it('uses user default provider when not specified', async () => {
        mockDbMock.where.mockResolvedValue([
          { id: 'user-123', currentAiProvider: 'google', currentAiModel: 'gemini-pro' },
        ]);
        mockGetUserGoogleSettings.mockResolvedValue({
          apiKey: 'google-key',
          isConfigured: true,
        });

        const result = await createAIProvider('user-123', {});

        expect(isProviderError(result)).toBe(false);
        if (!isProviderError(result)) {
          expect(result.provider).toBe('google');
          expect(result.modelName).toBe('gemini-pro');
        }
      });
    });

    describe('error handling', () => {
      it('catches and wraps provider creation errors', async () => {
        mockGetUserGoogleSettings.mockRejectedValue(new Error('Database connection failed'));

        const result = await createAIProvider('user-123', {
          selectedProvider: 'google',
        });

        expect(isProviderError(result)).toBe(true);
        if (isProviderError(result)) {
          expect(result.error).toContain('Failed to initialize AI provider');
          expect(result.status).toBe(500);
        }
      });
    });

    describe('consent enforcement', () => {
      it('returns consent_required error when cloud provider lacks consent', async () => {
        mockDbMock.where.mockResolvedValue([
          { id: 'user-123', currentAiProvider: 'openai', currentAiModel: 'gpt-4o' },
        ]);
        vi.mocked(requiresConsent).mockReturnValue(true);
        vi.mocked(aiConsentRepository.hasConsent).mockResolvedValue(false);

        const result = await createAIProvider('user-123', {
          selectedProvider: 'openai',
          selectedModel: 'gpt-4o',
        });

        expect(isProviderError(result)).toBe(true);
        if (isProviderError(result)) {
          expect(result.status).toBe(403);
          expect(result.error).toBe('consent_required:openai');
        }
      });

      it('proceeds when cloud provider has consent', async () => {
        mockDbMock.where.mockResolvedValue([
          { id: 'user-123', currentAiProvider: 'openai', currentAiModel: 'gpt-4o' },
        ]);
        vi.mocked(requiresConsent).mockReturnValue(true);
        vi.mocked(aiConsentRepository.hasConsent).mockResolvedValue(true);
        mockGetUserOpenAISettings.mockResolvedValue({ apiKey: 'test-key', isConfigured: true });

        const result = await createAIProvider('user-123', {
          selectedProvider: 'openai',
          selectedModel: 'gpt-4o',
        });

        expect(isProviderError(result)).toBe(false);
      });

      it('skips consent check for exempt providers', async () => {
        mockDbMock.where.mockResolvedValue([
          { id: 'user-123', currentAiProvider: 'pagespace', currentAiModel: 'glm-4.5-air' },
        ]);
        vi.mocked(requiresConsent).mockReturnValue(false);
        mockGetDefaultPageSpaceSettings.mockResolvedValue({
          provider: 'glm',
          apiKey: 'test-key',
          isConfigured: true,
        });

        const result = await createAIProvider('user-123', {
          selectedProvider: 'pagespace',
          selectedModel: 'glm-4.5-air',
        });

        expect(aiConsentRepository.hasConsent).not.toHaveBeenCalled();
        expect(isProviderError(result)).toBe(false);
      });
    });
  });

  describe('updateUserProviderSettings', () => {
    it('does nothing when provider and model not specified', async () => {
      await updateUserProviderSettings('user-123');

      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it('does nothing when only provider specified', async () => {
      await updateUserProviderSettings('user-123', 'google');

      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it('does nothing when only model specified', async () => {
      await updateUserProviderSettings('user-123', undefined, 'gemini-pro');

      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it('updates when both provider and model specified and different', async () => {
      mockDbMock.where.mockResolvedValue([
        { id: 'user-123', currentAiProvider: 'old-provider', currentAiModel: 'old-model' },
      ]);

      await updateUserProviderSettings('user-123', 'google', 'gemini-pro');

      expect(mockDb.update).toHaveBeenCalled();
    });

    it('does not update when provider and model are same', async () => {
      mockDbMock.where.mockResolvedValue([
        { id: 'user-123', currentAiProvider: 'google', currentAiModel: 'gemini-pro' },
      ]);

      await updateUserProviderSettings('user-123', 'google', 'gemini-pro');

      expect(mockDb.update).not.toHaveBeenCalled();
    });
  });

  describe('createProviderErrorResponse', () => {
    it('creates NextResponse with error message and status', async () => {
      const response = createProviderErrorResponse({
        error: 'Test error message',
        status: 403,
      });

      expect(response).toBeInstanceOf(NextResponse);
      expect(response.status).toBe(403);

      const body = await response.json();
      expect(body).toMatchObject({ error: 'Test error message' });
    });

    it('uses provided status code', async () => {
      const response = createProviderErrorResponse({
        error: 'Not found',
        status: 404,
      });

      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error).toBe('Not found');
    });
  });

  describe('isProviderError', () => {
    it('returns true for error result', () => {
      const result = { error: 'Something went wrong', status: 400 };

      expect(isProviderError(result)).toBe(true);
    });

    it('returns false for success result', () => {
      // Create a minimal valid mock of a LanguageModel
      const mockModel = {
        specificationVersion: 'v1',
        provider: 'test-provider',
        modelId: 'test-model',
        doGenerate: vi.fn(),
        doStream: vi.fn(),
      } as unknown as LanguageModel;

      const result: ProviderResult = {
        model: mockModel,
        provider: 'google',
        modelName: 'gemini-pro',
      };

      expect(isProviderError(result)).toBe(false);
    });
  });

  describe('SSRF validation', () => {
    it('blocks Ollama with cloud metadata URL', async () => {
      mockGetUserOllamaSettings.mockResolvedValue({
        baseUrl: 'http://169.254.169.254',
        isConfigured: true,
      });
      vi.mocked(validateLocalProviderURL).mockResolvedValue({
        valid: false,
        error: 'IP address blocked: cloud metadata endpoint',
      });

      const result = await createAIProvider('user-123', {
        selectedProvider: 'ollama',
        selectedModel: 'llama3',
      });

      expect(isProviderError(result)).toBe(true);
      if (isProviderError(result)) {
        expect(result.status).toBe(400);
        expect(result.error).toContain('blocked');
      }
    });

    it('allows Ollama with localhost URL', async () => {
      mockGetUserOllamaSettings.mockResolvedValue({
        baseUrl: 'http://localhost:11434',
        isConfigured: true,
      });
      vi.mocked(validateLocalProviderURL).mockResolvedValue({
        valid: true,
        url: new URL('http://localhost:11434'),
        resolvedIPs: ['127.0.0.1'],
      });

      const result = await createAIProvider('user-123', {
        selectedProvider: 'ollama',
        selectedModel: 'llama3',
      });

      expect(isProviderError(result)).toBe(false);
    });

    it('blocks LM Studio with cloud metadata URL', async () => {
      mockGetUserLMStudioSettings.mockResolvedValue({
        baseUrl: 'http://169.254.169.254',
        isConfigured: true,
      });
      vi.mocked(validateLocalProviderURL).mockResolvedValue({
        valid: false,
        error: 'IP address blocked: cloud metadata endpoint',
      });

      const result = await createAIProvider('user-123', {
        selectedProvider: 'lmstudio',
        selectedModel: 'local-model',
      });

      expect(isProviderError(result)).toBe(true);
      if (isProviderError(result)) {
        expect(result.status).toBe(400);
        expect(result.error).toContain('blocked');
      }
    });

    it('allows LM Studio with localhost URL', async () => {
      mockGetUserLMStudioSettings.mockResolvedValue({
        baseUrl: 'http://localhost:1234/v1',
        isConfigured: true,
      });
      vi.mocked(validateLocalProviderURL).mockResolvedValue({
        valid: true,
        url: new URL('http://localhost:1234/v1'),
        resolvedIPs: ['127.0.0.1'],
      });

      const result = await createAIProvider('user-123', {
        selectedProvider: 'lmstudio',
        selectedModel: 'local-model',
      });

      expect(isProviderError(result)).toBe(false);
    });
  });
});
