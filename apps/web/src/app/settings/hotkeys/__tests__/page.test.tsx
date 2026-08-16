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

const { mockMutate, mockDelete, mockSWRState, mockToast } = vi.hoisted(() => ({
  mockMutate: vi.fn(),
  mockDelete: vi.fn(),
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
}));

import HotkeysSettingsPage from '../page';
import { useHotkeyStore } from '@/stores/useHotkeyStore';

/** Load a payload the way the hook's effect would, then render the page. */
function loadAndRender(preferences: { hotkeyId: string; binding: string }[]) {
  mockSWRState.data = { preferences };
  useHotkeyStore.getState().setUserBindings(preferences);
  render(<HotkeysSettingsPage />);
}

async function clickDismiss() {
  await act(async () => {
    screen.getByRole('button', { name: 'Dismiss' }).click();
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
    mockMutate.mockResolvedValue({
      preferences: [{ hotkeyId: 'pages.quick-create', binding: 'Ctrl+Shift+J' }],
    });

    return clickDismiss().then(() => {
      expect(mockDelete).not.toHaveBeenCalled();
      expect(useHotkeyStore.getState().resetHotkeys).toEqual([]);
    });
  });

  it('given the row is still unusable, should delete it', async () => {
    loadAndRender([{ hotkeyId: 'pages.quick-create', binding: 'Alt+Π' }]);
    mockMutate.mockResolvedValue({
      preferences: [{ hotkeyId: 'pages.quick-create', binding: 'Alt+Π' }],
    });

    await clickDismiss();

    expect(mockDelete).toHaveBeenCalledWith('pages.quick-create');
    expect(useHotkeyStore.getState().resetHotkeys).toEqual([]);
  });

  it('given a delete that fails, should say so rather than let the notice creep back', async () => {
    loadAndRender([{ hotkeyId: 'pages.quick-create', binding: 'Alt+Π' }]);
    mockMutate.mockResolvedValue({
      preferences: [{ hotkeyId: 'pages.quick-create', binding: 'Alt+Π' }],
    });
    mockDelete.mockRejectedValue(new Error('offline'));

    await clickDismiss();

    expect(mockToast.error).toHaveBeenCalled();
  });

  it('given no reset happened, should not show the notice at all', () => {
    loadAndRender([{ hotkeyId: 'pages.quick-create', binding: 'Alt+P' }]);

    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });
});
