/**
 * Keyboard grammar for the command picker (spec §1.7) — mirrors
 * `useSuggestion.handleKeyDown`'s placement-aware arrow inversion exactly,
 * with two deltas: Tab also selects (Slack/Discord tab-to-complete), and
 * Enter selects only on hardware keyboards (`enterSelects` — on mobile soft
 * keyboards Enter inserts a newline and tapping is the selection mechanism).
 */

export interface PickerKeyContext {
  placement: 'top' | 'bottom';
  selectedIndex: number;
  itemCount: number;
  enterSelects: boolean;
}

export type PickerKeyAction =
  | { type: 'move'; index: number }
  | { type: 'select' }
  | { type: 'dismiss' }
  | { type: 'none' };

export function resolvePickerKeyAction(
  key: string,
  context: PickerKeyContext,
  modifiers: { shiftKey?: boolean } = {}
): PickerKeyAction {
  const { placement, selectedIndex, itemCount, enterSelects } = context;

  if (key === 'Escape') return { type: 'dismiss' };
  if (itemCount === 0) return { type: 'none' };

  // Visual direction always matches key direction: with placement 'top' the
  // list grows upward, so the index math inverts (mirrors useSuggestion).
  const moveUp = (): PickerKeyAction =>
    placement === 'top'
      ? { type: 'move', index: selectedIndex < itemCount - 1 ? selectedIndex + 1 : 0 }
      : { type: 'move', index: selectedIndex > 0 ? selectedIndex - 1 : itemCount - 1 };

  const moveDown = (): PickerKeyAction =>
    placement === 'top'
      ? { type: 'move', index: selectedIndex > 0 ? selectedIndex - 1 : itemCount - 1 }
      : { type: 'move', index: selectedIndex < itemCount - 1 ? selectedIndex + 1 : 0 };

  switch (key) {
    case 'ArrowUp':
      return moveUp();
    case 'ArrowDown':
      return moveDown();
    case 'Enter':
      return enterSelects ? { type: 'select' } : { type: 'none' };
    case 'Tab':
      return modifiers.shiftKey ? { type: 'none' } : { type: 'select' };
    default:
      return { type: 'none' };
  }
}
