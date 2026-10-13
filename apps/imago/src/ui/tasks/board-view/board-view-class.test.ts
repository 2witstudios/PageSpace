import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  boardAssigneesClass,
  boardBlockedClass,
  boardCardClass,
  boardCardMetaClass,
  boardCardRowClass,
  boardCardsClass,
  boardClass,
  boardColumnClass,
  boardColumnHeadClass,
  boardCountClass,
  boardDotClass,
  boardDueClass,
  boardEmptyClass,
  boardHandleClass,
  boardMenuClass,
  boardMenuItemClass,
  boardMoveClass,
  boardMoveTriggerClass,
  boardPriorityClass,
  boardSubtasksClass,
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

  test('what a card flags', () => {
    assert({
      given: 'the meta row, Blocked, a high and a low priority, and where the faces sit',
      should: 'wrap the row, flag Blocked and high in the live red, low faint, and push the faces to the end',
      actual: [boardCardMetaClass, boardBlockedClass, boardPriorityClass('high'), boardPriorityClass('low'), boardAssigneesClass],
      expected: [
        'flex flex-wrap items-center gap-2',
        'flex-none text-2xs font-medium text-live',
        'flex flex-none items-center gap-1 text-2xs text-live',
        'flex flex-none items-center gap-1 text-2xs text-ink-faint',
        'ml-auto',
      ],
    });
  });

  test('due dates and subtasks', () => {
    assert({
      given: 'an overdue, a soon and a later due date, and an open card’s subtasks',
      should: 'grade the date red, full ink and faint, and rule the subtasks off under a hairline',
      actual: [boardDueClass('overdue'), boardDueClass('soon'), boardDueClass('later'), boardSubtasksClass],
      expected: [
        'flex-none text-2xs tabular-nums font-medium text-live',
        'flex-none text-2xs tabular-nums font-medium text-ink',
        'flex-none text-2xs tabular-nums text-ink-faint',
        'border-t border-hairline pt-2',
      ],
    });
  });
});
