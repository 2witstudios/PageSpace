import { describe, it, expect } from 'vitest';
import {
  eventToBinding,
  formatBindingForDisplay,
  hasModifier,
  isCanonicalBinding,
  resolveEventKey,
} from '../binding';
import { HOTKEY_REGISTRY } from '../registry';
import { matchesKeyEvent } from '@/stores/useHotkeyStore';

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

describe('resolveEventKey', () => {
  it('given a plain letter, should use the character on the keycap', () => {
    expect(resolveEventKey(keyEvent({ key: 'p', code: 'KeyP' }))).toBe('P');
  });

  it('given a non-US layout, should follow the label rather than the position', () => {
    // AZERTY: the key labelled A sits at physical KeyQ. A user who bound
    // "Ctrl+A" means the key they see, so e.key is the correct signal.
    expect(resolveEventKey(keyEvent({ ctrlKey: true, key: 'a', code: 'KeyQ' }))).toBe('A');
  });

  it('given a numpad digit, should resolve the same as the top-row digit', () => {
    // Both report e.key "1", so one binding covers both keys — as it always did.
    expect(resolveEventKey(keyEvent({ key: '1', code: 'Numpad1' }))).toBe('1');
    expect(resolveEventKey(keyEvent({ key: '1', code: 'Digit1' }))).toBe('1');
  });

  it('given Alt held, should fall back to the physical key', () => {
    // macOS composes with Option: ⌥P reports "π", ⌥N reports "Dead".
    expect(resolveEventKey(keyEvent({ altKey: true, key: 'π', code: 'KeyP' }))).toBe('P');
    expect(resolveEventKey(keyEvent({ altKey: true, key: 'Dead', code: 'KeyN' }))).toBe('N');
    expect(resolveEventKey(keyEvent({ altKey: true, key: '¡', code: 'Digit1' }))).toBe('1');
  });

  it('given Alt on a named key, should use the code, which reads the same', () => {
    expect(resolveEventKey(keyEvent({ altKey: true, key: 'Tab', code: 'Tab' }))).toBe('Tab');
  });

  it('given Alt on punctuation, should use the code rather than the composed character', () => {
    // macOS ⌥⇧/ reports "¿" — resolving the whole keyboard through e.code under
    // Alt is what keeps capture and matching in agreement here.
    expect(resolveEventKey(keyEvent({ altKey: true, shiftKey: true, key: '¿', code: 'Slash' }))).toBe('Slash');
  });

  it('given Alt on a modifier key, should return empty', () => {
    expect(resolveEventKey(keyEvent({ altKey: true, key: 'Alt', code: 'AltLeft' }))).toBe('');
  });

  it('given a long-tail named key, should pass the name through', () => {
    expect(resolveEventKey(keyEvent({ key: 'Pause', code: 'Pause' }))).toBe('Pause');
    expect(resolveEventKey(keyEvent({ key: 'PrintScreen' }))).toBe('PrintScreen');
  });

  it('given no code, should fall back to the key', () => {
    expect(resolveEventKey(keyEvent({ key: 'k' }))).toBe('K');
    expect(resolveEventKey(keyEvent({ key: 'Tab' }))).toBe('Tab');
  });

  it('given a modifier-only press, should return empty', () => {
    expect(resolveEventKey(keyEvent({ key: 'Shift', code: 'ShiftLeft' }))).toBe('');
  });
});

describe('eventToBinding', () => {
  it('given macOS Option+P where e.key is the composed character, should record the physical key', () => {
    const binding = eventToBinding(keyEvent({ altKey: true, key: 'π', code: 'KeyP' }));
    expect(binding).toBe('Alt+P');
  });

  it('given macOS Option+N which reports a dead key, should record the physical key', () => {
    const binding = eventToBinding(keyEvent({ altKey: true, key: 'Dead', code: 'KeyN' }));
    expect(binding).toBe('Alt+N');
  });

  it('given a shifted punctuation key, should record the character typed', () => {
    // "Ctrl+Shift+?" is what the old capture stored and what still matches.
    const binding = eventToBinding(keyEvent({ ctrlKey: true, shiftKey: true, key: '?', code: 'Slash' }));
    expect(binding).toBe('Ctrl+Shift+?');
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

  it('given a dead key without Alt, should refuse rather than emit "Dead"', () => {
    // Some layouts report key "Dead" for a plain dead key (´, ^, ~). Only the
    // Alt branch resolves through e.code, so a Ctrl or Shift press here would
    // otherwise capture "Ctrl+Dead" — which the PATCH validator rejects.
    expect(eventToBinding(keyEvent({ ctrlKey: true, key: 'Dead', code: 'Backquote' }))).toBe('');
    expect(eventToBinding(keyEvent({ shiftKey: true, key: 'Dead', code: 'Quote' }))).toBe('');
  });

  it('given an Option press with no e.code, should refuse rather than emit a composed character', () => {
    // A virtual or IME keyboard can report an empty code, which skips the Alt
    // branch of resolveEventKey. Emitting "Alt+Π" here would hand the widget a
    // binding its own PATCH validator rejects with a 400.
    expect(eventToBinding(keyEvent({ altKey: true, key: 'π', code: '' }))).toBe('');
  });
});

describe('capture and validation agree', () => {
  // The invariant the whole module rests on: if the widget can record it, the
  // API must accept it and the store must keep it. Every bug found in review so
  // far has been a violation of exactly this.
  const presses = [
    { name: 'macOS Option+P', ctrlKey: false, metaKey: false, altKey: true, shiftKey: false, key: 'π', code: 'KeyP' },
    { name: 'macOS Option+Shift+/', ctrlKey: false, metaKey: false, altKey: true, shiftKey: true, key: '¿', code: 'Slash' },
    { name: 'macOS Option+N (dead key)', ctrlKey: false, metaKey: false, altKey: true, shiftKey: false, key: 'Dead', code: 'KeyN' },
    { name: 'macOS Option+1', ctrlKey: false, metaKey: false, altKey: true, shiftKey: false, key: '¡', code: 'Digit1' },
    { name: 'Alt+Tab', ctrlKey: false, metaKey: false, altKey: true, shiftKey: false, key: 'Tab', code: 'Tab' },
    { name: 'Ctrl+Shift+= (types "+")', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true, key: '+', code: 'Equal' },
    { name: 'Ctrl+Shift+?', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true, key: '?', code: 'Slash' },
    { name: 'AZERTY Ctrl+A', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, key: 'a', code: 'KeyQ' },
    { name: 'Meta+1 from the numpad', ctrlKey: false, metaKey: true, altKey: false, shiftKey: false, key: '1', code: 'Numpad1' },
    { name: 'Ctrl+Pause', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, key: 'Pause', code: 'Pause' },
    { name: 'Ctrl+ArrowUp', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, key: 'ArrowUp', code: 'ArrowUp' },
    { name: 'Meta+Shift+Tab', ctrlKey: false, metaKey: true, altKey: false, shiftKey: true, key: 'Tab', code: 'Tab' },
    { name: 'Meta+Backspace', ctrlKey: false, metaKey: true, altKey: false, shiftKey: false, key: 'Backspace', code: 'Backspace' },
    { name: 'Ctrl+Space', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, key: ' ', code: 'Space' },
    { name: 'macOS Option+1 from the numpad', ctrlKey: false, metaKey: false, altKey: true, shiftKey: false, key: '¡', code: 'Numpad1' },
  ];

  for (const press of presses) {
    it(`given ${press.name}, what is captured should validate and match`, () => {
      const event = keyEvent(press as unknown as Partial<KeyboardEvent> & { key: string });
      const captured = eventToBinding(event);

      // `eventToBinding` refuses anything non-canonical, so asserting
      // `isCanonicalBinding(captured)` here would be a tautology. The two legs
      // worth asserting are that the press was recordable at all, and that the
      // runtime matcher fires on the string that was recorded.
      expect(captured, 'should capture something').not.toBe('');
      expect(hasModifier(captured), `${captured} should carry a modifier`).toBe(true);
      expect(matchesKeyEvent(captured, event), `${captured} should match its own press`).toBe(true);
    });
  }
});

describe('isCanonicalBinding', () => {
  it('given every registry default, should accept it', () => {
    for (const hotkey of HOTKEY_REGISTRY) {
      expect(isCanonicalBinding(hotkey.defaultBinding), hotkey.id).toBe(true);
    }
  });

  it('given a legacy binding that still matches, should accept it untouched', () => {
    // These all worked before this change and must keep working — no migration.
    expect(isCanonicalBinding('Ctrl+Shift+?')).toBe(true);
    expect(isCanonicalBinding('Ctrl+Shift+_')).toBe(true);
    expect(isCanonicalBinding('Ctrl+Pause')).toBe(true);
    expect(isCanonicalBinding('Ctrl+PrintScreen')).toBe(true);
    expect(isCanonicalBinding('Ctrl+MediaPlayPause')).toBe(true);
  });

  it('given an Alt binding holding a composed character, should reject it', () => {
    // Alt resolves through e.code, which only yields A-Z or 0-9, so these can
    // never be produced by a key press and never matched anything.
    expect(isCanonicalBinding('Alt+Π')).toBe(false);
    expect(isCanonicalBinding('Alt+†')).toBe(false);
    expect(isCanonicalBinding('Alt+~')).toBe(false);
    expect(isCanonicalBinding('Alt+Dead')).toBe(false);
  });

  it('given an Alt binding on a plain key, should accept it', () => {
    expect(isCanonicalBinding('Alt+N')).toBe(true);
    expect(isCanonicalBinding('Alt+1')).toBe(true);
    expect(isCanonicalBinding('Alt+Tab')).toBe(true);
  });

  it('given an unknown or misordered modifier, should reject it', () => {
    expect(isCanonicalBinding('Cmd+K')).toBe(false);
    expect(isCanonicalBinding('Shift+Ctrl+K')).toBe(false);
    expect(isCanonicalBinding('Ctrl+Ctrl+K')).toBe(false);
    expect(isCanonicalBinding('Meta+Ctrl+K')).toBe(false);
  });

  it('given "+" as the main key, should accept it', () => {
    // Shift+= types "+", so the separator is also a bindable key.
    expect(isCanonicalBinding('Ctrl+Shift++')).toBe(true);
    expect(isCanonicalBinding('Ctrl++')).toBe(true);
  });

  it('given an Alt binding on a digit, should fire from the numpad as well', () => {
    // The e.key path gives numpad parity for free; Alt resolves through e.code,
    // so it has to map Numpad1 back to the digit or the same rebind would
    // silently drop the numpad half.
    expect(resolveEventKey(keyEvent({ altKey: true, key: '¡', code: 'Numpad1' }))).toBe('1');
    expect(resolveEventKey(keyEvent({ altKey: true, key: '¡', code: 'Digit1' }))).toBe('1');
  });

  it('given a modifier key the old widget never excluded, should reject it', () => {
    // X11 AltGr reports key "AltGraph" with altKey false, so it takes the
    // e.key path and would otherwise be recorded as a main key.
    expect(resolveEventKey(keyEvent({ ctrlKey: true, key: 'AltGraph', code: 'AltRight' }))).toBe('');
    expect(isCanonicalBinding('Ctrl+AltGraph')).toBe(false);
    expect(isCanonicalBinding('Ctrl+NumLock')).toBe(false);
    expect(isCanonicalBinding('Ctrl+OS')).toBe(false);
  });

  it('given a modifier name as the main key, should reject it', () => {
    // resolveEventKey returns '' for these, so the binding could never fire —
    // keeping it would shadow the default with something silently dead.
    expect(isCanonicalBinding('Ctrl+CapsLock')).toBe(false);
    expect(isCanonicalBinding('Ctrl+Shift')).toBe(false);
    expect(isCanonicalBinding('Meta+Control')).toBe(false);
  });

  it('given an Alt binding on punctuation, should accept the code token', () => {
    // macOS ⌥⇧/ composes "¿", so Alt resolves the whole keyboard through e.code.
    expect(isCanonicalBinding('Alt+Shift+Slash')).toBe(true);
    expect(isCanonicalBinding('Alt+Period')).toBe(true);
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

  it('given a bare numpad "+", should return false', () => {
    // The Add key reports key === "+", so an unmodified press captures as "+".
    // Reading that lone separator as a modifier would admit a bare global
    // shortcut that fires while the user is typing.
    const captured = eventToBinding(keyEvent({ key: '+', code: 'NumpadAdd' }));
    expect(captured).toBe('+');
    expect(hasModifier(captured)).toBe(false);
  });

  it('given "+" as the main key under a modifier, should still return true', () => {
    expect(hasModifier('Ctrl+Shift++')).toBe(true);
    expect(hasModifier('Ctrl++')).toBe(true);
  });
});

describe('formatBindingForDisplay', () => {
  it('given a Mac, should use symbols', () => {
    expect(formatBindingForDisplay('Meta+Shift+K', true)).toBe('⌘⇧K');
  });

  it('given the space bar, should name it rather than render a blank', () => {
    // e.key for the space bar is " ", so the unnamed form displays as a lone
    // "⌃" — indistinguishable from a half-recorded binding.
    expect(formatBindingForDisplay('Ctrl+ ', true)).toBe('⌃Space');
    expect(formatBindingForDisplay('Ctrl+ ', false)).toBe('Ctrl+Space');
  });

  it('given "+" as the main key, should keep it', () => {
    expect(formatBindingForDisplay('Ctrl+Shift++', false)).toBe('Ctrl+Shift++');
    expect(formatBindingForDisplay('Ctrl+Shift++', true)).toBe('⌃⇧+');
  });

  it('given a non-Mac, should keep the plain form', () => {
    expect(formatBindingForDisplay('Ctrl+Shift+K', false)).toBe('Ctrl+Shift+K');
  });
});
