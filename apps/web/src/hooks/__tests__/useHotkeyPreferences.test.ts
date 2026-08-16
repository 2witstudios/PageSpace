/**
 * useHotkeyPreferences Hook Tests
 *
 * Two things, both about the same decision: the row for a reset shortcut is
 * left on the server, and the notice is derived from it.
 *
 * The hook must not delete it — that row is the durable record that the reset
 * happened, and deleting it on load makes the reset silent for anyone who
 * reloads before opening Keyboard Shortcuts. `unusablePreferences` is the
 * derivation: what the banner shows is a pure function of the payload, which
 * is what stops it going stale, re-arming itself, or outliving a logout.
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

import {
  useHotkeyPreferences,
  unusablePreferences,
  deleteHotkeyPreference,
} from '../useHotkeyPreferences';
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
  });

  it('given a stored bare key, should fall back but keep the row', async () => {
    mockSWRState.data = { preferences: [{ hotkeyId: 'pages.quick-create', binding: 'N' }] };

    renderHook(() => useHotkeyPreferences());

    expect(writes()).toEqual([]);
    expect(getEffectiveBinding('pages.quick-create')).toBe('Alt+N');
  });

  it('given only valid bindings, should write nothing', async () => {
    mockSWRState.data = { preferences: [{ hotkeyId: 'pages.quick-create', binding: 'Alt+P' }] };

    renderHook(() => useHotkeyPreferences());

    expect(writes()).toEqual([]);
  });

  it('given a revalidation that still returns the row, should still not delete it', async () => {
    // A fresh payload object, so the effect genuinely re-runs — the previous
    // version reused the same reference, so nothing ran and it could not fail.
    mockSWRState.data = { preferences: [{ hotkeyId: 'pages.quick-create', binding: 'Alt+Π' }] };
    const { rerender } = renderHook(() => useHotkeyPreferences());

    mockFetchWithAuth.mockClear();
    mockSWRState.data = {
      preferences: [
        { hotkeyId: 'pages.quick-create', binding: 'Alt+Π' },
        { hotkeyId: 'editing.find', binding: 'N' },
      ],
    };
    rerender();

    expect(writes()).toEqual([]);
    expect(getEffectiveBinding('pages.quick-create')).toBe('Alt+N');
    expect(getEffectiveBinding('editing.find')).toBe('Ctrl+F');
  });
});

describe('deleteHotkeyPreference', () => {
  // The joint between the two ends of the conditional delete. The page passes
  // a second argument and the route honours an `ifBinding` field, but only
  // this line puts one on the wire — and if it stopped, both of those tests
  // would still pass while the delete silently became unconditional again.
  beforeEach(() => {
    vi.clearAllMocks();
    useHotkeyStore.getState().reset();
    mockFetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({}) });
  });

  it('given a binding to match, should send it as ifBinding', async () => {
    await deleteHotkeyPreference('pages.quick-create', 'Alt+Π');

    expect(writes()).toEqual([
      ['DELETE', { hotkeyId: 'pages.quick-create', ifBinding: 'Alt+Π' }],
    ]);
  });

  it('given no binding to match, should omit ifBinding entirely', async () => {
    // The Reset button: delete whatever is stored, unconditionally. Sending
    // `ifBinding: undefined` would be the same on the wire, but sending an
    // empty string would silently make it conditional on a disabled shortcut.
    await deleteHotkeyPreference('pages.quick-create');

    expect(writes()).toEqual([['DELETE', { hotkeyId: 'pages.quick-create' }]]);
  });

  it('given a failure, should throw rather than report a delete that did not happen', async () => {
    mockFetchWithAuth.mockResolvedValue({ ok: false, json: async () => ({}) });

    await expect(deleteHotkeyPreference('pages.quick-create', 'Alt+Π')).rejects.toThrow();
  });
});

describe('unusablePreferences', () => {
  // The banner, as a pure function of the payload.

  it('given a binding that cannot fire, should name it', () => {
    const ids = unusablePreferences([
      { hotkeyId: 'a', binding: 'Alt+Π' },
      { hotkeyId: 'b', binding: 'N' },
      { hotkeyId: 'c', binding: '+' },
      { hotkeyId: 'd', binding: 'Ctrl+CapsLock' },
    ]).map((p) => p.hotkeyId);

    expect(ids).toEqual(['a', 'b', 'c', 'd']);
  });

  it('given a binding that still fires, should leave it out', () => {
    const ids = unusablePreferences([
      { hotkeyId: 'a', binding: 'Alt+P' },
      { hotkeyId: 'b', binding: 'Ctrl+Shift+?' },
      { hotkeyId: 'c', binding: 'Ctrl+Pause' },
      { hotkeyId: 'd', binding: 'Ctrl+NumLock' },
    ]).map((p) => p.hotkeyId);

    expect(ids).toEqual([]);
  });

  it('given a deliberately disabled shortcut, should leave it out', () => {
    // '' is "off", chosen by the user — not a binding that broke.
    expect(unusablePreferences([{ hotkeyId: 'a', binding: '' }])).toEqual([]);
  });

  it('given a payload that re-binds a previously broken shortcut, should say nothing', () => {
    // Another tab re-bound it. There is no second copy of the old answer to go
    // stale, so the notice simply stops being true.
    expect(unusablePreferences([{ hotkeyId: 'a', binding: 'Ctrl+Shift+J' }])).toEqual([]);
  });
});
