/**
 * The agent page's read-only gate. Fail-open to editable is the documented
 * intent (the server enforces regardless) — so the property worth pinning is
 * that fail-open holds PER PAGE: one page's read-only verdict must never leak
 * onto the next page when that page's own check errors out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const mockFetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

import { usePermissionsCheck } from '../usePermissionsCheck';

const respondCanEdit = (canEdit: boolean) =>
  mockFetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ canEdit }) });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('usePermissionsCheck', () => {
  it('reports read-only when the viewer cannot edit the page', async () => {
    respondCanEdit(false);
    const { result } = renderHook(() => usePermissionsCheck('page-1', 'user-1'));
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('reports editable when the viewer can edit', async () => {
    respondCanEdit(true);
    const { result } = renderHook(() => usePermissionsCheck('page-1', 'user-1'));
    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/pages/page-1/permissions/check'));
    expect(result.current).toBe(false);
  });

  it('fails open to editable when the check errors', async () => {
    mockFetchWithAuth.mockRejectedValue(new Error('down'));
    const { result } = renderHook(() => usePermissionsCheck('page-1', 'user-1'));
    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it("a page change starts from editable again — the previous page's verdict must not leak", async () => {
    respondCanEdit(false);
    const { result, rerender } = renderHook(
      ({ pageId }) => usePermissionsCheck(pageId, 'user-1'),
      { initialProps: { pageId: 'page-1' } },
    );
    await waitFor(() => expect(result.current).toBe(true));

    // The NEXT page's check errors: fail-open must win, not the stale `true`.
    mockFetchWithAuth.mockRejectedValue(new Error('down'));
    rerender({ pageId: 'page-2' });

    await waitFor(() => expect(result.current).toBe(false));
  });

  it('makes no check without a user, and stays editable', () => {
    const { result } = renderHook(() => usePermissionsCheck('page-1', undefined));
    expect(result.current).toBe(false);
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });
});
