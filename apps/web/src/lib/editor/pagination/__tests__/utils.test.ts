import { describe, it, expect } from 'vitest';
import { updateCssVariables, getPageSize } from '../utils';
import type { PaginationConfig } from '../utils';

describe('pagination/utils', () => {
  describe('getPageSize', () => {
    it('should create a PageSize object', () => {
      const result = getPageSize(1123, 794, 95, 95, 76, 76);
      expect(result).toEqual({
        pageHeight: 1123,
        pageWidth: 794,
        marginTop: 95,
        marginBottom: 95,
        marginLeft: 76,
        marginRight: 76,
      });
    });
  });

  describe('updateCssVariables', () => {
    it('should set CSS custom properties on the target element', () => {
      const element = document.createElement('div');
      const config: PaginationConfig = {
        pageHeight: 1123,
        pageWidth: 794,
        pageHeaderHeight: 50,
        pageFooterHeight: 50,
        marginTop: 95,
        marginBottom: 95,
        marginLeft: 76,
        marginRight: 76,
        contentMarginTop: 20,
        contentMarginBottom: 20,
        pageGapBorderColor: '#ccc',
      };

      updateCssVariables(element, config);

      expect(element.style.getPropertyValue('--rm-page-width')).toBe('794px');
      expect(element.style.getPropertyValue('--rm-margin-top')).toBe('95px');
      expect(element.style.getPropertyValue('--rm-margin-bottom')).toBe('95px');
      expect(element.style.getPropertyValue('--rm-margin-left')).toBe('76px');
      expect(element.style.getPropertyValue('--rm-margin-right')).toBe('76px');
      expect(element.style.getPropertyValue('--rm-content-margin-top')).toBe('20px');
      expect(element.style.getPropertyValue('--rm-content-margin-bottom')).toBe('20px');
      expect(element.style.getPropertyValue('--rm-page-gap-border-color')).toBe('#ccc');
    });

    it('should calculate correct content height', () => {
      const element = document.createElement('div');
      const config: PaginationConfig = {
        pageHeight: 1000,
        pageWidth: 800,
        pageHeaderHeight: 40,
        pageFooterHeight: 40,
        marginTop: 50,
        marginBottom: 50,
        marginLeft: 50,
        marginRight: 50,
        contentMarginTop: 10,
        contentMarginBottom: 10,
        pageGapBorderColor: '#000',
      };

      updateCssVariables(element, config);

      // 1000 - (40+40) - 10 - 10 - 50 - 50 = 800
      expect(element.style.getPropertyValue('--rm-page-content-height')).toBe('800px');
      expect(element.style.getPropertyValue('--rm-max-content-child-height')).toBe('790px');
    });
  });
});
