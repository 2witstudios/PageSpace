import { describe, test, beforeEach } from 'vitest';
import { assert } from './riteway';

import { getManagedProviderKey } from '../ai-utils';

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
] as const;

describe('getManagedProviderKey', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  test('Anthropic with env unset', () => {
    assert({
      given: 'ANTHROPIC_DEFAULT_API_KEY is unset',
      should: 'return null',
      actual: getManagedProviderKey('anthropic'),
      expected: null,
    });
  });

  test('Anthropic with env set', () => {
    process.env.ANTHROPIC_DEFAULT_API_KEY = 'sk-ant-managed';
    assert({
      given: 'ANTHROPIC_DEFAULT_API_KEY is set',
      should: 'return the env key without a baseUrl',
      actual: getManagedProviderKey('anthropic'),
      expected: { apiKey: 'sk-ant-managed' },
    });
  });

  test('OpenAI with env set', () => {
    process.env.OPENAI_DEFAULT_API_KEY = 'sk-openai';
    assert({
      given: 'OPENAI_DEFAULT_API_KEY is set',
      should: 'return the env key',
      actual: getManagedProviderKey('openai'),
      expected: { apiKey: 'sk-openai' },
    });
  });

  test('Google with env set', () => {
    process.env.GOOGLE_AI_DEFAULT_API_KEY = 'google-managed';
    assert({
      given: 'GOOGLE_AI_DEFAULT_API_KEY is set',
      should: 'return the env key',
      actual: getManagedProviderKey('google'),
      expected: { apiKey: 'google-managed' },
    });
  });

  test('xAI with env set', () => {
    process.env.XAI_DEFAULT_API_KEY = 'xai-managed';
    assert({
      given: 'XAI_DEFAULT_API_KEY is set',
      should: 'return the env key',
      actual: getManagedProviderKey('xai'),
      expected: { apiKey: 'xai-managed' },
    });
  });

  test('OpenRouter shares its env var with openrouter_free', () => {
    process.env.OPENROUTER_DEFAULT_API_KEY = 'or-key';
    assert({
      given: 'OPENROUTER_DEFAULT_API_KEY is set',
      should: 'resolve openrouter to that key',
      actual: getManagedProviderKey('openrouter'),
      expected: { apiKey: 'or-key' },
    });
    assert({
      given: 'OPENROUTER_DEFAULT_API_KEY is set',
      should: 'resolve openrouter_free to the same key',
      actual: getManagedProviderKey('openrouter_free'),
      expected: { apiKey: 'or-key' },
    });
  });

  test('GLM Coder Plan with env set', () => {
    process.env.GLM_CODER_DEFAULT_API_KEY = 'glm-coder';
    assert({
      given: 'GLM_CODER_DEFAULT_API_KEY is set',
      should: 'return the env key for the glm provider',
      actual: getManagedProviderKey('glm'),
      expected: { apiKey: 'glm-coder' },
    });
  });

  test('MiniMax with env set', () => {
    process.env.MINIMAX_DEFAULT_API_KEY = 'minimax-key';
    assert({
      given: 'MINIMAX_DEFAULT_API_KEY is set',
      should: 'return the env key',
      actual: getManagedProviderKey('minimax'),
      expected: { apiKey: 'minimax-key' },
    });
  });

  test('Ollama with base URL env set', () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    assert({
      given: 'OLLAMA_BASE_URL is set',
      should: 'return baseUrl without an apiKey',
      actual: getManagedProviderKey('ollama'),
      expected: { baseUrl: 'http://localhost:11434' },
    });
  });

  test('LM Studio with base URL env set', () => {
    process.env.LMSTUDIO_BASE_URL = 'http://localhost:1234/v1';
    assert({
      given: 'LMSTUDIO_BASE_URL is set',
      should: 'return baseUrl without an apiKey',
      actual: getManagedProviderKey('lmstudio'),
      expected: { baseUrl: 'http://localhost:1234/v1' },
    });
  });

  test('Azure OpenAI requires both apiKey and endpoint', () => {
    process.env.AZURE_OPENAI_API_KEY = 'azure-key';
    assert({
      given: 'only AZURE_OPENAI_API_KEY is set without an endpoint',
      should: 'return null because both are required',
      actual: getManagedProviderKey('azure_openai'),
      expected: null,
    });

    process.env.AZURE_OPENAI_ENDPOINT = 'https://example.openai.azure.com';
    assert({
      given: 'both AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT are set',
      should: 'return both',
      actual: getManagedProviderKey('azure_openai'),
      expected: { apiKey: 'azure-key', baseUrl: 'https://example.openai.azure.com' },
    });
  });

  test('Unknown provider', () => {
    assert({
      given: 'an unknown provider name',
      should: 'return null',
      actual: getManagedProviderKey('not-a-real-provider'),
      expected: null,
    });
  });

  test('Empty env values are treated as unset', () => {
    process.env.ANTHROPIC_DEFAULT_API_KEY = '';
    assert({
      given: 'ANTHROPIC_DEFAULT_API_KEY is set to empty string',
      should: 'return null',
      actual: getManagedProviderKey('anthropic'),
      expected: null,
    });
  });
});
