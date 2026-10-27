import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  taskListCountClass,
  taskListEmptyClass,
  taskListRowClass,
  taskListRowTitleClass,
  tasksPaneMessageClass,
  taskViewCountClass,
} from './tasks-pane-class';

const row = 'flex w-full cursor-pointer text-left text-sm no-underline transition-colors duration-120 ease-standard hover:no-underline flex-col gap-1 rounded-lg px-2 py-2';

describe('tasks pane classes', () => {
  test('a list row', () => {
    assert({
      given: 'a list row at rest and the open one',
      should: 'be the quiet sidebar row stacked over its bar, the open one on the soft accent at full ink',
      actual: [taskListRowClass(false), taskListRowClass(true)],
      expected: [`${row} text-ink-muted hover:bg-surface-overlay hover:text-ink`, `${row} bg-accent-soft text-ink`],
    });
  });

  test('its parts', () => {
    assert({
      given: 'the row’s title, its count, an empty list’s note and the pane’s messages',
      should: 'truncate the title and keep the rest quiet',
      actual: [taskListRowTitleClass, taskListCountClass, taskListEmptyClass, tasksPaneMessageClass],
      expected: [
        'min-w-0 flex-1 truncate',
        'flex-none font-mono text-2xs tabular-nums text-ink-faint',
        'flex-none text-2xs text-ink-faint',
        'px-2 text-sm text-ink-muted',
      ],
    });
  });

  test('a view count', () => {
    assert({
      given: 'an overdue count that is not zero and a quiet count',
      should: 'read the overdue count as a warning and keep the other quiet',
      actual: [taskViewCountClass(true), taskViewCountClass(false)],
      expected: [
        'flex-none font-mono text-2xs tabular-nums font-medium text-status-danger',
        'flex-none font-mono text-2xs tabular-nums text-ink-faint',
      ],
    });
  });
});
