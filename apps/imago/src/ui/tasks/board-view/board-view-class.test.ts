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
  boardColumnsClass,
  boardColumnTitleClass,
  boardCountClass,
  boardInsertClass,
  boardMenuDangerClass,
  boardRailClass,
  boardRailTextClass,
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
      given: 'the board, its row of columns, a column at rest and one a card is dragged over',
      should: 'lay columns side by side, scrolling across, sunk in the object, and outline the drop target in the accent',
      actual: [boardClass, boardColumnsClass, boardColumnClass(false), boardColumnClass(true), boardColumnHeadClass, boardColumnTitleClass],
      expected: [
        'flex min-h-0 flex-1 flex-col gap-3',
        'flex min-h-0 flex-1 items-start gap-3 overflow-x-auto pb-2',
        'flex w-board-column flex-none flex-col gap-2 rounded-lg border p-2 border-transparent bg-surface-sunken',
        'flex w-board-column flex-none flex-col gap-2 rounded-lg border p-2 border-dashed border-accent bg-accent-soft',
        'flex items-center gap-1 px-1',
        'flex min-w-0 flex-1 items-center gap-2 text-xs font-semibold text-ink',
      ],
    });
  });

  test('a folded column', () => {
    assert({
      given: 'a rail at rest, one dragged over, and its name',
      should: 'stand narrow, take drops like a column, and turn its name on end',
      actual: [boardRailClass(false), boardRailClass(true), boardRailTextClass],
      expected: [
        'flex w-board-rail flex-none flex-col items-center gap-2 rounded-lg border py-2 border-transparent bg-surface-sunken',
        'flex w-board-rail flex-none flex-col items-center gap-2 rounded-lg border py-2 border-dashed border-accent bg-accent-soft',
        'max-w-board-rail-label flex-none rotate-90 truncate',
      ],
    });
  });

  test('the count against a WIP limit', () => {
    assert({
      given: 'no limit, under it, at it and over it',
      should: 'stay faint without one, then chip it, warning at the limit and red past it',
      actual: [boardCountClass(null), boardCountClass('under'), boardCountClass('at'), boardCountClass('over')],
      expected: [
        'font-normal text-ink-faint tabular-nums',
        'rounded-sm border px-1 tabular-nums border-hairline font-normal text-ink-muted',
        'rounded-sm border px-1 tabular-nums border-status-warning font-medium text-status-warning-ink',
        'rounded-sm border px-1 tabular-nums border-status-danger bg-live-soft font-medium text-status-danger',
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
      given: 'a card at rest, its slot while dragged, a done one, the landing line, its parts and an empty column',
      should: 'raise cards on the column, leave a dashed slot for the one in flight and set done ones back',
      actual: [
        boardCardsClass,
        boardCardClass({ dragging: false, done: false }),
        boardCardClass({ dragging: true, done: false }),
        boardCardClass({ dragging: false, done: true }),
        boardInsertClass,
        boardCardRowClass,
        boardHandleClass,
        boardEmptyClass,
      ],
      expected: [
        'flex flex-col gap-2',
        'flex flex-col gap-2 rounded-lg border p-3 transition-colors duration-120 ease-standard border-hairline bg-surface-raised shadow-ambient hover:border-border',
        'flex flex-col gap-2 rounded-lg border p-3 transition-colors duration-120 ease-standard border-dashed border-accent bg-accent-soft *:invisible',
        'flex flex-col gap-2 rounded-lg border p-3 transition-colors duration-120 ease-standard border-hairline bg-surface-raised shadow-ambient hover:border-border opacity-75',
        'h-board-insert rounded-round bg-accent',
        'flex min-w-0 items-start gap-2',
        'inline-flex size-checkbox flex-none cursor-grab items-center justify-center rounded-sm text-ink-faint hover:text-ink',
        'px-1 text-xs text-ink-faint',
      ],
    });
  });

  test('Move to…', () => {
    assert({
      given: 'a card’s menu trigger, its menu, its rows and Delete',
      should: 'anchor a glass menu of sidebar-sized rows under a quiet square trigger, Delete in red',
      actual: [boardMoveClass, boardMoveTriggerClass, boardMenuClass, boardMenuItemClass, boardMenuDangerClass],
      expected: [
        'relative flex-none',
        'inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-ink-faint transition-colors duration-120 ease-standard hover:bg-surface-overlay hover:text-ink',
        'absolute right-0 z-popover mt-1 flex w-menu flex-col gap-1 rounded-lg border border-hairline p-1 shadow-2 surface-glass-raised',
        'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-row-y text-left text-sm text-ink hover:bg-surface-overlay focus-visible:bg-surface-overlay',
        'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-row-y text-left text-sm text-status-danger hover:bg-live-soft focus-visible:bg-live-soft',
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
