import { describe, it } from 'vitest';
import { expect } from 'vitest';
import { shouldFetchDescription } from '../TaskDetailSheet';

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

describe('shouldFetchDescription', () => {
  it('sheet closed', () => {
    assert({
      given: 'the sheet is closed',
      should: 'not fetch',
      actual: shouldFetchDescription(false, 'page-1'),
      expected: false,
    });
  });

  it('null pageId', () => {
    assert({
      given: 'a null pageId',
      should: 'not fetch',
      actual: shouldFetchDescription(true, null),
      expected: false,
    });
  });

  it('undefined pageId', () => {
    assert({
      given: 'an undefined pageId',
      should: 'not fetch',
      actual: shouldFetchDescription(true, undefined),
      expected: false,
    });
  });

  it('sheet open with valid pageId', () => {
    assert({
      given: 'the sheet is open and pageId exists',
      should: 'fetch the description',
      actual: shouldFetchDescription(true, 'page-1'),
      expected: true,
    });
  });
});
