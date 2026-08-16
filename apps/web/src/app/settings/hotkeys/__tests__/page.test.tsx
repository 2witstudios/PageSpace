/**
 * Keyboard Shortcuts settings page — the reset notice.
 *
 * Dismissing the notice is a destructive write: it deletes the rows that kept
 * the notice alive across reloads. The list it deletes from must come from a
 * fresh read of the server, never from the in-memory `resetHotkeys`, which
 * accumulates per tab and — with SWR revalidation off for focus — never learns
 * that the shortcut was re-bound somewhere else. Getting that wrong deletes a
 * binding the user had just set.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

const { mockMutate, mockDelete, mockFetch, mockSWRState, mockToast } = vi.hoisted(() => ({
  mockMutate: vi.fn(),
  mockDelete: vi.fn(),
  mockFetch: vi.fn(),
  mockSWRState: { data: { preferences: [] as { hotkeyId: string; binding: string }[] } },
  mockToast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: mockToast }));
vi.mock('@/hooks/useHotkeyPreferences', () => ({
  useHotkeyPreferences: () => ({
    preferences: mockSWRState.data.preferences,
    isLoading: false,
    error: undefined,
    mutate: mockMutate,
  }),
  updateHotkeyPreference: vi.fn(),
  deleteHotkeyPreference: (id: string) => mockDelete(id),
  fetchHotkeyPreferences: () => mockFetch(),
}));

import HotkeysSettingsPage from '../page';
import { useHotkeyStore } from '@/stores/useHotkeyStore';

/**
 * Set what the server holds.
 *
 * `mutate` is modelled the way the real one behaves and the way it broke this
 * page: it revalidates, and the hook's effect then feeds that payload into the
 * store — asynchronously, *after* the caller's continuation. A dismiss flow
 * that reads through `mutate` therefore re-arms the notice from the very rows
 * it is about to delete, whichever order the rest of the handler runs in.
 * `fetchHotkeyPreferences` is the plain read that does not touch the store.
 */
function serverReturns(preferences: { hotkeyId: string; binding: string }[]) {
  mockSWRState.data = { preferences };
  mockFetch.mockImplementation(async () => mockSWRState.data.preferences);
  mockMutate.mockImplementation(async () => {
    const settled = mockSWRState.data;
    setTimeout(() => useHotkeyStore.getState().setUserBindings(settled.preferences), 0);
    return settled;
  });
}

/** Load a payload the way the hook's effect would, then render the page. */
function loadAndRender(preferences: { hotkeyId: string; binding: string }[]) {
  serverReturns(preferences);
  useHotkeyStore.getState().setUserBindings(preferences);
  render(<HotkeysSettingsPage />);
}

async function clickDismiss() {
  await act(async () => {
    screen.getByRole('button', { name: 'Dismiss' }).click();
    // Let any store write the hook's effect would have scheduled land, so a
    // notice that re-arms itself after the handler returns is still visible.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('HotkeysSettingsPage reset notice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useHotkeyStore.getState().reset();
    mockDelete.mockResolvedValue(undefined);
  });

  it('given a shortcut re-bound in another tab, should not delete the new binding', () => {
    // This tab loaded the broken row and still has it in `resetHotkeys`.
    loadAndRender([{ hotkeyId: 'pages.quick-create', binding: 'Alt+Π' }]);
    expect(useHotkeyStore.getState().resetHotkeys).toContain('pages.quick-create');

    // Another tab has since saved a real binding. Dismiss re-reads and finds
    // nothing unusable, so it must delete nothing.
    serverReturns([{ hotkeyId: 'pages.quick-create', binding: 'Ctrl+Shift+J' }]);

    return clickDismiss().then(() => {
      expect(mockDelete).not.toHaveBeenCalled();
      expect(useHotkeyStore.getState().resetHotkeys).toEqual([]);
    });
  });

  it('given the read is taken through SWR, should not re-arm the notice it just cleared', async () => {
    // The regression this guards: reading via `mutate` writes the pre-delete
    // payload back through the hook's effect, which lands after the handler
    // finishes. The banner returned seconds later and — because a payload that
    // omits a row preserves its notice by design — never cleared again.
    loadAndRender([{ hotkeyId: 'pages.quick-create', binding: 'Alt+Π' }]);
    mockDelete.mockImplementation(async () => {
      mockSWRState.data = { preferences: [] };
      useHotkeyStore.getState().removeBinding('pages.quick-create');
    });

    await clickDismiss();

    expect(useHotkeyStore.getState().resetHotkeys).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('given the row is still unusable, should delete it and leave the notice gone', async () => {
    // The read Dismiss takes still contains the row, and its effect feeds the
    // notice back into the store. Clearing before the deletes therefore left
    // the banner re-armed for the rest of the session.
    loadAndRender([{ hotkeyId: 'pages.quick-create', binding: 'Alt+Π' }]);
    mockDelete.mockImplementation(async () => {
      mockSWRState.data = { preferences: [] };
      useHotkeyStore.getState().removeBinding('pages.quick-create');
    });

    await clickDismiss();

    expect(mockDelete).toHaveBeenCalledWith('pages.quick-create');
    expect(useHotkeyStore.getState().resetHotkeys).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('given a delete that fails, should say so and keep the notice standing', async () => {
    loadAndRender([{ hotkeyId: 'pages.quick-create', binding: 'Alt+Π' }]);
    mockDelete.mockRejectedValue(new Error('offline'));

    await clickDismiss();

    expect(mockToast.error).toHaveBeenCalled();
    // The row survived, so the notice must too — silently clearing it would
    // hide a shortcut that is still broken.
    expect(useHotkeyStore.getState().resetHotkeys).toContain('pages.quick-create');
  });

  it('given the read fails, should delete nothing and keep the notice', async () => {
    // Without the current server state there is no safe list to delete from —
    // and clearing the banner anyway would make Dismiss look like it worked
    // until the notice returned on the next load.
    loadAndRender([{ hotkeyId: 'pages.quick-create', binding: 'Alt+Π' }]);
    mockFetch.mockRejectedValue(new Error('offline'));

    await clickDismiss();

    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockToast.error).toHaveBeenCalled();
    expect(useHotkeyStore.getState().resetHotkeys).toContain('pages.quick-create');
  });

  it('given no reset happened, should not show the notice at all', () => {
    loadAndRender([{ hotkeyId: 'pages.quick-create', binding: 'Alt+P' }]);

    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });
});
