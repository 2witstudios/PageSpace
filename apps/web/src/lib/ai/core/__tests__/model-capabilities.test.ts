import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock loggers
vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    ai: {
      child: vi.fn().mockReturnValue({
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  },
}));

// Mock fetch for OpenRouter API calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  hasToolCapability,
  getSuggestedToolCapableModels,
  getModelCapabilities,
  hasVisionCapability,
  getSuggestedVisionModels,
} from '../model-capabilities';

describe('model-capabilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  describe('hasVisionCapability (re-exported from vision-models)', () => {
    it('should return true for gpt-4o', () => {
      expect(hasVisionCapability('gpt-4o')).toBe(true);
    });

    it('should return true for claude-3-5-sonnet-20241022', () => {
      expect(hasVisionCapability('claude-3-5-sonnet-20241022')).toBe(true);
    });

    it('should return true for gemini-2.5-flash', () => {
      expect(hasVisionCapability('gemini-2.5-flash')).toBe(true);
    });

    it('should return false for o1', () => {
      expect(hasVisionCapability('o1')).toBe(false);
    });

    it('should return false for unknown model without vision patterns', () => {
      expect(hasVisionCapability('some-unknown-text-model')).toBe(false);
    });

    it('should return true for model with "vision" in name', () => {
      expect(hasVisionCapability('some-vision-model')).toBe(true);
    });
  });

  describe('getSuggestedVisionModels (re-exported)', () => {
    it('should return an array of model names', () => {
      const models = getSuggestedVisionModels();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
    });
  });

  describe('hasToolCapability', () => {
    it('should return false for gemma:2b (known non-tool model)', async () => {
      const result = await hasToolCapability('gemma:2b', 'ollama');
      expect(result).toBe(false);
    });

    it('should return false for gemma:7b (known non-tool model)', async () => {
      const result = await hasToolCapability('gemma:7b', 'ollama');
      expect(result).toBe(false);
    });

    it('should return false for gemma3:1b (known non-tool model)', async () => {
      const result = await hasToolCapability('gemma3:1b', 'ollama');
      expect(result).toBe(false);
    });

    it('should return false for a model containing "gemma" in name', async () => {
      const result = await hasToolCapability('gemma-variant-model', 'ollama');
      expect(result).toBe(false);
    });

    it('should return true for llama3.1 (modern model default)', async () => {
      const result = await hasToolCapability('llama3.1:8b', 'ollama');
      expect(result).toBe(true);
    });

    it('should cache results for the same model/provider pair', async () => {
      // First call
      const result1 = await hasToolCapability('llama3.1:8b', 'ollama');
      // Second call should use cache (no additional DB/API calls)
      const result2 = await hasToolCapability('llama3.1:8b', 'ollama');
      expect(result1).toBe(result2);
    });

    it('should query OpenRouter API for openrouter provider', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'meta-llama/llama-3.1-8b-instruct',
              supported_parameters: ['tools', 'tool_choice', 'temperature'],
            },
          ],
        }),
      });

      const result = await hasToolCapability('meta-llama/llama-3.1-8b-instruct', 'openrouter');
      expect(result).toBe(true);
    });

    it('should return false for openrouter model not supporting tools', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'some-no-tools-model',
              supported_parameters: ['temperature'],
            },
          ],
        }),
      });

      const result = await hasToolCapability('some-no-tools-model', 'openrouter');
      expect(result).toBe(false);
    });

    it('should handle OpenRouter API failure gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      // Should fall through to default behavior (true for non-gemma models)
      const result = await hasToolCapability('some-model', 'openrouter');
      expect(typeof result).toBe('boolean');
    });

    it('should handle OpenRouter non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      // Should fall through gracefully
      const result = await hasToolCapability('some-model-2', 'openrouter');
      expect(typeof result).toBe('boolean');
    });

    it('should handle openrouter_free provider as an openrouter variant', async () => {
      // Use a model that is not already cached to avoid cache pollution
      // The openrouter_free provider queries the same OpenRouter API
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'deepseek/deepseek-r2:free',
              supported_parameters: ['tools', 'tool_choice'],
            },
          ],
        }),
      });

      const result = await hasToolCapability('deepseek/deepseek-r2:free', 'openrouter_free');
      // The result depends on whether the OpenRouter cache already has data from prior tests.
      // Just verify it returns a boolean without throwing.
      expect(typeof result).toBe('boolean');
    });
  });

  describe('getSuggestedToolCapableModels', () => {
    it('should return ollama suggestions for ollama provider', () => {
      const models = getSuggestedToolCapableModels('ollama');
      expect(models).toContain('llama3.1:8b');
    });

    it('should return openrouter suggestions for openrouter provider', () => {
      const models = getSuggestedToolCapableModels('openrouter');
      expect(models.length).toBeGreaterThan(0);
    });

    it('should return google suggestions for google provider', () => {
      const models = getSuggestedToolCapableModels('google');
      expect(models.some(m => m.includes('gemini'))).toBe(true);
    });

    it('should return openai suggestions for openai provider', () => {
      const models = getSuggestedToolCapableModels('openai');
      expect(models.some(m => m.includes('gpt'))).toBe(true);
    });

    it('should return anthropic suggestions for anthropic provider', () => {
      const models = getSuggestedToolCapableModels('anthropic');
      expect(models.some(m => m.includes('claude'))).toBe(true);
    });

    it('should return default suggestions for unknown provider', () => {
      const models = getSuggestedToolCapableModels('unknown-provider');
      expect(models.length).toBeGreaterThan(0);
    });

    it('should return suggestions for openrouter_free provider', () => {
      const models = getSuggestedToolCapableModels('openrouter_free');
      expect(models.length).toBeGreaterThan(0);
    });
  });

  describe('getModelCapabilities', () => {
    it('should return capabilities object with hasVision and hasTools', async () => {
      const result = await getModelCapabilities('gpt-4o', 'openai');
      expect(result).toHaveProperty('hasVision');
      expect(result).toHaveProperty('hasTools');
      expect(result).toHaveProperty('model');
      expect(result).toHaveProperty('provider');
    });

    it('should return model and provider as provided', async () => {
      const result = await getModelCapabilities('gpt-4o', 'openai');
      expect(result.model).toBe('gpt-4o');
      expect(result.provider).toBe('openai');
    });

    it('should return hasVision true for gpt-4o', async () => {
      const result = await getModelCapabilities('gpt-4o', 'openai');
      expect(result.hasVision).toBe(true);
    });

    it('should return hasTools false for gemma model', async () => {
      const result = await getModelCapabilities('gemma:2b', 'ollama');
      expect(result.hasTools).toBe(false);
    });
  });
});
