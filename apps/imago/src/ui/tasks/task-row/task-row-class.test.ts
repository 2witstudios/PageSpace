import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  taskCaretClass,
  taskChildrenClass,
  taskLevelClass,
  taskNoticeClass,
  taskRowClass,
  taskSlotClass,
  taskTitleClass,
  taskToggleClass,
} from './task-row-class';

describe('task row classes', () => {
  test('the row', () => {
    assert({
      given: 'a task row',
      should: 'be the file tree’s quiet ~32px row, holding controls rather than being one',
      actual: taskRowClass,
      expected:
        'flex w-full items-center gap-2 rounded-lg px-2 py-row-y text-left text-sm transition-colors duration-120 ease-standard hover:bg-surface-overlay',
    });
  });

  test('the lead slot', () => {
    assert({
      given: 'the caret and the empty slot a leaf keeps',
      should: 'both take the checkbox’s square',
      actual: [taskSlotClass, taskToggleClass],
      expected: [
        'inline-flex size-checkbox flex-none items-center justify-center',
        'inline-flex size-checkbox flex-none cursor-pointer items-center justify-center rounded-sm',
      ],
    });
  });

  test('the caret', () => {
    assert({
      given: 'a collapsed and an expanded parent',
      should: 'turn the caret a quarter while open',
      actual: [taskCaretClass(false), taskCaretClass(true)],
      expected: [
        'inline-flex text-ink-faint transition-transform duration-120 ease-standard rotate-0',
        'inline-flex text-ink-faint transition-transform duration-120 ease-standard rotate-90',
      ],
    });
  });

  test('the title', () => {
    assert({
      given: 'an open and a done task',
      should: 'strike through and fade only the done one',
      actual: [taskTitleClass(false), taskTitleClass(true)],
      expected: ['min-w-0 flex-1 truncate text-ink', 'min-w-0 flex-1 truncate text-ink-faint line-through'],
    });
  });

  test('levels and notices', () => {
    assert({
      given: 'a level of the outline, a nested level and a refusal',
      should: 'stack rows, step nested levels in, and say why in the live tone',
      actual: [taskLevelClass, taskChildrenClass, taskNoticeClass],
      expected: ['flex flex-col gap-1', 'flex flex-col gap-1 pl-tree-step', 'px-2 pt-1 text-2xs font-medium text-live'],
    });
  });
});
