/**
 * Index Module Tests
 *
 * Comprehensive test coverage for iOS bridge initialization and exports:
 * - Module exports verification
 * - initializeIOSBridge function
 * - Re-exported Capacitor utilities
 * - Integration tests
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mockStatusBar, mockKeyboardListeners, consoleSpy } from './setup';

// Re-import to get fresh module state for each test
let indexModule: typeof import('../index');

describe('index (iOS bridge entry point)', () => {
  beforeEach(async () => {
    vi.resetModules();

    // Reset DOM state
    document.documentElement.className = '';
    document.body.className = '';

    indexModule = await import('../index');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('module exports', () => {
    describe('auth-bridge exports', () => {
      it('exports getOrCreateDeviceId', () => {
        expect(typeof indexModule.getOrCreateDeviceId).toBe('function');
      });

      it('exports storeSession', () => {
        expect(typeof indexModule.storeSession).toBe('function');
      });

      it('exports getSession', () => {
        expect(typeof indexModule.getSession).toBe('function');
      });

      it('exports getSessionToken', () => {
        expect(typeof indexModule.getSessionToken).toBe('function');
      });

      it('exports clearSession', () => {
        expect(typeof indexModule.clearSession).toBe('function');
      });

      it('exports storeCsrfToken', () => {
        expect(typeof indexModule.storeCsrfToken).toBe('function');
      });

      it('exports getCsrfToken', () => {
        expect(typeof indexModule.getCsrfToken).toBe('function');
      });

      it('exports isAuthenticated', () => {
        expect(typeof indexModule.isAuthenticated).toBe('function');
      });

      it('exports StoredAuthSession type (type export verified by usage)', () => {
        // Type exports are verified at compile time
        // We verify the interface is usable
        const session: indexModule.StoredAuthSession = {
          sessionToken: 'test',
          csrfToken: 'csrf',
          deviceId: 'device',
          deviceToken: 'dt',
        };
        expect(session.sessionToken).toBe('test');
      });
    });

    describe('ui-setup exports', () => {
      it('exports setupIOSUI', () => {
        expect(typeof indexModule.setupIOSUI).toBe('function');
      });

      it('exports setStatusBarStyle', () => {
        expect(typeof indexModule.setStatusBarStyle).toBe('function');
      });

      it('exports cleanupKeyboardListeners', () => {
        expect(typeof indexModule.cleanupKeyboardListeners).toBe('function');
      });
    });

    describe('lifecycle exports', () => {
      it('exports setupAppLifecycle', () => {
        expect(typeof indexModule.setupAppLifecycle).toBe('function');
      });

      it('exports setDeepLinkHandler', () => {
        expect(typeof indexModule.setDeepLinkHandler).toBe('function');
      });

      it('exports hideSplashScreen', () => {
        expect(typeof indexModule.hideSplashScreen).toBe('function');
      });
    });

    describe('capacitor re-exports', () => {
      it('exports Capacitor from @capacitor/core', () => {
        expect(indexModule.Capacitor).toBeDefined();
      });

      it('exports App from @capacitor/app', () => {
        expect(indexModule.App).toBeDefined();
      });

      it('exports Browser from @capacitor/browser', () => {
        expect(indexModule.Browser).toBeDefined();
      });
    });
  });

  describe('initializeIOSBridge', () => {
    describe('happy path', () => {
      it('is exported as a function', () => {
        expect(typeof indexModule.initializeIOSBridge).toBe('function');
      });

      it('returns a Promise', () => {
        const result = indexModule.initializeIOSBridge();
        expect(result).toBeInstanceOf(Promise);
      });

      it('resolves without error', async () => {
        await expect(indexModule.initializeIOSBridge()).resolves.not.toThrow();
      });

      it('calls setupIOSUI', async () => {
        await indexModule.initializeIOSBridge();

        // Verify UI setup occurred by checking status bar was configured
        expect(mockStatusBar.setStyle).toHaveBeenCalled();
      });

      it('calls setupAppLifecycle', async () => {
        await indexModule.initializeIOSBridge();

        // Verify lifecycle setup occurred by checking keyboard listeners exist
        expect(mockKeyboardListeners.size).toBeGreaterThan(0);
      });

      it('adds platform class to document', async () => {
        await indexModule.initializeIOSBridge();

        expect(
          document.documentElement.classList.contains('capacitor-ios')
        ).toBe(true);
      });

      it('logs initialization message', async () => {
        await indexModule.initializeIOSBridge();

        expect(consoleSpy.log).toHaveBeenCalledWith(
          expect.stringContaining('[PageSpace iOS]')
        );
      });
    });

    describe('error handling', () => {
      it('handles UI setup failure gracefully', async () => {
        mockStatusBar.setStyle.mockRejectedValueOnce(new Error('UI Error'));

        // Should not throw - setupIOSUI handles errors internally
        await expect(
          indexModule.initializeIOSBridge()
        ).resolves.not.toThrow();
      });
    });

    describe('idempotency', () => {
      it('can be called multiple times safely', async () => {
        await indexModule.initializeIOSBridge();
        await indexModule.initializeIOSBridge();
        await indexModule.initializeIOSBridge();

        // Should complete without errors
        expect(
          document.documentElement.classList.contains('capacitor-ios')
        ).toBe(true);
      });
    });
  });

  describe('export consistency', () => {
    it('all auth-bridge functions are re-exported', async () => {
      const authBridge = await import('../auth-bridge');

      const authExports = [
        'getOrCreateDeviceId',
        'storeSession',
        'getSession',
        'getSessionToken',
        'clearSession',
        'storeCsrfToken',
        'getCsrfToken',
        'isAuthenticated',
      ];

      for (const exportName of authExports) {
        expect(indexModule[exportName as keyof typeof indexModule]).toBe(
          authBridge[exportName as keyof typeof authBridge]
        );
      }
    });

    it('all ui-setup functions are re-exported', async () => {
      const uiSetup = await import('../ui-setup');

      const uiExports = [
        'setupIOSUI',
        'setStatusBarStyle',
        'cleanupKeyboardListeners',
      ];

      for (const exportName of uiExports) {
        expect(indexModule[exportName as keyof typeof indexModule]).toBe(
          uiSetup[exportName as keyof typeof uiSetup]
        );
      }
    });

    it('all lifecycle functions are re-exported', async () => {
      const lifecycle = await import('../lifecycle');

      const lifecycleExports = [
        'setupAppLifecycle',
        'setDeepLinkHandler',
        'hideSplashScreen',
      ];

      for (const exportName of lifecycleExports) {
        expect(indexModule[exportName as keyof typeof indexModule]).toBe(
          lifecycle[exportName as keyof typeof lifecycle]
        );
      }
    });
  });

  describe('usage patterns', () => {
    it('supports standard initialization flow', async () => {
      // Typical app startup
      await indexModule.initializeIOSBridge();

      // Check authentication
      const isAuth = await indexModule.isAuthenticated();
      expect(typeof isAuth).toBe('boolean');
    });

    it('supports custom deep link handler registration', async () => {
      const handler = vi.fn();

      await indexModule.initializeIOSBridge();
      indexModule.setDeepLinkHandler(handler);

      // Handler should be registered
      expect(handler).not.toHaveBeenCalled(); // Not called until deep link received
    });

    it('supports theme-based status bar changes', async () => {
      await indexModule.initializeIOSBridge();

      // User toggles dark mode
      await indexModule.setStatusBarStyle(true);
      expect(mockStatusBar.setStyle).toHaveBeenCalledWith({ style: 'LIGHT' });

      // User toggles light mode
      await indexModule.setStatusBarStyle(false);
      expect(mockStatusBar.setStyle).toHaveBeenCalledWith({ style: 'DARK' });
    });

    it('supports logout flow', async () => {
      await indexModule.initializeIOSBridge();

      // Store session
      await indexModule.storeSession({
        sessionToken: 'ps_sess_logout_test',
        csrfToken: 'csrf_test',
      });

      // Verify authenticated
      let isAuth = await indexModule.isAuthenticated();
      expect(isAuth).toBe(true);

      // Logout
      await indexModule.clearSession();

      // Verify logged out
      isAuth = await indexModule.isAuthenticated();
      expect(isAuth).toBe(false);
    });
  });

  describe('Capacitor utility re-exports', () => {
    it('Capacitor has isNativePlatform method', () => {
      expect(typeof indexModule.Capacitor.isNativePlatform).toBe('function');
    });

    it('Capacitor has getPlatform method', () => {
      expect(typeof indexModule.Capacitor.getPlatform).toBe('function');
    });

    it('App has addListener method', () => {
      expect(typeof indexModule.App.addListener).toBe('function');
    });

    it('Browser has open method', () => {
      expect(typeof indexModule.Browser.open).toBe('function');
    });
  });
});
