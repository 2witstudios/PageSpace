/**
 * useMobile Hook Tests
 * Tests for mobile detection combining breakpoint and tablet detection
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Mock the hooks that useMobile depends on using their resolved paths
vi.mock('@/hooks/useBreakpoint', () => ({
  useBreakpoint: vi.fn(() => false),
}));

vi.mock('@/hooks/useDeviceTier', () => ({
  useIsTablet: vi.fn(() => false),
}));

import { useMobile } from '../useMobile';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useIsTablet } from '@/hooks/useDeviceTier';

const mockedUseBreakpoint = vi.mocked(useBreakpoint);
const mockedUseIsTablet = vi.mocked(useIsTablet);

describe('useMobile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseBreakpoint.mockReturnValue(false);
    mockedUseIsTablet.mockReturnValue(false);
  });

  it('should return false when viewport is large and device is not a tablet', () => {
    const { result } = renderHook(() => useMobile());

    expect(result.current).toBe(false);
  });

  it('should return true when viewport is small (mobile-sized)', () => {
    mockedUseBreakpoint.mockReturnValue(true);

    const { result } = renderHook(() => useMobile());

    expect(result.current).toBe(true);
  });

  it('should return true when device is a tablet', () => {
    mockedUseIsTablet.mockReturnValue(true);

    const { result } = renderHook(() => useMobile());

    expect(result.current).toBe(true);
  });

  it('should return true when both small viewport and tablet', () => {
    mockedUseBreakpoint.mockReturnValue(true);
    mockedUseIsTablet.mockReturnValue(true);

    const { result } = renderHook(() => useMobile());

    expect(result.current).toBe(true);
  });

  it('should call useBreakpoint with the mobile query', () => {
    renderHook(() => useMobile());

    expect(mockedUseBreakpoint).toHaveBeenCalledWith('(max-width: 767px)');
  });

  it('should call useIsTablet', () => {
    renderHook(() => useMobile());

    expect(mockedUseIsTablet).toHaveBeenCalled();
  });
});
