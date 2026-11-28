import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { isApplePlatform, isPaletteShortcut, type ShortcutKey } from './palette-shortcut';

const key = (overrides: Partial<ShortcutKey> = {}): ShortcutKey => ({
  key: 'k',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  ...overrides,
});

describe('isPaletteShortcut()', () => {
  test('on a Mac', () => {
    assert({
      given: '⌘K, ⌘⇧K (caps), Ctrl-K, ⌘⌥K, ⌘J and ⌘K mid-composition on a Mac',
      should: 'open only for ⌘K and ⌘K with caps lock, leaving Ctrl-K to the text field’s delete-to-end',
      actual: [
        isPaletteShortcut(key({ metaKey: true }), true),
        isPaletteShortcut(key({ metaKey: true, key: 'K' }), true),
        isPaletteShortcut(key({ ctrlKey: true }), true),
        isPaletteShortcut(key({ metaKey: true, altKey: true }), true),
        isPaletteShortcut(key({ metaKey: true, key: 'j' }), true),
        isPaletteShortcut(key({ metaKey: true, isComposing: true }), true),
      ],
      expected: [true, true, false, false, false, false],
    });
  });

  test('elsewhere', () => {
    assert({
      given: 'Ctrl-K, Ctrl-Shift-K, the Windows key with K, and K alone off a Mac',
      should: 'open only for Ctrl-K',
      actual: [
        isPaletteShortcut(key({ ctrlKey: true }), false),
        isPaletteShortcut(key({ ctrlKey: true, shiftKey: true }), false),
        isPaletteShortcut(key({ metaKey: true }), false),
        isPaletteShortcut(key(), false),
      ],
      expected: [true, false, false, false],
    });
  });
});

describe('isApplePlatform()', () => {
  test('what the browser says', () => {
    assert({
      given: 'a Mac, an iPad, Windows, Linux and a browser that says nothing',
      should: 'treat only Apple’s platforms as Apple',
      actual: [
        isApplePlatform({ platform: 'MacIntel', userAgent: '' }),
        isApplePlatform({ platform: 'iPad', userAgent: '' }),
        isApplePlatform({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0)' }),
        isApplePlatform({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }),
        isApplePlatform({ platform: '', userAgent: '' }),
      ],
      expected: [true, true, false, false, false],
    });
  });

  test('a browser that leaves platform empty', () => {
    assert({
      given: 'no platform but a Mac user agent',
      should: 'go by the user agent',
      actual: isApplePlatform({ platform: '', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' }),
      expected: true,
    });
  });
});
