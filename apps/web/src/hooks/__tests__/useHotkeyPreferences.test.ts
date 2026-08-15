/**
 * useHotkeyPreferences Hook Tests
 *
 * Guards the persistence half of stale-binding cleanup: the store decides what
 * it can honour, but the hook is what writes that decision back. A bug here is
 * invisible in the store's own tests — the wrong call silently deletes a
 * shortcut that works, or retries a failed delete on every revalidation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const { mockFetchWithAuth, mockSWRState } = vi.hoisted(() => ({
  mockFetchWithAuth: vi.fn(),
  mockSWRState: { data: undefined as unknown },
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

vi.mock('swr', () => ({
  default: () => ({
    data: mockSWRState.data,
    error: undefined,
    mutate: vi.fn(),
    isLoading: mockSWRState.data === undefined,
  }),
}));

import { useHotkeyPreferences } from '../useHotkeyPreferences';
import { useHotkeyStore, getEffectiveBinding } from '@/stores/useHotkeyStore';

/** Requests the hook made, as [method, body] pairs. */
function writes() {
  return mockFetchWithAuth.mock.calls
    .map(([, init]) => init as RequestInit | undefined)
    .filter((init): init is RequestInit => Boolean(init?.method))
    .map((init) => [init.method, JSON.parse(String(init.body))] as const);
}

describe('useHotkeyPreferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useHotkeyStore.getState().reset();
    mockFetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({}) });
  });

  it('given a legacy binding that still matches, should leave it alone', async () => {
    mockSWRState.data = { preferences: [{ hotkeyId: 'editing.find', binding: 'Ctrl+Shift+?' }] };

    renderHook(() => useHotkeyPreferences());

    expect(writes()).toEqual([]);
    expect(getEffectiveBinding('editing.find')).toBe('Ctrl+Shift+?');
  });

  it('given an unmatchable legacy binding, should delete the row', async () => {
    mockSWRState.data = { preferences: [{ hotkeyId: 'pages.quick-create', binding: 'Alt+Π' }] };

    renderHook(() => useHotkeyPreferences());

    expect(writes()).toContainEqual(['DELETE', { hotkeyId: 'pages.quick-create' }]);
    expect(getEffectiveBinding('pages.quick-create')).toBe('Alt+N');
  });

  it('given a stored bare key, should delete the row', async () => {
    mockSWRState.data = { preferences: [{ hotkeyId: 'pages.quick-create', binding: 'N' }] };

    renderHook(() => useHotkeyPreferences());

    expect(writes()).toContainEqual(['DELETE', { hotkeyId: 'pages.quick-create' }]);
    expect(getEffectiveBinding('pages.quick-create')).toBe('Alt+N');
  });

  it('given only valid bindings, should write nothing', async () => {
    mockSWRState.data = { preferences: [{ hotkeyId: 'pages.quick-create', binding: 'Alt+P' }] };

    renderHook(() => useHotkeyPreferences());

    expect(writes()).toEqual([]);
  });

  it('given a revalidation that still returns the dropped row, should not re-delete it', async () => {
    // A failed delete leaves the row in place. Retrying on every revalidation
    // would hammer the endpoint for as long as the session lasts.
    mockSWRState.data = { preferences: [{ hotkeyId: 'pages.quick-create', binding: 'Alt+Π' }] };

    const { rerender } = renderHook(() => useHotkeyPreferences());
    expect(writes()).toContainEqual(['DELETE', { hotkeyId: 'pages.quick-create' }]);

    mockFetchWithAuth.mockClear();
    mockSWRState.data = { preferences: [{ hotkeyId: 'pages.quick-create', binding: 'Alt+Π' }] };
    rerender();

    expect(writes()).toEqual([]);
  });

  it('given a revalidation after the row is gone, should write nothing and keep the notice', async () => {
    mockSWRState.data = { preferences: [{ hotkeyId: 'pages.quick-create', binding: 'Alt+Π' }] };

    const { rerender } = renderHook(() => useHotkeyPreferences());

    mockFetchWithAuth.mockClear();
    mockSWRState.data = { preferences: [] };
    rerender();

    expect(writes()).toEqual([]);
    // The notice still stands even though the row that caused it is gone.
    expect(useHotkeyStore.getState().resetHotkeys).toContain('pages.quick-create');
  });
});
