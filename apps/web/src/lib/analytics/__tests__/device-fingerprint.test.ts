import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── device-fingerprint.ts tests ───────────────────────────────────────────────
// The module tests browser-environment functions. We use jsdom (vitest's default
// environment) but still need to manage globals carefully.

describe('device-fingerprint', () => {
  let originalWindow: typeof globalThis.window;

  beforeEach(() => {
    vi.resetModules();
    // Ensure localStorage is clean
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  // ── generateBrowserFingerprint ────────────────────────────────────────────

  describe('generateBrowserFingerprint', () => {
    it('should return a string starting with web_', async () => {
      const { generateBrowserFingerprint } = await import('../device-fingerprint');
      const result = generateBrowserFingerprint();
      expect(result).toMatch(/^web_/);
    });

    it('should return a consistent fingerprint for same browser state', async () => {
      const { generateBrowserFingerprint } = await import('../device-fingerprint');
      const first = generateBrowserFingerprint();
      const second = generateBrowserFingerprint();
      expect(first).toBe(second);
    });

    it('should return server-side-render when window is undefined', async () => {
      // Temporarily hide window
      const originalWindow = globalThis.window;
      // @ts-expect-error - testing SSR scenario
      delete globalThis.window;

      const { generateBrowserFingerprint } = await import('../device-fingerprint?ssr1');
      const result = generateBrowserFingerprint();
      expect(result).toBe('server-side-render');

      globalThis.window = originalWindow;
    });

    it('should include hash in base36 format', async () => {
      const { generateBrowserFingerprint } = await import('../device-fingerprint');
      const result = generateBrowserFingerprint();
      // Remove the 'web_' prefix and check remaining is base36
      const hash = result.replace(/^web_/, '');
      expect(hash).toMatch(/^[0-9a-z]+$/);
    });
  });

  // ── getOrCreateDeviceId ───────────────────────────────────────────────────

  describe('getOrCreateDeviceId', () => {
    it('should return server-side-render when window is undefined', async () => {
      const originalWindow = globalThis.window;
      // @ts-expect-error - testing SSR scenario
      delete globalThis.window;

      const { getOrCreateDeviceId } = await import('../device-fingerprint?ssr2');
      const result = getOrCreateDeviceId();
      expect(result).toBe('server-side-render');

      globalThis.window = originalWindow;
    });

    it('should generate and store a device id in localStorage', async () => {
      const { getOrCreateDeviceId } = await import('../device-fingerprint');
      const deviceId = getOrCreateDeviceId();
      expect(deviceId).toBeTruthy();
      expect(localStorage.getItem('browser_device_id')).toBe(deviceId);
    });

    it('should return existing device id from localStorage', async () => {
      localStorage.setItem('browser_device_id', 'existing_device_id');
      const { getOrCreateDeviceId } = await import('../device-fingerprint');
      const result = getOrCreateDeviceId();
      expect(result).toBe('existing_device_id');
    });

    it('should return a new fingerprint when localStorage throws on getItem', async () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('localStorage unavailable');
      });

      const { getOrCreateDeviceId } = await import('../device-fingerprint?localstoragefail');
      const result = getOrCreateDeviceId();
      // Should fall back to generating a fingerprint
      expect(result).toMatch(/^web_/);
    });

    it('should still return fingerprint when localStorage setItem throws', async () => {
      vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(null);
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('localStorage full');
      });

      const { getOrCreateDeviceId } = await import('../device-fingerprint?setitemfail');
      const result = getOrCreateDeviceId();
      expect(result).toMatch(/^web_/);
    });
  });

  // ── getDeviceName ─────────────────────────────────────────────────────────

  describe('getDeviceName', () => {
    it('should return Server when window is undefined', async () => {
      const originalWindow = globalThis.window;
      // @ts-expect-error - testing SSR scenario
      delete globalThis.window;

      const { getDeviceName } = await import('../device-fingerprint?ssrname');
      const result = getDeviceName();
      expect(result).toBe('Server');

      globalThis.window = originalWindow;
    });

    it('should detect Firefox browser', async () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/109.0'
      );
      const { getDeviceName } = await import('../device-fingerprint');
      const result = getDeviceName();
      expect(result).toContain('Firefox');
    });

    it('should detect Chrome browser', async () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
      );
      const { getDeviceName } = await import('../device-fingerprint');
      const result = getDeviceName();
      expect(result).toContain('Chrome');
    });

    it('should detect Edge browser', async () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'
      );
      const { getDeviceName } = await import('../device-fingerprint');
      const result = getDeviceName();
      expect(result).toContain('Edge');
    });

    it('should detect Safari browser', async () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/605.1.15 Version/16.0 Safari/605.1.15'
      );
      const { getDeviceName } = await import('../device-fingerprint');
      const result = getDeviceName();
      expect(result).toContain('Safari');
    });

    it('should detect Windows OS', async () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
      );
      const { getDeviceName } = await import('../device-fingerprint');
      const result = getDeviceName();
      expect(result).toContain('Windows');
    });

    it('should detect macOS', async () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
      );
      const { getDeviceName } = await import('../device-fingerprint');
      const result = getDeviceName();
      expect(result).toContain('macOS');
    });

    it('should detect Linux OS', async () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
      );
      const { getDeviceName } = await import('../device-fingerprint');
      const result = getDeviceName();
      expect(result).toContain('Linux');
    });

    it('should return Linux for Android UA (Android contains "Linux" which matches first)', async () => {
      // The getDeviceName() function checks 'Win', 'Mac', 'Linux' before 'Android',
      // so Android UA strings that include 'Linux' will be detected as Linux.
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36'
      );
      const { getDeviceName } = await import('../device-fingerprint');
      const result = getDeviceName();
      // 'Linux' is matched before 'Android' in the source
      expect(result).toContain('Linux');
    });

    it('should return macOS for iOS UA (iPhone UA contains "Mac OS X" which matches first)', async () => {
      // iPhone UA contains 'Mac OS X' so 'Mac' matches before 'iOS'/'iPhone'
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Version/16.0 Mobile/15E148 Safari/604.1'
      );
      const { getDeviceName } = await import('../device-fingerprint');
      const result = getDeviceName();
      expect(result).toContain('macOS');
    });

    it('should return format "Browser on OS"', async () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/109.0'
      );
      const { getDeviceName } = await import('../device-fingerprint');
      const result = getDeviceName();
      expect(result).toMatch(/.+ on .+/);
    });

    it('should return Unknown for unrecognized browser and OS', async () => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('UnknownAgent/1.0');
      const { getDeviceName } = await import('../device-fingerprint');
      const result = getDeviceName();
      expect(result).toContain('Unknown Browser');
      expect(result).toContain('Unknown OS');
    });
  });
});
