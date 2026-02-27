/**
 * useDevices Hook Tests
 * Tests for SWR editing protection with hasLoadedRef guard
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { SWRResponse } from 'swr';

// Mock dependencies before imports
vi.mock('swr', () => ({
  default: vi.fn(),
}));

vi.mock('@/stores/useEditingStore', () => ({
  useEditingStore: vi.fn(),
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));

import useSWR from 'swr';
import { useEditingStore } from '@/stores/useEditingStore';
import { useDevices } from '../useDevices';

describe('useDevices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('SWR editing protection', () => {
    it('given initial load has not completed, should allow revalidation even when editing', () => {
      // Arrange: User is actively editing but initial load hasn't completed
      vi.mocked(useEditingStore).mockReturnValue(true);

      vi.mocked(useSWR).mockReturnValue({
        data: undefined,
        error: undefined,
        isLoading: false,
        mutate: vi.fn(),
        isValidating: false,
      } as SWRResponse);

      // Act: Render hook
      renderHook(() => useDevices());

      // Assert: isPaused returns false because hasLoadedRef is still false
      const swrCall = vi.mocked(useSWR).mock.calls[0];
      const swrConfig = swrCall[2] as { isPaused?: () => boolean; onSuccess?: () => void };

      expect(swrConfig.isPaused).toBeDefined();
      expect(swrConfig.isPaused!()).toBe(false);
    });

    it('given initial load completed and user is editing, should pause device revalidation', () => {
      // Arrange: User is actively editing
      vi.mocked(useEditingStore).mockReturnValue(true);

      vi.mocked(useSWR).mockReturnValue({
        data: undefined,
        error: undefined,
        isLoading: false,
        mutate: vi.fn(),
        isValidating: false,
      } as SWRResponse);

      // Act: Render hook and simulate initial load completing via onSuccess
      renderHook(() => useDevices());

      const swrCall = vi.mocked(useSWR).mock.calls[0];
      const swrConfig = swrCall[2] as { isPaused?: () => boolean; onSuccess?: () => void };

      // Simulate SWR calling onSuccess after initial fetch
      swrConfig.onSuccess!();

      // Assert: isPaused now returns true because hasLoadedRef flipped
      expect(swrConfig.isPaused).toBeDefined();
      expect(swrConfig.isPaused!()).toBe(true);
    });

    it('given user is not editing or streaming, should allow device revalidation', () => {
      // Arrange: No active editing/streaming
      vi.mocked(useEditingStore).mockReturnValue(false);

      vi.mocked(useSWR).mockReturnValue({
        data: undefined,
        error: undefined,
        isLoading: false,
        mutate: vi.fn(),
        isValidating: false,
      } as SWRResponse);

      // Act: Render hook and simulate initial load
      renderHook(() => useDevices());

      const swrCall = vi.mocked(useSWR).mock.calls[0];
      const swrConfig = swrCall[2] as { isPaused?: () => boolean; onSuccess?: () => void };

      // Simulate onSuccess
      swrConfig.onSuccess!();

      // Assert: isPaused returns false because isAnyActive is false
      expect(swrConfig.isPaused).toBeDefined();
      expect(swrConfig.isPaused!()).toBe(false);
    });
  });
});
