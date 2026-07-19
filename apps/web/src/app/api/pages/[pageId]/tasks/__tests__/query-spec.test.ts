import { describe, it, expect } from 'vitest';
import { parseTaskQuerySpec, escapeLikePattern } from '../query-spec';

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

describe('parseTaskQuerySpec', () => {
  it('no params', () => {
    assert({
      given: 'an empty query string',
      should: 'default to limit 100, offset 0, sortOrder asc, no filters',
      actual: parseTaskQuerySpec(new URLSearchParams('')),
      expected: { sortOrder: 'asc', limit: 100, offset: 0 },
    });
  });

  it('limit=0', () => {
    assert({
      given: 'limit=0',
      should: 'clamp to the minimum of 1',
      actual: parseTaskQuerySpec(new URLSearchParams('limit=0')).limit,
      expected: 1,
    });
  });

  it('negative limit', () => {
    assert({
      given: 'limit=-5',
      should: 'clamp to the minimum of 1',
      actual: parseTaskQuerySpec(new URLSearchParams('limit=-5')).limit,
      expected: 1,
    });
  });

  it('non-numeric limit', () => {
    assert({
      given: 'limit=abc',
      should: 'fall back to the default of 100',
      actual: parseTaskQuerySpec(new URLSearchParams('limit=abc')).limit,
      expected: 100,
    });
  });

  it('limit=9999', () => {
    assert({
      given: 'limit=9999',
      should: 'clamp to the maximum of 200',
      actual: parseTaskQuerySpec(new URLSearchParams('limit=9999')).limit,
      expected: 200,
    });
  });

  it('negative offset', () => {
    assert({
      given: 'offset=-10',
      should: 'clamp to the minimum of 0',
      actual: parseTaskQuerySpec(new URLSearchParams('offset=-10')).offset,
      expected: 0,
    });
  });

  it('non-numeric offset', () => {
    assert({
      given: 'offset=abc',
      should: 'fall back to the default of 0',
      actual: parseTaskQuerySpec(new URLSearchParams('offset=abc')).offset,
      expected: 0,
    });
  });

  it('positive offset', () => {
    assert({
      given: 'offset=50',
      should: 'pass through unmodified',
      actual: parseTaskQuerySpec(new URLSearchParams('offset=50')).offset,
      expected: 50,
    });
  });

  it('invalid sortOrder', () => {
    assert({
      given: 'sortOrder=bogus',
      should: 'fall back to asc',
      actual: parseTaskQuerySpec(new URLSearchParams('sortOrder=bogus')).sortOrder,
      expected: 'asc',
    });
  });

  it('sortOrder=desc', () => {
    assert({
      given: 'sortOrder=desc',
      should: 'pass through as desc',
      actual: parseTaskQuerySpec(new URLSearchParams('sortOrder=desc')).sortOrder,
      expected: 'desc',
    });
  });

  it('status present', () => {
    assert({
      given: 'status=in_progress',
      should: 'pass through unmodified',
      actual: parseTaskQuerySpec(new URLSearchParams('status=in_progress')).status,
      expected: 'in_progress',
    });
  });

  it('status absent', () => {
    assert({
      given: 'no status param',
      should: 'be undefined',
      actual: parseTaskQuerySpec(new URLSearchParams('')).status,
      expected: undefined,
    });
  });

  it('assigneeId present', () => {
    assert({
      given: 'assigneeId=user-1',
      should: 'pass through unmodified',
      actual: parseTaskQuerySpec(new URLSearchParams('assigneeId=user-1')).assigneeId,
      expected: 'user-1',
    });
  });

  it('assigneeId absent', () => {
    assert({
      given: 'no assigneeId param',
      should: 'be undefined',
      actual: parseTaskQuerySpec(new URLSearchParams('')).assigneeId,
      expected: undefined,
    });
  });

  it('search present', () => {
    assert({
      given: 'search=groceries',
      should: 'pass through unmodified',
      actual: parseTaskQuerySpec(new URLSearchParams('search=groceries')).search,
      expected: 'groceries',
    });
  });

  it('search absent', () => {
    assert({
      given: 'no search param',
      should: 'be undefined',
      actual: parseTaskQuerySpec(new URLSearchParams('')).search,
      expected: undefined,
    });
  });
});

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
