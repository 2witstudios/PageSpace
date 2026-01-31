// apps/web/src/lib/hotkeys/registry.ts

export type HotkeyCategory = 'navigation' | 'tabs' | 'editing' | 'general';

export interface HotkeyDefinition {
  id: string;
  label: string;
  description: string;
  category: HotkeyCategory;
  defaultBinding: string; // e.g., "Ctrl+K" or "Meta+K" (Meta = Cmd on Mac)
  /** If true, works even when focused in input/textarea */
  allowInInputs?: boolean;
}

export const HOTKEY_CATEGORIES: Record<HotkeyCategory, { label: string; description: string }> = {
  navigation: { label: 'Navigation', description: 'Move around the app' },
  tabs: { label: 'Tabs', description: 'Manage open tabs' },
  editing: { label: 'Editing', description: 'Document editing shortcuts' },
  general: { label: 'General', description: 'General application shortcuts' },
};

export const HOTKEY_REGISTRY: HotkeyDefinition[] = [
  // Navigation
  {
    id: 'navigation.search',
    label: 'Open Search',
    description: 'Open the global search dialog',
    category: 'navigation',
    defaultBinding: 'Meta+K',
  },
  {
    id: 'navigation.toggle-sidebar',
    label: 'Toggle Sidebar',
    description: 'Show or hide the sidebar',
    category: 'navigation',
    defaultBinding: 'Meta+B',
  },

  // Tabs
  {
    id: 'tabs.cycle-next',
    label: 'Next Tab',
    description: 'Switch to the next open tab',
    category: 'tabs',
    defaultBinding: 'Ctrl+Tab',
    allowInInputs: true,
  },
  {
    id: 'tabs.cycle-prev',
    label: 'Previous Tab',
    description: 'Switch to the previous open tab',
    category: 'tabs',
    defaultBinding: 'Ctrl+Shift+Tab',
    allowInInputs: true,
  },
  {
    id: 'tabs.close',
    label: 'Close Tab',
    description: 'Close the current tab',
    category: 'tabs',
    defaultBinding: 'Meta+W',
  },
  {
    id: 'tabs.go-to-1',
    label: 'Go to Tab 1',
    description: 'Switch to the first tab',
    category: 'tabs',
    defaultBinding: 'Meta+1',
    allowInInputs: true,
  },
  {
    id: 'tabs.go-to-2',
    label: 'Go to Tab 2',
    description: 'Switch to the second tab',
    category: 'tabs',
    defaultBinding: 'Meta+2',
    allowInInputs: true,
  },
  {
    id: 'tabs.go-to-3',
    label: 'Go to Tab 3',
    description: 'Switch to the third tab',
    category: 'tabs',
    defaultBinding: 'Meta+3',
    allowInInputs: true,
  },
  {
    id: 'tabs.go-to-4',
    label: 'Go to Tab 4',
    description: 'Switch to the fourth tab',
    category: 'tabs',
    defaultBinding: 'Meta+4',
    allowInInputs: true,
  },
  {
    id: 'tabs.go-to-5',
    label: 'Go to Tab 5',
    description: 'Switch to the fifth tab',
    category: 'tabs',
    defaultBinding: 'Meta+5',
    allowInInputs: true,
  },
  {
    id: 'tabs.go-to-6',
    label: 'Go to Tab 6',
    description: 'Switch to the sixth tab',
    category: 'tabs',
    defaultBinding: 'Meta+6',
    allowInInputs: true,
  },
  {
    id: 'tabs.go-to-7',
    label: 'Go to Tab 7',
    description: 'Switch to the seventh tab',
    category: 'tabs',
    defaultBinding: 'Meta+7',
    allowInInputs: true,
  },
  {
    id: 'tabs.go-to-8',
    label: 'Go to Tab 8',
    description: 'Switch to the eighth tab',
    category: 'tabs',
    defaultBinding: 'Meta+8',
    allowInInputs: true,
  },
  {
    id: 'tabs.go-to-9',
    label: 'Go to Tab 9',
    description: 'Switch to the ninth tab',
    category: 'tabs',
    defaultBinding: 'Meta+9',
    allowInInputs: true,
  },
];

/** Get a hotkey definition by ID */
export function getHotkeyDefinition(id: string): HotkeyDefinition | undefined {
  return HOTKEY_REGISTRY.find((h) => h.id === id);
}

/** Get all hotkeys grouped by category */
export function getHotkeysByCategory(): Record<HotkeyCategory, HotkeyDefinition[]> {
  return HOTKEY_REGISTRY.reduce(
    (acc, hotkey) => {
      acc[hotkey.category].push(hotkey);
      return acc;
    },
    {
      navigation: [],
      tabs: [],
      editing: [],
      general: [],
    } as Record<HotkeyCategory, HotkeyDefinition[]>
  );
}
