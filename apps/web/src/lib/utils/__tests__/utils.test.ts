import { describe, it, expect, vi, afterEach } from 'vitest';
import { cn, slugify, formatBytes, isElectron, ROLE_COLORS, getRoleColorClasses } from '../utils';

describe('utils', () => {
  describe('cn', () => {
    it('should merge tailwind classes', () => {
      expect(cn('p-4', 'p-2')).toBe('p-2');
    });

    it('should handle conditional classes', () => {
      expect(cn('base', false && 'hidden', 'visible')).toBe('base visible');
    });

    it('should handle empty input', () => {
      expect(cn()).toBe('');
    });
  });

  describe('slugify', () => {
    it('should convert text to slug', () => {
      expect(slugify('Hello World')).toBe('hello-world');
    });

    it('should remove special characters', () => {
      expect(slugify('Hello! World?')).toBe('hello-world');
    });

    it('should collapse multiple dashes', () => {
      expect(slugify('Hello   World')).toBe('hello-world');
    });

    it('should trim leading and trailing dashes', () => {
      expect(slugify(' -Hello World- ')).toBe('hello-world');
    });

    it('should handle empty string', () => {
      expect(slugify('')).toBe('');
    });

    it('should handle uppercase', () => {
      expect(slugify('HELLO WORLD')).toBe('hello-world');
    });
  });

  describe('formatBytes', () => {
    it('should format 0 bytes', () => {
      expect(formatBytes(0)).toBe('0 Bytes');
    });

    it('should format bytes', () => {
      expect(formatBytes(500)).toBe('500 Bytes');
    });

    it('should format kilobytes', () => {
      expect(formatBytes(1024)).toBe('1 KB');
    });

    it('should format megabytes', () => {
      expect(formatBytes(1024 * 1024)).toBe('1 MB');
    });

    it('should format gigabytes', () => {
      expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
    });

    it('should respect decimals parameter', () => {
      expect(formatBytes(1536, 1)).toBe('1.5 KB');
    });

    it('should handle negative decimals as 0', () => {
      expect(formatBytes(1536, -1)).toBe('2 KB');
    });
  });

  describe('isElectron', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should return false in non-Electron browser', () => {
      expect(isElectron()).toBe(false);
    });

    it('should return true when userAgent includes Electron', () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Electron/28.0.0');
      expect(isElectron()).toBe(true);
    });
  });

  describe('ROLE_COLORS', () => {
    it('should have 8 colors', () => {
      expect(ROLE_COLORS).toHaveLength(8);
    });

    it('should have unique names', () => {
      const names = ROLE_COLORS.map(c => c.name);
      expect(new Set(names).size).toBe(names.length);
    });
  });

  describe('getRoleColorClasses', () => {
    it('should return classes for known colors', () => {
      expect(getRoleColorClasses('blue')).toContain('bg-blue-100');
    });

    it('should return default classes for unknown color', () => {
      expect(getRoleColorClasses('magenta')).toContain('bg-gray-100');
    });

    it('should return default classes when undefined', () => {
      expect(getRoleColorClasses(undefined)).toContain('bg-gray-100');
    });

    it('should return default classes for empty string', () => {
      expect(getRoleColorClasses('')).toContain('bg-gray-100');
    });

    it('should return correct classes for all defined colors', () => {
      for (const { name } of ROLE_COLORS) {
        const classes = getRoleColorClasses(name);
        expect(classes).toContain(name);
      }
    });
  });
});
