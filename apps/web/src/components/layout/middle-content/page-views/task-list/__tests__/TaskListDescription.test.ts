import { describe, it } from 'vitest';
import { expect } from 'vitest';
import { getInitialOpenState } from '../TaskListDescription';

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

describe('getInitialOpenState', () => {
  it('null content', () => {
    assert({
      given: 'null content',
      should: 'start collapsed',
      actual: getInitialOpenState(null),
      expected: false,
    });
  });

  it('empty paragraph', () => {
    assert({
      given: 'an empty paragraph tag',
      should: 'start collapsed',
      actual: getInitialOpenState('<p></p>'),
      expected: false,
    });
  });

  it('content with text', () => {
    assert({
      given: 'a paragraph with text content',
      should: 'start expanded',
      actual: getInitialOpenState('<p>Some notes here</p>'),
      expected: true,
    });
  });
});
