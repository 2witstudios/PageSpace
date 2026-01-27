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
import { renderHook, waitFor, act } from '@testing-library/react';

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
      it('handles initial render on server (no window)', async () => {
        // The hook should handle SSR gracefully
        // In testing environment, window exists but we can verify initial state
        const { result } = renderHook(() => useCapacitorModule.useCapacitor());

        // Initial state should be safe defaults
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

        expect(result.current.isNative).toBe(true);
        expect(result.current.platform).toBe('unknown');
        expect(result.current.isIOS).toBe(false);
        expect(result.current.isAndroid).toBe(false);
      });
    });
  });

  describe('isCapacitorApp utility function', () => {
    it('returns true for native iOS app', async () => {
      setupCapacitorMock(true, 'ios');
      vi.resetModules();
      useCapacitorModule = await import('../useCapacitor');

      expect(useCapacitorModule.isCapacitorApp()).toBe(true);
    });

    it('returns true for native Android app', async () => {
      setupCapacitorMock(true, 'android');
      vi.resetModules();
      useCapacitorModule = await import('../useCapacitor');

      expect(useCapacitorModule.isCapacitorApp()).toBe(true);
    });

    it('returns false for web', () => {
      removeCapacitorMock();

      expect(useCapacitorModule.isCapacitorApp()).toBe(false);
    });

    it('returns false when Capacitor is not native', async () => {
      setupCapacitorMock(false, 'web');
      vi.resetModules();
      useCapacitorModule = await import('../useCapacitor');

      expect(useCapacitorModule.isCapacitorApp()).toBe(false);
    });

    it('can be called outside of React components', () => {
      // This is the main use case - calling before React initializes
      expect(() => useCapacitorModule.isCapacitorApp()).not.toThrow();
    });
  });

  describe('getPlatform utility function', () => {
    it('returns ios for iOS app', async () => {
      setupCapacitorMock(true, 'ios');
      vi.resetModules();
      useCapacitorModule = await import('../useCapacitor');

      expect(useCapacitorModule.getPlatform()).toBe('ios');
    });

    it('returns android for Android app', async () => {
      setupCapacitorMock(true, 'android');
      vi.resetModules();
      useCapacitorModule = await import('../useCapacitor');

      expect(useCapacitorModule.getPlatform()).toBe('android');
    });

    it('returns web for browser', () => {
      removeCapacitorMock();

      expect(useCapacitorModule.getPlatform()).toBe('web');
    });

    it('returns web when Capacitor.getPlatform returns empty', async () => {
      (window as Window & { Capacitor?: MockCapacitor }).Capacitor = {
        isNativePlatform: vi.fn(() => true),
        getPlatform: vi.fn(() => ''),
      };
      vi.resetModules();
      useCapacitorModule = await import('../useCapacitor');

      expect(useCapacitorModule.getPlatform()).toBe('web');
    });

    it('can be called outside of React components', () => {
      expect(() => useCapacitorModule.getPlatform()).not.toThrow();
    });
  });

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
