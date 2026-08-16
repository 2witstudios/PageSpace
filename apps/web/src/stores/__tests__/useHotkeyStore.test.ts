import { describe, it, expect, beforeEach } from 'vitest';
import { useHotkeyStore, getEffectiveBinding, parseBinding, matchesKeyEvent } from '../useHotkeyStore';
import { eventToBinding } from '@/lib/hotkeys/binding';

describe('useHotkeyStore', () => {
  beforeEach(() => {
    useHotkeyStore.getState().reset();
  });

  describe('setUserBindings', () => {
    it('given user bindings, should store them', () => {
      useHotkeyStore.getState().setUserBindings([
        { hotkeyId: 'tabs.cycle-next', binding: 'Alt+Tab' },
      ]);

      const bindings = useHotkeyStore.getState().userBindings;
      expect(bindings.get('tabs.cycle-next')).toBe('Alt+Tab');
    });
  });

  describe('getEffectiveBinding', () => {
    it('given no user binding, should return default', () => {
      const binding = getEffectiveBinding('tabs.cycle-next');
      expect(binding).toBe('Ctrl+Tab');
    });

    it('given user binding, should return user binding', () => {
      useHotkeyStore.getState().setUserBindings([
        { hotkeyId: 'tabs.cycle-next', binding: 'Alt+Tab' },
      ]);

      const binding = getEffectiveBinding('tabs.cycle-next');
      expect(binding).toBe('Alt+Tab');
    });

    it('given empty user binding (disabled), should return empty string', () => {
      useHotkeyStore.getState().setUserBindings([
        { hotkeyId: 'tabs.cycle-next', binding: '' },
      ]);

      const binding = getEffectiveBinding('tabs.cycle-next');
      expect(binding).toBe('');
    });
  });

  describe('stale bindings', () => {
    it('given an Alt binding that can never match, should reset it to the default', () => {
      // "Alt+Π" is what the old capture code stored for macOS Option+P.
      useHotkeyStore.getState().setUserBindings([
        { hotkeyId: 'pages.quick-create', binding: 'Alt+Π' },
      ]);

      expect(getEffectiveBinding('pages.quick-create')).toBe('Alt+N');
      expect(useHotkeyStore.getState().resetHotkeys).toContain('pages.quick-create');
    });

    it('given a valid binding, should keep it and report nothing reset', () => {
      useHotkeyStore.getState().setUserBindings([
        { hotkeyId: 'pages.quick-create', binding: 'Alt+P' },
      ]);

      expect(getEffectiveBinding('pages.quick-create')).toBe('Alt+P');
      expect(useHotkeyStore.getState().resetHotkeys).toEqual([]);
    });

    it('given a legacy shifted-punctuation binding, should keep it working untouched', () => {
      // "Ctrl+Shift+?" matched before this change and must still match after it.
      useHotkeyStore.getState().setUserBindings([
        { hotkeyId: 'editing.find', binding: 'Ctrl+Shift+?' },
      ]);

      expect(getEffectiveBinding('editing.find')).toBe('Ctrl+Shift+?');
      expect(useHotkeyStore.getState().resetHotkeys).toEqual([]);

      const event = {
        ctrlKey: true, metaKey: false, altKey: false, shiftKey: true,
        key: '?', code: 'Slash',
      } as KeyboardEvent;
      expect(matchesKeyEvent(getEffectiveBinding('editing.find'), event)).toBe(true);
    });

    it('given a legacy long-tail named key, should keep it rather than delete it', () => {
      useHotkeyStore.getState().setUserBindings([
        { hotkeyId: 'editing.find', binding: 'Ctrl+Pause' },
      ]);

      expect(getEffectiveBinding('editing.find')).toBe('Ctrl+Pause');
      expect(useHotkeyStore.getState().resetHotkeys).toEqual([]);
    });

    it('given a stored bare key, should reset it rather than let it fire while browsing', () => {
      // The old capture widget had no modifier guard, so a plain "N" could be
      // saved. It would fire while the user is simply reading.
      useHotkeyStore.getState().setUserBindings([
        { hotkeyId: 'pages.quick-create', binding: 'N' },
      ]);

      expect(getEffectiveBinding('pages.quick-create')).toBe('Alt+N');
      expect(useHotkeyStore.getState().resetHotkeys).toContain('pages.quick-create');
    });

    it('given a stored bare "+", should reset it like any other bare key', () => {
      // The numpad Add key reports key === "+", so an unmodified press captures
      // as "+" — the one bare key whose shape looks modified.
      useHotkeyStore.getState().setUserBindings([
        { hotkeyId: 'pages.quick-create', binding: '+' },
      ]);

      expect(getEffectiveBinding('pages.quick-create')).toBe('Alt+N');
      expect(useHotkeyStore.getState().resetHotkeys).toContain('pages.quick-create');
    });

    it('given a binding on a modifier key, should reset it rather than keep a dead override', () => {
      // The old widget only excluded Control/Meta/Alt/Shift, so "Ctrl+CapsLock"
      // was capturable. It can no longer fire, and keeping it would shadow the
      // default with something silently dead and no notice.
      useHotkeyStore.getState().setUserBindings([
        { hotkeyId: 'pages.quick-create', binding: 'Ctrl+CapsLock' },
      ]);

      expect(getEffectiveBinding('pages.quick-create')).toBe('Alt+N');
      expect(useHotkeyStore.getState().resetHotkeys).toContain('pages.quick-create');
    });

    it('given a later payload with a valid binding, should drop the notice', () => {
      // Another tab re-bound it, so the payload is positive evidence that the
      // reset no longer stands. Keeping the id shows a notice — and, before
      // the settings page re-read the server, deleted a working binding.
      useHotkeyStore.getState().setUserBindings([
        { hotkeyId: 'pages.quick-create', binding: 'Alt+Π' },
      ]);
      expect(useHotkeyStore.getState().resetHotkeys).toContain('pages.quick-create');

      useHotkeyStore.getState().setUserBindings([
        { hotkeyId: 'pages.quick-create', binding: 'Ctrl+Shift+J' },
      ]);

      expect(useHotkeyStore.getState().resetHotkeys).toEqual([]);
      expect(getEffectiveBinding('pages.quick-create')).toBe('Ctrl+Shift+J');
    });

    it('given a later payload that disables the shortcut, should drop the notice too', () => {
      // '' is a deliberate "off", not a broken binding.
      useHotkeyStore.getState().setUserBindings([
        { hotkeyId: 'pages.quick-create', binding: 'Alt+Π' },
      ]);
      useHotkeyStore.getState().setUserBindings([
        { hotkeyId: 'pages.quick-create', binding: '' },
      ]);

      expect(useHotkeyStore.getState().resetHotkeys).toEqual([]);
    });

    it('given a re-saved binding, should clear its reset notice', () => {
      useHotkeyStore.getState().setUserBindings([
        { hotkeyId: 'pages.quick-create', binding: 'Alt+Π' },
      ]);
      useHotkeyStore.getState().updateBinding('pages.quick-create', 'Alt+P');

      expect(useHotkeyStore.getState().resetHotkeys).toEqual([]);
    });

    it('given a payload that no longer names the shortcut, should keep the notice until dismissed', () => {
      // Another tab may have deleted the row. This tab's user has still not
      // read the notice, and a payload that merely goes quiet about a shortcut
      // is not evidence that it works — so the notice stands.
      useHotkeyStore.getState().setUserBindings([
        { hotkeyId: 'pages.quick-create', binding: 'Alt+Π' },
      ]);
      useHotkeyStore.getState().setUserBindings([]);

      expect(useHotkeyStore.getState().resetHotkeys).toContain('pages.quick-create');

      useHotkeyStore.getState().dismissResetNotice();
      expect(useHotkeyStore.getState().resetHotkeys).toEqual([]);
    });

    it('given the row is deleted here, should drop the notice with it', () => {
      // Deleting the row is the acknowledgement — it is the thing that kept
      // the notice alive across reloads. Holding the id afterwards let a read
      // taken before the delete re-arm a banner that had just been dismissed,
      // which the accumulate leg then preserved for the rest of the session.
      useHotkeyStore.getState().setUserBindings([
        { hotkeyId: 'pages.quick-create', binding: 'Alt+Π' },
      ]);
      useHotkeyStore.getState().removeBinding('pages.quick-create');

      expect(useHotkeyStore.getState().resetHotkeys).toEqual([]);
    });
  });

  describe('capture/match round trip', () => {
    it('given macOS Option+P, what is recorded should match that same press', () => {
      // The regression this whole fix exists for: recording used e.key ("π")
      // while matching used e.code ("p"), so the binding could never fire.
      const event = {
        ctrlKey: false,
        metaKey: false,
        altKey: true,
        shiftKey: false,
        key: 'π',
        code: 'KeyP',
      } as KeyboardEvent;

      const captured = eventToBinding(event);

      expect(captured).toBe('Alt+P');
      expect(matchesKeyEvent(captured, event)).toBe(true);
    });

    it('given Shift+1, what is recorded should match that same press', () => {
      const event = {
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: true,
        key: '!',
        code: 'Digit1',
      } as KeyboardEvent;

      const captured = eventToBinding(event);

      expect(captured).toBe('Ctrl+Shift+!');
      expect(matchesKeyEvent(captured, event)).toBe(true);
    });

    it('given a non-US layout, should bind the key the user sees', () => {
      // AZERTY puts the key labelled A at physical KeyQ. Binding by position
      // would silently move the shortcut to the key labelled Q.
      const event = {
        ctrlKey: true, metaKey: false, altKey: false, shiftKey: false,
        key: 'a', code: 'KeyQ',
      } as KeyboardEvent;

      const captured = eventToBinding(event);

      expect(captured).toBe('Ctrl+A');
      expect(matchesKeyEvent(captured, event)).toBe(true);
    });

    it('given a numpad digit, should fire the same binding as the top row', () => {
      // Both report e.key "1", so "Meta+1" covers both — as it did before.
      const numpad = {
        ctrlKey: false, metaKey: true, altKey: false, shiftKey: false,
        key: '1', code: 'Numpad1',
      } as KeyboardEvent;
      const topRow = { ...numpad, code: 'Digit1' } as KeyboardEvent;

      expect(matchesKeyEvent('Meta+1', numpad)).toBe(true);
      expect(matchesKeyEvent('Meta+1', topRow)).toBe(true);
    });
  });
});

describe('parseBinding', () => {
  it('given Ctrl+K, should parse correctly', () => {
    const parsed = parseBinding('Ctrl+K');
    expect(parsed).toEqual({ ctrl: true, meta: false, shift: false, alt: false, key: 'k' });
  });

  it('given Meta+Shift+P, should parse correctly', () => {
    const parsed = parseBinding('Meta+Shift+P');
    expect(parsed).toEqual({ ctrl: false, meta: true, shift: true, alt: false, key: 'p' });
  });

  it('given Ctrl+Shift+Tab, should parse correctly', () => {
    const parsed = parseBinding('Ctrl+Shift+Tab');
    expect(parsed).toEqual({ ctrl: true, meta: false, shift: true, alt: false, key: 'Tab' });
  });
});

describe('matchesKeyEvent', () => {
  it('given matching event, should return true', () => {
    const event = {
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      key: 'k',
    } as KeyboardEvent;

    expect(matchesKeyEvent('Ctrl+K', event)).toBe(true);
  });

  it('given non-matching event, should return false', () => {
    const event = {
      ctrlKey: false,
      metaKey: true,
      shiftKey: false,
      altKey: false,
      key: 'k',
    } as KeyboardEvent;

    expect(matchesKeyEvent('Ctrl+K', event)).toBe(false);
  });

  it('given empty binding (disabled), should return false', () => {
    const event = {
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      key: 'k',
      code: 'KeyK',
    } as KeyboardEvent;

    expect(matchesKeyEvent('', event)).toBe(false);
  });

  it('given Alt+N on macOS where e.key is "~", should match via e.code', () => {
    // On macOS US layout, Option+N produces "~" as e.key but e.code stays "KeyN"
    const event = {
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: true,
      key: '~',
      code: 'KeyN',
    } as KeyboardEvent;

    expect(matchesKeyEvent('Alt+N', event)).toBe(true);
  });

  it('given Alt+N on Windows where e.key is "n", should match directly', () => {
    const event = {
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: true,
      key: 'n',
      code: 'KeyN',
    } as KeyboardEvent;

    expect(matchesKeyEvent('Alt+N', event)).toBe(true);
  });
});
