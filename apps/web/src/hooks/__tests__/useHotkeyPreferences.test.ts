/**
 * useHotkeyPreferences Hook Tests
 *
 * Guards the persistence half of the stale-binding path: the store decides what
 * it can honour, but the hook is what does — or deliberately does not — write
 * that decision back. The row for a reset shortcut is the only durable record
 * that the reset happened, because the notice lives in an in-memory store. A
 * bug here makes the reset silent for anyone who reloads before opening
 * Keyboard Shortcuts, which is invisible in the store's own tests.
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

  it('given an unmatchable legacy binding, should fall back but keep the row', async () => {
    // Deleting here would work, and would also destroy the only evidence the
    // reset happened — the banner is in-memory, so a reload before the user
    // opens Keyboard Shortcuts would leave them with a changed shortcut and no
    // explanation. The row is removed when they acknowledge the notice.
    mockSWRState.data = { preferences: [{ hotkeyId: 'pages.quick-create', binding: 'Alt+Π' }] };

    renderHook(() => useHotkeyPreferences());

    expect(writes()).toEqual([]);
    expect(getEffectiveBinding('pages.quick-create')).toBe('Alt+N');
    expect(useHotkeyStore.getState().resetHotkeys).toContain('pages.quick-create');
  });

  it('given a stored bare key, should fall back but keep the row', async () => {
    mockSWRState.data = { preferences: [{ hotkeyId: 'pages.quick-create', binding: 'N' }] };

    renderHook(() => useHotkeyPreferences());

    expect(writes()).toEqual([]);
    expect(getEffectiveBinding('pages.quick-create')).toBe('Alt+N');
    expect(useHotkeyStore.getState().resetHotkeys).toContain('pages.quick-create');
  });

  it('given a reload after the reset, should raise the notice again from the row', async () => {
    // The point of keeping the row: a fresh document has an empty store, and
    // the payload is what reconstructs the banner.
    mockSWRState.data = { preferences: [{ hotkeyId: 'pages.quick-create', binding: 'Alt+Π' }] };
    renderHook(() => useHotkeyPreferences());

    // A new document: same server state, brand-new in-memory store.
    useHotkeyStore.getState().reset();
    expect(useHotkeyStore.getState().resetHotkeys).toEqual([]);

    renderHook(() => useHotkeyPreferences());

    expect(useHotkeyStore.getState().resetHotkeys).toContain('pages.quick-create');
  });

  it('given only valid bindings, should write nothing', async () => {
    mockSWRState.data = { preferences: [{ hotkeyId: 'pages.quick-create', binding: 'Alt+P' }] };

    renderHook(() => useHotkeyPreferences());

    expect(writes()).toEqual([]);
    expect(useHotkeyStore.getState().resetHotkeys).toEqual([]);
  });

  it('given a revalidation that no longer returns the row, should keep the notice', async () => {
    // Acknowledging clears the notice and deletes the row. A revalidation that
    // lands in between must not erase a notice the user has not read.
    mockSWRState.data = { preferences: [{ hotkeyId: 'pages.quick-create', binding: 'Alt+Π' }] };

    const { rerender } = renderHook(() => useHotkeyPreferences());

    mockFetchWithAuth.mockClear();
    mockSWRState.data = { preferences: [] };
    rerender();

    expect(writes()).toEqual([]);
    expect(useHotkeyStore.getState().resetHotkeys).toContain('pages.quick-create');
  });
});
