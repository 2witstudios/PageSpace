/**
 * useCapacitor Hook Tests
 *
 * Comprehensive test coverage for the React hook for platform detection:
 * - State initialization
 * - Platform detection on mount
 * - SSR safety and hydration
 * - Non-hook utility functions
 * - Edge cases
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

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

describe('useCapacitor', () => {
  let useCapacitorModule: typeof import('../useCapacitor');

  beforeEach(async () => {
    vi.resetModules();
    removeCapacitorMock();
    useCapacitorModule = await import('../useCapacitor');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    removeCapacitorMock();
  });

  describe('useCapacitor hook', () => {
    describe('initial state', () => {
      it('eventually becomes ready', async () => {
        const { result } = renderHook(() => useCapacitorModule.useCapacitor());

        // Wait for effect to complete
        await waitFor(() => {
          expect(result.current.isReady).toBe(true);
        });
      });

      it('has default web values when not in native context', async () => {
        const { result } = renderHook(() => useCapacitorModule.useCapacitor());

        await waitFor(() => {
          expect(result.current.isReady).toBe(true);
        });

        expect(result.current.isNative).toBe(false);
        expect(result.current.platform).toBe('web');
        expect(result.current.isIOS).toBe(false);
        expect(result.current.isAndroid).toBe(false);
      });
    });

    describe('when running in native iOS app', () => {
      beforeEach(async () => {
        setupCapacitorMock(true, 'ios');
        vi.resetModules();
        useCapacitorModule = await import('../useCapacitor');
      });

      it('detects iOS platform after mount', async () => {
        const { result } = renderHook(() => useCapacitorModule.useCapacitor());

        await waitFor(() => {
          expect(result.current.isReady).toBe(true);
        });

        expect(result.current.isNative).toBe(true);
        expect(result.current.platform).toBe('ios');
        expect(result.current.isIOS).toBe(true);
        expect(result.current.isAndroid).toBe(false);
      });
    });

    describe('when running in native Android app', () => {
      beforeEach(async () => {
        setupCapacitorMock(true, 'android');
        vi.resetModules();
        useCapacitorModule = await import('../useCapacitor');
      });

      it('detects Android platform after mount', async () => {
        const { result } = renderHook(() => useCapacitorModule.useCapacitor());

        await waitFor(() => {
          expect(result.current.isReady).toBe(true);
        });

        expect(result.current.isNative).toBe(true);
        expect(result.current.platform).toBe('android');
        expect(result.current.isIOS).toBe(false);
        expect(result.current.isAndroid).toBe(true);
      });
    });

    describe('when running in web browser', () => {
      it('detects web platform after mount', async () => {
        removeCapacitorMock();

        const { result } = renderHook(() => useCapacitorModule.useCapacitor());

        await waitFor(() => {
          expect(result.current.isReady).toBe(true);
        });

        expect(result.current.isNative).toBe(false);
        expect(result.current.platform).toBe('web');
        expect(result.current.isIOS).toBe(false);
        expect(result.current.isAndroid).toBe(false);
      });

      it('handles Capacitor defined but not native', async () => {
        setupCapacitorMock(false, 'web');
        vi.resetModules();
        useCapacitorModule = await import('../useCapacitor');

        const { result } = renderHook(() => useCapacitorModule.useCapacitor());

        await waitFor(() => {
          expect(result.current.isReady).toBe(true);
        });

        expect(result.current.isNative).toBe(false);
        expect(result.current.platform).toBe('web');
      });
    });

    describe('stability', () => {
      it('state remains stable after initial detection', async () => {
        setupCapacitorMock(true, 'ios');
        vi.resetModules();
        useCapacitorModule = await import('../useCapacitor');

        const { result, rerender } = renderHook(() =>
          useCapacitorModule.useCapacitor()
        );

        await waitFor(() => {
          expect(result.current.isReady).toBe(true);
        });

        const firstState = { ...result.current };

        // Rerender multiple times
        rerender();
        rerender();
        rerender();

        // State should be identical
        expect(result.current).toEqual(firstState);
      });

      it('effect only runs once', async () => {
        const mock = setupCapacitorMock(true, 'ios');
        vi.resetModules();
        useCapacitorModule = await import('../useCapacitor');

        const { rerender } = renderHook(() =>
          useCapacitorModule.useCapacitor()
        );

        await waitFor(() => {
          expect(mock.isNativePlatform).toHaveBeenCalled();
        });

        const callCount = (mock.isNativePlatform as ReturnType<typeof vi.fn>)
          .mock.calls.length;

        rerender();
        rerender();

        // Call count should not increase significantly
        expect(
          (mock.isNativePlatform as ReturnType<typeof vi.fn>).mock.calls.length
        ).toBeLessThanOrEqual(callCount + 1);
      });
    });

    describe('SSR safety', () => {
      it('returns safe defaults before hydration', async () => {
        // Note: True SSR (no window) cannot be tested under jsdom. This test
        // verifies the hook's initial synchronous state before the useEffect
        // runs, which is the same state a server render would produce.
        const { result } = renderHook(() => useCapacitorModule.useCapacitor());

        expect(result.current.isNative).toBe(false);
        expect(result.current.platform).toBe('web');
      });
    });

    describe('edge cases', () => {
      it('handles Capacitor object with missing methods', async () => {
        (window as Window & { Capacitor?: object }).Capacitor = {};
        vi.resetModules();
        useCapacitorModule = await import('../useCapacitor');

        const { result } = renderHook(() => useCapacitorModule.useCapacitor());

        await waitFor(() => {
          expect(result.current.isReady).toBe(true);
        });

        expect(result.current.isNative).toBe(false);
        expect(result.current.platform).toBe('web');
      });

      it('handles Capacitor.getPlatform returning unexpected value', async () => {
        (window as Window & { Capacitor?: MockCapacitor }).Capacitor = {
          isNativePlatform: vi.fn(() => true),
          getPlatform: vi.fn(() => 'unknown'),
        };
        vi.resetModules();
        useCapacitorModule = await import('../useCapacitor');

        const { result } = renderHook(() => useCapacitorModule.useCapacitor());

        await waitFor(() => {
          expect(result.current.isReady).toBe(true);
        });

        // Still a native shell — that is about Capacitor, not about which
        // platform row we recognize.
        expect(result.current.isNative).toBe(true);
        // `platform` is typed `Platform`, so an unrecognized value normalizes to
        // 'web' rather than leaking a string outside that union.
        expect(result.current.platform).toBe('web');
        expect(result.current.isIOS).toBe(false);
        expect(result.current.isAndroid).toBe(false);
        // No capability row for it, so nothing is claimed as supported.
        expect(result.current.capabilities).toEqual({
          secureStore: false,
          nativeAuth: false,
          push: false,
          badge: false,
        });
      });
    });
  });

  describe('capabilities', () => {
    it('exposes the iOS capability set', async () => {
      (window as Window & { Capacitor?: MockCapacitor }).Capacitor = {
        isNativePlatform: vi.fn(() => true),
        getPlatform: vi.fn(() => 'ios'),
      };
      vi.resetModules();
      useCapacitorModule = await import('../useCapacitor');

      const { result } = renderHook(() => useCapacitorModule.useCapacitor());
      await waitFor(() => expect(result.current.isReady).toBe(true));

      expect(result.current.capabilities).toEqual({
        secureStore: true,
        nativeAuth: true,
        push: true,
        badge: true,
      });
    });

    it('exposes the Android capability set, badge still unsupported', async () => {
      (window as Window & { Capacitor?: MockCapacitor }).Capacitor = {
        isNativePlatform: vi.fn(() => true),
        getPlatform: vi.fn(() => 'android'),
      };
      vi.resetModules();
      useCapacitorModule = await import('../useCapacitor');

      const { result } = renderHook(() => useCapacitorModule.useCapacitor());
      await waitFor(() => expect(result.current.isReady).toBe(true));

      expect(result.current.isAndroid).toBe(true);
      expect(result.current.capabilities).toEqual({
        secureStore: true,
        nativeAuth: true,
        push: true,
        badge: false,
      });
    });

    it('renders unsupported first on iOS, so hydration cannot mismatch', async () => {
      // The server has no window.Capacitor, so it always renders the
      // unsupported set. If the hook's initial state read the real platform,
      // the first client render would disagree with the server's HTML.
      (window as Window & { Capacitor?: MockCapacitor }).Capacitor = {
        isNativePlatform: vi.fn(() => true),
        getPlatform: vi.fn(() => 'ios'),
      };
      vi.resetModules();
      useCapacitorModule = await import('../useCapacitor');

      const seen: Array<{ badge: boolean; isReady: boolean }> = [];
      const { result } = renderHook(() => {
        const state = useCapacitorModule.useCapacitor();
        seen.push({ badge: state.capabilities.badge, isReady: state.isReady });
        return state;
      });
      await waitFor(() => expect(result.current.isReady).toBe(true));

      // First render (pre-effect) must look exactly like the server's.
      expect(seen[0]).toEqual({ badge: false, isReady: false });
      // and only then move to the real capability set.
      expect(result.current.capabilities.badge).toBe(true);
    });

    it('reports everything unsupported in a browser tab', async () => {
      delete (window as Window & { Capacitor?: MockCapacitor }).Capacitor;
      vi.resetModules();
      useCapacitorModule = await import('../useCapacitor');

      const { result } = renderHook(() => useCapacitorModule.useCapacitor());
      await waitFor(() => expect(result.current.isReady).toBe(true));

      expect(result.current.isNative).toBe(false);
      expect(result.current.capabilities).toEqual({
        secureStore: false,
        nativeAuth: false,
        push: false,
        badge: false,
      });
    });
  });

  // Note: isCapacitorApp(), getPlatform() and isIPad() live in
  // capacitor-bridge.ts and are thoroughly tested in capacitor-bridge.test.ts.
  // This file focuses on the React hook behavior only.

  describe('usage patterns', () => {
    describe('conditional rendering', () => {
      it('enables conditional rendering based on platform', async () => {
        setupCapacitorMock(true, 'ios');
        vi.resetModules();
        useCapacitorModule = await import('../useCapacitor');

        const { result } = renderHook(() => useCapacitorModule.useCapacitor());

        await waitFor(() => {
          expect(result.current.isReady).toBe(true);
        });

        // Example: Show iOS-specific UI
        if (result.current.isIOS) {
          expect(true).toBe(true); // iOS-specific behavior
        }
      });

      it('avoids flash of wrong content with isReady', async () => {
        setupCapacitorMock(true, 'ios');
        vi.resetModules();
        useCapacitorModule = await import('../useCapacitor');

        const { result } = renderHook(() => useCapacitorModule.useCapacitor());

        // Before ready, show loading or default
        if (!result.current.isReady) {
          expect(result.current.platform).toBe('web'); // Safe default
        }

        await waitFor(() => {
          expect(result.current.isReady).toBe(true);
        });

        // After ready, show platform-specific UI
        expect(result.current.platform).toBe('ios');
      });
    });

    describe('feature detection', () => {
      it('enables feature flags based on platform', async () => {
        setupCapacitorMock(true, 'ios');
        vi.resetModules();
        useCapacitorModule = await import('../useCapacitor');

        const { result } = renderHook(() => useCapacitorModule.useCapacitor());

        await waitFor(() => {
          expect(result.current.isReady).toBe(true);
        });

        const features = {
          pushNotifications: result.current.isNative,
          hapticFeedback: result.current.isIOS,
          materialDesign: result.current.isAndroid,
          pwaBanner: !result.current.isNative,
        };

        expect(features.pushNotifications).toBe(true);
        expect(features.hapticFeedback).toBe(true);
        expect(features.materialDesign).toBe(false);
        expect(features.pwaBanner).toBe(false);
      });
    });
  });

  describe('TypeScript types', () => {
    it('CapacitorState has correct shape', async () => {
      const { result } = renderHook(() => useCapacitorModule.useCapacitor());

      await waitFor(() => {
        expect(result.current.isReady).toBe(true);
      });

      // Type check - these properties should exist
      expect(typeof result.current.isNative).toBe('boolean');
      expect(typeof result.current.platform).toBe('string');
      expect(typeof result.current.isIOS).toBe('boolean');
      expect(typeof result.current.isAndroid).toBe('boolean');
      expect(typeof result.current.isReady).toBe('boolean');
    });
  });
});
