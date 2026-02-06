/**
 * Capacitor Bridge Tests
 *
 * Comprehensive test coverage for platform detection utilities:
 * - isCapacitorApp detection
 * - getPlatform function
 * - Platform-specific checks (isIOS)
 * - Platform info injection
 * - SSR safety
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock Capacitor global
interface MockCapacitor {
  isNativePlatform: () => boolean;
  getPlatform: () => string;
}

function setupCapacitorMock(
  isNative: boolean,
  platform: string = 'ios'
): MockCapacitor {
  const mock: MockCapacitor = {
    isNativePlatform: vi.fn(() => isNative),
    getPlatform: vi.fn(() => platform),
  };

  (window as Window & { Capacitor?: MockCapacitor }).Capacitor = mock;
  return mock;
}

function removeCapacitorMock(): void {
  delete (window as Window & { Capacitor?: MockCapacitor }).Capacitor;
}

describe('capacitor-bridge', () => {
  let capacitorBridge: typeof import('../capacitor-bridge');

  beforeEach(async () => {
    vi.resetModules();

    // Reset window state
    delete (window as Window & { __PAGESPACE_PLATFORM__?: string })
      .__PAGESPACE_PLATFORM__;
    removeCapacitorMock();

    capacitorBridge = await import('../capacitor-bridge');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    removeCapacitorMock();
  });

  describe('isCapacitorApp', () => {
    describe('when running in native Capacitor app', () => {
      it('returns true for iOS native app', async () => {
        setupCapacitorMock(true, 'ios');
        vi.resetModules();
        capacitorBridge = await import('../capacitor-bridge');

        expect(capacitorBridge.isCapacitorApp()).toBe(true);
      });

      it('returns true for Android native app', async () => {
        setupCapacitorMock(true, 'android');
        vi.resetModules();
        capacitorBridge = await import('../capacitor-bridge');

        expect(capacitorBridge.isCapacitorApp()).toBe(true);
      });
    });

    describe('when running in web browser', () => {
      it('returns false when Capacitor is not defined', () => {
        removeCapacitorMock();

        expect(capacitorBridge.isCapacitorApp()).toBe(false);
      });

      it('returns false when Capacitor.isNativePlatform returns false', async () => {
        setupCapacitorMock(false, 'web');
        vi.resetModules();
        capacitorBridge = await import('../capacitor-bridge');

        expect(capacitorBridge.isCapacitorApp()).toBe(false);
      });

      it('returns false when isNativePlatform is undefined', async () => {
        (window as Window & { Capacitor?: Partial<MockCapacitor> }).Capacitor = {
          getPlatform: vi.fn(() => 'web'),
        };
        vi.resetModules();
        capacitorBridge = await import('../capacitor-bridge');

        expect(capacitorBridge.isCapacitorApp()).toBe(false);
      });
    });

    describe('SSR safety', () => {
      it('returns false when window is undefined', async () => {
        const windowBackup = globalThis.window;
        // @ts-expect-error - intentionally testing undefined window
        delete globalThis.window;

        vi.resetModules();
        capacitorBridge = await import('../capacitor-bridge');

        expect(capacitorBridge.isCapacitorApp()).toBe(false);

        globalThis.window = windowBackup;
      });
    });
  });

  describe('getPlatform', () => {
    describe('when running in native Capacitor app', () => {
      it('returns ios for iOS app', async () => {
        setupCapacitorMock(true, 'ios');
        vi.resetModules();
        capacitorBridge = await import('../capacitor-bridge');

        expect(capacitorBridge.getPlatform()).toBe('ios');
      });

      it('returns android for Android app', async () => {
        setupCapacitorMock(true, 'android');
        vi.resetModules();
        capacitorBridge = await import('../capacitor-bridge');

        expect(capacitorBridge.getPlatform()).toBe('android');
      });
    });

    describe('when running in web browser', () => {
      it('returns web when Capacitor is not defined', () => {
        removeCapacitorMock();

        expect(capacitorBridge.getPlatform()).toBe('web');
      });

      it('returns web when not native platform', async () => {
        setupCapacitorMock(false, 'web');
        vi.resetModules();
        capacitorBridge = await import('../capacitor-bridge');

        expect(capacitorBridge.getPlatform()).toBe('web');
      });

      it('returns web when getPlatform returns undefined', async () => {
        const mock = setupCapacitorMock(true, 'ios');
        mock.getPlatform = vi.fn(() => undefined as unknown as string);
        vi.resetModules();
        capacitorBridge = await import('../capacitor-bridge');

        expect(capacitorBridge.getPlatform()).toBe('web');
      });
    });

    describe('SSR safety', () => {
      it('returns web when window is undefined', async () => {
        const windowBackup = globalThis.window;
        // @ts-expect-error - intentionally testing undefined window
        delete globalThis.window;

        vi.resetModules();
        capacitorBridge = await import('../capacitor-bridge');

        expect(capacitorBridge.getPlatform()).toBe('web');

        globalThis.window = windowBackup;
      });
    });
  });

  describe('isIOS', () => {
    it('returns true for iOS platform', async () => {
      setupCapacitorMock(true, 'ios');
      vi.resetModules();
      capacitorBridge = await import('../capacitor-bridge');

      expect(capacitorBridge.isIOS()).toBe(true);
    });

    it('returns false for Android platform', async () => {
      setupCapacitorMock(true, 'android');
      vi.resetModules();
      capacitorBridge = await import('../capacitor-bridge');

      expect(capacitorBridge.isIOS()).toBe(false);
    });

    it('returns false for web platform', () => {
      removeCapacitorMock();

      expect(capacitorBridge.isIOS()).toBe(false);
    });
  });

  describe('injectPlatformInfo', () => {
    it('sets __PAGESPACE_PLATFORM__ on window', async () => {
      setupCapacitorMock(true, 'ios');
      vi.resetModules();
      capacitorBridge = await import('../capacitor-bridge');

      capacitorBridge.injectPlatformInfo();

      expect(
        (window as Window & { __PAGESPACE_PLATFORM__?: string })
          .__PAGESPACE_PLATFORM__
      ).toBe('ios');
    });

    it('sets platform to web when not native', () => {
      removeCapacitorMock();

      capacitorBridge.injectPlatformInfo();

      expect(
        (window as Window & { __PAGESPACE_PLATFORM__?: string })
          .__PAGESPACE_PLATFORM__
      ).toBe('web');
    });

    it('does not throw when window is undefined', async () => {
      const windowBackup = globalThis.window;
      // @ts-expect-error - intentionally testing undefined window
      delete globalThis.window;

      vi.resetModules();
      capacitorBridge = await import('../capacitor-bridge');

      expect(() => capacitorBridge.injectPlatformInfo()).not.toThrow();

      globalThis.window = windowBackup;
    });
  });

  describe('module initialization', () => {
    it('automatically injects platform info on import', async () => {
      setupCapacitorMock(true, 'android');
      vi.resetModules();

      // Import triggers module-level code
      await import('../capacitor-bridge');

      expect(
        (window as Window & { __PAGESPACE_PLATFORM__?: string })
          .__PAGESPACE_PLATFORM__
      ).toBe('android');
    });
  });

  describe('edge cases', () => {
    it('handles Capacitor object with no methods', async () => {
      (window as Window & { Capacitor?: object }).Capacitor = {};
      vi.resetModules();
      capacitorBridge = await import('../capacitor-bridge');

      expect(capacitorBridge.isCapacitorApp()).toBe(false);
      expect(capacitorBridge.getPlatform()).toBe('web');
    });

    it('coerces truthy non-boolean from isNativePlatform to true', async () => {
      // The Capacitor global is injected by the native shell and its type shape
      // is not guaranteed. Our bridge uses Boolean() coercion intentionally so
      // that any truthy return value (string, number, object) is treated as
      // "running in native context". This is defensive API design, not a bug.
      (window as Window & { Capacitor?: { isNativePlatform: () => unknown } })
        .Capacitor = {
        isNativePlatform: () => 'yes' as unknown,
      };
      vi.resetModules();
      capacitorBridge = await import('../capacitor-bridge');

      expect(capacitorBridge.isCapacitorApp()).toBe(true);
    });

    it('handles concurrent platform checks', async () => {
      setupCapacitorMock(true, 'ios');
      vi.resetModules();
      capacitorBridge = await import('../capacitor-bridge');

      const results = await Promise.all([
        Promise.resolve(capacitorBridge.isCapacitorApp()),
        Promise.resolve(capacitorBridge.getPlatform()),
        Promise.resolve(capacitorBridge.isIOS()),
      ]);

      expect(results).toEqual([true, 'ios', true]);
    });
  });

  describe('type definitions', () => {
    it('returns correct Platform type', async () => {
      setupCapacitorMock(true, 'ios');
      vi.resetModules();
      capacitorBridge = await import('../capacitor-bridge');

      const platform = capacitorBridge.getPlatform();

      // TypeScript should infer this as Platform type
      expect(['ios', 'android', 'web']).toContain(platform);
    });
  });
});
