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
// Every cloud vendor is served through OpenRouter. The mock returns a chat()
// factory whose result carries the model id we asked for, so we can assert the
// model is forwarded verbatim.
const mockOpenRouterChat = vi.fn((model: string) => ({ modelId: model }));
vi.mock('@openrouter/ai-sdk-provider', () => ({
  createOpenRouter: vi.fn(() => ({ chat: mockOpenRouterChat })),
}));
vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: vi.fn(() => vi.fn((m: string) => ({ modelId: m }))),
}));
vi.mock('ollama-ai-provider-v2', () => ({
  createOllama: vi.fn(() => vi.fn((m: string) => ({ modelId: m }))),
}));

vi.mock('@pagespace/lib/security/url-validator', () => ({
  validateLocalProviderURL: vi.fn(),
}));

vi.mock('@pagespace/lib/deployment-mode', () => ({
  isOnPrem: vi.fn(() => false),
}));

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
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOllama } from 'ollama-ai-provider-v2';
import { validateLocalProviderURL } from '@pagespace/lib/security/url-validator';
import { isOnPrem } from '@pagespace/lib/deployment-mode';

const ENV_KEYS = [
  'OPENROUTER_DEFAULT_API_KEY',
  'OPENROUTER_BASE_URL',
  'OLLAMA_BASE_URL',
  'LMSTUDIO_BASE_URL',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
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
    mockOpenRouterChat.mockImplementation((model: string) => ({ modelId: model }));
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
    describe('default routing', () => {
      it('routes the unset default through OpenRouter with the default model', async () => {
        process.env.OPENROUTER_DEFAULT_API_KEY = 'or-key';

        const result = await createAIProvider('user-123', {});

        expect(isProviderError(result)).toBe(false);
        if (!isProviderError(result)) {
          // DEFAULT_PROVIDER / DEFAULT_MODEL
          expect(result.provider).toBe('openai');
          expect(result.modelName).toBe('openai/gpt-5.3-chat');
          expect(createOpenRouter).toHaveBeenCalled();
        }
      });

      it('returns 503 when OPENROUTER_DEFAULT_API_KEY is unset', async () => {
        const result = await createAIProvider('user-123', {});

        expect(isProviderError(result)).toBe(true);
        if (isProviderError(result)) {
          expect(result.status).toBe(503);
          expect(result.error).toContain('OpenRouter');
        }
      });
    });

    describe('cloud providers (all OpenRouter-backed)', () => {
      it.each([
        ['openai', 'openai/gpt-5.4'],
        ['anthropic', 'anthropic/claude-opus-4.8'],
        ['google', 'google/gemini-2.5-flash'],
        ['xai', 'x-ai/grok-4.3'],
        ['minimax', 'minimax/minimax-m2.5'],
        ['deepseek', 'deepseek/deepseek-v4-pro'],
      ])('%s routes %s through OpenRouter and forwards the model verbatim', async (provider, model) => {
        process.env.OPENROUTER_DEFAULT_API_KEY = 'or-key';

        const result = await createAIProvider('user-123', {
          selectedProvider: provider,
          selectedModel: model,
        });

        expect(isProviderError(result)).toBe(false);
        if (!isProviderError(result)) {
          expect(result.provider).toBe(provider);
          expect(result.modelName).toBe(model);
          expect(createOpenRouter).toHaveBeenCalled();
          // model id forwarded as-is to openrouter.chat with usage accounting +
          // tool-capable provider routing on
          expect(mockOpenRouterChat).toHaveBeenCalledWith(model, {
            usage: { include: true },
            extraBody: {
              provider: {
                require_parameters: true,
                allow_fallbacks: true,
              },
            },
          });
        }
      });

      it.each([
        ['openai', 'openai/gpt-5.4'],
        ['anthropic', 'anthropic/claude-opus-4.8'],
        ['google', 'google/gemini-2.5-flash'],
        ['xai', 'x-ai/grok-4.3'],
      ])('%s returns 503 (OpenRouter) when OPENROUTER_DEFAULT_API_KEY is unset', async (provider, model) => {
        const result = await createAIProvider('user-123', {
          selectedProvider: provider,
          selectedModel: model,
        });

        expect(isProviderError(result)).toBe(true);
        if (isProviderError(result)) {
          expect(result.status).toBe(503);
          expect(result.error).toContain('OpenRouter');
        }
      });

      it('creates the OpenRouter client with the env key and the response-cache header', async () => {
        process.env.OPENROUTER_DEFAULT_API_KEY = 'or-key';

        await createAIProvider('user-123', {
          selectedProvider: 'anthropic',
          selectedModel: 'anthropic/claude-opus-4.7',
        });

        expect(createOpenRouter).toHaveBeenCalledWith({
          apiKey: 'or-key',
          headers: { 'X-OpenRouter-Cache': 'true' },
        });
      });

      it('substitutes the default for an unknown provider (graceful, never forwards arbitrary)', async () => {
        process.env.OPENROUTER_DEFAULT_API_KEY = 'or-key';
        mockOpenRouterChat.mockClear();

        const result = await createAIProvider('user-123', {
          selectedProvider: 'totally-unknown',
          selectedModel: 'totally-unknown/model',
        });

        expect(isProviderError(result)).toBe(false);
        if (!isProviderError(result)) {
          expect(result.provider).toBe('openai');
          expect(result.modelName).toBe('openai/gpt-5.3-chat');
        }
        // the arbitrary model is never sent — only the default is
        expect(mockOpenRouterChat).toHaveBeenCalledWith('openai/gpt-5.3-chat', expect.anything());
        expect(mockOpenRouterChat).not.toHaveBeenCalledWith('totally-unknown/model', expect.anything());
      });

      it('substitutes the default for an off-catalog model on a known vendor', async () => {
        process.env.OPENROUTER_DEFAULT_API_KEY = 'or-key';
        mockOpenRouterChat.mockClear();

        const result = await createAIProvider('user-123', {
          selectedProvider: 'openai',
          selectedModel: 'openai/not-a-real-model',
        });

        expect(isProviderError(result)).toBe(false);
        if (!isProviderError(result)) {
          expect(result.modelName).toBe('openai/gpt-5.3-chat');
        }
        expect(mockOpenRouterChat).not.toHaveBeenCalledWith('openai/not-a-real-model', expect.anything());
      });

      it('enables usage accounting and tool-capable provider routing on the chat model', async () => {
        process.env.OPENROUTER_DEFAULT_API_KEY = 'or-key';
        mockOpenRouterChat.mockClear();

        await createAIProvider('user-123', {
          selectedProvider: 'anthropic',
          selectedModel: 'anthropic/claude-opus-4.7',
        });

        expect(mockOpenRouterChat).toHaveBeenCalledWith('anthropic/claude-opus-4.7', {
          usage: { include: true },
          extraBody: {
            provider: {
              require_parameters: true,
              allow_fallbacks: true,
            },
          },
        });
      });

      it('passes OPENROUTER_BASE_URL through when set (e.g. e2e stub)', async () => {
        process.env.OPENROUTER_DEFAULT_API_KEY = 'or-key';
        process.env.OPENROUTER_BASE_URL = 'http://localhost:9999/v1';

        await createAIProvider('user-123', {
          selectedProvider: 'openai',
          selectedModel: 'openai/gpt-5.4',
        });

        expect(createOpenRouter).toHaveBeenCalledWith({
          apiKey: 'or-key',
          baseURL: 'http://localhost:9999/v1',
          headers: { 'X-OpenRouter-Cache': 'true' },
        });
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
        process.env.OPENROUTER_DEFAULT_API_KEY = 'or-key';

        const result = await createAIProvider('user-123', {
          selectedProvider: 'anthropic',
          selectedModel: 'anthropic/claude-sonnet-4.6',
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

      it('blocks the default (cloud) provider in onprem mode', async () => {
        vi.mocked(isOnPrem).mockReturnValue(true);
        process.env.OPENROUTER_DEFAULT_API_KEY = 'or-key';

        // No selectedProvider → falls back to DEFAULT_PROVIDER (openai), a cloud vendor.
        const result = await createAIProvider('user-123', {});

        expect(isProviderError(result)).toBe(true);
        if (isProviderError(result)) {
          expect(result.status).toBe(403);
          expect(result.error).toContain('on-premise');
        }
      });
    });

    describe('user defaults and unsupported providers', () => {
      it('falls back to user.currentAiProvider when not specified', async () => {
        mockDb.where.mockResolvedValue([
          { id: 'user-123', currentAiProvider: 'google', currentAiModel: 'google/gemini-2.5-pro' },
        ]);
        process.env.OPENROUTER_DEFAULT_API_KEY = 'or-key';

        const result = await createAIProvider('user-123', {});

        expect(isProviderError(result)).toBe(false);
        if (!isProviderError(result)) {
          expect(result.provider).toBe('google');
          expect(result.modelName).toBe('google/gemini-2.5-pro');
        }
      });

      it('rejects an unknown provider in onprem mode (not on the allowlist)', async () => {
        vi.mocked(isOnPrem).mockReturnValue(true);

        const result = await createAIProvider('user-123', {
          selectedProvider: 'totally-not-a-provider',
        });

        expect(isProviderError(result)).toBe(true);
        if (isProviderError(result)) {
          expect(result.status).toBe(403);
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
        { id: 'user-123', currentAiProvider: 'google', currentAiModel: 'google/gemini-2.5-pro' },
      ]);

      await updateUserProviderSettings('user-123', 'anthropic', 'anthropic/claude-sonnet-4.6');

      expect(mockDb.update).toHaveBeenCalled();
    });

    describe('when a pre-loaded user row is provided', () => {
      it('skips the DB select for the user', async () => {
        const preloaded = { currentAiProvider: 'openai', currentAiModel: 'openai/gpt-5.3-chat' };

        await updateUserProviderSettings('user-123', 'anthropic', 'anthropic/claude-sonnet-4.6', {
          user: preloaded,
        });

        // select() should NOT have been called for user look-up
        expect(mockDb.select).not.toHaveBeenCalled();
        // But update() IS called because provider changed
        expect(mockDb.update).toHaveBeenCalled();
      });

      it('does not update when pre-loaded provider/model already match', async () => {
        const preloaded = { currentAiProvider: 'anthropic', currentAiModel: 'anthropic/claude-sonnet-4.6' };

        await updateUserProviderSettings('user-123', 'anthropic', 'anthropic/claude-sonnet-4.6', {
          user: preloaded,
        });

        expect(mockDb.select).not.toHaveBeenCalled();
        expect(mockDb.update).not.toHaveBeenCalled();
      });
    });
  });

  describe('createAIProvider — user row threading', () => {
    it('skips the DB select when a pre-loaded user row is provided', async () => {
      process.env.OPENROUTER_DEFAULT_API_KEY = 'or-key';
      const preloaded = { currentAiProvider: 'anthropic', currentAiModel: 'anthropic/claude-sonnet-4.6' };

      const result = await createAIProvider('user-123', {
        selectedProvider: 'anthropic',
        selectedModel: 'anthropic/claude-sonnet-4.6',
      }, { user: preloaded });

      expect(isProviderError(result)).toBe(false);
      // The DB should not have been queried for the user row
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it('still resolves provider correctly from pre-loaded user defaults', async () => {
      process.env.OPENROUTER_DEFAULT_API_KEY = 'or-key';
      // Pre-loaded row has google as the user's current provider
      const preloaded = { currentAiProvider: 'google', currentAiModel: 'google/gemini-2.5-pro' };

      // No selectedProvider/model → falls back to user defaults
      const result = await createAIProvider('user-123', {}, { user: preloaded });

      expect(isProviderError(result)).toBe(false);
      if (!isProviderError(result)) {
        expect(result.provider).toBe('google');
        expect(result.modelName).toBe('google/gemini-2.5-pro');
      }
    });
  });
});
