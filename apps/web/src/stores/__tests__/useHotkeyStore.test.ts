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
    it('given a binding that can never match, should drop it and fall back to the default', () => {
      // "Alt+Π" is what the old capture code stored for macOS Option+P.
      useHotkeyStore.getState().setUserBindings([
        { hotkeyId: 'pages.quick-create', binding: 'Alt+Π' },
      ]);

      expect(getEffectiveBinding('pages.quick-create')).toBe('Alt+N');
      expect(useHotkeyStore.getState().resetHotkeys).toContain('pages.quick-create');
      expect(useHotkeyStore.getState().migratedBindings).toEqual([]);
    });

    it('given a valid binding, should keep it and report nothing reset', () => {
      useHotkeyStore.getState().setUserBindings([
        { hotkeyId: 'pages.quick-create', binding: 'Alt+P' },
      ]);

      expect(getEffectiveBinding('pages.quick-create')).toBe('Alt+P');
      expect(useHotkeyStore.getState().resetHotkeys).toEqual([]);
    });

    it('given a legacy shifted-punctuation binding, should migrate it rather than reset it', () => {
      // "Ctrl+Shift+?" worked under the old matcher — it must not be discarded.
      useHotkeyStore.getState().setUserBindings([
        { hotkeyId: 'editing.find', binding: 'Ctrl+Shift+?' },
      ]);

      expect(getEffectiveBinding('editing.find')).toBe('Ctrl+Shift+/');
      expect(useHotkeyStore.getState().resetHotkeys).toEqual([]);
      expect(useHotkeyStore.getState().migratedBindings).toEqual([
        { hotkeyId: 'editing.find', binding: 'Ctrl+Shift+/' },
      ]);
    });

    it('given a migrated binding, should still match the same physical keys', () => {
      useHotkeyStore.getState().setUserBindings([
        { hotkeyId: 'editing.find', binding: 'Ctrl+Shift+?' },
      ]);

      const event = {
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: true,
        key: '?',
        code: 'Slash',
      } as KeyboardEvent;

      expect(matchesKeyEvent(getEffectiveBinding('editing.find'), event)).toBe(true);
    });

    it('given a stored bare key, should reset it rather than let it fire while browsing', () => {
      // The old capture widget had no modifier guard, so a plain "N" could be
      // saved. It is canonical, but it would fire while the user is reading.
      useHotkeyStore.getState().setUserBindings([
        { hotkeyId: 'pages.quick-create', binding: 'N' },
      ]);

      expect(getEffectiveBinding('pages.quick-create')).toBe('Alt+N');
      expect(useHotkeyStore.getState().resetHotkeys).toContain('pages.quick-create');
      expect(useHotkeyStore.getState().migratedBindings).toEqual([]);
    });

    it('given a re-saved binding, should clear its reset notice', () => {
      useHotkeyStore.getState().setUserBindings([
        { hotkeyId: 'pages.quick-create', binding: 'Alt+Π' },
      ]);
      useHotkeyStore.getState().updateBinding('pages.quick-create', 'Alt+P');

      expect(useHotkeyStore.getState().resetHotkeys).toEqual([]);
    });

    it('given cleanup that removes the row, should keep the notice until dismissed', () => {
      // The reviewer's case: cleanup deletes the row, so the next load sees
      // nothing wrong. The notice must survive that or the user is never told.
      useHotkeyStore.getState().setUserBindings([
        { hotkeyId: 'pages.quick-create', binding: 'Alt+Π' },
      ]);
      useHotkeyStore.getState().removeBinding('pages.quick-create');
      useHotkeyStore.getState().setUserBindings([]);

      expect(useHotkeyStore.getState().resetHotkeys).toContain('pages.quick-create');

      useHotkeyStore.getState().dismissResetNotice();
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

      expect(captured).toBe('Ctrl+Shift+1');
      expect(matchesKeyEvent(captured, event)).toBe(true);
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
