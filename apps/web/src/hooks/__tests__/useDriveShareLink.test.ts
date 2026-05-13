import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('@/lib/auth/auth-fetch', () => ({
  post: vi.fn(),
  del: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { post, del } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';
import { useDriveShareLink } from '../useDriveShareLink';

const DRIVE_ID = 'drive-abc';
const LINK_ID = 'link-123';
const SHARE_URL = 'https://app.pagespace.ai/s/ps_share_xyz';

function mockFetchResolve(data: unknown) {
  vi.spyOn(global, 'fetch').mockResolvedValueOnce({
    ok: true,
    json: async () => data,
  } as Response);
}

function mockFetchReject() {
  vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('network error'));
}

describe('useDriveShareLink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('loading existing link', () => {
    it('Given GET returns a link with shareUrl, should populate activeLink and shareUrl', async () => {
      mockFetchResolve({
        links: [{ id: LINK_ID, role: 'MEMBER', useCount: 3, shareUrl: SHARE_URL, expiresAt: null, createdAt: new Date().toISOString() }],
      });

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));

      expect(result.current.isLoading).toBe(true);

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.activeLink?.id).toBe(LINK_ID);
      expect(result.current.activeLink?.role).toBe('MEMBER');
      expect(result.current.shareUrl).toBe(SHARE_URL);
    });

    it('Given GET returns an empty list, should have no activeLink', async () => {
      mockFetchResolve({ links: [] });

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.activeLink).toBeNull();
      expect(result.current.shareUrl).toBeNull();
    });

    it('Given GET returns a link with null shareUrl (legacy row), should set shareUrl to null', async () => {
      mockFetchResolve({
        links: [{ id: LINK_ID, role: 'ADMIN', useCount: 0, shareUrl: null, expiresAt: null, createdAt: new Date().toISOString() }],
      });

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.activeLink?.id).toBe(LINK_ID);
      expect(result.current.shareUrl).toBeNull();
    });

    it('Given GET returns malformed data (missing id), should treat as no active link', async () => {
      mockFetchResolve({ links: [{ role: 'MEMBER', useCount: 0 }] });

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.activeLink).toBeNull();
    });

    it('Given GET fails with network error, should finish loading with no active link', async () => {
      mockFetchReject();

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.activeLink).toBeNull();
    });
  });

  describe('generating a link', () => {
    it('Given POST succeeds, should update shareUrl and activeLink from response', async () => {
      mockFetchResolve({ links: [] });
      vi.mocked(post).mockResolvedValueOnce({
        id: LINK_ID,
        rawToken: 'ps_share_xyz',
        shareUrl: SHARE_URL,
      });

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });

      await act(async () => {
        await result.current.handleGenerate();
      });

      expect(result.current.shareUrl).toBe(SHARE_URL);
      expect(result.current.activeLink?.id).toBe(LINK_ID);
      expect(result.current.activeLink?.role).toBe('MEMBER');
    });

    it('Given POST fails, should not update activeLink', async () => {
      mockFetchResolve({ links: [] });
      vi.mocked(post).mockRejectedValueOnce(new Error('server error'));

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.handleGenerate();
      });

      expect(result.current.activeLink).toBeNull();
      expect(toast.error).toHaveBeenCalled();
    });
  });

  describe('copying a link', () => {
    it('Given shareUrl is set, handleCopy should write shareUrl to clipboard', async () => {
      mockFetchResolve({
        links: [{ id: LINK_ID, role: 'MEMBER', useCount: 1, shareUrl: SHARE_URL, expiresAt: null, createdAt: new Date().toISOString() }],
      });
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.handleCopy();
      });

      expect(writeText).toHaveBeenCalledWith(SHARE_URL);
      expect(toast.success).toHaveBeenCalled();
    });

    it('Given shareUrl is null, handleCopy should do nothing', async () => {
      mockFetchResolve({ links: [] });
      const writeText = vi.fn();
      Object.assign(navigator, { clipboard: { writeText } });

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.handleCopy();
      });

      expect(writeText).not.toHaveBeenCalled();
    });
  });

  describe('revoking a link', () => {
    it('Given DELETE succeeds, should clear activeLink and shareUrl', async () => {
      mockFetchResolve({
        links: [{ id: LINK_ID, role: 'MEMBER', useCount: 2, shareUrl: SHARE_URL, expiresAt: null, createdAt: new Date().toISOString() }],
      });
      vi.mocked(del).mockResolvedValueOnce(undefined);

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.handleRevoke();
      });

      expect(result.current.activeLink).toBeNull();
      expect(result.current.shareUrl).toBeNull();
      expect(toast.success).toHaveBeenCalled();
    });
  });

  describe('role state', () => {
    it('should default role to MEMBER', async () => {
      mockFetchResolve({ links: [] });

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.role).toBe('MEMBER');
    });

    it('should expose setRole to change the role used for generation', async () => {
      mockFetchResolve({ links: [] });

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      act(() => { result.current.setRole('ADMIN'); });

      expect(result.current.role).toBe('ADMIN');
    });
  });
});
