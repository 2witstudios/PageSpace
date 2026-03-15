/**
 * usePageNavigation Hook Tests
 *
 * Tests page navigation behavior:
 * - Navigates directly with driveId
 * - Uses /p/ route on web without driveId
 * - Fetches driveId from API on Electron
 * - Handles API errors on Electron
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockPush = vi.hoisted(() => vi.fn());
const mockFetchWithAuth = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: mockFetchWithAuth,
}));

import { usePageNavigation } from '../usePageNavigation';

describe('usePageNavigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no electron (web environment)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).electron;
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).electron;
  });

  describe('with driveId provided', () => {
    it('should navigate directly to /dashboard/driveId/pageId when driveId is provided', async () => {
      const { result } = renderHook(() => usePageNavigation());

      await act(async () => {
        await result.current.navigateToPage('page-123', 'drive-456');
      });

      expect(mockPush).toHaveBeenCalledWith('/dashboard/drive-456/page-123');
    });

    it('should not fetch driveId when driveId is already provided', async () => {
      const { result } = renderHook(() => usePageNavigation());

      await act(async () => {
        await result.current.navigateToPage('page-123', 'drive-456');
      });

      expect(mockFetchWithAuth).not.toHaveBeenCalled();
    });
  });

  describe('web (no Electron)', () => {
    it('should use /p/ route on web when no driveId is provided', async () => {
      const { result } = renderHook(() => usePageNavigation());

      await act(async () => {
        await result.current.navigateToPage('page-123');
      });

      expect(mockPush).toHaveBeenCalledWith('/p/page-123');
    });

    it('should not fetch from API on web', async () => {
      const { result } = renderHook(() => usePageNavigation());

      await act(async () => {
        await result.current.navigateToPage('page-123');
      });

      expect(mockFetchWithAuth).not.toHaveBeenCalled();
    });
  });

  describe('Electron (desktop)', () => {
    function setupElectron() {
      Object.defineProperty(window, 'electron', {
        value: { isDesktop: true },
        configurable: true,
        writable: true,
      });
    }

    it('should fetch driveId from API and navigate on Electron', async () => {
      setupElectron();
      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ driveId: 'fetched-drive-id' }),
      });

      const { result } = renderHook(() => usePageNavigation());

      await act(async () => {
        await result.current.navigateToPage('page-123');
      });

      expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/pages/page-123');
      expect(mockPush).toHaveBeenCalledWith('/dashboard/fetched-drive-id/page-123');
    });

    it('should not navigate when API returns non-ok response', async () => {
      setupElectron();
      mockFetchWithAuth.mockResolvedValue({
        ok: false,
        status: 404,
      });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { result } = renderHook(() => usePageNavigation());

      await act(async () => {
        await result.current.navigateToPage('page-123');
      });

      expect(mockPush).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        '[usePageNavigation] Failed to fetch page info:',
        404
      );

      warnSpy.mockRestore();
    });

    it('should not navigate when page has no driveId', async () => {
      setupElectron();
      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ driveId: null }),
      });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { result } = renderHook(() => usePageNavigation());

      await act(async () => {
        await result.current.navigateToPage('page-123');
      });

      expect(mockPush).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith('[usePageNavigation] Page has no driveId');

      warnSpy.mockRestore();
    });

    it('should handle fetch errors gracefully without navigating', async () => {
      setupElectron();
      mockFetchWithAuth.mockRejectedValue(new Error('Network error'));

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() => usePageNavigation());

      await act(async () => {
        await result.current.navigateToPage('page-123');
      });

      expect(mockPush).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        '[usePageNavigation] Error fetching page info:',
        expect.any(Error)
      );

      errorSpy.mockRestore();
    });

    it('should still navigate directly when driveId is provided on Electron', async () => {
      setupElectron();

      const { result } = renderHook(() => usePageNavigation());

      await act(async () => {
        await result.current.navigateToPage('page-123', 'drive-789');
      });

      expect(mockPush).toHaveBeenCalledWith('/dashboard/drive-789/page-123');
      expect(mockFetchWithAuth).not.toHaveBeenCalled();
    });
  });

  describe('return value', () => {
    it('should return an object with navigateToPage function', () => {
      const { result } = renderHook(() => usePageNavigation());

      expect(result.current).toHaveProperty('navigateToPage');
      expect(typeof result.current.navigateToPage).toBe('function');
    });
  });
});
