import { describe, it } from 'vitest';
import { assert } from '@/test/riteway';
import { hasVisionCapability, hasPdfInputCapability } from '../vision-models';

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
