import { describe, it, expect } from 'vitest';
import {
  A4_PAGE_SIZE,
  A3_PAGE_SIZE,
  A5_PAGE_SIZE,
  LETTER_PAGE_SIZE,
  LEGAL_PAGE_SIZE,
  TABLOID_PAGE_SIZE,
  PAGE_SIZES,
} from '../constants';

describe('pagination/constants', () => {
  describe('page sizes', () => {
    it('should have A4 page size', () => {
      expect(A4_PAGE_SIZE.pageHeight).toBe(1123);
      expect(A4_PAGE_SIZE.pageWidth).toBe(794);
    });

    it('should have A3 page size', () => {
      expect(A3_PAGE_SIZE.pageHeight).toBe(1591);
      expect(A3_PAGE_SIZE.pageWidth).toBe(1123);
    });

    it('should have A5 page size', () => {
      expect(A5_PAGE_SIZE.pageHeight).toBe(794);
      expect(A5_PAGE_SIZE.pageWidth).toBe(419);
    });

    it('should have Letter page size', () => {
      expect(LETTER_PAGE_SIZE.pageHeight).toBe(1060);
      expect(LETTER_PAGE_SIZE.pageWidth).toBe(818);
    });

    it('should have Legal page size', () => {
      expect(LEGAL_PAGE_SIZE.pageHeight).toBe(1404);
      expect(LEGAL_PAGE_SIZE.pageWidth).toBe(818);
    });

    it('should have Tabloid page size', () => {
      expect(TABLOID_PAGE_SIZE.pageHeight).toBe(1635);
      expect(TABLOID_PAGE_SIZE.pageWidth).toBe(1060);
    });
  });

  describe('PAGE_SIZES', () => {
    it('should contain all page size variants', () => {
      expect(Object.keys(PAGE_SIZES)).toEqual(['A4', 'A3', 'A5', 'LETTER', 'LEGAL', 'TABLOID']);
    });

    it('should reference the same objects', () => {
      expect(PAGE_SIZES.A4).toBe(A4_PAGE_SIZE);
      expect(PAGE_SIZES.LETTER).toBe(LETTER_PAGE_SIZE);
    });
  });
});
