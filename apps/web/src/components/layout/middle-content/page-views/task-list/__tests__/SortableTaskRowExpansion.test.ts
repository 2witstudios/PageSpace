import { describe, it } from 'vitest';
import { assert } from '@/hooks/__tests__/riteway';
import { getExpansionRowClass } from '../TaskListView';

describe('getExpansionRowClass', () => {
  it('collapsed row is hidden', () => {
    assert({
      given: 'isExpanded is false',
      should: 'include the hidden class',
      actual: getExpansionRowClass(false).includes('hidden'),
      expected: true,
    });
  });

  it('expanded row is visible', () => {
    assert({
      given: 'isExpanded is true',
      should: 'not include the hidden class',
      actual: getExpansionRowClass(true).includes('hidden'),
      expected: false,
    });
  });
});
