import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { listGroupLabelClass, listGroupRowsClass } from './list-group-class';

describe('listGroupLabelClass', () => {
  test('the group label', () => {
    assert({
      given: 'a sidebar group label such as "Direct messages"',
      should: 'set it small, semibold and faint, aligned with the rows and never uppercase',
      actual: listGroupLabelClass,
      expected: 'px-2 pb-1 text-2xs font-semibold tracking-wide text-ink-faint',
    });
  });
});

describe('listGroupRowsClass', () => {
  test('the rows', () => {
    assert({
      given: 'the list of rows under the label',
      should: 'stack them in a column 4px apart',
      actual: listGroupRowsClass,
      expected: 'flex flex-col gap-1',
    });
  });
});
