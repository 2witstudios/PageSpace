/**
 * The whole point of this PR, end to end.
 *
 * Every other test here covers one link: the widget records a string, the
 * validator accepts it, the store keeps it, the matcher fires on it. The bug
 * lived *between* those links — recording used `e.key` ("π") while matching
 * used `e.code` ("p"), so each half was correct in isolation and the shortcut
 * still could not fire.
 *
 * So this file joins them: press a key in the real capture widget, save what it
 * produces through the real store, then dispatch that same press at a real
 * global handler and require it to fire — and require the shortcut it replaced
 * to stop firing, since the second half of the bug was that a broken override
 * killed the default too.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { HotkeyInput } from '../HotkeyInput';
import {
  useHotkeyStore,
  getEffectiveBinding,
  matchesKeyEvent,
} from '@/stores/useHotkeyStore';

const QUICK_CREATE = 'pages.quick-create';

/** A macOS Option press: the OS has already composed `key` away. */
const OPTION_P = { key: 'π', code: 'KeyP', altKey: true } as const;
/** The default this shortcut ships with, pressed the same way. */
const OPTION_N = { key: 'Dead', code: 'KeyN', altKey: true } as const;

function keydown(init: Partial<KeyboardEventInit> & { key: string; code?: string }) {
  return new KeyboardEvent('keydown', { bubbles: true, ...init });
}

/**
 * What a consumer does — QuickCreatePalette, TabBar, CenterPanel and the
 * sidebar all resolve the binding inside the handler exactly like this.
 */
function firesFor(hotkeyId: string, event: KeyboardEvent): boolean {
  return matchesKeyEvent(getEffectiveBinding(hotkeyId), event);
}

/** Record a press in the real widget and return what it would save. */
function recordInWidget(press: Partial<KeyboardEventInit> & { key: string; code?: string }) {
  let saved: string | null = null;
  render(
    <HotkeyInput
      initialValue={getEffectiveBinding(QUICK_CREATE)}
      onSave={(binding) => {
        saved = binding;
      }}
      onCancel={() => {}}
    />
  );

  act(() => {
    window.dispatchEvent(keydown(press));
  });
  act(() => {
    screen.getByRole('button', { name: 'Save' }).click();
  });

  return saved;
}

describe('rebinding a shortcut, end to end', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useHotkeyStore.getState().reset();
  });

  it('given the default, should fire for the press it describes', () => {
    // Baseline: ⌥N opens Quick Create before anyone rebinds anything.
    expect(getEffectiveBinding(QUICK_CREATE)).toBe('Alt+N');
    expect(firesFor(QUICK_CREATE, keydown(OPTION_N))).toBe(true);
  });

  it('given ⌥P recorded in the widget, should fire for ⌥P and stop firing for ⌥N', () => {
    const saved = recordInWidget(OPTION_P);

    // What the old widget wrote here was "Alt+Π", which nothing could match.
    expect(saved).toBe('Alt+P');

    // Save it the way the API response would come back.
    useHotkeyStore.getState().setUserBindings([{ hotkeyId: QUICK_CREATE, binding: saved! }]);

    expect(firesFor(QUICK_CREATE, keydown(OPTION_P))).toBe(true);
    expect(firesFor(QUICK_CREATE, keydown(OPTION_N))).toBe(false);
  });

  it('given the binding the old widget would have written, should fall back to a working default', () => {
    // The state a real user is already in. It cannot fire, so rather than
    // leave the shortcut dead — which is what shipped — the default returns.
    useHotkeyStore.getState().setUserBindings([{ hotkeyId: QUICK_CREATE, binding: 'Alt+Π' }]);

    expect(getEffectiveBinding(QUICK_CREATE)).toBe('Alt+N');
    expect(firesFor(QUICK_CREATE, keydown(OPTION_N))).toBe(true);
  });

  it('given the override is removed, should fire for the default again', () => {
    useHotkeyStore.getState().setUserBindings([{ hotkeyId: QUICK_CREATE, binding: 'Alt+P' }]);
    expect(firesFor(QUICK_CREATE, keydown(OPTION_N))).toBe(false);

    useHotkeyStore.getState().removeBinding(QUICK_CREATE);

    expect(firesFor(QUICK_CREATE, keydown(OPTION_N))).toBe(true);
    expect(firesFor(QUICK_CREATE, keydown(OPTION_P))).toBe(false);
  });

  it('given a shortcut disabled deliberately, should fire for nothing', () => {
    useHotkeyStore.getState().setUserBindings([{ hotkeyId: QUICK_CREATE, binding: '' }]);

    expect(firesFor(QUICK_CREATE, keydown(OPTION_N))).toBe(false);
    expect(firesFor(QUICK_CREATE, keydown(OPTION_P))).toBe(false);
  });
});
