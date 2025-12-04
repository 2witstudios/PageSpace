/**
 * usePermissions Hook Tests
 * Tests for SWR editing protection and permission fetching
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

vi.mock('../use-auth', () => ({
  useAuth: vi.fn(() => ({ user: { id: 'user-123' } })),
}));

import useSWR from 'swr';
import { useEditingStore } from '@/stores/useEditingStore';
import { usePermissions } from '../use-permissions';

describe('usePermissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('SWR editing protection', () => {
    it('given user is editing a document, should pause permission revalidation', () => {
      // Arrange: User is actively editing
      vi.mocked(useEditingStore).mockReturnValue(true); // isAnyActive returns true

      vi.mocked(useSWR).mockReturnValue({
        data: undefined,
        error: undefined,
        isLoading: false,
        mutate: vi.fn(),
        isValidating: false,
      } as SWRResponse);

      // Act: Render hook
      renderHook(() => usePermissions('page-123'));

      // Assert: SWR was called with isPaused function
      expect(useSWR).toHaveBeenCalled();
      const swrCall = vi.mocked(useSWR).mock.calls[0];
      const swrConfig = swrCall[2] as { isPaused?: () => boolean };

      // The isPaused function should exist and return true when editing
      expect(swrConfig.isPaused).toBeDefined();
      expect(swrConfig.isPaused!()).toBe(true);
    });

    it('given user is in AI streaming session, should pause permission revalidation', () => {
      // Arrange: AI streaming is active
      vi.mocked(useEditingStore).mockReturnValue(true); // isAnyActive returns true

      vi.mocked(useSWR).mockReturnValue({
        data: undefined,
        error: undefined,
        isLoading: false,
        mutate: vi.fn(),
        isValidating: false,
      } as SWRResponse);

      // Act: Render hook
      renderHook(() => usePermissions('page-123'));

      // Assert: SWR isPaused returns true
      const swrCall = vi.mocked(useSWR).mock.calls[0];
      const swrConfig = swrCall[2] as { isPaused?: () => boolean };

      expect(swrConfig.isPaused).toBeDefined();
      expect(swrConfig.isPaused!()).toBe(true);
    });

    it('given user is not editing or streaming, should allow permission revalidation', () => {
      // Arrange: No active editing/streaming
      vi.mocked(useEditingStore).mockReturnValue(false); // isAnyActive returns false

      vi.mocked(useSWR).mockReturnValue({
        data: undefined,
        error: undefined,
        isLoading: false,
        mutate: vi.fn(),
        isValidating: false,
      } as SWRResponse);

      // Act: Render hook
      renderHook(() => usePermissions('page-123'));

      // Assert: SWR isPaused returns false
      const swrCall = vi.mocked(useSWR).mock.calls[0];
      const swrConfig = swrCall[2] as { isPaused?: () => boolean };

      expect(swrConfig.isPaused).toBeDefined();
      expect(swrConfig.isPaused!()).toBe(false);
    });
  });
});
