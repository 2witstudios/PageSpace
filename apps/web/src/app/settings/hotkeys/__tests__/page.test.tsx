/**
 * Keyboard Shortcuts settings page — the reset notice.
 *
 * The banner is derived from the preferences payload, so there is no in-memory
 * copy to keep in step and nothing to re-arm it. What is left to get wrong is
 * the destructive half: dismissing deletes the rows that keep the notice alive,
 * and the list it deletes from must come from a fresh read. SWR does not
 * revalidate on focus here, so a tab left open on this page never learns that
 * another tab re-bound the shortcut — deleting from what it is rendering would
 * throw away the binding the user had just set.
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
    updateHotkeyPreference: vi.fn(),
    deleteHotkeyPreference: (id: string) => mockDelete(id),
    fetchHotkeyPreferences: () => mockFetch(),
  };
});

import HotkeysSettingsPage from '../page';

/** Set what the server holds, for both the rendered payload and a fresh read. */
function serverHolds(preferences: { hotkeyId: string; binding: string }[]) {
  mockSWRState.data = { preferences };
  mockFetch.mockImplementation(async () => mockSWRState.data.preferences);
  mockMutate.mockImplementation(async () => mockSWRState.data);
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
    mockDelete.mockResolvedValue(undefined);
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
    const { rerender } = renderPage([{ hotkeyId: 'pages.quick-create', binding: 'Alt+Π' }]);
    mockDelete.mockImplementation(async () => {
      mockSWRState.data = { preferences: [] };
    });

    await clickDismiss();

    expect(mockDelete).toHaveBeenCalledWith('pages.quick-create');
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

  it('given the read fails, should delete nothing rather than guess', async () => {
    renderPage([{ hotkeyId: 'pages.quick-create', binding: 'Alt+Π' }]);
    mockFetch.mockRejectedValue(new Error('offline'));

    await clickDismiss();

    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockToast.error).toHaveBeenCalled();
  });
});
