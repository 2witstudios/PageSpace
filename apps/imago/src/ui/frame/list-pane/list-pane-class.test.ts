import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { listBodyClass, listPaneClass } from './list-pane-class';

describe('listPaneClass()', () => {
  test('the variants', () => {
    assert({
      given: 'the wide list and the narrow tree',
      should: 'fill the allocated pane width and allow content to shrink for every variant',
      actual: [listPaneClass('list'), listPaneClass('tree')],
      expected: [
        'flex h-full w-full min-w-0 flex-1 flex-col border-r border-hairline bg-tint phone:border-r-0',
        'flex h-full w-full min-w-0 flex-1 flex-col border-r border-hairline bg-tint phone:border-r-0',
      ],
    });
  });

  test('the body', () => {
    assert({
      given: 'the list body',
      should: 'scroll on its own under the header, padded 8px',
      actual: listBodyClass,
      expected: 'flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2 py-2',
    });
  });
});
