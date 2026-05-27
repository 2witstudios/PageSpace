import { describe, it } from 'vitest';
import { expect } from 'vitest';
import { shouldShowPlaceholder, shouldShowSkeleton } from '../TaskRowDescription';
import { canExpandTask } from '../task-list-types';

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

describe('canExpandTask', () => {
  it('no pageId', () => {
    assert({ given: 'no pageId', should: 'not expand', actual: canExpandTask({ pageId: null, hasContent: true, subTaskCount: 5 }), expected: false });
  });
  it('has content, no subtasks', () => {
    assert({ given: 'hasContent=true, subTaskCount=0', should: 'expand', actual: canExpandTask({ pageId: 'p1', hasContent: true, subTaskCount: 0 }), expected: true });
  });
  it('has subtasks, no content', () => {
    assert({ given: 'hasContent=false, subTaskCount=3', should: 'expand', actual: canExpandTask({ pageId: 'p1', hasContent: false, subTaskCount: 3 }), expected: true });
  });
  it('no content, no subtasks', () => {
    assert({ given: 'hasContent=false, subTaskCount=0', should: 'not expand', actual: canExpandTask({ pageId: 'p1', hasContent: false, subTaskCount: 0 }), expected: false });
  });
  it('undefined hasContent and subTaskCount', () => {
    assert({ given: 'both undefined', should: 'not expand', actual: canExpandTask({ pageId: 'p1', hasContent: undefined, subTaskCount: undefined }), expected: false });
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
