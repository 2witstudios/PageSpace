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
import { useDriveShareLink, type DriveLink } from '../useDriveShareLink';

const DRIVE_ID = 'drive-abc';
const LINK_ID = 'link-123';
const LINK_ID_2 = 'link-456';
const SHARE_URL = 'https://app.pagespace.ai/s/ps_share_xyz';
const SHARE_URL_2 = 'https://app.pagespace.ai/s/ps_share_abc';

const MEMBER_LINK: DriveLink = { id: LINK_ID, role: 'MEMBER', useCount: 3, shareUrl: SHARE_URL };
const ADMIN_LINK: DriveLink = { id: LINK_ID_2, role: 'ADMIN', useCount: 1, shareUrl: SHARE_URL_2 };

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

  describe('loading existing links', () => {
    it('Given GET returns links, should populate links list', async () => {
      mockFetchResolve({ links: [MEMBER_LINK] });

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));

      expect(result.current.isLoading).toBe(true);

      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.links).toHaveLength(1);
      expect(result.current.links[0].id).toBe(LINK_ID);
      expect(result.current.links[0].role).toBe('MEMBER');
      expect(result.current.links[0].shareUrl).toBe(SHARE_URL);
    });

    it('Given GET returns multiple links, should populate all in list', async () => {
      mockFetchResolve({ links: [MEMBER_LINK, ADMIN_LINK] });

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.links).toHaveLength(2);
      expect(result.current.links[0].id).toBe(LINK_ID);
      expect(result.current.links[1].id).toBe(LINK_ID_2);
    });

    it('Given GET returns an empty list, should have empty links array', async () => {
      mockFetchResolve({ links: [] });

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.links).toHaveLength(0);
    });

    it('Given GET returns a link with null shareUrl, should include it in list', async () => {
      mockFetchResolve({
        links: [{ id: LINK_ID, role: 'ADMIN', useCount: 0, shareUrl: null }],
      });

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.links).toHaveLength(1);
      expect(result.current.links[0].shareUrl).toBeNull();
    });

    it('Given GET returns malformed data (missing id), should leave links empty', async () => {
      mockFetchResolve({ links: [{ role: 'MEMBER', useCount: 0 }] });

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.links).toHaveLength(0);
    });

    it('Given GET fails with network error, should finish loading with empty links', async () => {
      mockFetchReject();

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.links).toHaveLength(0);
    });
  });

  describe('generating a link', () => {
    it('Given POST succeeds, should append new link to list', async () => {
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

      expect(result.current.links).toHaveLength(1);
      expect(result.current.links[0].id).toBe(LINK_ID);
      expect(result.current.links[0].role).toBe('MEMBER');
      expect(result.current.links[0].shareUrl).toBe(SHARE_URL);
    });

    it('Given existing links, POST should append without removing existing', async () => {
      mockFetchResolve({ links: [MEMBER_LINK] });
      vi.mocked(post).mockResolvedValueOnce({
        id: LINK_ID_2,
        rawToken: 'ps_share_abc',
        shareUrl: SHARE_URL_2,
      });

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });

      act(() => { result.current.setRole('ADMIN'); });

      await act(async () => {
        await result.current.handleGenerate();
      });

      expect(result.current.links).toHaveLength(2);
      expect(result.current.links[1].id).toBe(LINK_ID_2);
      expect(result.current.links[1].role).toBe('ADMIN');
    });

    it('Given POST fails, should not update links list', async () => {
      mockFetchResolve({ links: [] });
      vi.mocked(post).mockRejectedValueOnce(new Error('server error'));

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.handleGenerate();
      });

      expect(result.current.links).toHaveLength(0);
      expect(toast.error).toHaveBeenCalled();
    });
  });

  describe('copying a link', () => {
    it('Given a link with shareUrl, handleCopy should write that shareUrl to clipboard', async () => {
      mockFetchResolve({ links: [MEMBER_LINK] });
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.handleCopy(result.current.links[0]);
      });

      expect(writeText).toHaveBeenCalledWith(SHARE_URL);
      expect(toast.success).toHaveBeenCalled();
    });

    it('Given a link with null shareUrl, handleCopy should do nothing', async () => {
      const nullUrlLink: DriveLink = { id: LINK_ID, role: 'MEMBER', useCount: 0, shareUrl: null };
      mockFetchResolve({ links: [nullUrlLink] });
      const writeText = vi.fn();
      Object.assign(navigator, { clipboard: { writeText } });

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.handleCopy(result.current.links[0]);
      });

      expect(writeText).not.toHaveBeenCalled();
    });

    it('Given multiple links, handleCopy copies only the specified link URL', async () => {
      mockFetchResolve({ links: [MEMBER_LINK, ADMIN_LINK] });
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.handleCopy(result.current.links[1]);
      });

      expect(writeText).toHaveBeenCalledWith(SHARE_URL_2);
    });
  });

  describe('revoking a link', () => {
    it('Given DELETE succeeds, should remove revoked link from list', async () => {
      mockFetchResolve({ links: [MEMBER_LINK] });
      vi.mocked(del).mockResolvedValueOnce(undefined);

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.handleRevoke(LINK_ID);
      });

      expect(result.current.links).toHaveLength(0);
      expect(toast.success).toHaveBeenCalled();
    });

    it('Given multiple links, revoking one should leave the other', async () => {
      mockFetchResolve({ links: [MEMBER_LINK, ADMIN_LINK] });
      vi.mocked(del).mockResolvedValueOnce(undefined);

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.handleRevoke(LINK_ID);
      });

      expect(result.current.links).toHaveLength(1);
      expect(result.current.links[0].id).toBe(LINK_ID_2);
    });

    it('Given DELETE fails, should keep link in list and show error', async () => {
      mockFetchResolve({ links: [MEMBER_LINK] });
      vi.mocked(del).mockRejectedValueOnce(new Error('server error'));

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.handleRevoke(LINK_ID);
      });

      expect(result.current.links).toHaveLength(1);
      expect(toast.error).toHaveBeenCalled();
    });

    it('revokingId should be set during DELETE and cleared after', async () => {
      mockFetchResolve({ links: [MEMBER_LINK] });
      let resolveDelete!: () => void;
      vi.mocked(del).mockReturnValueOnce(new Promise<void>(res => { resolveDelete = res; }));

      const { result } = renderHook(() => useDriveShareLink(DRIVE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      act(() => { result.current.handleRevoke(LINK_ID); });
      expect(result.current.revokingId).toBe(LINK_ID);

      await act(async () => { resolveDelete(); });
      expect(result.current.revokingId).toBeNull();
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
