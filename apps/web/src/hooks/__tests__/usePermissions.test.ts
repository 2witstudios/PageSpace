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

vi.mock('@/hooks/useAuth', () => ({
  useAuth: vi.fn(() => ({ user: { id: 'user-123' } })),
}));

import useSWR from 'swr';
import { useEditingStore } from '@/stores/useEditingStore';
import { usePermissions } from '../usePermissions';

describe('usePermissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('SWR editing protection', () => {
    let capturedConfig: { isPaused?: () => boolean; onSuccess?: (data: unknown, key: string, config: never) => void };

    it('given user is editing a document, should pause permission revalidation', () => {
      // Arrange: User is actively editing
      vi.mocked(useEditingStore).mockReturnValue(true); // isAnyActive returns true

      // Mock SWR - capture config but don't call onSuccess yet (effects need to run first)
      vi.mocked(useSWR).mockImplementation((key, fetcher, config) => {
        capturedConfig = config as typeof capturedConfig;
        return {
          data: { canView: true, canEdit: true, canShare: true, canDelete: true },
          error: undefined,
          isLoading: false,
          mutate: vi.fn(),
          isValidating: false,
        } as SWRResponse;
      });

      // Act: Render hook (useEffect resets hasLoadedRef to false for new pageId)
      renderHook(() => usePermissions('page-123'));

      // Simulate SWR calling onSuccess after initial render/effects complete
      if (capturedConfig?.onSuccess) {
        capturedConfig.onSuccess({ canView: true, canEdit: true, canShare: true, canDelete: true }, '/api/pages/page-123/permissions/check', {} as never);
      }

      // Assert: isPaused should return true when editing (after initial load)
      expect(capturedConfig.isPaused).toBeDefined();
      expect(capturedConfig.isPaused!()).toBe(true);
    });

    it('given user is in AI streaming session, should pause permission revalidation', () => {
      // Arrange: AI streaming is active
      vi.mocked(useEditingStore).mockReturnValue(true); // isAnyActive returns true

      // Mock SWR - capture config but don't call onSuccess yet
      vi.mocked(useSWR).mockImplementation((key, fetcher, config) => {
        capturedConfig = config as typeof capturedConfig;
        return {
          data: { canView: true, canEdit: true, canShare: true, canDelete: true },
          error: undefined,
          isLoading: false,
          mutate: vi.fn(),
          isValidating: false,
        } as SWRResponse;
      });

      // Act: Render hook
      renderHook(() => usePermissions('page-123'));

      // Simulate SWR calling onSuccess after initial render/effects complete
      if (capturedConfig?.onSuccess) {
        capturedConfig.onSuccess({ canView: true, canEdit: true, canShare: true, canDelete: true }, '/api/pages/page-123/permissions/check', {} as never);
      }

      // Assert: SWR isPaused returns true (after initial load)
      expect(capturedConfig.isPaused).toBeDefined();
      expect(capturedConfig.isPaused!()).toBe(true);
    });

    it('given user is not editing or streaming, should allow permission revalidation', () => {
      // Arrange: No active editing/streaming
      vi.mocked(useEditingStore).mockReturnValue(false); // isAnyActive returns false

      // Mock SWR - capture config but don't call onSuccess yet
      vi.mocked(useSWR).mockImplementation((key, fetcher, config) => {
        capturedConfig = config as typeof capturedConfig;
        return {
          data: { canView: true, canEdit: true, canShare: true, canDelete: true },
          error: undefined,
          isLoading: false,
          mutate: vi.fn(),
          isValidating: false,
        } as SWRResponse;
      });

      // Act: Render hook
      renderHook(() => usePermissions('page-123'));

      // Simulate SWR calling onSuccess after initial render/effects complete
      if (capturedConfig?.onSuccess) {
        capturedConfig.onSuccess({ canView: true, canEdit: true, canShare: true, canDelete: true }, '/api/pages/page-123/permissions/check', {} as never);
      }

      // Assert: SWR isPaused returns false (hasLoadedRef.current=true && isAnyActive=false => false)
      expect(capturedConfig.isPaused).toBeDefined();
      expect(capturedConfig.isPaused!()).toBe(false);
    });
  });
});
