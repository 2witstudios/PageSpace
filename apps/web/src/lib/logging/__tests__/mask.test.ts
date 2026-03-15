import { describe, it, expect } from 'vitest';
import { maskIdentifier } from '../mask';

describe('mask', () => {
  describe('maskIdentifier', () => {
    it('should return undefined for null', () => {
      expect(maskIdentifier(null)).toBeUndefined();
    });

    it('should return undefined for undefined', () => {
      expect(maskIdentifier(undefined)).toBeUndefined();
    });

    it('should return undefined for empty string', () => {
      expect(maskIdentifier('')).toBeUndefined();
    });

    it('should return full string when 8 chars or less', () => {
      expect(maskIdentifier('12345678')).toBe('12345678');
    });

    it('should return full string when less than 8 chars', () => {
      expect(maskIdentifier('abcd')).toBe('abcd');
    });

    it('should mask middle of strings longer than 8 chars', () => {
      expect(maskIdentifier('abcdefghijklmnop')).toBe('abcd...mnop');
    });

    it('should mask a 9-character string', () => {
      expect(maskIdentifier('123456789')).toBe('1234...6789');
    });

    it('should handle numeric values', () => {
      expect(maskIdentifier(123456789 as unknown as string)).toBe('1234...6789');
    });
  });
});
