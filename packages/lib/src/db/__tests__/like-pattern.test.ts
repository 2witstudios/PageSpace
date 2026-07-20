import { describe, it, expect } from 'vitest';
import { escapeLikePattern } from '../like-pattern';

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

describe('escapeLikePattern', () => {
  it('plain text', () => {
    assert({
      given: 'a search term with no special characters',
      should: 'pass through unmodified',
      actual: escapeLikePattern('groceries'),
      expected: 'groceries',
    });
  });

  it('literal percent sign', () => {
    assert({
      given: 'a search term containing a % character',
      should: 'escape it so ILIKE treats it as a literal char, not a wildcard',
      actual: escapeLikePattern('50% off'),
      expected: '50\\% off',
    });
  });

  it('literal underscore', () => {
    assert({
      given: 'a search term containing a _ character',
      should: 'escape it so ILIKE treats it as a literal char, not a single-char wildcard',
      actual: escapeLikePattern('foo_bar'),
      expected: 'foo\\_bar',
    });
  });

  it('literal backslash', () => {
    assert({
      given: 'a search term containing a backslash',
      should: 'escape the backslash itself so it is not read as an escape character',
      actual: escapeLikePattern('a\\b'),
      expected: 'a\\\\b',
    });
  });

  it('multiple special characters', () => {
    assert({
      given: 'a search term containing %, _, and \\ together',
      should: 'escape every occurrence',
      actual: escapeLikePattern('100%_done\\ish'),
      expected: '100\\%\\_done\\\\ish',
    });
  });
});
