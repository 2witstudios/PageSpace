import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { listBodyClass, listPaneClass } from './list-pane-class';

describe('listPaneClass()', () => {
  test('the variants', () => {
    assert({
      given: 'the wide list and the narrow tree',
      should: 'hold its own width so the content never reflows while the pane slides',
      actual: [listPaneClass('list'), listPaneClass('tree')],
      expected: [
        'flex h-full flex-none flex-col border-r border-hairline surface-glass w-list-pane',
        'flex h-full flex-none flex-col border-r border-hairline surface-glass w-tree-pane',
      ],
    });
  });

  test('the body', () => {
    assert({
      given: 'the list body',
      should: 'scroll on its own under the header',
      actual: listBodyClass,
      expected: 'flex flex-1 flex-col gap-4 overflow-y-auto p-3',
    });
  });
});
