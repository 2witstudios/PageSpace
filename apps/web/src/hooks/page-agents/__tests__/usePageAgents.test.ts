/**
 * usePageAgents Hook Tests
 * Tests for SWR editing protection with hasLoadedRef guard and key-change reset
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

vi.mock('@/stores/page-agents', () => ({
  type: {} as Record<string, unknown>,
}));

import useSWR from 'swr';
import { useEditingStore } from '@/stores/useEditingStore';
import { usePageAgents } from '../usePageAgents';

describe('usePageAgents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockSwrReturn = () => {
    vi.mocked(useSWR).mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: false,
      mutate: vi.fn(),
      isValidating: false,
    } as SWRResponse);
  };

  describe('SWR editing protection', () => {
    it('given initial load has not completed, should allow revalidation even when editing', () => {
      vi.mocked(useEditingStore).mockReturnValue(true);
      mockSwrReturn();

      renderHook(() => usePageAgents());

      const swrCall = vi.mocked(useSWR).mock.calls[0];
      const swrConfig = swrCall[2] as { isPaused?: () => boolean; onSuccess?: () => void };

      expect(swrConfig.isPaused).toBeDefined();
      expect(swrConfig.isPaused!()).toBe(false);
    });

    it('given initial load completed and user is editing, should pause revalidation', () => {
      vi.mocked(useEditingStore).mockReturnValue(true);
      mockSwrReturn();

      renderHook(() => usePageAgents());

      const swrCall = vi.mocked(useSWR).mock.calls[0];
      const swrConfig = swrCall[2] as { isPaused?: () => boolean; onSuccess?: () => void };

      // Simulate SWR calling onSuccess after initial fetch
      swrConfig.onSuccess!();

      expect(swrConfig.isPaused).toBeDefined();
      expect(swrConfig.isPaused!()).toBe(true);
    });

    it('given user is not editing or streaming, should allow revalidation', () => {
      vi.mocked(useEditingStore).mockReturnValue(false);
      mockSwrReturn();

      renderHook(() => usePageAgents());

      const swrCall = vi.mocked(useSWR).mock.calls[0];
      const swrConfig = swrCall[2] as { isPaused?: () => boolean; onSuccess?: () => void };

      swrConfig.onSuccess!();

      expect(swrConfig.isPaused).toBeDefined();
      expect(swrConfig.isPaused!()).toBe(false);
    });
  });

  describe('SWR key change resets hasLoadedRef', () => {
    it('given SWR key changes, should allow initial fetch for new key even when editing', () => {
      vi.mocked(useEditingStore).mockReturnValue(true);
      mockSwrReturn();

      // First render with includeSystemPrompt=false
      const { rerender } = renderHook(
        ({ includeSystemPrompt }: { includeSystemPrompt: boolean }) =>
          usePageAgents(undefined, { includeSystemPrompt }),
        { initialProps: { includeSystemPrompt: false } }
      );

      // Simulate initial load completing
      const firstCall = vi.mocked(useSWR).mock.calls[0];
      const firstConfig = firstCall[2] as { isPaused?: () => boolean; onSuccess?: () => void };
      firstConfig.onSuccess!();

      // Verify it's paused after load
      expect(firstConfig.isPaused!()).toBe(true);

      // Change the SWR key by toggling includeSystemPrompt
      vi.mocked(useSWR).mockClear();
      mockSwrReturn();
      rerender({ includeSystemPrompt: true });

      // After key change, hasLoadedRef should be reset — isPaused should return false
      const secondCall = vi.mocked(useSWR).mock.calls[0];
      const secondConfig = secondCall[2] as { isPaused?: () => boolean; onSuccess?: () => void };

      expect(secondConfig.isPaused!()).toBe(false);
    });
  });
});
