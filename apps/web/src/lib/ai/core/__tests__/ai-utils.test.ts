import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const mockFindFirst = vi.fn();
  const mockSet = vi.fn();
  const mockWhere = vi.fn();
  const mockValues = vi.fn();
  const mockDecrypt = vi.fn();
  const mockEncrypt = vi.fn();
  return { mockFindFirst, mockSet, mockWhere, mockValues, mockDecrypt, mockEncrypt };
});

// Mock @pagespace/db
vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      userAiSettings: {
        findFirst: mocks.mockFindFirst,
      },
    },
    update: vi.fn(() => ({ set: mocks.mockSet })),
    insert: vi.fn(() => ({ values: mocks.mockValues })),
    delete: vi.fn(() => ({ where: mocks.mockWhere })),
  },
  userAiSettings: {
    id: 'id',
    userId: 'userId',
    provider: 'provider',
    encryptedApiKey: 'encryptedApiKey',
    baseUrl: 'baseUrl',
    updatedAt: 'updatedAt',
  },
  eq: vi.fn((a, b) => ({ eq: true, a, b })),
  and: vi.fn((...args) => ({ and: true, args })),
}));

// Mock @pagespace/lib/server
vi.mock('@pagespace/lib/server', () => ({
  decrypt: mocks.mockDecrypt,
  encrypt: mocks.mockEncrypt,
  loggers: {
    ai: {
      child: vi.fn().mockReturnValue({
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
      }),
    },
  },
}));

// Mock @paralleldrive/cuid2
vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'generated-id'),
}));

// Mock @/lib/logging/mask
vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id: string) => `masked:${id}`),
}));

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
  getUserAzureOpenAISettings,
  createAzureOpenAISettings,
  deleteAzureOpenAISettings,
} from '../ai-utils';

import { db } from '@pagespace/db';

describe('ai-utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset env vars
    delete process.env.GLM_DEFAULT_API_KEY;
    delete process.env.GOOGLE_AI_DEFAULT_API_KEY;
    delete process.env.OPENROUTER_DEFAULT_API_KEY;
    // Re-wire set/where chain after clearAllMocks
    vi.mocked(db.update).mockReturnValue({ set: mocks.mockSet } as never);
    mocks.mockSet.mockReturnValue({ where: mocks.mockWhere });
    vi.mocked(db.delete).mockReturnValue({ where: mocks.mockWhere } as never);
    vi.mocked(db.insert).mockReturnValue({ values: mocks.mockValues } as never);
  });

  describe('getDefaultPageSpaceSettings', () => {
    it('should return GLM settings when GLM_DEFAULT_API_KEY is set', async () => {
      process.env.GLM_DEFAULT_API_KEY = 'glm-test-key';
      const result = await getDefaultPageSpaceSettings();
      expect(result).toEqual({ apiKey: 'glm-test-key', isConfigured: true, provider: 'glm' });
    });

    it('should not return GLM when key is placeholder', async () => {
      process.env.GLM_DEFAULT_API_KEY = 'your_glm_api_key_here';
      process.env.GOOGLE_AI_DEFAULT_API_KEY = 'google-test-key';
      const result = await getDefaultPageSpaceSettings();
      expect(result?.provider).toBe('google');
    });

    it('should return Google settings when GOOGLE_AI_DEFAULT_API_KEY is set and GLM not configured', async () => {
      process.env.GOOGLE_AI_DEFAULT_API_KEY = 'google-test-key';
      const result = await getDefaultPageSpaceSettings();
      expect(result).toEqual({ apiKey: 'google-test-key', isConfigured: true, provider: 'google' });
    });

    it('should not return Google when key is placeholder', async () => {
      process.env.GOOGLE_AI_DEFAULT_API_KEY = 'your_google_ai_api_key_here';
      process.env.OPENROUTER_DEFAULT_API_KEY = 'openrouter-test-key';
      const result = await getDefaultPageSpaceSettings();
      expect(result?.provider).toBe('openrouter');
    });

    it('should return OpenRouter settings when OPENROUTER_DEFAULT_API_KEY is set', async () => {
      process.env.OPENROUTER_DEFAULT_API_KEY = 'openrouter-key';
      const result = await getDefaultPageSpaceSettings();
      expect(result).toEqual({ apiKey: 'openrouter-key', isConfigured: true, provider: 'openrouter' });
    });

    it('should return null when no default keys are configured', async () => {
      const result = await getDefaultPageSpaceSettings();
      expect(result).toBeNull();
    });

    it('should prefer GLM over Google and OpenRouter', async () => {
      process.env.GLM_DEFAULT_API_KEY = 'glm-key';
      process.env.GOOGLE_AI_DEFAULT_API_KEY = 'google-key';
      process.env.OPENROUTER_DEFAULT_API_KEY = 'openrouter-key';
      const result = await getDefaultPageSpaceSettings();
      expect(result?.provider).toBe('glm');
    });
  });

  describe('getUserOpenRouterSettings', () => {
    it('should return null when settings not found', async () => {
      mocks.mockFindFirst.mockResolvedValue(null);
      const result = await getUserOpenRouterSettings('user-1');
      expect(result).toBeNull();
    });

    it('should return null when encryptedApiKey is missing', async () => {
      mocks.mockFindFirst.mockResolvedValue({ userId: 'user-1', provider: 'openrouter', encryptedApiKey: null });
      const result = await getUserOpenRouterSettings('user-1');
      expect(result).toBeNull();
    });

    it('should return decrypted API key', async () => {
      mocks.mockFindFirst.mockResolvedValue({ id: 'setting-1', userId: 'user-1', provider: 'openrouter', encryptedApiKey: 'encrypted-key' });
      mocks.mockDecrypt.mockResolvedValue('decrypted-key');
      const result = await getUserOpenRouterSettings('user-1');
      expect(result).toEqual({ apiKey: 'decrypted-key', isConfigured: true });
    });

    it('should return null on decryption error', async () => {
      mocks.mockFindFirst.mockResolvedValue({ id: 'setting-1', userId: 'user-1', provider: 'openrouter', encryptedApiKey: 'encrypted-key' });
      mocks.mockDecrypt.mockRejectedValue(new Error('Decryption failed'));
      const result = await getUserOpenRouterSettings('user-1');
      expect(result).toBeNull();
    });
  });

  describe('createOpenRouterSettings', () => {
    it('should create new settings when none exist', async () => {
      mocks.mockFindFirst.mockResolvedValue(null);
      mocks.mockEncrypt.mockResolvedValue('encrypted-new-key');
      mocks.mockValues.mockResolvedValue(undefined);

      await createOpenRouterSettings('user-1', 'api-key');

      expect(db.insert).toHaveBeenCalled();
      expect(mocks.mockValues).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          provider: 'openrouter',
          encryptedApiKey: 'encrypted-new-key',
        })
      );
    });

    it('should update existing settings', async () => {
      mocks.mockFindFirst.mockResolvedValue({ id: 'existing-id', userId: 'user-1', provider: 'openrouter' });
      mocks.mockEncrypt.mockResolvedValue('encrypted-updated-key');
      mocks.mockWhere.mockResolvedValue(undefined);

      await createOpenRouterSettings('user-1', 'new-api-key');

      expect(db.update).toHaveBeenCalled();
      expect(mocks.mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ encryptedApiKey: 'encrypted-updated-key' })
      );
    });
  });

  describe('deleteOpenRouterSettings', () => {
    it('should delete existing settings', async () => {
      mocks.mockFindFirst.mockResolvedValue({ id: 'setting-id' });
      mocks.mockWhere.mockResolvedValue(undefined);

      await deleteOpenRouterSettings('user-1');

      expect(db.delete).toHaveBeenCalled();
    });

    it('should do nothing when settings do not exist', async () => {
      mocks.mockFindFirst.mockResolvedValue(null);

      await deleteOpenRouterSettings('user-1');

      expect(db.delete).not.toHaveBeenCalled();
    });
  });

  describe('getUserGoogleSettings', () => {
    it('should return null when settings not found', async () => {
      mocks.mockFindFirst.mockResolvedValue(null);
      const result = await getUserGoogleSettings('user-1');
      expect(result).toBeNull();
    });

    it('should return decrypted API key', async () => {
      mocks.mockFindFirst.mockResolvedValue({ id: 'setting-1', encryptedApiKey: 'enc' });
      mocks.mockDecrypt.mockResolvedValue('decrypted');
      const result = await getUserGoogleSettings('user-1');
      expect(result?.apiKey).toBe('decrypted');
    });

    it('should return null on decryption error', async () => {
      mocks.mockFindFirst.mockResolvedValue({ id: 'setting-1', encryptedApiKey: 'enc' });
      mocks.mockDecrypt.mockRejectedValue(new Error('Failed'));
      const result = await getUserGoogleSettings('user-1');
      expect(result).toBeNull();
    });
  });

  describe('createGoogleSettings', () => {
    it('should create new google settings', async () => {
      mocks.mockFindFirst.mockResolvedValue(null);
      mocks.mockEncrypt.mockResolvedValue('encrypted-key');
      mocks.mockValues.mockResolvedValue(undefined);

      await createGoogleSettings('user-1', 'google-api-key');
      expect(db.insert).toHaveBeenCalled();
    });

    it('should update existing google settings', async () => {
      mocks.mockFindFirst.mockResolvedValue({ id: 'existing-id' });
      mocks.mockEncrypt.mockResolvedValue('encrypted-key');
      mocks.mockWhere.mockResolvedValue(undefined);

      await createGoogleSettings('user-1', 'google-api-key');
      expect(db.update).toHaveBeenCalled();
    });
  });

  describe('deleteGoogleSettings', () => {
    it('should delete existing google settings', async () => {
      mocks.mockFindFirst.mockResolvedValue({ id: 'setting-id' });
      mocks.mockWhere.mockResolvedValue(undefined);
      await deleteGoogleSettings('user-1');
      expect(db.delete).toHaveBeenCalled();
    });

    it('should do nothing when no settings exist', async () => {
      mocks.mockFindFirst.mockResolvedValue(null);
      await deleteGoogleSettings('user-1');
      expect(db.delete).not.toHaveBeenCalled();
    });
  });

  describe('getUserOpenAISettings', () => {
    it('should return null when not found', async () => {
      mocks.mockFindFirst.mockResolvedValue(null);
      expect(await getUserOpenAISettings('user-1')).toBeNull();
    });

    it('should return decrypted key', async () => {
      mocks.mockFindFirst.mockResolvedValue({ encryptedApiKey: 'enc' });
      mocks.mockDecrypt.mockResolvedValue('decrypted');
      const result = await getUserOpenAISettings('user-1');
      expect(result?.apiKey).toBe('decrypted');
    });

    it('should return null on decrypt error', async () => {
      mocks.mockFindFirst.mockResolvedValue({ encryptedApiKey: 'enc' });
      mocks.mockDecrypt.mockRejectedValue(new Error('fail'));
      expect(await getUserOpenAISettings('user-1')).toBeNull();
    });
  });

  describe('createOpenAISettings', () => {
    it('should create new openai settings', async () => {
      mocks.mockFindFirst.mockResolvedValue(null);
      mocks.mockEncrypt.mockResolvedValue('enc');
      mocks.mockValues.mockResolvedValue(undefined);
      await createOpenAISettings('user-1', 'key');
      expect(db.insert).toHaveBeenCalled();
    });

    it('should update existing openai settings', async () => {
      mocks.mockFindFirst.mockResolvedValue({ id: 'existing' });
      mocks.mockEncrypt.mockResolvedValue('enc');
      mocks.mockWhere.mockResolvedValue(undefined);
      await createOpenAISettings('user-1', 'key');
      expect(db.update).toHaveBeenCalled();
    });
  });

  describe('deleteOpenAISettings', () => {
    it('should delete openai settings', async () => {
      mocks.mockFindFirst.mockResolvedValue({ id: 'id' });
      mocks.mockWhere.mockResolvedValue(undefined);
      await deleteOpenAISettings('user-1');
      expect(db.delete).toHaveBeenCalled();
    });
  });

  describe('getUserAnthropicSettings', () => {
    it('should return null when not found', async () => {
      mocks.mockFindFirst.mockResolvedValue(null);
      expect(await getUserAnthropicSettings('user-1')).toBeNull();
    });

    it('should return decrypted key', async () => {
      mocks.mockFindFirst.mockResolvedValue({ encryptedApiKey: 'enc' });
      mocks.mockDecrypt.mockResolvedValue('anthropic-key');
      const result = await getUserAnthropicSettings('user-1');
      expect(result?.apiKey).toBe('anthropic-key');
    });
  });

  describe('createAnthropicSettings', () => {
    it('should create new anthropic settings', async () => {
      mocks.mockFindFirst.mockResolvedValue(null);
      mocks.mockEncrypt.mockResolvedValue('enc');
      mocks.mockValues.mockResolvedValue(undefined);
      await createAnthropicSettings('user-1', 'key');
      expect(db.insert).toHaveBeenCalled();
    });
  });

  describe('deleteAnthropicSettings', () => {
    it('should delete anthropic settings', async () => {
      mocks.mockFindFirst.mockResolvedValue({ id: 'id' });
      mocks.mockWhere.mockResolvedValue(undefined);
      await deleteAnthropicSettings('user-1');
      expect(db.delete).toHaveBeenCalled();
    });
  });

  describe('getUserXAISettings', () => {
    it('should return null when not found', async () => {
      mocks.mockFindFirst.mockResolvedValue(null);
      expect(await getUserXAISettings('user-1')).toBeNull();
    });

    it('should return decrypted key', async () => {
      mocks.mockFindFirst.mockResolvedValue({ encryptedApiKey: 'enc' });
      mocks.mockDecrypt.mockResolvedValue('xai-key');
      const result = await getUserXAISettings('user-1');
      expect(result?.apiKey).toBe('xai-key');
    });

    it('should return null on decrypt error', async () => {
      mocks.mockFindFirst.mockResolvedValue({ encryptedApiKey: 'enc' });
      mocks.mockDecrypt.mockRejectedValue(new Error('fail'));
      expect(await getUserXAISettings('user-1')).toBeNull();
    });
  });

  describe('createXAISettings', () => {
    it('should create new xai settings', async () => {
      mocks.mockFindFirst.mockResolvedValue(null);
      mocks.mockEncrypt.mockResolvedValue('enc');
      mocks.mockValues.mockResolvedValue(undefined);
      await createXAISettings('user-1', 'key');
      expect(db.insert).toHaveBeenCalled();
    });

    it('should update existing xai settings', async () => {
      mocks.mockFindFirst.mockResolvedValue({ id: 'existing' });
      mocks.mockEncrypt.mockResolvedValue('enc');
      mocks.mockWhere.mockResolvedValue(undefined);
      await createXAISettings('user-1', 'key');
      expect(db.update).toHaveBeenCalled();
    });
  });

  describe('deleteXAISettings', () => {
    it('should delete xai settings', async () => {
      mocks.mockFindFirst.mockResolvedValue({ id: 'id' });
      mocks.mockWhere.mockResolvedValue(undefined);
      await deleteXAISettings('user-1');
      expect(db.delete).toHaveBeenCalled();
    });
  });

  describe('getUserOllamaSettings', () => {
    it('should return null when not found', async () => {
      mocks.mockFindFirst.mockResolvedValue(null);
      expect(await getUserOllamaSettings('user-1')).toBeNull();
    });

    it('should return null when baseUrl is missing', async () => {
      mocks.mockFindFirst.mockResolvedValue({ userId: 'user-1', provider: 'ollama', baseUrl: null });
      expect(await getUserOllamaSettings('user-1')).toBeNull();
    });

    it('should return baseUrl when found', async () => {
      mocks.mockFindFirst.mockResolvedValue({ baseUrl: 'http://localhost:11434', provider: 'ollama' });
      const result = await getUserOllamaSettings('user-1');
      expect(result).toEqual({ baseUrl: 'http://localhost:11434', isConfigured: true });
    });
  });

  describe('createOllamaSettings', () => {
    it('should create new ollama settings with trailing slash removed', async () => {
      mocks.mockFindFirst.mockResolvedValue(null);
      mocks.mockValues.mockResolvedValue(undefined);

      await createOllamaSettings('user-1', 'http://localhost:11434/');
      expect(db.insert).toHaveBeenCalled();
      expect(mocks.mockValues).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: 'http://localhost:11434',
          provider: 'ollama',
        })
      );
    });

    it('should update existing ollama settings', async () => {
      mocks.mockFindFirst.mockResolvedValue({ id: 'existing' });
      mocks.mockWhere.mockResolvedValue(undefined);

      await createOllamaSettings('user-1', 'http://localhost:11434');
      expect(db.update).toHaveBeenCalled();
    });

    it('should trim whitespace from URL', async () => {
      mocks.mockFindFirst.mockResolvedValue(null);
      mocks.mockValues.mockResolvedValue(undefined);

      await createOllamaSettings('user-1', '  http://localhost:11434  ');
      expect(mocks.mockValues).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: 'http://localhost:11434' })
      );
    });
  });

  describe('deleteOllamaSettings', () => {
    it('should delete ollama settings', async () => {
      mocks.mockFindFirst.mockResolvedValue({ id: 'id' });
      mocks.mockWhere.mockResolvedValue(undefined);
      await deleteOllamaSettings('user-1');
      expect(db.delete).toHaveBeenCalled();
    });

    it('should not delete when settings do not exist', async () => {
      mocks.mockFindFirst.mockResolvedValue(null);
      await deleteOllamaSettings('user-1');
      expect(db.delete).not.toHaveBeenCalled();
    });
  });

  describe('getUserLMStudioSettings', () => {
    it('should return null when not found', async () => {
      mocks.mockFindFirst.mockResolvedValue(null);
      expect(await getUserLMStudioSettings('user-1')).toBeNull();
    });

    it('should return baseUrl when found', async () => {
      mocks.mockFindFirst.mockResolvedValue({ baseUrl: 'http://localhost:1234', provider: 'lmstudio' });
      const result = await getUserLMStudioSettings('user-1');
      expect(result).toEqual({ baseUrl: 'http://localhost:1234', isConfigured: true });
    });
  });

  describe('createLMStudioSettings', () => {
    it('should create new lmstudio settings with trailing slash removed', async () => {
      mocks.mockFindFirst.mockResolvedValue(null);
      mocks.mockValues.mockResolvedValue(undefined);

      await createLMStudioSettings('user-1', 'http://localhost:1234/');
      expect(db.insert).toHaveBeenCalled();
      expect(mocks.mockValues).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: 'http://localhost:1234' })
      );
    });
  });

  describe('deleteLMStudioSettings', () => {
    it('should delete lmstudio settings', async () => {
      mocks.mockFindFirst.mockResolvedValue({ id: 'id' });
      mocks.mockWhere.mockResolvedValue(undefined);
      await deleteLMStudioSettings('user-1');
      expect(db.delete).toHaveBeenCalled();
    });
  });

  describe('getUserGLMSettings', () => {
    it('should return null when not found', async () => {
      mocks.mockFindFirst.mockResolvedValue(null);
      expect(await getUserGLMSettings('user-1')).toBeNull();
    });

    it('should return decrypted key', async () => {
      mocks.mockFindFirst.mockResolvedValue({ encryptedApiKey: 'enc' });
      mocks.mockDecrypt.mockResolvedValue('glm-key');
      const result = await getUserGLMSettings('user-1');
      expect(result?.apiKey).toBe('glm-key');
    });
  });

  describe('createGLMSettings', () => {
    it('should create new glm settings', async () => {
      mocks.mockFindFirst.mockResolvedValue(null);
      mocks.mockEncrypt.mockResolvedValue('enc');
      mocks.mockValues.mockResolvedValue(undefined);
      await createGLMSettings('user-1', 'key');
      expect(db.insert).toHaveBeenCalled();
    });
  });

  describe('deleteGLMSettings', () => {
    it('should delete glm settings', async () => {
      mocks.mockFindFirst.mockResolvedValue({ id: 'id' });
      mocks.mockWhere.mockResolvedValue(undefined);
      await deleteGLMSettings('user-1');
      expect(db.delete).toHaveBeenCalled();
    });
  });

  describe('getUserMiniMaxSettings', () => {
    it('should return null when not found', async () => {
      mocks.mockFindFirst.mockResolvedValue(null);
      expect(await getUserMiniMaxSettings('user-1')).toBeNull();
    });

    it('should return decrypted key', async () => {
      mocks.mockFindFirst.mockResolvedValue({ encryptedApiKey: 'enc' });
      mocks.mockDecrypt.mockResolvedValue('minimax-key');
      const result = await getUserMiniMaxSettings('user-1');
      expect(result?.apiKey).toBe('minimax-key');
    });

    it('should return null on decrypt error', async () => {
      mocks.mockFindFirst.mockResolvedValue({ encryptedApiKey: 'enc' });
      mocks.mockDecrypt.mockRejectedValue(new Error('fail'));
      expect(await getUserMiniMaxSettings('user-1')).toBeNull();
    });
  });

  describe('createMiniMaxSettings', () => {
    it('should create new minimax settings', async () => {
      mocks.mockFindFirst.mockResolvedValue(null);
      mocks.mockEncrypt.mockResolvedValue('enc');
      mocks.mockValues.mockResolvedValue(undefined);
      await createMiniMaxSettings('user-1', 'key');
      expect(db.insert).toHaveBeenCalled();
    });

    it('should update existing minimax settings', async () => {
      mocks.mockFindFirst.mockResolvedValue({ id: 'existing' });
      mocks.mockEncrypt.mockResolvedValue('enc');
      mocks.mockWhere.mockResolvedValue(undefined);
      await createMiniMaxSettings('user-1', 'key');
      expect(db.update).toHaveBeenCalled();
    });
  });

  describe('deleteMiniMaxSettings', () => {
    it('should delete minimax settings', async () => {
      mocks.mockFindFirst.mockResolvedValue({ id: 'id' });
      mocks.mockWhere.mockResolvedValue(undefined);
      await deleteMiniMaxSettings('user-1');
      expect(db.delete).toHaveBeenCalled();
    });
  });

  describe('getUserAzureOpenAISettings', () => {
    it('should return null when not found', async () => {
      mocks.mockFindFirst.mockResolvedValue(null);
      expect(await getUserAzureOpenAISettings('user-1')).toBeNull();
    });

    it('should return null when encryptedApiKey is missing', async () => {
      mocks.mockFindFirst.mockResolvedValue({ baseUrl: 'https://azure.example.com', encryptedApiKey: null });
      expect(await getUserAzureOpenAISettings('user-1')).toBeNull();
    });

    it('should return null when baseUrl is missing', async () => {
      mocks.mockFindFirst.mockResolvedValue({ encryptedApiKey: 'enc', baseUrl: null });
      expect(await getUserAzureOpenAISettings('user-1')).toBeNull();
    });

    it('should return decrypted key and baseUrl when both present', async () => {
      mocks.mockFindFirst.mockResolvedValue({ encryptedApiKey: 'enc', baseUrl: 'https://azure.example.com' });
      mocks.mockDecrypt.mockResolvedValue('azure-key');
      const result = await getUserAzureOpenAISettings('user-1');
      expect(result).toEqual({ apiKey: 'azure-key', baseUrl: 'https://azure.example.com', isConfigured: true });
    });

    it('should return null on decrypt error', async () => {
      mocks.mockFindFirst.mockResolvedValue({ encryptedApiKey: 'enc', baseUrl: 'url' });
      mocks.mockDecrypt.mockRejectedValue(new Error('fail'));
      expect(await getUserAzureOpenAISettings('user-1')).toBeNull();
    });
  });

  describe('createAzureOpenAISettings', () => {
    it('should create new azure openai settings with trimmed URL', async () => {
      mocks.mockFindFirst.mockResolvedValue(null);
      mocks.mockEncrypt.mockResolvedValue('enc');
      mocks.mockValues.mockResolvedValue(undefined);

      await createAzureOpenAISettings('user-1', 'key', 'https://azure.example.com/');
      expect(db.insert).toHaveBeenCalled();
      expect(mocks.mockValues).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: 'https://azure.example.com' })
      );
    });

    it('should update existing azure openai settings', async () => {
      mocks.mockFindFirst.mockResolvedValue({ id: 'existing' });
      mocks.mockEncrypt.mockResolvedValue('enc');
      mocks.mockWhere.mockResolvedValue(undefined);
      await createAzureOpenAISettings('user-1', 'key', 'https://azure.example.com');
      expect(db.update).toHaveBeenCalled();
    });
  });

  describe('deleteAzureOpenAISettings', () => {
    it('should delete azure openai settings', async () => {
      mocks.mockFindFirst.mockResolvedValue({ id: 'id' });
      mocks.mockWhere.mockResolvedValue(undefined);
      await deleteAzureOpenAISettings('user-1');
      expect(db.delete).toHaveBeenCalled();
    });

    it('should do nothing when settings do not exist', async () => {
      mocks.mockFindFirst.mockResolvedValue(null);
      await deleteAzureOpenAISettings('user-1');
      expect(db.delete).not.toHaveBeenCalled();
    });
  });
});
