/**
 * HotkeyInput Tests
 *
 * The capture widget's escape hatches — Escape to cancel, Backspace/Delete to
 * disable — run before capture does, so they decide which presses can be
 * recorded at all. Ungated, they swallowed every modified Backspace, Delete and
 * Escape combination: the API accepts "Meta+Backspace", so the widget was
 * refusing to produce a binding its own server would have stored.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { HotkeyInput } from '../HotkeyInput';

/** Dispatch a real keydown on window, which is where the widget listens. */
function press(init: Partial<KeyboardEventInit> & { key: string; code?: string }) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
  });
}

describe('HotkeyInput', () => {
  const onSave = vi.fn();
  const onCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given a modified Backspace, should record it rather than disable the hotkey', () => {
    render(<HotkeyInput initialValue="Meta+W" onSave={onSave} onCancel={onCancel} />);

    press({ key: 'Backspace', code: 'Backspace', metaKey: true });

    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByText('Meta+Backspace')).toBeDefined();
  });

  it('given a modified Escape, should record it rather than cancel', () => {
    render(<HotkeyInput initialValue="Meta+W" onSave={onSave} onCancel={onCancel} />);

    press({ key: 'Escape', code: 'Escape', ctrlKey: true, shiftKey: true });

    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByText('Ctrl+Shift+Escape')).toBeDefined();
  });

  it('given a bare Escape, should still cancel', () => {
    render(<HotkeyInput initialValue="Meta+W" onSave={onSave} onCancel={onCancel} />);

    press({ key: 'Escape', code: 'Escape' });

    expect(onCancel).toHaveBeenCalled();
  });

  it('given a bare Backspace, should still disable the hotkey', () => {
    render(<HotkeyInput initialValue="Meta+W" onSave={onSave} onCancel={onCancel} />);

    press({ key: 'Backspace', code: 'Backspace' });

    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByText('Disabled')).toBeDefined();
  });

  it('given a bare letter, should keep capturing and ask for a modifier', () => {
    render(<HotkeyInput initialValue="Meta+W" onSave={onSave} onCancel={onCancel} />);

    press({ key: 'p', code: 'KeyP' });

    expect(screen.getByText('Add a modifier (Ctrl/Cmd/Alt/Shift)')).toBeDefined();
    expect(screen.getByText('Press keys...')).toBeDefined();
  });
});
