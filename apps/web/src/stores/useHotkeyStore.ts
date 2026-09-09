import { create } from 'zustand';
import { getHotkeyDefinition } from '@/lib/hotkeys/registry';
import {
  isMacPlatform,
  isUsableBinding,
  resolveEventKey,
  splitBinding,
} from '@/lib/hotkeys/binding';

interface HotkeyBinding {
  hotkeyId: string;
  binding: string;
}

interface HotkeyState {
  userBindings: Map<string, string>;
  loaded: boolean;
  setUserBindings: (bindings: HotkeyBinding[]) => void;
  updateBinding: (hotkeyId: string, binding: string) => void;
  removeBinding: (hotkeyId: string) => void;
  reset: () => void;
}

export const useHotkeyStore = create<HotkeyState>((set) => ({
  userBindings: new Map(),
  loaded: false,

  setUserBindings: (bindings) => {
    const map = new Map<string, string>();

    for (const { hotkeyId, binding } of bindings) {
      // An empty binding means "disabled" and is intentional.
      if (binding === '') {
        map.set(hotkeyId, binding);
        continue;
      }

      // Skip anything that cannot fire, so the default takes over. The old
      // capture widget accepted a bare key, so a stored "N" is a real
      // possibility, and it would fire against the global listeners while the
      // user is just reading; the other unusable shape is an Alt binding
      // holding a macOS-composed character ("Alt+Π"), which never matched
      // anything. Everything else — shifted punctuation, long-tail named keys
      // — still matches and is kept untouched.
      //
      // The row itself is left on the server. It is what tells Settings the
      // shortcut was reset, and the notice there is derived from the payload
      // rather than remembered here — see `unusablePreferences`.
      if (!isUsableBinding(binding)) continue;

      map.set(hotkeyId, binding);
    }

    set({ userBindings: map, loaded: true });
  },

  updateBinding: (hotkeyId, binding) => {
    set((state) => {
      const newMap = new Map(state.userBindings);
      newMap.set(hotkeyId, binding);
      return { userBindings: newMap };
    });
  },

  removeBinding: (hotkeyId) => {
    set((state) => {
      const newMap = new Map(state.userBindings);
      newMap.delete(hotkeyId);
      return { userBindings: newMap };
    });
  },

  reset: () => {
    set({ userBindings: new Map(), loaded: false });
  },
}));

/**
 * Get the effective binding for a hotkey (user override or default).
 *
 * Defaults are written with `Meta` meaning "the platform command key", so on
 * non-Mac platforms they resolve to Ctrl. User overrides are recorded from a
 * real key press on the user's own machine and are used exactly as captured.
 */
export function getEffectiveBinding(hotkeyId: string): string {
  const state = useHotkeyStore.getState();
  if (state.userBindings.has(hotkeyId)) {
    return state.userBindings.get(hotkeyId)!;
  }
  const definition = getHotkeyDefinition(hotkeyId);
  if (!definition) return '';
  return resolvePlatformBinding(definition.defaultBinding);
}

/**
 * Rewrite `Meta` to `Ctrl` in a default binding when not on a Mac.
 *
 * `isMac` is explicit for render paths: the server has no `navigator`, so
 * detecting the platform during render would produce different markup on the
 * server and the client. Callers that render pass the post-mount value.
 */
export function resolvePlatformBinding(binding: string, isMac = isMacPlatform()): string {
  if (!binding || isMac) return binding;
  if (!binding.startsWith('Meta+')) return binding;
  return `Ctrl+${binding.slice('Meta+'.length)}`;
}

interface ParsedBinding {
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

/** Parse a binding string like "Ctrl+Shift+K" into components */
export function parseBinding(binding: string): ParsedBinding {
  const { modifiers, key } = splitBinding(binding);
  const lower = modifiers.map((m) => m.toLowerCase());

  return {
    ctrl: lower.includes('ctrl'),
    meta: lower.includes('meta'),
    shift: lower.includes('shift'),
    alt: lower.includes('alt'),
    key: key.length === 1 ? key.toLowerCase() : key,
  };
}

/**
 * Check if a keyboard event matches a binding string.
 *
 * The key token comes from the same `resolveEventKey` the settings capture
 * widget uses, so what gets recorded and what gets matched cannot drift.
 */
export function matchesKeyEvent(binding: string, event: KeyboardEvent): boolean {
  if (!binding) return false;

  const parsed = parseBinding(binding);
  const eventKey = resolveEventKey(event);
  if (!eventKey) return false;

  return (
    event.ctrlKey === parsed.ctrl &&
    event.metaKey === parsed.meta &&
    event.shiftKey === parsed.shift &&
    event.altKey === parsed.alt &&
    eventKey.toLowerCase() === parsed.key.toLowerCase()
  );
}
