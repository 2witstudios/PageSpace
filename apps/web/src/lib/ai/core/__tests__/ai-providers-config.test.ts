import { describe, it, expect } from 'vitest';
import {
  PAGESPACE_MODEL_ALIASES,
  resolvePageSpaceModel,
  isPageSpaceModelAlias,
  getPageSpaceModelTier,
  getDefaultModel,
  getUserFacingModelName,
} from '../ai-providers-config';

describe('ai-providers-config', () => {
  describe('PAGESPACE_MODEL_ALIASES', () => {
    it('should define standard and pro tiers', () => {
      expect(PAGESPACE_MODEL_ALIASES).toHaveProperty('standard');
      expect(PAGESPACE_MODEL_ALIASES).toHaveProperty('pro');
    });

    it('should map standard to glm-4.7', () => {
      expect(PAGESPACE_MODEL_ALIASES.standard).toBe('glm-4.7');
    });

    it('should map pro to glm-5', () => {
      expect(PAGESPACE_MODEL_ALIASES.pro).toBe('glm-5');
    });
  });

  describe('resolvePageSpaceModel', () => {
    it('should resolve standard alias to glm-4.7', () => {
      expect(resolvePageSpaceModel('standard')).toBe('glm-4.7');
    });

    it('should resolve pro alias to glm-5', () => {
      expect(resolvePageSpaceModel('pro')).toBe('glm-5');
    });

    it('should be case-insensitive', () => {
      expect(resolvePageSpaceModel('STANDARD')).toBe('glm-4.7');
      expect(resolvePageSpaceModel('PRO')).toBe('glm-5');
    });

    it('should return the model unchanged if not an alias', () => {
      expect(resolvePageSpaceModel('glm-4.7')).toBe('glm-4.7');
      expect(resolvePageSpaceModel('some-other-model')).toBe('some-other-model');
    });
  });

  describe('isPageSpaceModelAlias', () => {
    it('should return true for standard alias', () => {
      expect(isPageSpaceModelAlias('standard')).toBe(true);
    });

    it('should return true for pro alias', () => {
      expect(isPageSpaceModelAlias('pro')).toBe(true);
    });

    it('should be case-insensitive', () => {
      expect(isPageSpaceModelAlias('STANDARD')).toBe(true);
      expect(isPageSpaceModelAlias('PRO')).toBe(true);
    });

    it('should return false for non-alias model names', () => {
      expect(isPageSpaceModelAlias('glm-4.7')).toBe(false);
      expect(isPageSpaceModelAlias('glm-5')).toBe(false);
    });
  });

  describe('getPageSpaceModelTier', () => {
    it('should return standard for glm-4.7', () => {
      expect(getPageSpaceModelTier('glm-4.7')).toBe('standard');
    });

    it('should return pro for glm-5', () => {
      expect(getPageSpaceModelTier('glm-5')).toBe('pro');
    });

    it('should be case-insensitive', () => {
      expect(getPageSpaceModelTier('GLM-4.7')).toBe('standard');
      expect(getPageSpaceModelTier('GLM-5')).toBe('pro');
    });

    it('should return null for non-tier models', () => {
      expect(getPageSpaceModelTier('glm-4.6')).toBe(null);
      expect(getPageSpaceModelTier('some-other-model')).toBe(null);
    });

    it('should return null for alias names (not resolved models)', () => {
      // Aliases are names like "standard", "pro" - not the actual model IDs
      expect(getPageSpaceModelTier('standard')).toBe(null);
      expect(getPageSpaceModelTier('pro')).toBe(null);
    });
  });

  describe('getDefaultModel', () => {
    it('should return glm-4.7 for pagespace provider', () => {
      expect(getDefaultModel('pagespace')).toBe('glm-4.7');
    });

    it('should return gemini-2.5-flash for google provider', () => {
      expect(getDefaultModel('google')).toBe('gemini-2.5-flash');
    });

    it('should return glm-4.7 for unknown provider', () => {
      expect(getDefaultModel('unknown-provider')).toBe('glm-4.7');
    });
  });

  describe('getUserFacingModelName', () => {
    it('should return PageSpace Standard for glm-4.7', () => {
      expect(getUserFacingModelName('pagespace', 'glm-4.7')).toBe('PageSpace Standard');
    });

    it('should return PageSpace Pro for glm-5', () => {
      expect(getUserFacingModelName('pagespace', 'glm-5')).toBe('PageSpace Pro');
    });

    it('should resolve aliases correctly', () => {
      expect(getUserFacingModelName('pagespace', 'standard')).toBe('PageSpace Standard');
      expect(getUserFacingModelName('pagespace', 'pro')).toBe('PageSpace Pro');
    });

    it('should return PageSpace AI for non-pagespace providers', () => {
      expect(getUserFacingModelName('openrouter', 'gpt-4')).toBe('PageSpace AI');
      expect(getUserFacingModelName('google', 'gemini-2.5-flash')).toBe('PageSpace AI');
    });

    it('should return PageSpace AI for null/undefined model', () => {
      expect(getUserFacingModelName('pagespace', null)).toBe('PageSpace AI');
      expect(getUserFacingModelName('pagespace', undefined)).toBe('PageSpace AI');
    });
  });
});
