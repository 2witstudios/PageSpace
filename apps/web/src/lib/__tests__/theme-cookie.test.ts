import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('theme-cookie', () => {
  beforeEach(() => {
    vi.resetModules();
    Object.defineProperty(document, 'cookie', {
      writable: true,
      value: '',
    });
  });

  describe('syncThemeToCookie', () => {
    it('should set theme cookie with correct format', async () => {
      vi.stubEnv('NEXT_PUBLIC_COOKIE_DOMAIN', '');
      const { syncThemeToCookie } = await import('../theme-cookie');
      syncThemeToCookie('dark');
      expect(document.cookie).toContain('theme=dark');
      expect(document.cookie).toContain('path=/');
      expect(document.cookie).toContain('SameSite=Lax');
      vi.unstubAllEnvs();
    });

    it('should include domain when NEXT_PUBLIC_COOKIE_DOMAIN is set', async () => {
      vi.stubEnv('NEXT_PUBLIC_COOKIE_DOMAIN', '.example.com');
      const { syncThemeToCookie } = await import('../theme-cookie');
      syncThemeToCookie('light');
      expect(document.cookie).toContain('domain=.example.com');
      vi.unstubAllEnvs();
    });
  });

  describe('getThemeFromCookie', () => {
    it('should return theme value from cookie', async () => {
      vi.stubEnv('NEXT_PUBLIC_COOKIE_DOMAIN', '');
      const { getThemeFromCookie } = await import('../theme-cookie');
      Object.defineProperty(document, 'cookie', {
        writable: true,
        value: 'theme=dark; other=value',
      });
      expect(getThemeFromCookie()).toBe('dark');
      vi.unstubAllEnvs();
    });

    it('should return null when theme cookie is not set', async () => {
      vi.stubEnv('NEXT_PUBLIC_COOKIE_DOMAIN', '');
      const { getThemeFromCookie } = await import('../theme-cookie');
      Object.defineProperty(document, 'cookie', {
        writable: true,
        value: 'other=value',
      });
      expect(getThemeFromCookie()).toBeNull();
      vi.unstubAllEnvs();
    });

    it('should return null for empty cookies', async () => {
      vi.stubEnv('NEXT_PUBLIC_COOKIE_DOMAIN', '');
      const { getThemeFromCookie } = await import('../theme-cookie');
      Object.defineProperty(document, 'cookie', {
        writable: true,
        value: '',
      });
      expect(getThemeFromCookie()).toBeNull();
      vi.unstubAllEnvs();
    });
  });
});
