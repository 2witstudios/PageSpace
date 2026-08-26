/**
 * Capacitor Bridge Tests
 *
 * Comprehensive test coverage for platform detection utilities:
 * - isCapacitorApp detection
 * - getPlatform function
 * - Platform-specific checks (isIOS, isAndroid, isNativeApp)
 * - Capability detection (hasNativeCapability, getNativeCapabilities)
 * - Native auth provider support (Apple is iOS-only)
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

/**
 * Set the reported screen size.
 *
 * jsdom's default (1024x768) already reads as a tablet, so any isIPad test must
 * state the size it means rather than inherit it. `restoreScreenSize` in
 * afterEach puts the default back so a later test cannot depend on where it
 * happens to sit in the file.
 */
function setScreenSize(width: number, height: number): void {
  Object.defineProperty(window.screen, 'width', { value: width, configurable: true });
  Object.defineProperty(window.screen, 'height', { value: height, configurable: true });
}

const DEFAULT_SCREEN = { width: window.screen.width, height: window.screen.height };

function restoreScreenSize(): void {
  setScreenSize(DEFAULT_SCREEN.width, DEFAULT_SCREEN.height);
}

/**
 * Run `fn` with `globalThis.window` removed, then restore it in a `finally`.
 *
 * The restore has to be unconditional: if an assertion or a dynamic import
 * throws while window is missing, an inline restore never runs and every later
 * test in the file inherits a leaked SSR global.
 */
async function withoutWindow(fn: () => Promise<void> | void): Promise<void> {
  const windowBackup = globalThis.window;
  // @ts-expect-error - intentionally testing undefined window
  delete globalThis.window;
  try {
    await fn();
  } finally {
    globalThis.window = windowBackup;
  }
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
    restoreScreenSize();
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
        await withoutWindow(async () => {

          vi.resetModules();
          capacitorBridge = await import('../capacitor-bridge');

          expect(capacitorBridge.isCapacitorApp()).toBe(false);

        });
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
        await withoutWindow(async () => {

          vi.resetModules();
          capacitorBridge = await import('../capacitor-bridge');

          expect(capacitorBridge.getPlatform()).toBe('web');

        });
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
      await withoutWindow(async () => {

        vi.resetModules();
        capacitorBridge = await import('../capacitor-bridge');

        expect(() => capacitorBridge.injectPlatformInfo()).not.toThrow();

      });
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

  describe('isAndroid', () => {
    it('returns true for Android platform', async () => {
      setupCapacitorMock(true, 'android');
      vi.resetModules();
      capacitorBridge = await import('../capacitor-bridge');

      expect(capacitorBridge.isAndroid()).toBe(true);
    });

    it('returns false for iOS platform', async () => {
      setupCapacitorMock(true, 'ios');
      vi.resetModules();
      capacitorBridge = await import('../capacitor-bridge');

      expect(capacitorBridge.isAndroid()).toBe(false);
    });

    it('returns false for web platform', () => {
      removeCapacitorMock();

      expect(capacitorBridge.isAndroid()).toBe(false);
    });

    it('returns false when window is undefined', async () => {
      await withoutWindow(async () => {

        vi.resetModules();
        capacitorBridge = await import('../capacitor-bridge');

        expect(capacitorBridge.isAndroid()).toBe(false);

      });
    });
  });

  describe('isIPad', () => {
    it('is true for iOS with a tablet-sized screen', async () => {
      setupCapacitorMock(true, 'ios');
      setScreenSize(834, 1194); // iPad Air
      vi.resetModules();
      capacitorBridge = await import('../capacitor-bridge');

      expect(capacitorBridge.isIPad()).toBe(true);
    });

    it('is true at exactly the 768px threshold', async () => {
      setupCapacitorMock(true, 'ios');
      setScreenSize(768, 1024); // original iPad
      vi.resetModules();
      capacitorBridge = await import('../capacitor-bridge');

      expect(capacitorBridge.isIPad()).toBe(true);
    });

    it('is false for iOS on a phone-sized screen', async () => {
      setupCapacitorMock(true, 'ios');
      setScreenSize(390, 844); // iPhone 14
      vi.resetModules();
      capacitorBridge = await import('../capacitor-bridge');

      expect(capacitorBridge.isIPad()).toBe(false);
    });

    it('is false one pixel below the threshold', async () => {
      setupCapacitorMock(true, 'ios');
      setScreenSize(767, 1024);
      vi.resetModules();
      capacitorBridge = await import('../capacitor-bridge');

      expect(capacitorBridge.isIPad()).toBe(false);
    });

    it('is false for an Android tablet — the heuristic is iOS-only', async () => {
      setupCapacitorMock(true, 'android');
      setScreenSize(800, 1280);
      vi.resetModules();
      capacitorBridge = await import('../capacitor-bridge');

      expect(capacitorBridge.isIPad()).toBe(false);
    });

    it('is false in a browser tab, however large the screen', async () => {
      removeCapacitorMock();
      setScreenSize(1440, 2560);
      vi.resetModules();
      capacitorBridge = await import('../capacitor-bridge');

      expect(capacitorBridge.isIPad()).toBe(false);
    });

    it('does not touch window.screen during SSR', async () => {
      await withoutWindow(async () => {

        vi.resetModules();
        capacitorBridge = await import('../capacitor-bridge');

        expect(() => capacitorBridge.isIPad()).not.toThrow();
        expect(capacitorBridge.isIPad()).toBe(false);

      });
    });
  });

  describe('isNativeApp', () => {
    it('returns true for iOS platform', async () => {
      setupCapacitorMock(true, 'ios');
      vi.resetModules();
      capacitorBridge = await import('../capacitor-bridge');

      expect(capacitorBridge.isNativeApp()).toBe(true);
    });

    it('returns true for Android platform', async () => {
      setupCapacitorMock(true, 'android');
      vi.resetModules();
      capacitorBridge = await import('../capacitor-bridge');

      expect(capacitorBridge.isNativeApp()).toBe(true);
    });

    it('returns false in a browser tab', () => {
      removeCapacitorMock();

      expect(capacitorBridge.isNativeApp()).toBe(false);
    });

    it('returns false when Capacitor is present but not native', async () => {
      setupCapacitorMock(false, 'web');
      vi.resetModules();
      capacitorBridge = await import('../capacitor-bridge');

      expect(capacitorBridge.isNativeApp()).toBe(false);
    });

    it('returns false during SSR when window is undefined', async () => {
      await withoutWindow(async () => {

        vi.resetModules();
        capacitorBridge = await import('../capacitor-bridge');

        expect(capacitorBridge.isNativeApp()).toBe(false);

      });
    });

    it('stays true on a native platform we have no capability row for', async () => {
      // isNativeApp reflects the shell, not the capability-table key. A future
      // Capacitor target is still a native app; it just has no capabilities.
      setupCapacitorMock(true, 'windows');
      vi.resetModules();
      capacitorBridge = await import('../capacitor-bridge');

      expect(capacitorBridge.isNativeApp()).toBe(true);
      expect(capacitorBridge.getPlatform()).toBe('web');
      expect(capacitorBridge.hasNativeCapability('push')).toBe(false);
    });
  });

  describe('hasNativeCapability', () => {
    // The capability truth table this module encodes. Each row is asserted
    // exhaustively so a wrong flag anywhere fails a named test.
    const TRUTH_TABLE = {
      ios: { secureStore: true, nativeAuth: true, push: true, badge: true },
      android: { secureStore: true, nativeAuth: true, push: true, badge: false },
      web: { secureStore: false, nativeAuth: false, push: false, badge: false },
    } as const;

    const CAPABILITIES = [
      'secureStore',
      'nativeAuth',
      'push',
      'badge',
    ] as const;

    describe('on iOS', () => {
      for (const capability of CAPABILITIES) {
        const expected = TRUTH_TABLE.ios[capability];
        it(`reports ${capability} as ${expected}`, async () => {
          setupCapacitorMock(true, 'ios');
          vi.resetModules();
          capacitorBridge = await import('../capacitor-bridge');

          expect(capacitorBridge.hasNativeCapability(capability)).toBe(expected);
        });
      }
    });

    describe('on Android', () => {
      for (const capability of CAPABILITIES) {
        const expected = TRUTH_TABLE.android[capability];
        it(`reports ${capability} as ${expected}`, async () => {
          setupCapacitorMock(true, 'android');
          vi.resetModules();
          capacitorBridge = await import('../capacitor-bridge');

          expect(capacitorBridge.hasNativeCapability(capability)).toBe(expected);
        });
      }
    });

    describe('in a browser tab', () => {
      for (const capability of CAPABILITIES) {
        it(`reports ${capability} as unsupported`, () => {
          removeCapacitorMock();

          expect(capacitorBridge.hasNativeCapability(capability)).toBe(false);
        });
      }
    });

    describe('SSR safety', () => {
      it('reports every capability unsupported without throwing when window is undefined', async () => {
        await withoutWindow(async () => {

          vi.resetModules();
          capacitorBridge = await import('../capacitor-bridge');

          for (const capability of CAPABILITIES) {
            expect(() =>
              capacitorBridge.hasNativeCapability(capability)
            ).not.toThrow();
            expect(capacitorBridge.hasNativeCapability(capability)).toBe(false);
          }

        });
      });
    });

    it('reports unsupported for an unrecognised native platform', async () => {
      // A Capacitor shell reporting a platform we have no row for must not
      // throw or claim capabilities it cannot deliver.
      setupCapacitorMock(true, 'windows');
      vi.resetModules();
      capacitorBridge = await import('../capacitor-bridge');

      for (const capability of CAPABILITIES) {
        expect(() =>
          capacitorBridge.hasNativeCapability(capability)
        ).not.toThrow();
        expect(capacitorBridge.hasNativeCapability(capability)).toBe(false);
      }
    });
  });

  describe('getNativeCapabilities', () => {
    it('returns the full iOS capability set', async () => {
      setupCapacitorMock(true, 'ios');
      vi.resetModules();
      capacitorBridge = await import('../capacitor-bridge');

      expect(capacitorBridge.getNativeCapabilities()).toEqual({
        secureStore: true,
        nativeAuth: true,
        push: true,
        badge: true,
      });
    });

    it('returns the full Android capability set with badge unsupported', async () => {
      setupCapacitorMock(true, 'android');
      vi.resetModules();
      capacitorBridge = await import('../capacitor-bridge');

      expect(capacitorBridge.getNativeCapabilities()).toEqual({
        secureStore: true,
        nativeAuth: true,
        push: true,
        badge: false,
      });
    });

    it('returns everything unsupported on web', () => {
      removeCapacitorMock();

      expect(capacitorBridge.getNativeCapabilities()).toEqual({
        secureStore: false,
        nativeAuth: false,
        push: false,
        badge: false,
      });
    });

    it('returns a frozen table entry callers cannot corrupt', async () => {
      setupCapacitorMock(true, 'android');
      vi.resetModules();
      capacitorBridge = await import('../capacitor-bridge');

      const capabilities = capacitorBridge.getNativeCapabilities();
      expect(Object.isFrozen(capabilities)).toBe(true);

      // Silently ignored in sloppy mode; the point is the table is unchanged.
      try {
        (capabilities as { badge: boolean }).badge = true;
      } catch {
        // strict-mode TypeError is equally acceptable
      }

      expect(capacitorBridge.getNativeCapabilities().badge).toBe(false);
    });
  });

  describe('supportsNativeAuthProvider', () => {
    it('supports Google natively on iOS', async () => {
      setupCapacitorMock(true, 'ios');
      vi.resetModules();
      capacitorBridge = await import('../capacitor-bridge');

      expect(capacitorBridge.supportsNativeAuthProvider('google')).toBe(true);
    });

    it('supports Apple natively on iOS', async () => {
      setupCapacitorMock(true, 'ios');
      vi.resetModules();
      capacitorBridge = await import('../capacitor-bridge');

      expect(capacitorBridge.supportsNativeAuthProvider('apple')).toBe(true);
    });

    it('supports Google natively on Android', async () => {
      setupCapacitorMock(true, 'android');
      vi.resetModules();
      capacitorBridge = await import('../capacitor-bridge');

      expect(capacitorBridge.supportsNativeAuthProvider('google')).toBe(true);
    });

    it('does NOT support Apple natively on Android (web flow only)', async () => {
      // There is no native Android SDK for Sign in with Apple. Modelling
      // nativeAuth as one boolean would get this wrong.
      setupCapacitorMock(true, 'android');
      vi.resetModules();
      capacitorBridge = await import('../capacitor-bridge');

      expect(capacitorBridge.hasNativeCapability('nativeAuth')).toBe(true);
      expect(capacitorBridge.supportsNativeAuthProvider('apple')).toBe(false);
    });

    it('supports no provider in a browser tab', () => {
      removeCapacitorMock();

      expect(capacitorBridge.supportsNativeAuthProvider('google')).toBe(false);
      expect(capacitorBridge.supportsNativeAuthProvider('apple')).toBe(false);
    });

    it('supports no provider during SSR without throwing', async () => {
      await withoutWindow(async () => {

        vi.resetModules();
        capacitorBridge = await import('../capacitor-bridge');

        expect(() =>
          capacitorBridge.supportsNativeAuthProvider('google')
        ).not.toThrow();
        expect(capacitorBridge.supportsNativeAuthProvider('google')).toBe(false);

      });
    });

    it('supports no provider on an unrecognised native platform', async () => {
      setupCapacitorMock(true, 'windows');
      vi.resetModules();
      capacitorBridge = await import('../capacitor-bridge');

      expect(() =>
        capacitorBridge.supportsNativeAuthProvider('google')
      ).not.toThrow();
      expect(capacitorBridge.supportsNativeAuthProvider('google')).toBe(false);
    });
  });

  describe('capability consumers', () => {
    it('needs no call-site change when a platform gains a capability', async () => {
      // Consumers ask hasNativeCapability('badge'); they never name a platform.
      // Adding badge support to Android is a one-line table edit, and this
      // simulated consumer picks it up unchanged.
      const consumer = (
        bridge: typeof import('../capacitor-bridge')
      ): string => (bridge.hasNativeCapability('badge') ? 'sync' : 'skip');

      setupCapacitorMock(true, 'android');
      vi.resetModules();
      capacitorBridge = await import('../capacitor-bridge');
      expect(consumer(capacitorBridge)).toBe('skip');

      setupCapacitorMock(true, 'ios');
      vi.resetModules();
      capacitorBridge = await import('../capacitor-bridge');
      expect(consumer(capacitorBridge)).toBe('sync');
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
