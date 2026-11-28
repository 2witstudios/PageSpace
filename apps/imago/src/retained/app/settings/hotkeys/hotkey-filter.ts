import type { HotkeyDefinition } from '@/retained/lib/hotkeys/registry';

/** Whether a shortcut matches the "Filter shortcuts" query, by its label or its description. */
export function matchesHotkeyFilter(hotkey: Pick<HotkeyDefinition, 'label' | 'description'>, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return hotkey.label.toLowerCase().includes(needle) || hotkey.description.toLowerCase().includes(needle);
}
