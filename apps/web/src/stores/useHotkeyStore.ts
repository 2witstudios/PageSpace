import { create } from 'zustand';
import { getHotkeyDefinition } from '@/lib/hotkeys/registry';
import { isCanonicalBinding, isMacPlatform, keyFromCode } from '@/lib/hotkeys/binding';

interface HotkeyBinding {
  hotkeyId: string;
  binding: string;
}

interface HotkeyState {
  userBindings: Map<string, string>;
  /** Hotkey IDs whose stored binding was stale and got dropped on load. */
  invalidBindings: string[];
  loaded: boolean;
  setUserBindings: (bindings: HotkeyBinding[]) => void;
  updateBinding: (hotkeyId: string, binding: string) => void;
  removeBinding: (hotkeyId: string) => void;
  reset: () => void;
}

export const useHotkeyStore = create<HotkeyState>((set) => ({
  userBindings: new Map(),
  invalidBindings: [],
  loaded: false,

  setUserBindings: (bindings) => {
    const map = new Map<string, string>();
    const invalid: string[] = [];

    for (const { hotkeyId, binding } of bindings) {
      // An empty binding means "disabled" and is intentional. Anything else that
      // isn't canonical was written by the old capture code and can never match
      // a real key event — drop it so the default takes over again.
      if (binding !== '' && !isCanonicalBinding(binding)) {
        invalid.push(hotkeyId);
        continue;
      }
      map.set(hotkeyId, binding);
    }

    set({ userBindings: map, invalidBindings: invalid, loaded: true });
  },

  updateBinding: (hotkeyId, binding) => {
    set((state) => {
      const newMap = new Map(state.userBindings);
      newMap.set(hotkeyId, binding);
      return {
        userBindings: newMap,
        invalidBindings: state.invalidBindings.filter((id) => id !== hotkeyId),
      };
    });
  },

  removeBinding: (hotkeyId) => {
    set((state) => {
      const newMap = new Map(state.userBindings);
      newMap.delete(hotkeyId);
      return {
        userBindings: newMap,
        invalidBindings: state.invalidBindings.filter((id) => id !== hotkeyId),
      };
    });
  },

  reset: () => {
    set({ userBindings: new Map(), invalidBindings: [], loaded: false });
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

/** Rewrite `Meta` to `Ctrl` in a default binding when not on a Mac. */
export function resolvePlatformBinding(binding: string): string {
  if (!binding || isMacPlatform()) return binding;
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
  const parts = binding.split('+');
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1).map((m) => m.toLowerCase());

  return {
    ctrl: modifiers.includes('ctrl'),
    meta: modifiers.includes('meta'),
    shift: modifiers.includes('shift'),
    alt: modifiers.includes('alt'),
    key: key.length === 1 ? key.toLowerCase() : key,
  };
}

/**
 * Check if a keyboard event matches a binding string.
 *
 * The key token is resolved through the same `keyFromCode` the settings capture
 * widget uses, so what gets recorded and what gets matched cannot drift.
 */
export function matchesKeyEvent(binding: string, event: KeyboardEvent): boolean {
  if (!binding) return false;

  const parsed = parseBinding(binding);
  const eventKey = keyFromCode(event.code, event.key);
  if (!eventKey) return false;

  return (
    event.ctrlKey === parsed.ctrl &&
    event.metaKey === parsed.meta &&
    event.shiftKey === parsed.shift &&
    event.altKey === parsed.alt &&
    eventKey.toLowerCase() === parsed.key.toLowerCase()
  );
}
