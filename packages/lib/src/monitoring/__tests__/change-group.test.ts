/**
 * Tests for change-group.ts
 * Covers createChangeGroupId and inferChangeGroupType
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @paralleldrive/cuid2 before importing the module under test
vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'mocked-cuid-value'),
  init: vi.fn(() => vi.fn(() => 'test-cuid')),
}));

import { createChangeGroupId, inferChangeGroupType } from '../change-group';

describe('change-group', () => {
  describe('createChangeGroupId', () => {
    it('should return a string', () => {
      const id = createChangeGroupId();
      expect(typeof id).toBe('string');
    });

    it('should return the mocked cuid value', () => {
      const id = createChangeGroupId();
      expect(id).toBe('mocked-cuid-value');
    });

    it('should call createId from @paralleldrive/cuid2', async () => {
      const { createId } = await import('@paralleldrive/cuid2');
      createChangeGroupId();
      expect(createId).toHaveBeenCalled();
    });
  });

  describe('inferChangeGroupType', () => {
    it('should return "ai" when isAiGenerated is true', () => {
      const result = inferChangeGroupType({ isAiGenerated: true });
      expect(result).toBe('ai');
    });

    it('should return "ai" even when requestOrigin is set and isAiGenerated is true', () => {
      const result = inferChangeGroupType({ isAiGenerated: true, requestOrigin: 'system' });
      expect(result).toBe('ai');
    });

    it('should return "system" when requestOrigin is "system"', () => {
      const result = inferChangeGroupType({ requestOrigin: 'system' });
      expect(result).toBe('system');
    });

    it('should return "automation" when requestOrigin is "automation"', () => {
      const result = inferChangeGroupType({ requestOrigin: 'automation' });
      expect(result).toBe('automation');
    });

    it('should return "user" when no options are provided', () => {
      const result = inferChangeGroupType();
      expect(result).toBe('user');
    });

    it('should return "user" when options is undefined', () => {
      const result = inferChangeGroupType(undefined);
      expect(result).toBe('user');
    });

    it('should return "user" when isAiGenerated is false and requestOrigin is not system or automation', () => {
      const result = inferChangeGroupType({ isAiGenerated: false, requestOrigin: 'other' });
      expect(result).toBe('user');
    });

    it('should return "user" when requestOrigin is null', () => {
      const result = inferChangeGroupType({ requestOrigin: null });
      expect(result).toBe('user');
    });

    it('should return "user" when options is empty object', () => {
      const result = inferChangeGroupType({});
      expect(result).toBe('user');
    });

    it('should return "user" when isAiGenerated is false', () => {
      const result = inferChangeGroupType({ isAiGenerated: false });
      expect(result).toBe('user');
    });

    it('should prioritise ai over system when both are set', () => {
      const result = inferChangeGroupType({ isAiGenerated: true, requestOrigin: 'automation' });
      expect(result).toBe('ai');
    });
  });
});
