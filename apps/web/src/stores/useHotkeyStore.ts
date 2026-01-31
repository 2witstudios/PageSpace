import { create } from 'zustand';
import { getHotkeyDefinition } from '@/lib/hotkeys/registry';

interface HotkeyBinding {
  hotkeyId: string;
  binding: string;
}

interface HotkeyState {
  userBindings: Map<string, string>;
  loaded: boolean;
  setUserBindings: (bindings: HotkeyBinding[]) => void;
  updateBinding: (hotkeyId: string, binding: string) => void;
  reset: () => void;
}

export const useHotkeyStore = create<HotkeyState>((set) => ({
  userBindings: new Map(),
  loaded: false,

  setUserBindings: (bindings) => {
    const map = new Map<string, string>();
    for (const { hotkeyId, binding } of bindings) {
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

  reset: () => {
    set({ userBindings: new Map(), loaded: false });
  },
}));

/** Get the effective binding for a hotkey (user override or default) */
export function getEffectiveBinding(hotkeyId: string): string {
  const state = useHotkeyStore.getState();
  if (state.userBindings.has(hotkeyId)) {
    return state.userBindings.get(hotkeyId)!;
  }
  const definition = getHotkeyDefinition(hotkeyId);
  return definition?.defaultBinding ?? '';
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

/** Check if a keyboard event matches a binding string */
export function matchesKeyEvent(binding: string, event: KeyboardEvent): boolean {
  if (!binding) return false;

  const parsed = parseBinding(binding);
  const eventKey = event.key.length === 1 ? event.key.toLowerCase() : event.key;

  return (
    event.ctrlKey === parsed.ctrl &&
    event.metaKey === parsed.meta &&
    event.shiftKey === parsed.shift &&
    event.altKey === parsed.alt &&
    eventKey === parsed.key
  );
}
