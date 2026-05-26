import { describe, it } from 'vitest';
import { expect } from 'vitest';
import { allRowsNull } from '../task-helpers';

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

describe('allRowsNull', () => {
  it('empty array', () => {
    assert({
      given: 'an empty array',
      should: 'return true',
      actual: allRowsNull([]),
      expected: true,
    });
  });

  it('all rows null', () => {
    assert({
      given: 'rows where every description is null',
      should: 'return true',
      actual: allRowsNull([{ description: null }, { description: null }]),
      expected: true,
    });
  });

  it('one row with a value', () => {
    assert({
      given: 'a row with a non-null description',
      should: 'return false',
      actual: allRowsNull([{ description: null }, { description: 'some text' }]),
      expected: false,
    });
  });
});
