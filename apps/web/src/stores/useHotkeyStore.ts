import { create } from 'zustand';
import { getHotkeyDefinition } from '@/lib/hotkeys/registry';
import { isCanonicalBinding, isMacPlatform, keyFromCode, migrateLegacyBinding } from '@/lib/hotkeys/binding';

interface HotkeyBinding {
  hotkeyId: string;
  binding: string;
}

/** A stored binding rewritten into the canonical form, to be persisted. */
interface MigratedBinding {
  hotkeyId: string;
  binding: string;
}

interface HotkeyState {
  userBindings: Map<string, string>;
  /**
   * Hotkey IDs whose stored binding could not be salvaged and fell back to the
   * default. Kept until the user re-binds or dismisses it, so the notice
   * survives the cleanup that removes the row.
   */
  resetHotkeys: string[];
  /**
   * Bindings rewritten during the most recent load; the caller persists these.
   * Recomputed on every load, so it never needs clearing.
   */
  migratedBindings: MigratedBinding[];
  loaded: boolean;
  setUserBindings: (bindings: HotkeyBinding[]) => void;
  updateBinding: (hotkeyId: string, binding: string) => void;
  removeBinding: (hotkeyId: string) => void;
  dismissResetNotice: () => void;
  reset: () => void;
}

export const useHotkeyStore = create<HotkeyState>((set) => ({
  userBindings: new Map(),
  resetHotkeys: [],
  migratedBindings: [],
  loaded: false,

  setUserBindings: (bindings) => {
    const map = new Map<string, string>();
    const wasReset: string[] = [];
    const migrated: MigratedBinding[] = [];

    for (const { hotkeyId, binding } of bindings) {
      // An empty binding means "disabled" and is intentional.
      if (binding === '' || isCanonicalBinding(binding)) {
        map.set(hotkeyId, binding);
        continue;
      }

      // Written by the old `e.key` capture. Shifted punctuation ("Ctrl+Shift+?")
      // used to match and is rewritten to the physical key it stands for; a
      // binding that could never match (an Option-composed letter) is dropped so
      // the default takes over.
      const rewritten = migrateLegacyBinding(binding);
      if (rewritten) {
        map.set(hotkeyId, rewritten);
        migrated.push({ hotkeyId, binding: rewritten });
      } else {
        wasReset.push(hotkeyId);
      }
    }

    set((state) => ({
      userBindings: map,
      // Accumulate: cleanup removes the row, so a later load sees nothing wrong
      // and would otherwise erase the notice before the user ever reads it.
      resetHotkeys: [...new Set([...state.resetHotkeys, ...wasReset])],
      migratedBindings: migrated,
      loaded: true,
    }));
  },

  updateBinding: (hotkeyId, binding) => {
    set((state) => {
      const newMap = new Map(state.userBindings);
      newMap.set(hotkeyId, binding);
      return {
        userBindings: newMap,
        // The user has set this one again — the notice has served its purpose.
        resetHotkeys: state.resetHotkeys.filter((id) => id !== hotkeyId),
      };
    });
  },

  removeBinding: (hotkeyId) => {
    set((state) => {
      const newMap = new Map(state.userBindings);
      newMap.delete(hotkeyId);
      return { userBindings: newMap };
    });
  },

  dismissResetNotice: () => {
    set({ resetHotkeys: [] });
  },

  reset: () => {
    set({ userBindings: new Map(), resetHotkeys: [], migratedBindings: [], loaded: false });
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
