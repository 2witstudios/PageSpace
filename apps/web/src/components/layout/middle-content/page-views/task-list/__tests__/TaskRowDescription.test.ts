import { describe, it } from 'vitest';
import { expect } from 'vitest';
import { shouldShowPlaceholder, shouldShowSkeleton } from '../TaskRowDescription';

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

describe('shouldShowPlaceholder', () => {
  it('null pageId', () => {
    assert({
      given: 'a null pageId',
      should: 'show the placeholder',
      actual: shouldShowPlaceholder(null),
      expected: true,
    });
  });

  it('undefined pageId', () => {
    assert({
      given: 'an undefined pageId',
      should: 'show the placeholder',
      actual: shouldShowPlaceholder(undefined),
      expected: true,
    });
  });

  it('valid pageId', () => {
    assert({
      given: 'a valid pageId string',
      should: 'not show the placeholder',
      actual: shouldShowPlaceholder('page-abc123'),
      expected: false,
    });
  });
});

describe('shouldShowSkeleton', () => {
  it('loading with no content yet', () => {
    assert({
      given: 'isLoading is true and content is null',
      should: 'show the skeleton',
      actual: shouldShowSkeleton(true, null),
      expected: true,
    });
  });

  it('not loading', () => {
    assert({
      given: 'isLoading is false',
      should: 'not show the skeleton',
      actual: shouldShowSkeleton(false, null),
      expected: false,
    });
  });

  it('loading but content already present', () => {
    assert({
      given: 'isLoading is true but content is already available',
      should: 'not show the skeleton so the editor does not flash',
      actual: shouldShowSkeleton(true, '<p>existing</p>'),
      expected: false,
    });
  });
});
