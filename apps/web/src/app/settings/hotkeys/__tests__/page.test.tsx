/**
 * Keyboard Shortcuts settings page — the reset notice.
 *
 * The banner is derived from the preferences payload, so there is no in-memory
 * copy to keep in step and nothing to re-arm it. That also means the banner
 * assertions here mostly restate a pure function that `unusablePreferences`
 * already covers directly — they are here to show the wiring, not to guard it.
 *
 * What these tests actually guard is the destructive half, and it is the
 * `mockDelete` and `mockToast` expectations that carry it:
 *
 *  - the list to delete comes from a *fresh* read, never the rendered payload.
 *    SWR does not revalidate on focus here, so a tab left open on this page
 *    never learns another tab re-bound the shortcut, and deleting from what it
 *    is rendering would throw away the binding the user had just set;
 *  - a failure before the deletes is reported and deletes nothing;
 *  - a failure *after* them is not reported, because the dismiss succeeded.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

const { mockMutate, mockDelete, mockFetch, mockSave, mockSWRState, mockToast } = vi.hoisted(() => ({
  mockMutate: vi.fn(),
  mockDelete: vi.fn(),
  mockFetch: vi.fn(),
  mockSave: vi.fn(),
  mockSWRState: {
    data: { preferences: [] as { hotkeyId: string; binding: string }[] },
    /** Make the revalidation half of `mutate` fail, as a flaky network would. */
    revalidationFails: false,
  },
  mockToast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: mockToast }));
vi.mock('@/hooks/useHotkeyPreferences', async (importOriginal) => {
  // `unusablePreferences` is the real thing — it is the subject here.
  const actual = await importOriginal<typeof import('@/hooks/useHotkeyPreferences')>();
  return {
    ...actual,
    useHotkeyPreferences: () => ({
      preferences: mockSWRState.data.preferences,
      isLoading: false,
      error: undefined,
      mutate: mockMutate,
    }),
    updateHotkeyPreference: (id: string, binding: string) => mockSave(id, binding),
    deleteHotkeyPreference: (id: string, ifBinding?: string) => mockDelete(id, ifBinding),
    fetchHotkeyPreferences: () => mockFetch(),
  };
});

import HotkeysSettingsPage from '../page';

/** Set what the server holds, for both the rendered payload and a fresh read. */
function serverHolds(preferences: { hotkeyId: string; binding: string }[]) {
  mockSWRState.data = { preferences };
  mockFetch.mockImplementation(async () => mockSWRState.data.preferences);
  // Model SWR's optimistic form faithfully: the updater rewrites the cache
  // *first*, and a revalidation that fails afterwards leaves that value in
  // place. Nothing else in this file writes the cache, so the banner can only
  // clear through the page's own updater — which is the mechanism under test.
  mockMutate.mockImplementation(async (updater?: unknown) => {
    if (typeof updater === 'function') {
      mockSWRState.data = (updater as (c: unknown) => typeof mockSWRState.data)(mockSWRState.data);
    }
    if (mockSWRState.revalidationFails) throw new Error('offline');
    return mockSWRState.data;
  });
}

function renderPage(preferences: { hotkeyId: string; binding: string }[]) {
  serverHolds(preferences);
  return render(<HotkeysSettingsPage />);
}

async function clickDismiss() {
  await act(async () => {
    screen.getByRole('button', { name: 'Dismiss' }).click();
  });
}

describe('HotkeysSettingsPage reset notice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSWRState.revalidationFails = false;
    // Resolves to whether the row actually went — see `deleteHotkeyPreference`.
    mockDelete.mockResolvedValue(true);
    mockSave.mockResolvedValue(undefined);
  });

  it('given a stored binding that cannot fire, should name it in the notice', () => {
    renderPage([{ hotkeyId: 'pages.quick-create', binding: 'Alt+Π' }]);

    expect(screen.getByText(/"Quick Create Page" was saved in a format/)).toBeDefined();
  });

  it('given only bindings that work, should show no notice', () => {
    renderPage([{ hotkeyId: 'pages.quick-create', binding: 'Alt+P' }]);

    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('given a shortcut re-bound in another tab, should not delete the new binding', async () => {
    // This tab is still rendering the broken row.
    const { rerender } = renderPage([{ hotkeyId: 'pages.quick-create', binding: 'Alt+Π' }]);
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeDefined();

    // The other tab has since saved a real binding. Dismiss re-reads, finds
    // nothing unusable, and must delete nothing.
    mockFetch.mockResolvedValue([{ hotkeyId: 'pages.quick-create', binding: 'Ctrl+Shift+J' }]);
    await clickDismiss();

    expect(mockDelete).not.toHaveBeenCalled();

    // And once this tab catches up, the notice is simply no longer true.
    serverHolds([{ hotkeyId: 'pages.quick-create', binding: 'Ctrl+Shift+J' }]);
    rerender(<HotkeysSettingsPage />);
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('given the row is still unusable, should delete it and let the notice fall away', async () => {
    // The delete deliberately does not touch the cache: the banner may only
    // disappear because the page folded the deletion into the payload itself.
    const { rerender } = renderPage([{ hotkeyId: 'pages.quick-create', binding: 'Alt+Π' }]);

    await clickDismiss();

    expect(mockDelete).toHaveBeenCalledWith('pages.quick-create', 'Alt+Π');
    rerender(<HotkeysSettingsPage />);
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('given a refetch that fails after the rows are gone, should not call it a failure', async () => {
    // The dismiss succeeded — the rows are deleted. A revalidation that fails
    // afterwards must not tell the user to try again, and must not leave the
    // banner up as though nothing happened.
    const { rerender } = renderPage([{ hotkeyId: 'pages.quick-create', binding: 'Alt+Π' }]);
    mockSWRState.revalidationFails = true;

    await clickDismiss();

    expect(mockDelete).toHaveBeenCalledWith('pages.quick-create', 'Alt+Π');
    expect(mockToast.error).not.toHaveBeenCalled();
    rerender(<HotkeysSettingsPage />);
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('given a delete that fails, should say so and leave the notice standing', async () => {
    const { rerender } = renderPage([{ hotkeyId: 'pages.quick-create', binding: 'Alt+Π' }]);
    mockDelete.mockRejectedValue(new Error('offline'));

    await clickDismiss();

    expect(mockToast.error).toHaveBeenCalled();
    // The row survived, so the notice is still true and must still show.
    rerender(<HotkeysSettingsPage />);
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeDefined();
  });

  it('given the shortcut re-bound here, should drop the notice without waiting for a refetch', async () => {
    // The banner tells the user to set the shortcut again. Doing so must take
    // it down now — not whenever a revalidation happens to land, which on a
    // slow connection left it instructing them to do what they had just done.
    mockSWRState.revalidationFails = true;
    const { rerender } = renderPage([{ hotkeyId: 'pages.quick-create', binding: 'Alt+Π' }]);

    await act(async () => {
      screen.getAllByRole('button', { name: 'Alt+N' })[0].click();
    });
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, key: 'π', code: 'KeyP', altKey: true })
      );
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Save' }).click();
    });

    expect(mockSave).toHaveBeenCalledWith('pages.quick-create', 'Alt+P');
    rerender(<HotkeysSettingsPage />);
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('given a save that lands after the read, should leave the new binding alone', async () => {
    // The fresh read narrows the window between deciding a row is unusable and
    // deleting it, but cannot close it. Here the other tab saves *after* the
    // read: the server's condition misses, nothing is deleted, and the payload
    // that comes back carries the shortcut the user just set.
    const { rerender } = renderPage([{ hotkeyId: 'pages.quick-create', binding: 'Alt+Π' }]);

    mockDelete.mockImplementation(async (_id: string, ifBinding?: string) => {
      // The other tab got there first, so the row no longer holds `ifBinding`.
      mockSWRState.data = {
        preferences: [{ hotkeyId: 'pages.quick-create', binding: 'Ctrl+Shift+J' }],
      };
      expect(ifBinding).toBe('Alt+Π');
      return false; // the condition missed, so nothing was removed
    });

    await clickDismiss();

    rerender(<HotkeysSettingsPage />);
    // The row the other tab saved is still there, so the notice is no longer
    // true and goes — rather than the shortcut being deleted under them.
    expect(mockSWRState.data.preferences).toEqual([
      { hotkeyId: 'pages.quick-create', binding: 'Ctrl+Shift+J' },
    ]);
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('given the read fails, should delete nothing rather than guess', async () => {
    renderPage([{ hotkeyId: 'pages.quick-create', binding: 'Alt+Π' }]);
    mockFetch.mockRejectedValue(new Error('offline'));

    await clickDismiss();

    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockToast.error).toHaveBeenCalled();
  });
});
