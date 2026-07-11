import { describe, it, afterEach, vi } from 'vitest';
import { assert } from './riteway';
import { isImageOutputModel, DEFAULT_IMAGE_MODEL } from '../model-capabilities';

describe('isImageOutputModel (pure)', () => {
  it('detects image-output models', () => {
    assert({
      given: 'a model whose architecture.output_modalities includes "image"',
      should: 'return true',
      actual: isImageOutputModel({
        id: 'google/gemini-3.1-flash-image-preview',
        architecture: { output_modalities: ['text', 'image'] },
      }),
      expected: true,
    });
  });

  it('rejects text-only models', () => {
    assert({
      given: 'a model whose output_modalities is ["text"] only',
      should: 'return false',
      actual: isImageOutputModel({
        id: 'openai/gpt-5.3-chat',
        architecture: { output_modalities: ['text'] },
      }),
      expected: false,
    });
  });

  it('rejects models with no architecture field', () => {
    assert({
      given: 'a model with no architecture field',
      should: 'return false',
      actual: isImageOutputModel({ id: 'some/model' }),
      expected: false,
    });
  });

  it('exposes an image-output default model', () => {
    assert({
      given: 'the DEFAULT_IMAGE_MODEL constant',
      should: 'be a google gemini flash image id',
      actual: DEFAULT_IMAGE_MODEL,
      expected: 'google/gemini-3.1-flash-image-preview',
    });
  });
});

const PAYLOAD = {
  data: [
    { id: 'openai/gpt-5.3-chat', architecture: { output_modalities: ['text'] } },
    {
      id: 'google/gemini-3.1-flash-image-preview',
      name: 'Gemini 3.1 Flash Image',
      architecture: { output_modalities: ['text', 'image'] },
    },
    {
      id: 'bytedance/seedream-4',
      name: 'Seedream 4',
      architecture: { output_modalities: ['image'] },
    },
  ],
};

describe('fetchOpenRouterImageModels (shell, injected fetch)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('returns only image-output models, sorted by id, with catalog display names', async () => {
    vi.resetModules();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => PAYLOAD })),
    );
    const { fetchOpenRouterImageModels } = await import('../model-capabilities');
    const result = await fetchOpenRouterImageModels();

    assert({
      given: 'a /api/v1/models payload with one text model and two image models',
      should: 'return only image models sorted by id',
      actual: result.map((m) => m.id),
      expected: ['bytedance/seedream-4', 'google/gemini-3.1-flash-image-preview'],
    });
    assert({
      given: 'a model present in the curated catalog',
      should: 'use the catalog display name',
      actual: result.find((m) => m.id === 'google/gemini-3.1-flash-image-preview')?.displayName,
      expected: 'Gemini 3.1 Flash Image',
    });
    assert({
      given: 'a model not in the curated catalog',
      should: 'fall back to the OpenRouter-provided name',
      actual: result.find((m) => m.id === 'bytedance/seedream-4')?.displayName,
      expected: 'Seedream 4',
    });
  });

  it('returns [] when the fetch fails (fail-soft, no throw)', async () => {
    vi.resetModules();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    const { fetchOpenRouterImageModels } = await import('../model-capabilities');
    assert({
      given: 'a failing OpenRouter fetch',
      should: 'return an empty array without throwing',
      actual: await fetchOpenRouterImageModels(),
      expected: [],
    });
  });
});
