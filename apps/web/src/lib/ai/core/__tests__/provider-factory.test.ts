import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a, b) => ({ a, b })),
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'id', currentAiProvider: 'currentAiProvider', currentAiModel: 'currentAiModel' },
}));
vi.mock('@pagespace/db/schema/ai', () => ({ userAiSettings: {} }));
vi.mock('@pagespace/lib/encryption/encryption-utils', () => ({
  decrypt: vi.fn(),
  encrypt: vi.fn(),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    ai: { child: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }) },
  },
}));
vi.mock('@/lib/logging/mask', () => ({ maskIdentifier: (s: string) => s }));

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

vi.mock('@pagespace/lib/security/url-validator', () => ({
  validateLocalProviderURL: vi.fn(),
}));

vi.mock('@pagespace/lib/deployment-mode', () => ({
  isOnPrem: vi.fn(() => false),
}));

vi.mock('../ai-providers-config', async () => {
  const actual = await vi.importActual<typeof import('../ai-providers-config')>('../ai-providers-config');
  return {
    ...actual,
    resolvePageSpaceModel: vi.fn((m: string) => {
      const aliases: Record<string, string> = { standard: 'glm-4.7', pro: 'glm-5' };
      return aliases[m?.toLowerCase()] || m;
    }),
  };
});

vi.mock('@/lib/fetch-bridge', () => ({
  isFetchBridgeInitialized: vi.fn(() => false),
  getFetchBridge: vi.fn(() => ({ isUserConnected: vi.fn(() => false) })),
}));

import {
  createAIProvider,
  isProviderError,
  updateUserProviderSettings,
} from '../provider-factory';
import { db } from '@pagespace/db/db';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createXai } from '@ai-sdk/xai';
import { createOllama } from 'ollama-ai-provider-v2';
import { validateLocalProviderURL } from '@pagespace/lib/security/url-validator';
import { isOnPrem } from '@pagespace/lib/deployment-mode';

const ENV_KEYS = [
  'ANTHROPIC_DEFAULT_API_KEY',
  'OPENAI_DEFAULT_API_KEY',
  'GOOGLE_AI_DEFAULT_API_KEY',
  'XAI_DEFAULT_API_KEY',
  'OPENROUTER_DEFAULT_API_KEY',
  'GLM_CODER_DEFAULT_API_KEY',
  'MINIMAX_DEFAULT_API_KEY',
  'OLLAMA_BASE_URL',
  'LMSTUDIO_BASE_URL',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'GLM_DEFAULT_API_KEY',
] as const;

type MockFn = ReturnType<typeof vi.fn>;
interface MockDb {
  select: MockFn;
  from: MockFn;
  where: MockFn;
  update: MockFn;
  set: MockFn;
}
const mockDb = vi.mocked(db) as unknown as MockDb;

describe('provider-factory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isOnPrem).mockReturnValue(false);
    mockDb.where.mockResolvedValue([
      { id: 'user-123', currentAiProvider: null, currentAiModel: null },
    ]);
    vi.mocked(validateLocalProviderURL).mockResolvedValue({
      valid: true,
      url: new URL('http://localhost:11434'),
      resolvedIPs: ['127.0.0.1'],
    });
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  describe('createAIProvider', () => {
    describe('pagespace provider', () => {
      it('uses GLM backend when GLM_DEFAULT_API_KEY is set', async () => {
        process.env.GLM_DEFAULT_API_KEY = 'glm-managed';

        const result = await createAIProvider('user-123', {});

        expect(isProviderError(result)).toBe(false);
        if (!isProviderError(result)) {
          expect(result.provider).toBe('pagespace');
          expect(createOpenAICompatible).toHaveBeenCalledWith({
            name: 'glm',
            apiKey: 'glm-managed',
            baseURL: 'https://api.z.ai/api/coding/paas/v4',
          });
        }
      });

      it('falls back to Google when only GOOGLE_AI_DEFAULT_API_KEY is set', async () => {
        process.env.GOOGLE_AI_DEFAULT_API_KEY = 'google-managed';

        const result = await createAIProvider('user-123', {});

        expect(isProviderError(result)).toBe(false);
        if (!isProviderError(result)) {
          expect(result.provider).toBe('pagespace');
          expect(createGoogleGenerativeAI).toHaveBeenCalledWith({ apiKey: 'google-managed' });
        }
      });

      it('returns 503 when no managed PageSpace key is configured', async () => {
        const result = await createAIProvider('user-123', {});

        expect(isProviderError(result)).toBe(true);
        if (isProviderError(result)) {
          expect(result.status).toBe(503);
          expect(result.error).toContain('PageSpace AI');
        }
      });
    });

    describe('cloud providers', () => {
      it.each([
        ['openrouter', 'OPENROUTER_DEFAULT_API_KEY', 'or-key'],
        ['google', 'GOOGLE_AI_DEFAULT_API_KEY', 'g-key'],
        ['openai', 'OPENAI_DEFAULT_API_KEY', 'oai-key'],
        ['anthropic', 'ANTHROPIC_DEFAULT_API_KEY', 'ant-key'],
        ['xai', 'XAI_DEFAULT_API_KEY', 'xai-key'],
        ['glm', 'GLM_CODER_DEFAULT_API_KEY', 'glm-key'],
        ['minimax', 'MINIMAX_DEFAULT_API_KEY', 'mm-key'],
      ])('%s resolves from %s env var', async (provider, envVar, key) => {
        process.env[envVar] = key;

        const result = await createAIProvider('user-123', {
          selectedProvider: provider,
          selectedModel: 'some-model',
        });

        expect(isProviderError(result)).toBe(false);
        if (!isProviderError(result)) {
          expect(result.provider).toBe(provider);
        }
      });

      it.each([
        ['openrouter', 'OpenRouter'],
        ['google', 'Google AI'],
        ['openai', 'OpenAI'],
        ['anthropic', 'Anthropic'],
        ['xai', 'xAI'],
        ['glm', 'GLM Coder Plan'],
        ['minimax', 'MiniMax'],
      ])('%s returns 503 when env var is unset', async (provider, displayName) => {
        const result = await createAIProvider('user-123', {
          selectedProvider: provider,
          selectedModel: 'some-model',
        });

        expect(isProviderError(result)).toBe(true);
        if (isProviderError(result)) {
          expect(result.status).toBe(503);
          expect(result.error).toContain(displayName);
        }
      });

      it('openrouter_free shares the OpenRouter env var', async () => {
        process.env.OPENROUTER_DEFAULT_API_KEY = 'or-key';

        const result = await createAIProvider('user-123', {
          selectedProvider: 'openrouter_free',
          selectedModel: 'meta-llama/llama-3-8b:free',
        });

        expect(isProviderError(result)).toBe(false);
        expect(createOpenRouter).toHaveBeenCalledWith({ apiKey: 'or-key' });
      });

      it('anthropic instantiates createAnthropic with the env key', async () => {
        process.env.ANTHROPIC_DEFAULT_API_KEY = 'ant-managed';

        await createAIProvider('user-123', {
          selectedProvider: 'anthropic',
          selectedModel: 'claude-sonnet-4-6',
        });

        expect(createAnthropic).toHaveBeenCalledWith({ apiKey: 'ant-managed' });
      });

      it('openai instantiates createOpenAI with the env key', async () => {
        process.env.OPENAI_DEFAULT_API_KEY = 'oai-managed';

        await createAIProvider('user-123', {
          selectedProvider: 'openai',
          selectedModel: 'gpt-5',
        });

        expect(createOpenAI).toHaveBeenCalledWith({ apiKey: 'oai-managed' });
      });

      it('xai instantiates createXai with the env key', async () => {
        process.env.XAI_DEFAULT_API_KEY = 'xai-managed';

        await createAIProvider('user-123', {
          selectedProvider: 'xai',
          selectedModel: 'grok-4',
        });

        expect(createXai).toHaveBeenCalledWith({ apiKey: 'xai-managed' });
      });
    });

    describe('local providers', () => {
      it('ollama resolves from OLLAMA_BASE_URL', async () => {
        process.env.OLLAMA_BASE_URL = 'http://localhost:11434';

        const result = await createAIProvider('user-123', {
          selectedProvider: 'ollama',
          selectedModel: 'llama3.2',
        });

        expect(isProviderError(result)).toBe(false);
        expect(createOllama).toHaveBeenCalledWith(expect.objectContaining({
          baseURL: 'http://localhost:11434/api',
        }));
      });

      it('ollama returns 503 when OLLAMA_BASE_URL is unset', async () => {
        const result = await createAIProvider('user-123', {
          selectedProvider: 'ollama',
        });

        expect(isProviderError(result)).toBe(true);
        if (isProviderError(result)) expect(result.status).toBe(503);
      });

      it('lmstudio resolves from LMSTUDIO_BASE_URL', async () => {
        process.env.LMSTUDIO_BASE_URL = 'http://localhost:1234/v1';

        const result = await createAIProvider('user-123', {
          selectedProvider: 'lmstudio',
          selectedModel: 'local-model',
        });

        expect(isProviderError(result)).toBe(false);
        expect(createOpenAICompatible).toHaveBeenCalledWith(expect.objectContaining({
          name: 'lmstudio',
          baseURL: 'http://localhost:1234/v1',
        }));
      });

      it('azure_openai requires both API key and endpoint', async () => {
        process.env.AZURE_OPENAI_API_KEY = 'azure-key';
        process.env.AZURE_OPENAI_ENDPOINT = 'https://example.openai.azure.com';

        const result = await createAIProvider('user-123', {
          selectedProvider: 'azure_openai',
          selectedModel: 'gpt-4',
        });

        expect(isProviderError(result)).toBe(false);
        expect(createOpenAICompatible).toHaveBeenCalledWith(expect.objectContaining({
          name: 'azure_openai',
          apiKey: 'azure-key',
          baseURL: 'https://example.openai.azure.com',
        }));
      });

      it('azure_openai returns 503 when endpoint is missing', async () => {
        process.env.AZURE_OPENAI_API_KEY = 'azure-key';

        const result = await createAIProvider('user-123', {
          selectedProvider: 'azure_openai',
          selectedModel: 'gpt-4',
        });

        expect(isProviderError(result)).toBe(true);
        if (isProviderError(result)) expect(result.status).toBe(503);
      });

      it('rejects ollama base URL that fails SSRF validation', async () => {
        process.env.OLLAMA_BASE_URL = 'http://169.254.169.254';
        vi.mocked(validateLocalProviderURL).mockResolvedValue({
          valid: false,
          error: 'metadata service IP blocked',
        });

        const result = await createAIProvider('user-123', {
          selectedProvider: 'ollama',
          selectedModel: 'llama3.2',
        });

        expect(isProviderError(result)).toBe(true);
        if (isProviderError(result)) expect(result.error).toContain('blocked');
      });
    });

    describe('onprem defense in depth', () => {
      it('rejects cloud providers in onprem mode even when env keys are present', async () => {
        vi.mocked(isOnPrem).mockReturnValue(true);
        process.env.ANTHROPIC_DEFAULT_API_KEY = 'ant-key';

        const result = await createAIProvider('user-123', {
          selectedProvider: 'anthropic',
          selectedModel: 'claude-sonnet-4-6',
        });

        expect(isProviderError(result)).toBe(true);
        if (isProviderError(result)) {
          expect(result.status).toBe(403);
          expect(result.error).toContain('on-premise');
        }
      });

      it('allows ollama in onprem mode', async () => {
        vi.mocked(isOnPrem).mockReturnValue(true);
        process.env.OLLAMA_BASE_URL = 'http://localhost:11434';

        const result = await createAIProvider('user-123', {
          selectedProvider: 'ollama',
          selectedModel: 'llama3.2',
        });

        expect(isProviderError(result)).toBe(false);
      });

      it('allows pagespace in onprem mode when GLM_DEFAULT_API_KEY is set', async () => {
        vi.mocked(isOnPrem).mockReturnValue(true);
        process.env.GLM_DEFAULT_API_KEY = 'glm-managed';

        const result = await createAIProvider('user-123', {});

        expect(isProviderError(result)).toBe(false);
      });
    });

    describe('user defaults and unsupported providers', () => {
      it('falls back to user.currentAiProvider when not specified', async () => {
        mockDb.where.mockResolvedValue([
          { id: 'user-123', currentAiProvider: 'google', currentAiModel: 'gemini-pro' },
        ]);
        process.env.GOOGLE_AI_DEFAULT_API_KEY = 'g-key';

        const result = await createAIProvider('user-123', {});

        expect(isProviderError(result)).toBe(false);
        if (!isProviderError(result)) {
          expect(result.provider).toBe('google');
          expect(result.modelName).toBe('gemini-pro');
        }
      });

      it('returns 400 for unknown provider names', async () => {
        const result = await createAIProvider('user-123', {
          selectedProvider: 'totally-not-a-provider',
        });

        expect(isProviderError(result)).toBe(true);
        if (isProviderError(result)) {
          expect(result.status).toBe(400);
          expect(result.error).toContain('Unsupported AI provider');
        }
      });
    });
  });

  describe('updateUserProviderSettings', () => {
    it('does nothing when provider and model are not specified', async () => {
      await updateUserProviderSettings('user-123');
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it('updates user when provider differs from stored value', async () => {
      mockDb.where.mockResolvedValue([
        { id: 'user-123', currentAiProvider: 'google', currentAiModel: 'gemini-pro' },
      ]);

      await updateUserProviderSettings('user-123', 'anthropic', 'claude-sonnet-4-6');

      expect(mockDb.update).toHaveBeenCalled();
    });
  });
});
