import { describe, it, afterEach, vi } from 'vitest';
import { assert } from '@/lib/ai/core/__tests__/riteway';

const imageModels = [
  { id: 'bytedance/seedream-4', displayName: 'Seedream 4' },
  { id: 'google/gemini-3.1-flash-image-preview', displayName: 'Gemini 3.1 Flash Image' },
];

describe('GET /api/ai/image-models', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns the dynamic image-model list on cloud', async () => {
    vi.resetModules();
    vi.doMock('@pagespace/lib/deployment-mode', () => ({ isOnPrem: () => false }));
    vi.doMock('@/lib/ai/core/model-capabilities', () => ({
      fetchOpenRouterImageModels: async () => imageModels,
    }));
    const { GET } = await import('../route');
    const body = await (await GET()).json();
    assert({
      given: 'a cloud deployment with image models available',
      should: 'return the model list',
      actual: body.models,
      expected: imageModels,
    });
  });

  it('returns [] on-prem without calling OpenRouter', async () => {
    vi.resetModules();
    const fetchSpy = vi.fn(async () => imageModels);
    vi.doMock('@pagespace/lib/deployment-mode', () => ({ isOnPrem: () => true }));
    vi.doMock('@/lib/ai/core/model-capabilities', () => ({ fetchOpenRouterImageModels: fetchSpy }));
    const { GET } = await import('../route');
    const body = await (await GET()).json();
    assert({
      given: 'an on-prem deployment',
      should: 'return an empty list and not query OpenRouter',
      actual: { models: body.models, called: fetchSpy.mock.calls.length },
      expected: { models: [], called: 0 },
    });
  });
});
