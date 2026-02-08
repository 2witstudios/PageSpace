/**
 * usePermissions Hook Tests
 * Tests for SWR configuration after isPaused removal
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { SWRResponse } from 'swr';

// Mock dependencies before imports
vi.mock('swr', () => ({
  default: vi.fn(),
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: vi.fn(() => ({ user: { id: 'user-123' } })),
}));

import useSWR from 'swr';
import { usePermissions } from '../usePermissions';

describe('usePermissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('SWR configuration', () => {
    let capturedConfig: Record<string, unknown>;

    beforeEach(() => {
      vi.mocked(useSWR).mockImplementation((_key, _fetcher, config) => {
        capturedConfig = config as Record<string, unknown>;
        return {
          data: { canView: true, canEdit: true, canShare: true, canDelete: true },
          error: undefined,
          isLoading: false,
          mutate: vi.fn(),
          isValidating: false,
        } as SWRResponse;
      });
    });

    it('given a pageId, should not use isPaused (allows initial fetch on all platforms)', () => {
      renderHook(() => usePermissions('page-123'));

      expect(capturedConfig.isPaused).toBeUndefined();
    });

    it('given a pageId, should disable revalidateOnFocus', () => {
      renderHook(() => usePermissions('page-123'));

      expect(capturedConfig.revalidateOnFocus).toBe(false);
    });

    it('given a pageId, should set dedupingInterval to 60 seconds', () => {
      renderHook(() => usePermissions('page-123'));

      expect(capturedConfig.dedupingInterval).toBe(60000);
    });
  });
});
