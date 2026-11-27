import { describe, it } from 'vitest';
import { assert } from '@/test/riteway';
import { hasVisionCapability, hasPdfInputCapability, getToolMediaCapabilities } from '../vision-models';
import { supportsToolResultMedia } from '../provider-backend';

/**
 * Labels are checked against OpenRouter's /api/v1/models `architecture.input_modalities`
 * (fetched 2026-11-26), not guessed: "image" → vision, "file" → native PDF input.
 */
describe('hasVisionCapability', () => {
  describe('GLM (z-ai) models', () => {
    const visionGlm = [
      'z-ai/glm-5.3-flash',   // text,image,video
      'z-ai/glm-5.3-flashx',  // text,image,video
      'z-ai/glm-4.6v',        // image,text,video
      'z-ai/glm-4.5v',        // text,image
      'z-ai/glm-5v-turbo',    // image,text,video
      'glm-5.3-flash',        // bare id used by the admin-only Z.ai provider
    ];
    for (const model of visionGlm) {
      it(`labels ${model} as vision-capable`, () => {
        assert({
          given: `${model}, which OpenRouter lists with image input`,
          should: 'be vision-capable',
          actual: hasVisionCapability(model),
          expected: true,
        });
      });
    }

    const textGlm = [
      'z-ai/glm-5.3',
      'z-ai/glm-5.3-prime',
      'z-ai/glm-5.2',
      'z-ai/glm-5.1',
      'z-ai/glm-5',
      'z-ai/glm-5-turbo',
      'z-ai/glm-4.7',
      'z-ai/glm-4.7-flash',
      'z-ai/glm-4.6',
      'z-ai/glm-4.5',
      'z-ai/glm-4.5-air',
    ];
    for (const model of textGlm) {
      it(`labels ${model} as text-only`, () => {
        assert({
          given: `${model}, which OpenRouter lists as text-only`,
          should: 'not be vision-capable',
          actual: hasVisionCapability(model),
          expected: false,
        });
      });
    }
  });

  describe('the version-v name pattern', () => {
    it('matches an unlisted <version>v model', () => {
      assert({
        given: 'an unlisted "glm-9.1v" id',
        should: 'be recognised as a vision model by its version-v suffix',
        actual: hasVisionCapability('z-ai/glm-9.1v'),
        expected: true,
      });
    });

    it('matches an unlisted v-turbo model', () => {
      assert({
        given: 'an unlisted "glm-7v-turbo" id',
        should: 'be recognised as a vision model',
        actual: hasVisionCapability('z-ai/glm-7v-turbo'),
        expected: true,
      });
    });

    it('does not match a vendor version prefix like "-v4"', () => {
      assert({
        given: 'deepseek-v4-pro (text-only, "v" precedes the version)',
        should: 'not be treated as a vision model',
        actual: hasVisionCapability('deepseek/deepseek-v4-pro'),
        expected: false,
      });
    });
  });

  describe('Claude 5.x', () => {
    for (const model of ['anthropic/claude-opus-5.5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-fable-5.1']) {
      it(`labels ${model} as vision-capable`, () => {
        assert({
          given: `${model} (text,image,file on OpenRouter)`,
          should: 'be vision-capable',
          actual: hasVisionCapability(model),
          expected: true,
        });
      });
    }
  });

  describe('text-only models previously mislabelled as vision', () => {
    for (const model of ['openai/gpt-4', 'minimax/minimax-m2.5']) {
      it(`labels ${model} as text-only`, () => {
        assert({
          given: `${model}, which OpenRouter lists as text-only`,
          should: 'not be vision-capable',
          actual: hasVisionCapability(model),
          expected: false,
        });
      });
    }
  });

  it('keeps Gemini 4 Neon vision-capable', () => {
    assert({
      given: 'google/gemini-4-neon',
      should: 'be vision-capable',
      actual: hasVisionCapability('google/gemini-4-neon'),
      expected: true,
    });
  });
});

describe('hasPdfInputCapability', () => {
  const pdfModels = [
    'google/gemini-4-neon',
    'google/gemini-3.5-flash',
    'anthropic/claude-opus-5.5',
    'anthropic/claude-haiku-4.5',
    'openai/gpt-4.1',
    'openai/gpt-5.4',
    'openai/gpt-6-luna',
  ];
  for (const model of pdfModels) {
    it(`accepts native PDF input for ${model} via OpenRouter`, () => {
      assert({
        given: `${model} routed through OpenRouter`,
        should: 'accept a PDF file part',
        actual: hasPdfInputCapability(model, 'openrouter'),
        expected: true,
      });
    });
  }

  it('treats a cloud vendor provider as OpenRouter-backed', () => {
    assert({
      given: 'a Gemini model on the "google" UI provider (routed via OpenRouter)',
      should: 'accept a PDF file part',
      actual: hasPdfInputCapability('google/gemini-4-neon', 'google'),
      expected: true,
    });
  });

  it('rejects vision-only models', () => {
    assert({
      given: 'GLM 5.3 Flash (text,image,video — no file input)',
      should: 'not accept a PDF file part',
      actual: hasPdfInputCapability('z-ai/glm-5.3-flash', 'zai'),
      expected: false,
    });
  });

  for (const model of ['openai/gpt-5.1-codex', 'openai/gpt-5.2-codex', 'google/gemini-3-pro-image']) {
    it(`rejects ${model}, which OpenRouter lists without file input`, () => {
      assert({
        given: `${model} (image input but no file input on OpenRouter)`,
        should: 'not accept a PDF file part',
        actual: hasPdfInputCapability(model, 'openrouter'),
        expected: false,
      });
    });
  }

  it('rejects Gemma, which is not Gemini', () => {
    assert({
      given: 'google/gemma-4-31b-it',
      should: 'not accept a PDF file part',
      actual: hasPdfInputCapability('google/gemma-4-31b-it', 'google'),
      expected: false,
    });
  });

  it('rejects providers that do not route through OpenRouter', () => {
    assert({
      given: 'a local Ollama model whose name contains "gemini"',
      should: 'not accept a PDF file part (no OpenRouter file mapping)',
      actual: hasPdfInputCapability('gemini-lookalike', 'ollama'),
      expected: false,
    });
  });
});

/**
 * Checked against the installed provider packages, not memory:
 * - @openrouter/ai-sdk-provider 2.10.0 maps tool-result image-data/file-data parts to
 *   image_url / file content (mapToolResultContentParts).
 * - @ai-sdk/openai-compatible 2.0.52 (glm, lmstudio, azure_openai) and
 *   ollama-ai-provider-v2 3.6.0 JSON.stringify a `content` tool output into the
 *   tool message, so any image becomes base64 text.
 */
describe('supportsToolResultMedia', () => {
  for (const provider of ['openrouter', 'openai', 'anthropic', 'google', 'zai']) {
    it(`is true for ${provider}, served through OpenRouter`, () => {
      expect(supportsToolResultMedia(provider)).toBe(true);
    });
  }
  for (const provider of ['glm', 'ollama', 'lmstudio', 'azure_openai']) {
    it(`is false for ${provider}, whose SDK sends tool-result media as JSON text`, () => {
      expect(supportsToolResultMedia(provider)).toBe(false);
    });
  }
});

describe('getToolMediaCapabilities', () => {
  it('reports a vision model on a provider that cannot receive tool-result media', () => {
    assert({
      given: 'GLM 5.3 Flash on the admin-only Z.ai (glm) provider',
      should: 'keep its vision label but report no tool-result media and no PDF input',
      actual: getToolMediaCapabilities('glm-5.3-flash', 'glm'),
      expected: { hasVision: true, hasPdfInput: false, hasToolResultMedia: false },
    });
  });

  it('reports full media for Gemini through OpenRouter', () => {
    expect(getToolMediaCapabilities('google/gemini-4-neon', 'google')).toEqual({
      hasVision: true, hasPdfInput: true, hasToolResultMedia: true,
    });
  });
});
