import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  boardCardClass,
  boardCardRowClass,
  boardCardsClass,
  boardClass,
  boardColumnClass,
  boardColumnHeadClass,
  boardCountClass,
  boardDotClass,
  boardEmptyClass,
  boardHandleClass,
  boardMenuClass,
  boardMenuItemClass,
  boardMoveClass,
  boardMoveTriggerClass,
} from './board-view-class';

describe('board view classes', () => {
  test('the board and its columns', () => {
    assert({
      given: 'the board, a column at rest and one a card is dragged over',
      should: 'lay columns side by side, scrolling across, and outline the drop target in the accent',
      actual: [boardClass, boardColumnClass(false), boardColumnClass(true), boardColumnHeadClass, boardCountClass],
      expected: [
        'flex min-h-0 flex-1 items-start gap-3 overflow-x-auto pb-2',
        'flex w-board-column flex-none flex-col gap-2 rounded-lg border p-2 border-transparent bg-surface-overlay',
        'flex w-board-column flex-none flex-col gap-2 rounded-lg border p-2 border-dashed border-accent bg-accent-soft',
        'flex items-center gap-2 px-1 text-xs font-semibold text-ink',
        'font-normal text-ink-faint tabular-nums',
      ],
    });
  });

  test('status dots', () => {
    assert({
      given: 'a to-do, an in-progress and a done status',
      should: 'dot them faint, accent and online',
      actual: (['todo', 'in_progress', 'done'] as const).map(boardDotClass),
      expected: [
        'size-live-dot flex-none rounded-round bg-ink-faint',
        'size-live-dot flex-none rounded-round bg-accent',
        'size-live-dot flex-none rounded-round bg-online',
      ],
    });
  });

  test('cards', () => {
    assert({
      given: 'a card at rest, one being dragged, its parts and an empty column',
      should: 'raise cards on the column and fade the one in flight',
      actual: [
        boardCardsClass,
        boardCardClass(false),
        boardCardClass(true),
        boardCardRowClass,
        boardHandleClass,
        boardEmptyClass,
      ],
      expected: [
        'flex flex-col gap-2',
        'flex flex-col gap-2 rounded-lg border border-hairline bg-background p-3 shadow-ambient',
        'flex flex-col gap-2 rounded-lg border border-hairline bg-background p-3 shadow-ambient opacity-60',
        'flex min-w-0 items-center gap-2',
        'inline-flex size-checkbox flex-none cursor-grab items-center justify-center rounded-sm text-ink-faint hover:text-ink',
        'px-1 text-xs text-ink-faint',
      ],
    });
  });

  test('Move to…', () => {
    assert({
      given: 'the Move to… control and its menu',
      should: 'anchor a glass menu of sidebar-sized rows under a quiet trigger',
      actual: [boardMoveClass, boardMoveTriggerClass, boardMenuClass, boardMenuItemClass],
      expected: [
        'relative flex-none',
        'rounded-md px-2 py-1 text-xs font-medium text-ink-muted hover:bg-surface-overlay hover:text-ink',
        'absolute right-0 z-popover mt-1 flex w-menu flex-col gap-1 rounded-lg border border-hairline p-1 shadow-2 surface-glass-raised',
        'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-row-y text-left text-sm text-ink hover:bg-surface-overlay focus-visible:bg-surface-overlay',
      ],
    });
  });
});
