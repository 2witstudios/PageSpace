import { describe, it, expect, vi } from 'vitest';

// Mock 'ai' package
vi.mock('ai', () => ({}));

import { mergeToolSets } from '../tool-utils';

describe('tool-utils', () => {
  describe('mergeToolSets', () => {
    it('should merge base and additional tool sets', () => {
      const base = {
        toolA: { description: 'Tool A', execute: vi.fn() },
        toolB: { description: 'Tool B', execute: vi.fn() },
      };
      const additional = {
        toolC: { description: 'Tool C', execute: vi.fn() },
      };

      const result = mergeToolSets(base as never, additional);
      expect(result).toHaveProperty('toolA');
      expect(result).toHaveProperty('toolB');
      expect(result).toHaveProperty('toolC');
    });

    it('should override base tools with additional tools when keys conflict', () => {
      const base = {
        toolA: { description: 'Original Tool A', execute: vi.fn() },
      };
      const overrideTool = { description: 'Overridden Tool A', execute: vi.fn() };
      const additional = {
        toolA: overrideTool,
      };

      const result = mergeToolSets(base as never, additional);
      expect(result.toolA).toBe(overrideTool);
    });

    it('should return base tools unchanged when additional is empty', () => {
      const base = {
        toolA: { description: 'Tool A', execute: vi.fn() },
      };

      const result = mergeToolSets(base as never, {});
      expect(result).toEqual(base);
    });

    it('should handle empty base tool set', () => {
      const additional = {
        toolC: { description: 'Tool C', execute: vi.fn() },
      };

      const result = mergeToolSets({} as never, additional);
      expect(result).toHaveProperty('toolC');
    });

    it('should return empty object when both are empty', () => {
      const result = mergeToolSets({} as never, {});
      expect(result).toEqual({});
    });
  });
});
