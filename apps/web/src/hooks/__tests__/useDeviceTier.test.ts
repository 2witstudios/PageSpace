/**
 * useDeviceTier Hook Tests
 * Tests for device tier detection: mobile, tablet (iPad via Capacitor), and desktop
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

interface MockCapacitor {
  isNativePlatform: () => boolean;
  getPlatform: () => string;
}

function setupCapacitorMock(isNative: boolean, platform: string = 'ios'): void {
  (window as Window & { Capacitor?: MockCapacitor }).Capacitor = {
    isNativePlatform: vi.fn(() => isNative),
    getPlatform: vi.fn(() => platform),
  };
}

function removeCapacitorMock(): void {
  delete (window as Window & { Capacitor?: MockCapacitor }).Capacitor;
}

function createMockMatchMedia(matches: boolean) {
  return vi.fn(() => ({
    matches,
    media: '',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
    dispatchEvent: vi.fn(),
  }));
}

describe('useDeviceTier', () => {
  beforeEach(() => {
    vi.resetModules();
    removeCapacitorMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    removeCapacitorMock();
  });

  describe('useIsTablet', () => {
    it('should return false when Capacitor is not present', async () => {
      vi.stubGlobal('matchMedia', createMockMatchMedia(false));
      const { useIsTablet } = await import('../useDeviceTier');

      const { result } = renderHook(() => useIsTablet());

      expect(result.current).toBe(false);
    });

    it('should return false when Capacitor is present but not native', async () => {
      setupCapacitorMock(false, 'web');
      vi.stubGlobal('matchMedia', createMockMatchMedia(false));
      vi.resetModules();
      const { useIsTablet } = await import('../useDeviceTier');

      const { result } = renderHook(() => useIsTablet());

      expect(result.current).toBe(false);
    });

    it('should return false when native iOS but small screen', async () => {
      setupCapacitorMock(true, 'ios');
      vi.stubGlobal('matchMedia', createMockMatchMedia(false));
      // Mock small screen
      Object.defineProperty(window, 'screen', {
        value: { width: 375, height: 667 },
        writable: true,
        configurable: true,
      });
      vi.resetModules();
      const { useIsTablet } = await import('../useDeviceTier');

      const { result } = renderHook(() => useIsTablet());

      expect(result.current).toBe(false);
    });

    it('should return true when native iOS with iPad-sized screen', async () => {
      setupCapacitorMock(true, 'ios');
      vi.stubGlobal('matchMedia', createMockMatchMedia(false));
      Object.defineProperty(window, 'screen', {
        value: { width: 1024, height: 768 },
        writable: true,
        configurable: true,
      });
      vi.resetModules();
      const { useIsTablet } = await import('../useDeviceTier');

      const { result } = renderHook(() => useIsTablet());

      expect(result.current).toBe(true);
    });

    it('should return false when native Android regardless of screen size', async () => {
      setupCapacitorMock(true, 'android');
      vi.stubGlobal('matchMedia', createMockMatchMedia(false));
      Object.defineProperty(window, 'screen', {
        value: { width: 1024, height: 768 },
        writable: true,
        configurable: true,
      });
      vi.resetModules();
      const { useIsTablet } = await import('../useDeviceTier');

      const { result } = renderHook(() => useIsTablet());

      expect(result.current).toBe(false);
    });
  });

  describe('useDeviceTier', () => {
    it('should return desktop tier when viewport is large and not a tablet', async () => {
      vi.stubGlobal('matchMedia', createMockMatchMedia(false));
      vi.resetModules();
      const { useDeviceTier } = await import('../useDeviceTier');

      const { result } = renderHook(() => useDeviceTier());

      expect(result.current.tier).toBe('desktop');
      expect(result.current.isDesktop).toBe(true);
      expect(result.current.isMobile).toBe(false);
      expect(result.current.isTablet).toBe(false);
      expect(result.current.isMobileOrTablet).toBe(false);
    });

    it('should return mobile tier when viewport is small', async () => {
      vi.stubGlobal('matchMedia', createMockMatchMedia(true));
      vi.resetModules();
      const { useDeviceTier } = await import('../useDeviceTier');

      const { result } = renderHook(() => useDeviceTier());

      expect(result.current.tier).toBe('mobile');
      expect(result.current.isMobile).toBe(true);
      expect(result.current.isDesktop).toBe(false);
      expect(result.current.isTablet).toBe(false);
      expect(result.current.isMobileOrTablet).toBe(true);
    });

    it('should return tablet tier when device is an iPad in Capacitor', async () => {
      setupCapacitorMock(true, 'ios');
      Object.defineProperty(window, 'screen', {
        value: { width: 1024, height: 768 },
        writable: true,
        configurable: true,
      });
      vi.stubGlobal('matchMedia', createMockMatchMedia(false));
      vi.resetModules();
      const { useDeviceTier } = await import('../useDeviceTier');

      const { result } = renderHook(() => useDeviceTier());

      expect(result.current.tier).toBe('tablet');
      expect(result.current.isTablet).toBe(true);
      expect(result.current.isMobile).toBe(false);
      expect(result.current.isDesktop).toBe(false);
      expect(result.current.isMobileOrTablet).toBe(true);
    });

    it('should prioritize tablet over mobile when both conditions match', async () => {
      // iPad in Capacitor with small viewport query matching
      setupCapacitorMock(true, 'ios');
      Object.defineProperty(window, 'screen', {
        value: { width: 1024, height: 768 },
        writable: true,
        configurable: true,
      });
      vi.stubGlobal('matchMedia', createMockMatchMedia(true));
      vi.resetModules();
      const { useDeviceTier } = await import('../useDeviceTier');

      const { result } = renderHook(() => useDeviceTier());

      // Tablet takes priority over mobile in the tier calculation
      expect(result.current.tier).toBe('tablet');
      expect(result.current.isTablet).toBe(true);
    });
  });
});
