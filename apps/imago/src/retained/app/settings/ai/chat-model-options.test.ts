import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { buildChatModelOptions, chatModelValue } from './chat-model-options';

describe('buildChatModelOptions', () => {
  test('lists only available providers, labelled Provider · Model', () => {
    const options = buildChatModelOptions({
      providers: { openai: { isAvailable: true }, anthropic: { isAvailable: false } },
      tier: 'pro',
      isAdmin: false,
      dynamicModels: {},
    });
    assert({
      given: 'OpenAI available and Anthropic not',
      should: 'offer OpenAI models only, labelled with the provider name',
      actual: {
        providers: [...new Set(options.map((o) => o.provider))],
        labelled: options.every((o) => o.label.startsWith('OpenAI · ')),
      },
      expected: { providers: ['openai'], labelled: true },
    });
  });

  test('a free tier is limited to the free allowlist', () => {
    const paid = buildChatModelOptions({
      providers: { openai: { isAvailable: true } },
      tier: 'pro',
      isAdmin: false,
      dynamicModels: {},
    });
    const free = buildChatModelOptions({
      providers: { openai: { isAvailable: true } },
      tier: 'free',
      isAdmin: false,
      dynamicModels: {},
    });
    assert({
      given: 'the same provider for a paid tier and a free tier',
      should: 'offer fewer models on the free tier',
      actual: free.length < paid.length && free.length > 0,
      expected: true,
    });
  });

  test('uses the models the server reported for a local provider', () => {
    const options = buildChatModelOptions({
      providers: { ollama: { isAvailable: true } },
      tier: 'free',
      isAdmin: false,
      dynamicModels: { ollama: { 'llama3:8b': 'Llama 3 8B' } },
    });
    assert({
      given: 'a local Ollama provider with a discovered model',
      should: 'offer that discovered model, not an empty static catalogue',
      actual: options.map((o) => [o.value, o.label]),
      expected: [[chatModelValue('ollama', 'llama3:8b'), 'Ollama (Local) · Llama 3 8B']],
    });
  });

  test('offers nothing when no provider is available', () => {
    assert({
      given: 'no available provider',
      should: 'offer no chat models',
      actual: buildChatModelOptions({
        providers: { openai: { isAvailable: false } },
        tier: 'pro',
        isAdmin: true,
        dynamicModels: {},
      }),
      expected: [],
    });
  });
});
