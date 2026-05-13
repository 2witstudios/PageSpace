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

  describe('loading existing link', () => {
    it('Given GET returns a link with shareUrl, should populate activeLink and shareUrl', async () => {
      mockFetchResolve({
        links: [{ id: LINK_ID, permissions: ['VIEW'], useCount: 5, shareUrl: SHARE_URL, expiresAt: null, createdAt: new Date().toISOString() }],
      });

      const { result } = renderHook(() => usePageShareLink(PAGE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.activeLink?.id).toBe(LINK_ID);
      expect(result.current.activeLink?.permissions).toEqual(['VIEW']);
      expect(result.current.shareUrl).toBe(SHARE_URL);
    });

    it('Given GET returns a VIEW+EDIT link, should expose permissions correctly', async () => {
      mockFetchResolve({
        links: [{ id: LINK_ID, permissions: ['VIEW', 'EDIT'], useCount: 0, shareUrl: SHARE_URL, expiresAt: null, createdAt: new Date().toISOString() }],
      });

      const { result } = renderHook(() => usePageShareLink(PAGE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.activeLink?.permissions).toEqual(['VIEW', 'EDIT']);
    });

    it('Given GET returns malformed data (permissions is not an array), should treat as no active link', async () => {
      mockFetchResolve({ links: [{ id: LINK_ID, permissions: 'VIEW', useCount: 0 }] });

      const { result } = renderHook(() => usePageShareLink(PAGE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.activeLink).toBeNull();
    });

    it('Given GET fails, should finish loading with no active link', async () => {
      mockFetchReject();

      const { result } = renderHook(() => usePageShareLink(PAGE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.activeLink).toBeNull();
    });
  });

  describe('generating a link', () => {
    it('Given POST succeeds with VIEW permissions, should update shareUrl and activeLink', async () => {
      mockFetchResolve({ links: [] });
      vi.mocked(post).mockResolvedValueOnce({
        id: LINK_ID,
        rawToken: 'ps_share_abc',
        shareUrl: SHARE_URL,
      });

      const { result } = renderHook(() => usePageShareLink(PAGE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });

      await act(async () => {
        await result.current.handleGenerate();
      });

      expect(result.current.shareUrl).toBe(SHARE_URL);
      expect(result.current.activeLink?.permissions).toEqual(['VIEW']);
    });

    it('Given includeEdit is true before generate, should include EDIT in permissions body', async () => {
      mockFetchResolve({ links: [] });
      vi.mocked(post).mockResolvedValueOnce({ id: LINK_ID, rawToken: 'tok', shareUrl: SHARE_URL });
      Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });

      const { result } = renderHook(() => usePageShareLink(PAGE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      act(() => { result.current.setIncludeEdit(true); });

      await act(async () => {
        await result.current.handleGenerate();
      });

      expect(vi.mocked(post)).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ permissions: ['VIEW', 'EDIT'] })
      );
    });
  });

  describe('copying a link', () => {
    it('Given shareUrl is set, handleCopy should write shareUrl to clipboard', async () => {
      mockFetchResolve({
        links: [{ id: LINK_ID, permissions: ['VIEW'], useCount: 0, shareUrl: SHARE_URL, expiresAt: null, createdAt: new Date().toISOString() }],
      });
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });

      const { result } = renderHook(() => usePageShareLink(PAGE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.handleCopy();
      });

      expect(writeText).toHaveBeenCalledWith(SHARE_URL);
    });
  });

  describe('revoking a link', () => {
    it('Given DELETE succeeds, should clear activeLink and shareUrl', async () => {
      mockFetchResolve({
        links: [{ id: LINK_ID, permissions: ['VIEW'], useCount: 1, shareUrl: SHARE_URL, expiresAt: null, createdAt: new Date().toISOString() }],
      });
      vi.mocked(del).mockResolvedValueOnce(undefined);

      const { result } = renderHook(() => usePageShareLink(PAGE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      await act(async () => {
        await result.current.handleRevoke();
      });

      expect(result.current.activeLink).toBeNull();
      expect(result.current.shareUrl).toBeNull();
    });
  });

  describe('includeEdit state', () => {
    it('should default includeEdit to false', async () => {
      mockFetchResolve({ links: [] });

      const { result } = renderHook(() => usePageShareLink(PAGE_ID));
      await waitFor(() => expect(result.current.isLoading).toBe(false));

      expect(result.current.includeEdit).toBe(false);
    });
  });
});
