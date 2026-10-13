import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { taskListEmptyClass, taskListRowClass, taskListRowTitleClass, tasksPaneMessageClass } from './tasks-pane-class';

const base =
  'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-row-y text-left text-sm no-underline transition-colors duration-120 ease-standard hover:no-underline';

describe('tasks pane classes', () => {
  test('a list row', () => {
    assert({
      given: 'a list row at rest and the open one',
      should: 'be the quiet sidebar row, the open one on the soft accent at full ink',
      actual: [taskListRowClass(false), taskListRowClass(true)],
      expected: [
        `${base} text-ink-muted hover:bg-surface-overlay hover:text-ink`,
        `${base} bg-accent-soft text-ink`,
      ],
    });
  });

  test('its parts', () => {
    assert({
      given: 'the row’s title, an empty list’s note and the pane’s messages',
      should: 'truncate the title and keep the rest quiet',
      actual: [taskListRowTitleClass, taskListEmptyClass, tasksPaneMessageClass],
      expected: ['min-w-0 flex-1 truncate', 'flex-none text-2xs text-ink-faint', 'px-2 text-sm text-ink-muted'],
    });
  });
});
