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
import { usePageShareLink } from '../usePageShareLink';

const PAGE_ID = 'page-abc';
const LINK_ID = 'link-456';
const SHARE_URL = 'https://app.pagespace.ai/s/ps_share_abc';

function mockFetchResolve(data: unknown) {
  vi.spyOn(global, 'fetch').mockResolvedValueOnce({
    ok: true,
    json: async () => data,
  } as Response);
}

function mockFetchReject() {
  vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('network error'));
}

describe('usePageShareLink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('loading existing links', () => {
    it('Given GET returns a link with shareUrl, should populate links array', async () => {
      mockFetchResolve({
        links: [{ id: LINK_ID, permissions: ['VIEW'], useCount: 5, shareUrl: SHARE_URL }],
      });

      const { result } = renderHook(() => usePageShareLink(PAGE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.links).toHaveLength(1);
      expect(result.current.links[0].id).toBe(LINK_ID);
      expect(result.current.links[0].permissions).toEqual(['VIEW']);
      expect(result.current.links[0].shareUrl).toBe(SHARE_URL);
    });

    it('Given GET returns multiple links, should populate all of them', async () => {
      mockFetchResolve({
        links: [
          { id: 'link-1', permissions: ['VIEW'], useCount: 0, shareUrl: SHARE_URL },
          { id: 'link-2', permissions: ['VIEW', 'EDIT'], useCount: 2, shareUrl: 'https://app.pagespace.ai/s/ps_share_def' },
        ],
      });

      const { result } = renderHook(() => usePageShareLink(PAGE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.links).toHaveLength(2);
    });

    it('Given GET returns a VIEW+EDIT link, should expose permissions correctly', async () => {
      mockFetchResolve({
        links: [{ id: LINK_ID, permissions: ['VIEW', 'EDIT'], useCount: 0, shareUrl: SHARE_URL }],
      });

      const { result } = renderHook(() => usePageShareLink(PAGE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.links[0].permissions).toEqual(['VIEW', 'EDIT']);
    });

    it('Given GET returns malformed data (permissions is not an array), should have empty links', async () => {
      mockFetchResolve({ links: [{ id: LINK_ID, permissions: 'VIEW', useCount: 0 }] });

      const { result } = renderHook(() => usePageShareLink(PAGE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.links).toHaveLength(0);
    });

    it('Given GET fails, should finish loading with empty links', async () => {
      mockFetchReject();

      const { result } = renderHook(() => usePageShareLink(PAGE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.links).toHaveLength(0);
    });
  });

  describe('generating a link', () => {
    it('Given VIEW-only permissions, should POST with only VIEW in permissions array', async () => {
      mockFetchResolve({ links: [] });
      vi.mocked(post).mockResolvedValueOnce({
        id: LINK_ID,
        rawToken: 'ps_share_abc',
        shareUrl: SHARE_URL,
      });
      Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });

      const { result } = renderHook(() => usePageShareLink(PAGE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.handleGenerate({ canView: true, canEdit: false, canShare: false, canDelete: false });
      });

      expect(result.current.links).toHaveLength(1);
      expect(result.current.links[0].permissions).toEqual(['VIEW']);
      expect(vi.mocked(post)).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ permissions: ['VIEW'] })
      );
    });

    it('Given canEdit is true, should include EDIT in permissions body', async () => {
      mockFetchResolve({ links: [] });
      vi.mocked(post).mockResolvedValueOnce({ id: LINK_ID, rawToken: 'tok', shareUrl: SHARE_URL });
      Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });

      const { result } = renderHook(() => usePageShareLink(PAGE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.handleGenerate({ canView: true, canEdit: true, canShare: false, canDelete: false });
      });

      expect(vi.mocked(post)).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ permissions: ['VIEW', 'EDIT'] })
      );
    });

    it('Given canShare and canDelete are true, should include SHARE and DELETE in permissions body', async () => {
      mockFetchResolve({ links: [] });
      vi.mocked(post).mockResolvedValueOnce({ id: LINK_ID, rawToken: 'tok', shareUrl: SHARE_URL });
      Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });

      const { result } = renderHook(() => usePageShareLink(PAGE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.handleGenerate({ canView: true, canEdit: false, canShare: true, canDelete: true });
      });

      expect(vi.mocked(post)).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ permissions: ['VIEW', 'SHARE', 'DELETE'] })
      );
    });

    it('Given all permissions true, should include all four in permissions body', async () => {
      mockFetchResolve({ links: [] });
      vi.mocked(post).mockResolvedValueOnce({ id: LINK_ID, rawToken: 'tok', shareUrl: SHARE_URL });
      Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });

      const { result } = renderHook(() => usePageShareLink(PAGE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.handleGenerate({ canView: true, canEdit: true, canShare: true, canDelete: true });
      });

      expect(vi.mocked(post)).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ permissions: ['VIEW', 'EDIT', 'SHARE', 'DELETE'] })
      );
    });

    it('Given existing links, generating a new link should append to the list', async () => {
      mockFetchResolve({
        links: [{ id: 'link-1', permissions: ['VIEW'], useCount: 0, shareUrl: SHARE_URL }],
      });
      vi.mocked(post).mockResolvedValueOnce({ id: 'link-2', rawToken: 'tok2', shareUrl: 'https://app.pagespace.ai/s/tok2' });
      Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });

      const { result } = renderHook(() => usePageShareLink(PAGE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.handleGenerate({ canView: true, canEdit: false, canShare: false, canDelete: false });
      });

      expect(result.current.links).toHaveLength(2);
    });
  });

  describe('copying a link', () => {
    it('Given a link with shareUrl, handleCopy should write shareUrl to clipboard', async () => {
      mockFetchResolve({
        links: [{ id: LINK_ID, permissions: ['VIEW'], useCount: 0, shareUrl: SHARE_URL }],
      });
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });

      const { result } = renderHook(() => usePageShareLink(PAGE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.handleCopy(result.current.links[0]);
      });

      expect(writeText).toHaveBeenCalledWith(SHARE_URL);
    });
  });

  describe('revoking a link', () => {
    it('Given DELETE succeeds, should remove the link from the list', async () => {
      mockFetchResolve({
        links: [{ id: LINK_ID, permissions: ['VIEW'], useCount: 1, shareUrl: SHARE_URL }],
      });
      vi.mocked(del).mockResolvedValueOnce(undefined);

      const { result } = renderHook(() => usePageShareLink(PAGE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.handleRevoke(LINK_ID);
      });

      expect(result.current.links).toHaveLength(0);
    });

    it('Given two links, revoking one should leave the other intact', async () => {
      mockFetchResolve({
        links: [
          { id: 'link-1', permissions: ['VIEW'], useCount: 0, shareUrl: SHARE_URL },
          { id: 'link-2', permissions: ['VIEW', 'EDIT'], useCount: 0, shareUrl: 'https://other.url' },
        ],
      });
      vi.mocked(del).mockResolvedValueOnce(undefined);

      const { result } = renderHook(() => usePageShareLink(PAGE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.handleRevoke('link-1');
      });

      expect(result.current.links).toHaveLength(1);
      expect(result.current.links[0].id).toBe('link-2');
    });

    it('Given DELETE fails, should keep the link in the list', async () => {
      mockFetchResolve({
        links: [{ id: LINK_ID, permissions: ['VIEW'], useCount: 1, shareUrl: SHARE_URL }],
      });
      vi.mocked(del).mockRejectedValueOnce(new Error('server error'));

      const { result } = renderHook(() => usePageShareLink(PAGE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.handleRevoke(LINK_ID);
      });

      expect(result.current.links).toHaveLength(1);
    });
  });
});
