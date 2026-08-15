// apps/web/src/lib/hotkeys/binding.ts
//
// Canonical binding-string format, shared by the settings capture widget and the
// runtime matcher. Both sides MUST derive the key token through this module —
// when they each rolled their own, macOS Option presses were recorded from
// `e.key` (Option+P → "π") but matched from `e.code` ("p"), so a rebound
// shortcut could never fire while still overriding its default.
//
// Format: modifiers in the fixed order Ctrl, Meta, Alt, Shift, then the key
// token, joined with "+". e.g. "Meta+Shift+K", "Ctrl+Tab", "Alt+N".

/** Modifier names, in the order they must appear in a canonical binding. */
const MODIFIER_ORDER = ['Ctrl', 'Meta', 'Alt', 'Shift'] as const;

/** Key event `code` values that map to a punctuation token. */
const PUNCTUATION_BY_CODE: Record<string, string> = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Backquote: '`',
};

/** Named (non-character) keys we accept, keyed by their `code`. */
const NAMED_CODES = new Set([
  'Tab',
  'Enter',
  'Escape',
  'Space',
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

const FUNCTION_KEY = /^F([1-9]|1\d|2[0-4])$/;

/** Keys that are modifiers themselves and can never be the main key. */
const MODIFIER_KEY_NAMES = new Set(['Control', 'Meta', 'Alt', 'Shift', 'CapsLock']);

/**
 * Resolve a keyboard event to its canonical key token, physical-position first.
 *
 * `code` describes the physical key and is unaffected by modifiers or layout
 * remapping, so it is preferred. `key` is the fallback for events that carry no
 * `code` (synthetic events in tests, some virtual keyboards).
 */
export function keyFromCode(code: string | undefined, key: string | undefined): string {
  if (code) {
    if (code.startsWith('Key') && code.length === 4) return code.slice(3).toUpperCase();
    if (code.startsWith('Digit') && code.length === 6) return code.slice(5);
    if (code.startsWith('Numpad') && code.length > 6) return `Numpad${code.slice(6)}`;
    if (FUNCTION_KEY.test(code)) return code;
    if (NAMED_CODES.has(code)) return code;
    if (PUNCTUATION_BY_CODE[code]) return PUNCTUATION_BY_CODE[code];
  }

  if (!key) return '';
  if (MODIFIER_KEY_NAMES.has(key)) return '';
  return key.length === 1 ? key.toUpperCase() : key;
}

interface BindingEventLike {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
  code?: string;
}

/**
 * Build a canonical binding string from a keyboard event.
 * Returns '' when the press carries no main key (modifiers only).
 */
export function eventToBinding(event: BindingEventLike): string {
  const mainKey = keyFromCode(event.code, event.key);
  if (!mainKey) return '';

  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.metaKey) parts.push('Meta');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(mainKey);

  return parts.join('+');
}

/** True when the key token is one this module can emit. */
function isCanonicalKeyToken(token: string): boolean {
  if (token.length === 1) {
    return /^[A-Z0-9]$/.test(token) || Object.values(PUNCTUATION_BY_CODE).includes(token);
  }
  if (NAMED_CODES.has(token)) return true;
  if (FUNCTION_KEY.test(token)) return true;
  if (token.startsWith('Numpad') && token.length > 6) return true;
  return false;
}

/**
 * True when `binding` is in the canonical format this module produces:
 * known modifiers, in order, with no duplicates, and an emittable key token.
 *
 * Bindings that fail this check were written by the old, asymmetric capture
 * code (e.g. "Alt+Π") and can never match a real event — callers treat them as
 * stale and fall back to the default.
 */
export function isCanonicalBinding(binding: string): boolean {
  if (!binding) return false;

  const parts = binding.split('+');
  // A trailing "+" key would produce an empty token; "+" itself is not emittable.
  if (parts.some((p) => p === '')) return false;

  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);

  if (!isCanonicalKeyToken(key)) return false;

  let lastIndex = -1;
  for (const modifier of modifiers) {
    const index = (MODIFIER_ORDER as readonly string[]).indexOf(modifier);
    if (index <= lastIndex) return false; // unknown, out of order, or duplicated
    lastIndex = index;
  }

  return true;
}

/** True when the binding carries at least one modifier key. */
export function hasModifier(binding: string): boolean {
  return binding.split('+').length > 1;
}

/**
 * Characters the old `e.key`-based capture recorded for a shifted key, mapped
 * back to the unshifted key in the same physical position (US layout).
 */
const UNSHIFTED_BY_SHIFTED_CHAR: Record<string, string> = {
  '!': '1',
  '@': '2',
  '#': '3',
  $: '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
  _: '-',
  '+': '=',
  '{': '[',
  '}': ']',
  ':': ';',
  '"': "'",
  '<': ',',
  '>': '.',
  '?': '/',
  '|': '\\',
  '~': '`',
  ' ': 'Space',
};

/**
 * Translate a binding written by the old `e.key`-based capture into the
 * canonical form, when the old form was one that actually worked.
 *
 * A shifted punctuation or digit key (`Ctrl+Shift+?`) matched fine under the
 * previous matcher because it also compared `e.key`, so those bindings are
 * migrated rather than discarded. A binding holding a character no key press
 * can produce in canonical form — an Option-composed letter like `Alt+Π` — was
 * never matchable and cannot be recovered; those return null.
 */
export function migrateLegacyBinding(binding: string): string | null {
  if (!binding) return null;
  if (isCanonicalBinding(binding)) return binding;

  const parts = binding.split('+');
  if (parts.some((p) => p === '')) return null;

  const key = parts[parts.length - 1];
  const migratedKey = UNSHIFTED_BY_SHIFTED_CHAR[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  const migrated = [...parts.slice(0, -1), migratedKey].join('+');

  return isCanonicalBinding(migrated) ? migrated : null;
}

/**
 * Combinations the browser or OS claims before the page sees them. Saving one
 * is allowed (some users remap at the OS level) but warned about, because the
 * shortcut will usually appear to do nothing.
 */
export const RESERVED_BINDINGS = new Set([
  'Meta+N',
  'Meta+T',
  'Meta+W',
  'Meta+Q',
  'Meta+Shift+N',
  'Meta+Shift+T',
  'Ctrl+N',
  'Ctrl+T',
  'Ctrl+W',
  'Ctrl+Shift+N',
  'Ctrl+Shift+T',
]);

const MAC_SYMBOLS: Record<string, string> = {
  Ctrl: '⌃',
  Meta: '⌘',
  Alt: '⌥',
  Shift: '⇧',
};

/** Render a binding for display: ⌘⇧K on macOS, Ctrl+Shift+K elsewhere. */
export function formatBindingForDisplay(binding: string, isMac: boolean): string {
  if (!binding) return '';
  if (!isMac) return binding;

  const parts = binding.split('+');
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1).map((m) => MAC_SYMBOLS[m] ?? m);

  return `${modifiers.join('')}${key}`;
}

/** True when running on a macOS-like platform (browser only). */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}
