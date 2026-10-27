/**
 * useDeviceTier Tests
 *
 * Tablet detection is delegated to `isIPad()` in the capability bridge, so the
 * 768px threshold has exactly one definition. These tests pin that delegation
 * and the tier derivation on top of it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const mockIsIPad = vi.fn<() => boolean>();
const mockUseBreakpoint = vi.fn<() => boolean>();

vi.mock('@/lib/capacitor-bridge', () => ({
  isIPad: () => mockIsIPad(),
}));

vi.mock('../useBreakpoint', () => ({
  useBreakpoint: () => mockUseBreakpoint(),
}));

import { useDeviceTier, useIsTablet } from '../useDeviceTier';

describe('useDeviceTier', () => {
  beforeEach(() => {
    mockIsIPad.mockReset();
    mockUseBreakpoint.mockReset();
    mockIsIPad.mockReturnValue(false);
    mockUseBreakpoint.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('useIsTablet', () => {
    it('reports the bridge answer when it says iPad', () => {
      mockIsIPad.mockReturnValue(true);

      const { result } = renderHook(() => useIsTablet());

      expect(result.current).toBe(true);
    });

    it('reports false when the bridge says not an iPad', () => {
      mockIsIPad.mockReturnValue(false);

      const { result } = renderHook(() => useIsTablet());

      expect(result.current).toBe(false);
    });

    it('asks the bridge rather than reading window.Capacitor itself', () => {
      mockIsIPad.mockReturnValue(true);

      renderHook(() => useIsTablet());

      expect(mockIsIPad).toHaveBeenCalled();
    });
  });

  describe('tier derivation', () => {
    it('is tablet on iPad, whatever the viewport reports', () => {
      mockIsIPad.mockReturnValue(true);
      mockUseBreakpoint.mockReturnValue(true); // small viewport too

      const { result } = renderHook(() => useDeviceTier());

      expect(result.current.tier).toBe('tablet');
      expect(result.current.isTablet).toBe(true);
      expect(result.current.isMobile).toBe(false);
      expect(result.current.isDesktop).toBe(false);
      expect(result.current.isMobileOrTablet).toBe(true);
    });

    it('is mobile on a small viewport that is not an iPad', () => {
      mockIsIPad.mockReturnValue(false);
      mockUseBreakpoint.mockReturnValue(true);

      const { result } = renderHook(() => useDeviceTier());

      expect(result.current.tier).toBe('mobile');
      expect(result.current.isMobile).toBe(true);
      expect(result.current.isMobileOrTablet).toBe(true);
    });

    it('is desktop on a large viewport that is not an iPad', () => {
      mockIsIPad.mockReturnValue(false);
      mockUseBreakpoint.mockReturnValue(false);

      const { result } = renderHook(() => useDeviceTier());

      expect(result.current.tier).toBe('desktop');
      expect(result.current.isDesktop).toBe(true);
      expect(result.current.isMobileOrTablet).toBe(false);
    });
  });
});
