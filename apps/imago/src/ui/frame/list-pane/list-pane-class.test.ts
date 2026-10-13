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
        'flex h-full flex-none flex-col border-r border-hairline bg-background w-list-pane',
        'flex h-full flex-none flex-col border-r border-hairline bg-background w-tree-pane',
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
