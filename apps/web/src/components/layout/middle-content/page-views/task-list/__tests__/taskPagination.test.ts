import { describe, it } from 'vitest';
import { assert } from '@/hooks/__tests__/riteway';
import { getHasMoreTasks, isLoadingNextTaskPage } from '../TaskListView';

describe('getHasMoreTasks', () => {
  it('no pages loaded yet', () => {
    assert({
      given: 'undefined pages (still loading the first page)',
      should: 'return false',
      actual: getHasMoreTasks(undefined),
      expected: false,
    });
  });

  it('empty pages array', () => {
    assert({
      given: 'an empty pages array',
      should: 'return false',
      actual: getHasMoreTasks([]),
      expected: false,
    });
  });

  it('last loaded page reports more tasks exist', () => {
    assert({
      given: 'the most recently loaded page has hasMore=true',
      should: 'return true',
      actual: getHasMoreTasks([{ hasMore: true }, { hasMore: true }]),
      expected: true,
    });
  });

  it('last loaded page reports no more tasks', () => {
    assert({
      given: 'the most recently loaded page has hasMore=false',
      should: 'return false, even though an earlier page had hasMore=true',
      actual: getHasMoreTasks([{ hasMore: true }, { hasMore: false }]),
      expected: false,
    });
  });
});

describe('isLoadingNextTaskPage', () => {
  it('size is 0', () => {
    assert({
      given: 'size 0 (nothing requested yet)',
      should: 'return false',
      actual: isLoadingNextTaskPage(undefined, 0),
      expected: false,
    });
  });

  it('a new page was requested but has not resolved yet', () => {
    assert({
      given: 'size incremented past the number of loaded pages',
      should: 'return true',
      actual: isLoadingNextTaskPage([{ hasMore: true }], 2),
      expected: true,
    });
  });

  it('all requested pages have resolved', () => {
    assert({
      given: 'the number of loaded pages matches size',
      should: 'return false',
      actual: isLoadingNextTaskPage([{ hasMore: true }, { hasMore: false }], 2),
      expected: false,
    });
  });

  it('pages is undefined but a page was requested', () => {
    assert({
      given: 'size 1 and no pages resolved yet (first load)',
      should: 'return true',
      actual: isLoadingNextTaskPage(undefined, 1),
      expected: true,
    });
  });
});
