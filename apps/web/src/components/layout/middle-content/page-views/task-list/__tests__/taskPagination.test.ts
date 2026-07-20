import { describe, it } from 'vitest';
import { assert } from '@/hooks/__tests__/riteway';
import { getHasMoreTasks, isLoadingNextTaskPage, redistributeTasksAcrossPages, getTaskLoadMoreState } from '../TaskListView';
import type { TaskItem } from '../task-list-types';

// Minimal stand-ins — redistributeTasksAcrossPages only reads/copies `id` and `.tasks.length`.
const task = (id: string) => ({ id }) as unknown as TaskItem;

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

describe('redistributeTasksAcrossPages', () => {
  it('preserves each page\'s original size', () => {
    const pages = [
      { hasMore: true, tasks: [task('a'), task('b')] },
      { hasMore: false, tasks: [task('c')] },
    ];
    const reordered = [task('c'), task('a'), task('b')];
    const result = redistributeTasksAcrossPages(pages, reordered);
    assert({
      given: 'pages of size 2 and 1',
      should: 'keep the same per-page task counts after redistributing',
      actual: result.map(p => p.tasks.length),
      expected: [2, 1],
    });
  });

  it('preserves order within the redistribution', () => {
    const pages = [
      { hasMore: true, tasks: [task('a'), task('b')] },
      { hasMore: false, tasks: [task('c')] },
    ];
    const reordered = [task('c'), task('a'), task('b')];
    const result = redistributeTasksAcrossPages(pages, reordered);
    assert({
      given: 'a reordered list where "c" moved to the front',
      should: 'fill each page sequentially from the reordered list',
      actual: result.map(p => p.tasks.map(t => t.id)),
      expected: [['c', 'a'], ['b']],
    });
  });

  it('preserves non-tasks fields (e.g. hasMore) untouched', () => {
    const pages = [
      { hasMore: true, tasks: [task('a')] },
      { hasMore: false, tasks: [task('b')] },
    ];
    const result = redistributeTasksAcrossPages(pages, [task('b'), task('a')]);
    assert({
      given: 'pages with distinct hasMore flags',
      should: 'leave hasMore on each page exactly as it was',
      actual: result.map(p => p.hasMore),
      expected: [true, false],
    });
  });

  it('does not mutate the input pages array', () => {
    const pages = [{ hasMore: true, tasks: [task('a')] }];
    redistributeTasksAcrossPages(pages, [task('a')]);
    assert({
      given: 'the original pages array after redistributing',
      should: 'remain referentially the same objects (pure function)',
      actual: pages[0].tasks[0].id,
      expected: 'a',
    });
  });

  it('shorter reordered list (e.g. a filtered subset) truncates later pages instead of throwing', () => {
    const pages = [
      { hasMore: true, tasks: [task('a'), task('b')] },
      { hasMore: false, tasks: [task('c'), task('d')] },
    ];
    // Only 2 of the original 4 tasks are in the reordered (filtered) list.
    const result = redistributeTasksAcrossPages(pages, [task('a'), task('b')]);
    assert({
      given: 'a reordered list shorter than the total task count across pages',
      should: 'fill leading pages fully and leave trailing pages empty rather than throwing',
      actual: result.map(p => p.tasks.length),
      expected: [2, 0],
    });
  });

  it('empty pages array', () => {
    assert({
      given: 'no loaded pages',
      should: 'return an empty array',
      actual: redistributeTasksAcrossPages([], []),
      expected: [],
    });
  });
});

describe('getTaskLoadMoreState', () => {
  it('nothing requested yet', () => {
    assert({
      given: 'size 0',
      should: 'return idle',
      actual: getTaskLoadMoreState(undefined, 0, false),
      expected: 'idle',
    });
  });

  it('all requested pages have resolved, no error', () => {
    assert({
      given: 'page count matching size and no error',
      should: 'return idle',
      actual: getTaskLoadMoreState([{}, {}], 2, false),
      expected: 'idle',
    });
  });

  it('a new page was requested and is still in flight', () => {
    assert({
      given: 'page count behind size and no error',
      should: 'return loading',
      actual: getTaskLoadMoreState([{}], 2, false),
      expected: 'loading',
    });
  });

  it('a new page was requested and permanently failed', () => {
    assert({
      given: 'page count behind size and an error is present (SWR keeps stale data + error together)',
      should: 'return failed, not loading',
      actual: getTaskLoadMoreState([{}], 2, true),
      expected: 'failed',
    });
  });

  it('an error exists but every requested page already resolved', () => {
    assert({
      given: 'page count matching size even though an error field happens to be set',
      should: 'return idle — nothing is behind, so there is nothing to retry',
      actual: getTaskLoadMoreState([{}, {}], 2, true),
      expected: 'idle',
    });
  });
});
