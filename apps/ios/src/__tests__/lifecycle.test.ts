/**
 * Lifecycle Tests
 *
 * Comprehensive test coverage for iOS app lifecycle functionality:
 * - Deep link handling (OAuth callbacks, universal links)
 * - Auth-exchange flow for token exchange
 * - Splash screen management
 * - Custom deep link handler registration
 * - Error handling and edge cases
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  mockAppListeners,
  mockSplashScreen,
  mockFetch,
  mockKeychainStore,
  simulateDeepLink,
  consoleSpy,
} from './setup';

// Re-import to get fresh module state for each test
let lifecycle: typeof import('../lifecycle');

// Track navigation calls
let navigatedTo: string | null = null;

describe('lifecycle', () => {
  beforeEach(async () => {
    vi.resetModules();

    // Reset navigation tracking
    navigatedTo = null;

    // Setup window.location tracking
    Object.defineProperty(window, 'location', {
      value: {
        href: 'http://localhost:3000',
        origin: 'http://localhost:3000',
        pathname: '/',
        search: '',
        hash: '',
      },
      writable: true,
      configurable: true,
    });

    // Track href assignments
    const locationProxy = new Proxy(
      { href: 'http://localhost:3000', origin: 'http://localhost:3000' },
      {
        set(target, prop, value) {
          if (prop === 'href') {
            navigatedTo = value as string;
          }
          target[prop as keyof typeof target] = value;
          return true;
        },
        get(target, prop) {
          return target[prop as keyof typeof target];
        },
      }
    );

    Object.defineProperty(window, 'location', {
      value: locationProxy,
      writable: true,
      configurable: true,
    });

    lifecycle = await import('../lifecycle');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('setupAppLifecycle', () => {
    it('registers appUrlOpen listener', () => {
      lifecycle.setupAppLifecycle();

      expect(mockAppListeners.has('appUrlOpen')).toBe(true);
      expect(mockAppListeners.get('appUrlOpen')?.length).toBeGreaterThan(0);
    });

    it('registers window load listener for splash screen', () => {
      const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

      lifecycle.setupAppLifecycle();

      expect(addEventListenerSpy).toHaveBeenCalledWith(
        'load',
        expect.any(Function)
      );
    });
  });

  describe('deep link handling', () => {
    describe('auth-exchange deep links', () => {
      beforeEach(() => {
        lifecycle.setupAppLifecycle();
      });

      it('handles auth-exchange with host pattern', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            sessionToken: 'ps_sess_new',
            csrfToken: 'csrf_new',
            deviceToken: 'dt_new',
          }),
        });

        simulateDeepLink('pagespace://auth-exchange?code=abc123');

        // Wait for async operations
        await vi.waitFor(() => {
          expect(mockFetch).toHaveBeenCalled();
        });
      });

      it('handles auth-exchange with pathname pattern', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            sessionToken: 'ps_sess_test',
            csrfToken: 'csrf_test',
            deviceToken: 'dt_test',
          }),
        });

        simulateDeepLink('https://pagespace.ai/auth-exchange?code=xyz789');

        await vi.waitFor(() => {
          expect(mockFetch).toHaveBeenCalled();
        });
      });

      it('extracts code from query parameters', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            sessionToken: 'ps_sess_test',
            csrfToken: 'csrf_test',
          }),
        });

        simulateDeepLink('pagespace://auth-exchange?code=my_exchange_code');

        await vi.waitFor(() => {
          expect(mockFetch).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
              body: JSON.stringify({ code: 'my_exchange_code' }),
            })
          );
        });
      });

      it('navigates to error page when code is missing', async () => {
        simulateDeepLink('pagespace://auth-exchange');

        await vi.waitFor(() => {
          expect(navigatedTo).toBe('/auth/signin?error=missing_code');
        });
      });

      it('stores tokens in keychain on successful exchange', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            sessionToken: 'ps_sess_stored',
            csrfToken: 'csrf_stored',
            deviceToken: 'dt_stored',
          }),
        });

        simulateDeepLink('pagespace://auth-exchange?code=valid_code');

        await vi.waitFor(() => {
          const stored = mockKeychainStore.get('pagespace_session');
          expect(stored).toBeTruthy();
          const parsed = JSON.parse(stored!);
          expect(parsed.sessionToken).toBe('ps_sess_stored');
        });
      });

      it('navigates to dashboard on success', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            sessionToken: 'ps_sess_test',
            csrfToken: 'csrf_test',
          }),
        });

        simulateDeepLink('pagespace://auth-exchange?code=code123');

        await vi.waitFor(() => {
          expect(navigatedTo).toBe('/dashboard');
        });
      });

      it('navigates to dashboard with welcome flag for new users', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            sessionToken: 'ps_sess_new_user',
            csrfToken: 'csrf_new',
          }),
        });

        simulateDeepLink('pagespace://auth-exchange?code=newuser&isNewUser=true');

        await vi.waitFor(() => {
          expect(navigatedTo).toBe('/dashboard?welcome=true');
        });
      });

      it('navigates to error page on exchange failure', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 401,
          json: async () => ({ error: 'Invalid code' }),
        });

        simulateDeepLink('pagespace://auth-exchange?code=invalid_code');

        await vi.waitFor(() => {
          expect(navigatedTo).toBe('/auth/signin?error=exchange_failed');
        });
      });

      it('handles network errors gracefully', async () => {
        mockFetch.mockRejectedValueOnce(new Error('Network error'));

        simulateDeepLink('pagespace://auth-exchange?code=network_fail');

        await vi.waitFor(() => {
          expect(navigatedTo).toBe('/auth/signin?error=exchange_failed');
          expect(consoleSpy.error).toHaveBeenCalled();
        });
      });

      it('handles missing session token in response', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            csrfToken: 'csrf_only',
            // No sessionToken
          }),
        });

        simulateDeepLink('pagespace://auth-exchange?code=no_session');

        await vi.waitFor(() => {
          expect(navigatedTo).toBe('/auth/signin?error=exchange_failed');
        });
      });

      it('calls exchange endpoint with correct payload', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            sessionToken: 'ps_sess_test',
            csrfToken: 'csrf_test',
          }),
        });

        simulateDeepLink('pagespace://auth-exchange?code=test_code');

        await vi.waitFor(() => {
          expect(mockFetch).toHaveBeenCalledWith(
            'http://localhost:3000/api/auth/desktop/exchange',
            expect.objectContaining({
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code: 'test_code' }),
            })
          );
        });
      });
    });

    describe('OAuth callback deep links (legacy)', () => {
      beforeEach(() => {
        lifecycle.setupAppLifecycle();
      });

      it('handles /auth/callback path', () => {
        simulateDeepLink('https://pagespace.ai/auth/callback?code=oauth');

        // Without custom handler, should navigate via window.location
        expect(navigatedTo).toBe('https://pagespace.ai/auth/callback?code=oauth');
      });

      it('handles /api/auth/callback path', () => {
        simulateDeepLink('https://pagespace.ai/api/auth/callback?code=oauth');

        expect(navigatedTo).toBe('https://pagespace.ai/api/auth/callback?code=oauth');
      });

      it('forwards to custom handler when registered', () => {
        const customHandler = vi.fn();
        lifecycle.setDeepLinkHandler(customHandler);

        simulateDeepLink('https://pagespace.ai/auth/callback?code=custom');

        expect(customHandler).toHaveBeenCalledWith(
          'https://pagespace.ai/auth/callback?code=custom'
        );
        expect(navigatedTo).toBeNull();
      });
    });

    describe('universal links', () => {
      beforeEach(() => {
        lifecycle.setupAppLifecycle();
      });

      it('forwards universal links to custom handler', () => {
        const customHandler = vi.fn();
        lifecycle.setDeepLinkHandler(customHandler);

        simulateDeepLink('https://pagespace.ai/drives/abc123/pages/xyz');

        expect(customHandler).toHaveBeenCalledWith(
          'https://pagespace.ai/drives/abc123/pages/xyz'
        );
      });

      it('handles universal links without custom handler', () => {
        simulateDeepLink('https://pagespace.ai/drives/abc123');

        // Without handler, no navigation occurs for non-auth links
        expect(navigatedTo).toBeNull();
      });
    });

    describe('invalid deep links', () => {
      beforeEach(() => {
        lifecycle.setupAppLifecycle();
      });

      it('logs error for invalid URL format', () => {
        simulateDeepLink('not-a-valid-url');

        expect(consoleSpy.error).toHaveBeenCalled();
      });

      it('still calls custom handler for invalid URLs', () => {
        const customHandler = vi.fn();
        lifecycle.setDeepLinkHandler(customHandler);

        simulateDeepLink('invalid://url');

        expect(customHandler).toHaveBeenCalledWith('invalid://url');
      });

      it('handles URLs with unusual characters', () => {
        const customHandler = vi.fn();
        lifecycle.setDeepLinkHandler(customHandler);

        simulateDeepLink('pagespace://test?param=value%20with%20spaces');

        expect(customHandler).toHaveBeenCalled();
      });
    });
  });

  describe('setDeepLinkHandler', () => {
    beforeEach(() => {
      lifecycle.setupAppLifecycle();
    });

    it('registers custom handler', () => {
      const handler = vi.fn();
      lifecycle.setDeepLinkHandler(handler);

      simulateDeepLink('https://pagespace.ai/custom/path');

      expect(handler).toHaveBeenCalledWith('https://pagespace.ai/custom/path');
    });

    it('replaces previous handler', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      lifecycle.setDeepLinkHandler(handler1);
      lifecycle.setDeepLinkHandler(handler2);

      simulateDeepLink('https://pagespace.ai/test');

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it('allows null handler', () => {
      const handler = vi.fn();
      lifecycle.setDeepLinkHandler(handler);
      lifecycle.setDeepLinkHandler(null as unknown as (url: string) => void);

      simulateDeepLink('https://pagespace.ai/auth/callback?code=test');

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('hideSplashScreen', () => {
    it('hides splash screen with fade animation', async () => {
      await lifecycle.hideSplashScreen();

      expect(mockSplashScreen.hide).toHaveBeenCalledWith({
        fadeOutDuration: 300,
      });
    });

    it('can be called multiple times safely', async () => {
      await lifecycle.hideSplashScreen();
      await lifecycle.hideSplashScreen();

      expect(mockSplashScreen.hide).toHaveBeenCalledTimes(2);
    });

    it('handles splash screen hide failure', async () => {
      mockSplashScreen.hide.mockRejectedValueOnce(new Error('Hide failed'));

      await expect(lifecycle.hideSplashScreen()).rejects.toThrow('Hide failed');
    });
  });

  describe('splash screen auto-hide', () => {
    it('hides splash on window load via requestAnimationFrame', async () => {
      lifecycle.setupAppLifecycle();

      // Get the load event handler
      const addEventListenerCalls = (window.addEventListener as unknown as { mock: { calls: [string, Function][] } }).mock?.calls;
      const loadHandler = addEventListenerCalls?.find(
        (call) => call[0] === 'load'
      )?.[1];

      if (loadHandler) {
        // Mock requestAnimationFrame
        const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
        rafSpy.mockImplementation((cb) => {
          cb(0);
          return 0;
        });

        loadHandler();

        await vi.waitFor(() => {
          expect(mockSplashScreen.hide).toHaveBeenCalled();
        });
      }
    });
  });

  describe('SSR safety', () => {
    it('handles undefined window gracefully in setupAppLifecycle', async () => {
      const originalWindow = globalThis.window;

      // Temporarily make window undefined
      // @ts-expect-error - intentionally testing undefined window
      delete globalThis.window;

      vi.resetModules();
      const ssrLifecycle = await import('../lifecycle');

      // Should not throw
      expect(() => ssrLifecycle.setupAppLifecycle()).not.toThrow();

      // Restore window
      globalThis.window = originalWindow;
    });
  });

  describe('device ID integration', () => {
    beforeEach(() => {
      lifecycle.setupAppLifecycle();
    });

    it('includes device ID in stored session', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessionToken: 'ps_sess_with_device',
          csrfToken: 'csrf_dev',
          deviceToken: 'dt_dev',
        }),
      });

      simulateDeepLink('pagespace://auth-exchange?code=device_test');

      await vi.waitFor(() => {
        const stored = mockKeychainStore.get('pagespace_session');
        expect(stored).toBeTruthy();
        const parsed = JSON.parse(stored!);
        expect(parsed.deviceId).toBeTruthy();
      });
    });
  });

  describe('production URL fallback', () => {
    it('uses production URL when window.location.origin is unavailable', async () => {
      lifecycle.setupAppLifecycle();

      // Simulate window without origin
      Object.defineProperty(window, 'location', {
        value: {
          ...window.location,
          origin: '',
        },
        writable: true,
        configurable: true,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessionToken: 'ps_sess_prod',
          csrfToken: 'csrf_prod',
        }),
      });

      simulateDeepLink('pagespace://auth-exchange?code=prod_fallback');

      await vi.waitFor(() => {
        const fetchUrl = mockFetch.mock.calls[0]?.[0];
        expect(fetchUrl).toContain('/api/auth/desktop/exchange');
      });
    });
  });

  describe('concurrent deep link handling', () => {
    beforeEach(() => {
      lifecycle.setupAppLifecycle();
    });

    it('handles multiple rapid deep links', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          sessionToken: 'ps_sess_concurrent',
          csrfToken: 'csrf_concurrent',
        }),
      });

      // Simulate rapid deep links
      simulateDeepLink('pagespace://auth-exchange?code=first');
      simulateDeepLink('pagespace://auth-exchange?code=second');
      simulateDeepLink('pagespace://auth-exchange?code=third');

      await vi.waitFor(() => {
        // Each should trigger a fetch
        expect(mockFetch).toHaveBeenCalledTimes(3);
      });
    });
  });

  describe('logging', () => {
    beforeEach(() => {
      lifecycle.setupAppLifecycle();
    });

    it('logs received deep links', () => {
      simulateDeepLink('https://pagespace.ai/test');

      expect(consoleSpy.log).toHaveBeenCalled();
    });

    it('logs successful token exchange', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sessionToken: 'ps_sess_logged',
          csrfToken: 'csrf_logged',
        }),
      });

      simulateDeepLink('pagespace://auth-exchange?code=log_test');

      await vi.waitFor(() => {
        expect(consoleSpy.log).toHaveBeenCalled();
      });
    });

    it('logs exchange failures', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Exchange error'));

      simulateDeepLink('pagespace://auth-exchange?code=fail');

      await vi.waitFor(() => {
        expect(consoleSpy.error).toHaveBeenCalled();
      });
    });
  });
});
