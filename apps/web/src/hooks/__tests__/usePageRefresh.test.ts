/**
 * usePageRefresh — specifically `managesOwnScroll`, the signal `CenterPanel`
 * uses to skip its own `overflow-auto` wrapper for AI_CHAT/CHANNEL pages
 * (they manage their own internal scroll; double-wrapping breaks it, see
 * `CenterPanel.tsx`).
 *
 * The property under test: a page not yet in the tree (freshly created, or a
 * deep link) still renders via `CenterPanel`'s `/api/pages/${pageId}`
 * fallback fetch — this hook must reach the SAME page-type conclusion via its
 * own mirrored fallback, not silently default to "unknown" and double-wrap a
 * fallback-rendered chat page's scroll until it happens to land in the tree
 * (review finding — chatgpt-codex-connector on PR #2296).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const mockUseParams = vi.fn<() => { driveId?: string; pageId?: string }>(() => ({}));
const mockUsePathname = vi.fn(() => '/dashboard/drive-1/page-1');
vi.mock('next/navigation', () => ({
  useParams: () => mockUseParams(),
  usePathname: () => mockUsePathname(),
}));

const mockUsePageTree = vi.fn();
vi.mock('../usePageTree', () => ({
  usePageTree: (...args: unknown[]) => mockUsePageTree(...args),
}));

const mockFetchWithAuth = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

import { usePageRefresh } from '../usePageRefresh';

const treePageFixture = (overrides: Partial<{ id: string; type: string }> = {}) => ({
  id: 'page-1',
  title: 'Fixture',
  type: 'DOCUMENT',
  driveId: 'drive-1',
  children: [],
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockUseParams.mockReturnValue({ driveId: 'drive-1', pageId: 'page-1' });
  mockUsePathname.mockReturnValue('/dashboard/drive-1/page-1');
  mockUsePageTree.mockReturnValue({ tree: [], isLoading: false, mutate: vi.fn() });
  mockFetchWithAuth.mockResolvedValue({ ok: true, json: async () => treePageFixture() });
});

describe('usePageRefresh — managesOwnScroll', () => {
  it('is true for an AI_CHAT page already present in the tree', () => {
    mockUsePageTree.mockReturnValue({
      tree: [treePageFixture({ type: 'AI_CHAT' })],
      isLoading: false,
      mutate: vi.fn(),
    });

    const { result } = renderHook(() => usePageRefresh());

    expect(result.current.managesOwnScroll).toBe(true);
    // Fallback fetch must not fire when the tree already answered.
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });

  it('is false for a DOCUMENT page already present in the tree', () => {
    mockUsePageTree.mockReturnValue({
      tree: [treePageFixture({ type: 'DOCUMENT' })],
      isLoading: false,
      mutate: vi.fn(),
    });

    const { result } = renderHook(() => usePageRefresh());

    expect(result.current.managesOwnScroll).toBe(false);
  });

  it('is true for an AI_CHAT page NOT yet in the tree, once the fallback fetch resolves', async () => {
    // Empty tree (settled, not loading) — the page is missing, exactly the
    // shape a freshly created page or a deep link produces.
    mockUsePageTree.mockReturnValue({ tree: [], isLoading: false, mutate: vi.fn() });
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      json: async () => treePageFixture({ type: 'AI_CHAT' }),
    });

    const { result } = renderHook(() => usePageRefresh());

    // Before the fallback resolves, the hook has no page-type answer yet —
    // it must not default to "false" (that would be the double-wrap bug,
    // just delayed instead of permanent).
    await waitFor(() => expect(result.current.managesOwnScroll).toBe(true));
    expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/pages/page-1');
  });

  it('does not fetch the fallback while the tree is still loading', () => {
    mockUsePageTree.mockReturnValue({ tree: [], isLoading: true, mutate: vi.fn() });

    renderHook(() => usePageRefresh());

    // A page absent from a tree that hasn't finished its FIRST load is not
    // yet "missing" — it just hasn't arrived. Fetching now would race the
    // tree's own request for the same answer.
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });

  it('does not fetch the fallback when there is no pageId', () => {
    mockUseParams.mockReturnValue({ driveId: 'drive-1' });
    mockUsePageTree.mockReturnValue({ tree: [], isLoading: false, mutate: vi.fn() });

    renderHook(() => usePageRefresh());

    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });
});
