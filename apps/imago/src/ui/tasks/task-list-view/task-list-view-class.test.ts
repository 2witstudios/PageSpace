import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  taskListBodyClass,
  taskListMessageClass,
  taskListTitleClass,
  taskListToolbarClass,
  taskListViewClass,
} from './task-list-view-class';

describe('task list view classes', () => {
  test('the frame', () => {
    assert({
      given: 'an open task list',
      should: 'stack a hairline-ruled toolbar over a padded body',
      actual: [taskListViewClass, taskListToolbarClass, taskListTitleClass, taskListBodyClass, taskListMessageClass],
      expected: [
        'flex min-h-full flex-col',
        'flex flex-none items-center gap-3 border-b border-hairline px-4 py-2',
        'min-w-0 flex-1 truncate font-semibold text-ink',
        'flex flex-1 flex-col px-6 py-4',
        'text-sm text-ink-muted',
      ],
    });
  });
});
