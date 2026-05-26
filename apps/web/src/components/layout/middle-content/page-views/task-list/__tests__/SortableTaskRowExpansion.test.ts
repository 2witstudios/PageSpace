import { describe, it } from 'vitest';
import { expect } from 'vitest';
import { getExpansionRowClass } from '../TaskListView';

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

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
