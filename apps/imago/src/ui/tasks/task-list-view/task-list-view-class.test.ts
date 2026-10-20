import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import {
  taskListBodyClass,
  taskListColumnClass,
  taskListDescriptionToggleClass,
  taskListMessageClass,
  taskListViewClass,
} from './task-list-view-class';

describe('task list view classes', () => {
  test('the frame', () => {
    assert({
      given: 'an open task list',
      should: 'stack the strip over a body that fills the rest',
      actual: [taskListViewClass, taskListMessageClass],
      expected: ['flex h-full min-h-0 flex-col', 'text-sm text-ink-muted'],
    });
  });

  test('wide and narrow bodies', () => {
    assert({
      given: 'the Board or Roadmap, then an outline view',
      should: 'let the wide views scroll themselves and the outline scroll in a centred column',
      actual: [taskListBodyClass(true), taskListBodyClass(false), taskListColumnClass],
      expected: [
        'flex min-h-0 flex-1 flex-col px-4 py-3',
        'min-h-0 flex-1 overflow-y-auto px-6 py-5',
        'mx-auto flex w-full max-w-imago-ground flex-col gap-4',
      ],
    });
  });

  test('the description toggle', () => {
    assert({
      given: 'the folded description, then the open one',
      should: 'bring the open toggle up to full ink',
      actual: taskListDescriptionToggleClass(true).endsWith('text-ink'),
      expected: true,
    });
  });
});
