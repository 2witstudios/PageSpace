import { describe, it, expect } from 'vitest';
import { parseBoundedIntParam } from '../query-params';

describe('query-params', () => {
  describe('parseBoundedIntParam', () => {
    it('should return default value when rawValue is null', () => {
      expect(parseBoundedIntParam(null, { defaultValue: 10 })).toBe(10);
    });

    it('should return default value when rawValue is empty string', () => {
      expect(parseBoundedIntParam('', { defaultValue: 10 })).toBe(10);
    });

    it('should parse valid integer', () => {
      expect(parseBoundedIntParam('25', { defaultValue: 10 })).toBe(25);
    });

    it('should clamp to min bound', () => {
      expect(parseBoundedIntParam('0', { defaultValue: 10, min: 5 })).toBe(5);
    });

    it('should clamp to max bound', () => {
      expect(parseBoundedIntParam('100', { defaultValue: 10, max: 50 })).toBe(50);
    });

    it('should return bounded default when default exceeds max', () => {
      expect(parseBoundedIntParam(null, { defaultValue: 100, max: 50 })).toBe(50);
    });

    it('should return bounded default when default is below min', () => {
      expect(parseBoundedIntParam(null, { defaultValue: 1, min: 5 })).toBe(5);
    });

    it('should return default for non-numeric string', () => {
      expect(parseBoundedIntParam('abc', { defaultValue: 10 })).toBe(10);
    });

    it('should return default for NaN', () => {
      expect(parseBoundedIntParam('NaN', { defaultValue: 10 })).toBe(10);
    });

    it('should return default for Infinity', () => {
      expect(parseBoundedIntParam('Infinity', { defaultValue: 10 })).toBe(10);
    });

    it('should handle negative values within bounds', () => {
      expect(parseBoundedIntParam('-5', { defaultValue: 0, min: -10 })).toBe(-5);
    });

    it('should work with both min and max', () => {
      expect(parseBoundedIntParam('25', { defaultValue: 10, min: 1, max: 50 })).toBe(25);
    });
  });
});
