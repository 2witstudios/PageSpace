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
import { usePermissions, canManageDrive, isDriveOwner } from '../usePermissions';

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

describe('canManageDrive', () => {
  it('returns false for a null/undefined drive', () => {
    expect(canManageDrive(null)).toBe(false);
    expect(canManageDrive(undefined)).toBe(false);
  });

  it('returns true when isOwned is true, regardless of role', () => {
    expect(canManageDrive({ isOwned: true, role: 'MEMBER' })).toBe(true);
  });

  it('returns true for ADMIN or OWNER role (case-insensitive)', () => {
    expect(canManageDrive({ role: 'ADMIN' })).toBe(true);
    expect(canManageDrive({ role: 'admin' })).toBe(true);
    expect(canManageDrive({ role: 'OWNER' })).toBe(true);
  });

  it('returns false for a MEMBER role with isOwned false', () => {
    expect(canManageDrive({ isOwned: false, role: 'MEMBER' })).toBe(false);
  });
});

describe('isDriveOwner', () => {
  it('returns false for a null/undefined drive', () => {
    expect(isDriveOwner(null)).toBe(false);
    expect(isDriveOwner(undefined)).toBe(false);
  });

  it('returns true when isOwned is true', () => {
    expect(isDriveOwner({ isOwned: true, role: 'MEMBER' })).toBe(true);
  });

  it('returns true for an OWNER role (case-insensitive)', () => {
    expect(isDriveOwner({ role: 'OWNER' })).toBe(true);
    expect(isDriveOwner({ role: 'owner' })).toBe(true);
  });

  // The whole point of this predicate over `canManageDrive`: an ADMIN can
  // manage a drive's resources but must never be treated as able to spend
  // the owner's money.
  it('returns false for an ADMIN role — stricter than canManageDrive', () => {
    expect(isDriveOwner({ role: 'ADMIN' })).toBe(false);
    expect(canManageDrive({ role: 'ADMIN' })).toBe(true);
  });

  it('returns false for a MEMBER role', () => {
    expect(isDriveOwner({ role: 'MEMBER' })).toBe(false);
  });
});
