import { describe, it, expect } from 'vitest';
import { hasVisionCapability, getSuggestedVisionModels } from '../vision-models';

describe('vision-models', () => {
  describe('hasVisionCapability', () => {
    it('should return true for gpt-4o', () => {
      expect(hasVisionCapability('gpt-4o')).toBe(true);
    });

    it('should return true for gpt-4o-mini', () => {
      expect(hasVisionCapability('gpt-4o-mini')).toBe(true);
    });

    it('should return true for claude-3-5-sonnet', () => {
      expect(hasVisionCapability('claude-3-5-sonnet-20241022')).toBe(true);
    });

    it('should return true for gemini models', () => {
      expect(hasVisionCapability('gemini-2.5-pro')).toBe(true);
    });

    it('should return false for o1 models', () => {
      expect(hasVisionCapability('o1')).toBe(false);
      expect(hasVisionCapability('o1-mini')).toBe(false);
      expect(hasVisionCapability('o1-preview')).toBe(false);
    });

    it('should return false for o3 models', () => {
      expect(hasVisionCapability('o3')).toBe(false);
      expect(hasVisionCapability('o3-mini')).toBe(false);
    });

    it('should strip provider prefix', () => {
      expect(hasVisionCapability('openai/gpt-4o')).toBe(true);
    });

    it('should detect vision keyword in model name', () => {
      expect(hasVisionCapability('some-custom-vision-model')).toBe(true);
    });

    it('should detect -v- in model name', () => {
      expect(hasVisionCapability('model-v-2')).toBe(true);
    });

    it('should return true for gpt-5 models by keyword', () => {
      expect(hasVisionCapability('gpt-5-custom')).toBe(true);
    });

    it('should return true for claude-3 models by keyword', () => {
      expect(hasVisionCapability('claude-3-custom')).toBe(true);
    });

    it('should return true for claude-4 models by keyword', () => {
      expect(hasVisionCapability('claude-4-custom')).toBe(true);
    });

    it('should return false for unknown models without vision keywords', () => {
      expect(hasVisionCapability('llama-3-70b')).toBe(false);
    });

    it('should return true for grok vision models', () => {
      expect(hasVisionCapability('grok-2-vision')).toBe(true);
    });

    it('should return false for grok non-vision models', () => {
      expect(hasVisionCapability('grok-2-beta')).toBe(false);
    });

    it('should return true for gpt-4o via keyword', () => {
      expect(hasVisionCapability('openai/gpt-4o-custom')).toBe(true);
    });
  });

  describe('getSuggestedVisionModels', () => {
    it('should return an array of model names', () => {
      const models = getSuggestedVisionModels();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
    });

    it('should include gpt-4o-mini', () => {
      expect(getSuggestedVisionModels()).toContain('gpt-4o-mini');
    });

    it('should include gemini-2.5-flash', () => {
      expect(getSuggestedVisionModels()).toContain('gemini-2.5-flash');
    });
  });
});
