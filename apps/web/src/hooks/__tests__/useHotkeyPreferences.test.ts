/**
 * useHotkeyPreferences Hook Tests
 *
 * Guards the persistence half of the legacy-binding migration: the store
 * decides what to salvage and what to drop, but the hook is what writes those
 * decisions back. A bug here is invisible in the store's own tests — the user
 * would silently re-migrate on every single load.
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

  it('given a salvageable legacy binding, should persist the rewritten form', async () => {
    mockSWRState.data = { preferences: [{ hotkeyId: 'editing.find', binding: 'Ctrl+Shift+?' }] };

    renderHook(() => useHotkeyPreferences());

    expect(writes()).toContainEqual([
      'PATCH',
      { hotkeyId: 'editing.find', binding: 'Ctrl+Shift+/' },
    ]);
    expect(getEffectiveBinding('editing.find')).toBe('Ctrl+Shift+/');
  });

  it('given an unmatchable legacy binding, should delete the row rather than rewrite it', async () => {
    mockSWRState.data = { preferences: [{ hotkeyId: 'pages.quick-create', binding: 'Alt+Π' }] };

    renderHook(() => useHotkeyPreferences());

    expect(writes()).toContainEqual(['DELETE', { hotkeyId: 'pages.quick-create' }]);
    expect(writes().some(([method]) => method === 'PATCH')).toBe(false);
    expect(getEffectiveBinding('pages.quick-create')).toBe('Alt+N');
  });

  it('given only valid bindings, should write nothing', async () => {
    mockSWRState.data = { preferences: [{ hotkeyId: 'pages.quick-create', binding: 'Alt+P' }] };

    renderHook(() => useHotkeyPreferences());

    expect(writes()).toEqual([]);
  });

  it('given a revalidation after the migration landed, should write nothing more', async () => {
    mockSWRState.data = { preferences: [{ hotkeyId: 'editing.find', binding: 'Ctrl+Shift+?' }] };

    const { rerender } = renderHook(() => useHotkeyPreferences());
    expect(writes().filter(([method]) => method === 'PATCH')).toHaveLength(1);

    // SWR revalidates and returns a fresh object holding the migrated value.
    mockFetchWithAuth.mockClear();
    mockSWRState.data = { preferences: [{ hotkeyId: 'editing.find', binding: 'Ctrl+Shift+/' }] };
    rerender();

    expect(writes()).toEqual([]);
  });

  it('given a revalidation that still returns the dropped row, should not re-delete it', async () => {
    mockSWRState.data = { preferences: [{ hotkeyId: 'pages.quick-create', binding: 'Alt+Π' }] };

    const { rerender } = renderHook(() => useHotkeyPreferences());
    expect(writes()).toContainEqual(['DELETE', { hotkeyId: 'pages.quick-create' }]);

    // Once the row is gone the payload is clean — nothing left to clean up.
    mockFetchWithAuth.mockClear();
    mockSWRState.data = { preferences: [] };
    rerender();

    expect(writes()).toEqual([]);
    // The notice still stands even though the row that caused it is gone.
    expect(useHotkeyStore.getState().resetHotkeys).toContain('pages.quick-create');
  });
});
