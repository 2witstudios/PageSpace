import { describe, it, expect, vi } from 'vitest';
import { assert } from './riteway';
import {
  extractImageFromResult,
  extractImageCost,
  extractImageGenerationIds,
  generateImageBytes,
  ImageGenerationError,
  type ImageGenResult,
} from '../image-generation';

const bytes = new Uint8Array([1, 2, 3]);

const goodResult: ImageGenResult = {
  files: [{ mediaType: 'image/jpeg', uint8Array: bytes }],
  providerMetadata: { openrouter: { id: 'gen-123', usage: { cost: 0.068 } } },
};

describe('pure extractors', () => {
  it('extracts the first image file', () => {
    assert({
      given: 'a result with an image file',
      should: 'return its bytes + mediaType',
      actual: extractImageFromResult(goodResult),
      expected: { bytes, mediaType: 'image/jpeg' },
    });
  });

  it('returns null when there is no image file', () => {
    assert({
      given: 'a result with only text (no files)',
      should: 'return null',
      actual: extractImageFromResult({ files: [] }),
      expected: null,
    });
  });

  it('rejects media types the platform does not accept (e.g. SVG)', () => {
    // SVG is not an allowed image type: the FILE page could never be read back or rendered
    // (and is force-downloaded as a dangerous MIME). Treat it as "no image" instead.
    assert({
      given: 'a model returning image/svg+xml',
      should: 'return null rather than persist an unreadable file',
      actual: extractImageFromResult({
        files: [{ mediaType: 'image/svg+xml', uint8Array: bytes }],
      }),
      expected: null,
    });
  });

  it('extracts the OpenRouter cost', () => {
    assert({ given: 'usage.cost present', should: 'return it', actual: extractImageCost(goodResult), expected: 0.068 });
    assert({ given: 'no provider metadata', should: 'return undefined', actual: extractImageCost({}), expected: undefined });
  });

  it('extracts generation ids (metadata or response id)', () => {
    assert({ given: 'openrouter.id present', should: 'collect it', actual: extractImageGenerationIds(goodResult), expected: ['gen-123'] });
    assert({ given: 'no ids anywhere', should: 'return []', actual: extractImageGenerationIds({}), expected: [] });
  });
});

describe('generateImageBytes (shell, injected client + generate)', () => {
  const client = { chat: vi.fn(() => 'MODEL_HANDLE') } as unknown as import('../image-generation').OpenRouterImageClient;

  it('returns bytes, mediaType, cost and ids on success', async () => {
    const generate = vi.fn(async () => goodResult);
    const out = await generateImageBytes(
      { prompt: 'a red panda astronaut', model: 'google/gemini-3.1-flash-image-preview' },
      { client, generate },
    );
    assert({
      given: 'a model that returns an image + cost',
      should: 'return the mapped GeneratedImage',
      actual: { mediaType: out.mediaType, cost: out.providerCostDollars, ids: out.generationIds, bytes: Array.from(out.bytes) },
      expected: { mediaType: 'image/jpeg', cost: 0.068, ids: ['gen-123'], bytes: [1, 2, 3] },
    });
  });

  it('passes modalities and aspect ratio through extraBody', async () => {
    const chat = vi.fn((_model: string, _opts: unknown) => 'MODEL_HANDLE');
    const c2 = { chat } as unknown as import('../image-generation').OpenRouterImageClient;
    const generate = vi.fn(async () => goodResult);
    await generateImageBytes({ prompt: 'x', model: 'm', aspectRatio: '16:9' }, { client: c2, generate });
    const opts = chat.mock.calls[0][1] as { usage: unknown; extraBody: Record<string, unknown> };
    assert({
      given: 'an aspectRatio',
      should: 'set modalities + image_config on extraBody with usage.include',
      actual: opts.extraBody,
      expected: { modalities: ['image', 'text'], image_config: { aspect_ratio: '16:9' } },
    });
  });

  it('throws ImageGenerationError when no image comes back', async () => {
    const generate = vi.fn(async () => ({ files: [] }) as ImageGenResult);
    await expect(
      generateImageBytes({ prompt: 'x', model: 'm' }, { client, generate }),
    ).rejects.toBeInstanceOf(ImageGenerationError);
  });
});
