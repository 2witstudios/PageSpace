// apps/web/src/lib/hotkeys/binding.ts
//
// Canonical binding-string format, shared by the settings capture widget and the
// runtime matcher. Both sides MUST derive the key token through `resolveEventKey`
// — when they each rolled their own, macOS Option presses were recorded from
// `e.key` (Option+P → "π") but matched with an `e.code` fallback ("P"), so a
// rebound shortcut could never fire while still overriding its default.
//
// The token is `e.key` — the character on the keycap — except when Alt is held.
// Alt composes characters on macOS (⌥P → "π", ⌥N → "Dead"), so there the
// physical `e.code` is the only usable signal. Keeping `e.key` everywhere else
// is deliberate: it is what makes `Ctrl+A` land on the key labelled A whatever
// the layout, and `Ctrl+1` fire from the numpad as well as the top row.
//
// Format: modifiers in the fixed order Ctrl, Meta, Alt, Shift, then the key
// token, joined with "+". e.g. "Meta+Shift+K", "Ctrl+Tab", "Alt+N".

/** Modifier names, in the order they must appear in a canonical binding. */
const MODIFIER_ORDER = ['Ctrl', 'Meta', 'Alt', 'Shift'] as const;

/** Keys that are modifiers themselves and can never be the main key. */
const MODIFIER_KEY_NAMES = new Set(['Control', 'Meta', 'Alt', 'Shift', 'CapsLock']);

/** `e.code` values for the modifier keys, which can never be the main key. */
const MODIFIER_CODE = /^(Control|Meta|Alt|Shift|OS)(Left|Right)?$|^CapsLock$/;

/**
 * A token `resolveEventKey` can emit for an Alt binding: a letter or digit from
 * `e.code`, or a `e.code` name, which is always ASCII and starts with a capital.
 * Anything else under Alt — "Π", "¿", "~" — was written by the old capture code
 * from a composed `e.key` and can never be produced again.
 */
const ALT_KEY_TOKEN = /^([A-Z0-9]|[A-Z][A-Za-z0-9]*)$/;

interface BindingEventLike {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
  code?: string;
}

/**
 * Resolve a keyboard event to its canonical key token.
 *
 * `e.key` is preferred because it is the character the user sees on the key —
 * layout-correct by construction. The one case it cannot be trusted is Alt:
 * macOS composes a different character (⌥P → "π", ⌥⇧/ → "¿") or a dead key
 * (⌥N → "Dead"). For Alt the physical `e.code` is used throughout — every key,
 * not just letters and digits — so that capture and matching agree on the whole
 * keyboard rather than only the part `e.key` survives.
 */
export function resolveEventKey(event: BindingEventLike): string {
  if (event.altKey && event.code) {
    if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
    if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
    // Punctuation, named and navigation keys keep their code ("Slash", "Tab").
    // Alt bindings are therefore layout-independent, which is the trade Alt
    // forces on us: e.key carries no usable signal here.
    if (!MODIFIER_CODE.test(event.code)) return event.code;
    return '';
  }

  if (!event.key || MODIFIER_KEY_NAMES.has(event.key)) return '';
  return event.key.length === 1 ? event.key.toUpperCase() : event.key;
}

/**
 * Build a canonical binding string from a keyboard event.
 *
 * Returns '' when the press cannot be recorded: modifiers alone, or a press
 * `isCanonicalBinding` would refuse. That last guard makes "anything capture
 * emits, validation accepts" true by construction rather than by test — the
 * invariant every bug in this module has been a violation of. It is reachable:
 * an event with no `e.code` (a virtual or IME keyboard) skips the Alt branch of
 * `resolveEventKey`, so macOS Option would otherwise capture the composed
 * character and the PATCH would 400 on the widget's own output.
 */
export function eventToBinding(event: BindingEventLike): string {
  const mainKey = resolveEventKey(event);
  if (!mainKey) return '';

  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.metaKey) parts.push('Meta');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(mainKey);

  const binding = parts.join('+');
  return isCanonicalBinding(binding) ? binding : '';
}

/**
 * Split a binding into its modifiers and key token.
 *
 * Modifiers are stripped from the left rather than splitting on every "+",
 * because "+" is itself a key: Shift+= types one, so "Ctrl+Shift++" is a real
 * binding whose key is "+". Splitting naively yields empty tokens and loses it.
 */
export function splitBinding(binding: string): { modifiers: string[]; key: string } {
  const modifiers: string[] = [];
  let rest = binding;

  for (const modifier of MODIFIER_ORDER) {
    if (rest.startsWith(`${modifier}+`) && rest.length > modifier.length + 1) {
      modifiers.push(modifier);
      rest = rest.slice(modifier.length + 1);
    }
  }

  return { modifiers, key: rest };
}

/**
 * True when `binding` could actually be produced by a key press.
 *
 * Validation is deliberately permissive about the key token: `e.key` covers a
 * long tail this module has no business enumerating (`Pause`, `PrintScreen`,
 * media keys, layout-specific characters), and rejecting an unfamiliar name
 * would throw away a shortcut that works.
 *
 * The one thing it does reject is an Alt binding holding a composed character.
 * Those were written by the old capture code on macOS — `Alt+Π`, `Alt+~`,
 * `Alt+Dead` — and can never match, because Alt combinations now resolve
 * through `e.code` and yield a plain letter or digit.
 */
export function isCanonicalBinding(binding: string): boolean {
  if (!binding) return false;

  const { modifiers, key } = splitBinding(binding);
  if (!key) return false;

  // Modifiers are stripped in canonical order, so anything left holding a "+"
  // is a modifier out of order, duplicated, or unknown ("Shift+Ctrl+K" leaves
  // "Ctrl+K"). The one legitimate "+" key is exactly "+".
  if (key !== '+' && key.includes('+')) return false;

  // A modifier name is never the main key: `resolveEventKey` returns '' for
  // those, so "Ctrl+CapsLock" would be kept as an override that never fires.
  if (MODIFIER_KEY_NAMES.has(key)) return false;

  // "Dead" is what macOS reports for ⌥N and friends — never a real key.
  if (key === 'Dead') return false;

  // Under Alt the token comes from `e.code`, so it is ASCII and capitalised.
  // A composed character ("Π", "¿", "~") could only have been written by the
  // old capture code and can never be produced again.
  if (modifiers.includes('Alt') && !ALT_KEY_TOKEN.test(key)) return false;

  return true;
}

/**
 * True when the binding carries at least one modifier key.
 *
 * Counted through `splitBinding`, not by splitting on "+": the numpad Add key
 * reports `key === "+"`, so a bare, unmodified press captures as "+", and a
 * naive split reads that lone separator as a modifier. It would have let a
 * global bare shortcut past the widget, the API and the store alike.
 */
export function hasModifier(binding: string): boolean {
  return splitBinding(binding).modifiers.length > 0;
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

  const { modifiers, key } = splitBinding(binding);
  return `${modifiers.map((m) => MAC_SYMBOLS[m] ?? m).join('')}${key}`;
}

/** True when running on a macOS-like platform (browser only). */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}
