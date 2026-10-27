import { describe, test, beforeEach } from 'vitest';
import { assert } from './riteway';

import { getManagedProviderKey } from '../ai-utils';

const ENV_KEYS = [
  'OPENAI_DEFAULT_API_KEY',
  'OPENROUTER_DEFAULT_API_KEY',
  'OLLAMA_BASE_URL',
  'LMSTUDIO_BASE_URL',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
] as const;

describe('getManagedProviderKey', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  test('cloud vendor with OpenRouter env unset', () => {
    assert({
      given: 'OPENROUTER_DEFAULT_API_KEY is unset',
      should: 'return null for a cloud vendor',
      actual: getManagedProviderKey('anthropic'),
      expected: null,
    });
  });

  test('Anthropic resolves to the OpenRouter key', () => {
    process.env.OPENROUTER_DEFAULT_API_KEY = 'or-key';
    assert({
      given: 'OPENROUTER_DEFAULT_API_KEY is set',
      should: 'resolve the anthropic vendor to the OpenRouter key',
      actual: getManagedProviderKey('anthropic'),
      expected: { apiKey: 'or-key' },
    });
  });

  test('OpenAI resolves to the OpenRouter key', () => {
    process.env.OPENROUTER_DEFAULT_API_KEY = 'or-key';
    assert({
      given: 'OPENROUTER_DEFAULT_API_KEY is set',
      should: 'resolve the openai vendor to the OpenRouter key',
      actual: getManagedProviderKey('openai'),
      expected: { apiKey: 'or-key' },
    });
  });

  test('Google resolves to the OpenRouter key', () => {
    process.env.OPENROUTER_DEFAULT_API_KEY = 'or-key';
    assert({
      given: 'OPENROUTER_DEFAULT_API_KEY is set',
      should: 'resolve the google vendor to the OpenRouter key',
      actual: getManagedProviderKey('google'),
      expected: { apiKey: 'or-key' },
    });
  });

  test('xAI resolves to the OpenRouter key', () => {
    process.env.OPENROUTER_DEFAULT_API_KEY = 'or-key';
    assert({
      given: 'OPENROUTER_DEFAULT_API_KEY is set',
      should: 'resolve the xai vendor to the OpenRouter key',
      actual: getManagedProviderKey('xai'),
      expected: { apiKey: 'or-key' },
    });
  });

  test('MiniMax (a cloud vendor) resolves to the OpenRouter key', () => {
    process.env.OPENROUTER_DEFAULT_API_KEY = 'or-key';
    assert({
      given: 'OPENROUTER_DEFAULT_API_KEY is set',
      should: 'resolve the minimax vendor to the OpenRouter key',
      actual: getManagedProviderKey('minimax'),
      expected: { apiKey: 'or-key' },
    });
  });

  test('The literal openrouter backend resolves to the OpenRouter key', () => {
    process.env.OPENROUTER_DEFAULT_API_KEY = 'or-key';
    assert({
      given: 'OPENROUTER_DEFAULT_API_KEY is set',
      should: 'resolve the openrouter backend to that key',
      actual: getManagedProviderKey('openrouter'),
      expected: { apiKey: 'or-key' },
    });
  });

  test('Voice provider uses the real OpenAI key, not OpenRouter', () => {
    process.env.OPENAI_DEFAULT_API_KEY = 'sk-openai';
    assert({
      given: 'OPENAI_DEFAULT_API_KEY is set',
      should: 'resolve openai_voice to the direct OpenAI key',
      actual: getManagedProviderKey('openai_voice'),
      expected: { apiKey: 'sk-openai' },
    });
  });

  test('Voice provider with env unset returns null', () => {
    assert({
      given: 'OPENAI_DEFAULT_API_KEY is unset',
      should: 'return null for openai_voice',
      actual: getManagedProviderKey('openai_voice'),
      expected: null,
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

  test('Ollama with base URL env unset returns null', () => {
    assert({
      given: 'OLLAMA_BASE_URL is unset',
      should: 'return null',
      actual: getManagedProviderKey('ollama'),
      expected: null,
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

  test('Empty OpenRouter env value is treated as unset', () => {
    process.env.OPENROUTER_DEFAULT_API_KEY = '';
    assert({
      given: 'OPENROUTER_DEFAULT_API_KEY is set to empty string',
      should: 'return null for a cloud vendor',
      actual: getManagedProviderKey('anthropic'),
      expected: null,
    });
  });
});
