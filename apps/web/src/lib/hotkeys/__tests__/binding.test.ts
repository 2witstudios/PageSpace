import { describe, it, expect } from 'vitest';
import {
  eventToBinding,
  formatBindingForDisplay,
  hasModifier,
  isCanonicalBinding,
  keyFromCode,
  migrateLegacyBinding,
} from '../binding';
import { HOTKEY_REGISTRY } from '../registry';

function keyEvent(overrides: Partial<KeyboardEvent> & { key: string }) {
  return {
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    code: undefined,
    ...overrides,
  } as unknown as KeyboardEvent;
}

describe('keyFromCode', () => {
  it('given a letter code, should return the uppercase letter', () => {
    expect(keyFromCode('KeyP', 'p')).toBe('P');
  });

  it('given a digit code, should return the digit regardless of shift symbol', () => {
    expect(keyFromCode('Digit1', '!')).toBe('1');
  });

  it('given a named code, should return the code', () => {
    expect(keyFromCode('Tab', 'Tab')).toBe('Tab');
    expect(keyFromCode('ArrowUp', 'ArrowUp')).toBe('ArrowUp');
  });

  it('given a punctuation code, should return the character', () => {
    expect(keyFromCode('Slash', '/')).toBe('/');
  });

  it('given no code, should fall back to the key', () => {
    expect(keyFromCode(undefined, 'k')).toBe('K');
    expect(keyFromCode(undefined, 'Tab')).toBe('Tab');
  });

  it('given a modifier-only press with no usable code, should return empty', () => {
    expect(keyFromCode(undefined, 'Shift')).toBe('');
  });
});

describe('eventToBinding', () => {
  it('given macOS Option+P where e.key is the composed character, should record the physical key', () => {
    // This is the bug: Option mutates e.key ("π") while e.code stays "KeyP".
    const binding = eventToBinding(keyEvent({ altKey: true, key: 'π', code: 'KeyP' }));
    expect(binding).toBe('Alt+P');
  });

  it('given macOS Option+N which reports a dead key, should record the physical key', () => {
    const binding = eventToBinding(keyEvent({ altKey: true, key: 'Dead', code: 'KeyN' }));
    expect(binding).toBe('Alt+N');
  });

  it('given Shift+1, should record the digit rather than the shifted symbol', () => {
    const binding = eventToBinding(keyEvent({ shiftKey: true, key: '!', code: 'Digit1' }));
    expect(binding).toBe('Shift+1');
  });

  it('given all modifiers, should emit them in canonical order', () => {
    const binding = eventToBinding(
      keyEvent({ ctrlKey: true, metaKey: true, altKey: true, shiftKey: true, key: 'k', code: 'KeyK' })
    );
    expect(binding).toBe('Ctrl+Meta+Alt+Shift+K');
  });

  it('given a modifiers-only press, should return empty', () => {
    expect(eventToBinding(keyEvent({ metaKey: true, key: 'Meta', code: 'MetaLeft' }))).toBe('');
  });
});

describe('isCanonicalBinding', () => {
  it('given every registry default, should accept it', () => {
    for (const hotkey of HOTKEY_REGISTRY) {
      expect(isCanonicalBinding(hotkey.defaultBinding), hotkey.id).toBe(true);
    }
  });

  it('given a binding written from a mutated macOS key, should reject it', () => {
    expect(isCanonicalBinding('Alt+Π')).toBe(false);
    expect(isCanonicalBinding('Alt+†')).toBe(false);
  });

  it('given an unknown or misordered modifier, should reject it', () => {
    expect(isCanonicalBinding('Cmd+K')).toBe(false);
    expect(isCanonicalBinding('Shift+Ctrl+K')).toBe(false);
    expect(isCanonicalBinding('Ctrl+Ctrl+K')).toBe(false);
  });

  it('given an empty binding, should reject it (callers treat empty as disabled)', () => {
    expect(isCanonicalBinding('')).toBe(false);
  });
});

describe('hasModifier', () => {
  it('given a bare key, should return false', () => {
    expect(hasModifier('K')).toBe(false);
  });

  it('given a modified key, should return true', () => {
    expect(hasModifier('Meta+K')).toBe(true);
  });
});

describe('migrateLegacyBinding', () => {
  it('given a shifted punctuation binding that used to work, should map it to the physical key', () => {
    expect(migrateLegacyBinding('Ctrl+Shift+?')).toBe('Ctrl+Shift+/');
    expect(migrateLegacyBinding('Ctrl+Shift+_')).toBe('Ctrl+Shift+-');
    expect(migrateLegacyBinding('Meta+Shift+{')).toBe('Meta+Shift+[');
  });

  it('given a shifted digit binding, should map it to the digit', () => {
    expect(migrateLegacyBinding('Ctrl+Shift+!')).toBe('Ctrl+Shift+1');
  });

  it('given a legacy space binding, should map it to Space', () => {
    expect(migrateLegacyBinding('Ctrl+ ')).toBe('Ctrl+Space');
  });

  it('given an already-canonical binding, should return it unchanged', () => {
    expect(migrateLegacyBinding('Meta+K')).toBe('Meta+K');
  });

  it('given an Option-composed binding that never matched, should return null', () => {
    expect(migrateLegacyBinding('Alt+Π')).toBeNull();
    expect(migrateLegacyBinding('Alt+†')).toBeNull();
  });

  it('given an empty binding, should return null', () => {
    expect(migrateLegacyBinding('')).toBeNull();
  });
});

describe('formatBindingForDisplay', () => {
  it('given a Mac, should use symbols', () => {
    expect(formatBindingForDisplay('Meta+Shift+K', true)).toBe('⌘⇧K');
  });

  it('given a non-Mac, should keep the plain form', () => {
    expect(formatBindingForDisplay('Ctrl+Shift+K', false)).toBe('Ctrl+Shift+K');
  });
});
