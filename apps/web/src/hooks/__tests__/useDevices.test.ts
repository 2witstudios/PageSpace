/**
 * useDevices Hook Tests
 * Tests for SWR editing protection and device fetching
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

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
    it('given user is editing a document, should pause device revalidation', () => {
      // Arrange: User is actively editing
      vi.mocked(useEditingStore).mockReturnValue(true); // isAnyActive returns true

      vi.mocked(useSWR).mockReturnValue({
        data: undefined,
        error: undefined,
        isLoading: false,
        mutate: vi.fn(),
        isValidating: false,
      } as any);

      // Act: Render hook
      renderHook(() => useDevices());

      // Assert: SWR was called with isPaused function
      expect(useSWR).toHaveBeenCalled();
      const swrCall = vi.mocked(useSWR).mock.calls[0];
      const swrConfig = swrCall[2] as { isPaused?: () => boolean };

      // The isPaused function should exist and return true when editing
      expect(swrConfig.isPaused).toBeDefined();
      expect(swrConfig.isPaused!()).toBe(true);
    });

    it('given user is in AI streaming session, should pause device revalidation', () => {
      // Arrange: AI streaming is active
      vi.mocked(useEditingStore).mockReturnValue(true); // isAnyActive returns true

      vi.mocked(useSWR).mockReturnValue({
        data: undefined,
        error: undefined,
        isLoading: false,
        mutate: vi.fn(),
        isValidating: false,
      } as any);

      // Act: Render hook
      renderHook(() => useDevices());

      // Assert: SWR isPaused returns true
      const swrCall = vi.mocked(useSWR).mock.calls[0];
      const swrConfig = swrCall[2] as { isPaused?: () => boolean };

      expect(swrConfig.isPaused).toBeDefined();
      expect(swrConfig.isPaused!()).toBe(true);
    });

    it('given user is not editing or streaming, should allow device revalidation', () => {
      // Arrange: No active editing/streaming
      vi.mocked(useEditingStore).mockReturnValue(false); // isAnyActive returns false

      vi.mocked(useSWR).mockReturnValue({
        data: undefined,
        error: undefined,
        isLoading: false,
        mutate: vi.fn(),
        isValidating: false,
      } as any);

      // Act: Render hook
      renderHook(() => useDevices());

      // Assert: SWR isPaused returns false
      const swrCall = vi.mocked(useSWR).mock.calls[0];
      const swrConfig = swrCall[2] as { isPaused?: () => boolean };

      expect(swrConfig.isPaused).toBeDefined();
      expect(swrConfig.isPaused!()).toBe(false);
    });
  });
});
