import { describe, it, expect, beforeEach } from 'vitest';
import { useHotkeyStore, getEffectiveBinding, parseBinding, matchesKeyEvent } from '../useHotkeyStore';

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
    } as KeyboardEvent;

    expect(matchesKeyEvent('', event)).toBe(false);
  });
});
