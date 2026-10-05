import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import type { Post } from '../message-model/post';
import { initialThreadState, threadReducer, type ChannelPage, type ThreadState } from './channel-thread-state';

const post = (id: string, at = '2026-10-05T09:00:00.000Z'): Post => ({
  id,
  authorKey: 'u2',
  authorName: 'Grace',
  authorImage: null,
  agent: false,
  countsAsUnread: true,
  at,
  text: id,
  edited: false,
  reactions: [],
});

const page = (ids: readonly string[], overrides: Partial<ChannelPage> = {}): ChannelPage => ({
  posts: ids.map((id) => post(id)),
  nextCursor: null,
  lastReadAt: '2026-10-05T08:00:00.000Z',
  ...overrides,
});

const run = (state: ThreadState, ...actions: Parameters<typeof threadReducer>[1][]): ThreadState =>
  actions.reduce(threadReducer, state);

describe('threadReducer', () => {
  test('opening a channel', () => {
    assert({
      given: 'a channel opened',
      should: 'be loading it with no posts',
      actual: initialThreadState('c1'),
      expected: { pageId: 'c1', status: 'loading', posts: [], lastReadAt: null, nextCursor: null, older: 'idle' },
    });
  });

  test('the first page', () => {
    assert({
      given: 'the newest page with an older cursor and the viewer’s read watermark',
      should: 'show its posts and keep the cursor and the watermark',
      actual: run(initialThreadState('c1'), {
        type: 'loaded',
        pageId: 'c1',
        page: page(['a', 'b'], { nextCursor: 'cur-1' }),
      }),
      expected: {
        pageId: 'c1',
        status: 'ready',
        posts: [post('a'), post('b')],
        lastReadAt: '2026-10-05T08:00:00.000Z',
        nextCursor: 'cur-1',
        older: 'idle',
      },
    });
  });

  test('earlier posts', () => {
    const state = run(
      initialThreadState('c1'),
      { type: 'loaded', pageId: 'c1', page: page(['c', 'd'], { nextCursor: 'cur-1' }) },
      { type: 'olderRequested', pageId: 'c1' },
    );
    const loaded = run(state, {
      type: 'olderLoaded',
      pageId: 'c1',
      page: page(['a', 'b', 'c'], { nextCursor: null, lastReadAt: '2026-10-05T12:00:00.000Z' }),
    });
    assert({
      given: 'an older page requested, then answered with one post the thread already holds',
      should: 'mark it loading, then put the older posts first once each, take the next cursor, and keep the watermark the channel opened with',
      actual: [state.older, loaded.posts.map((entry) => entry.id), loaded.nextCursor, loaded.lastReadAt, loaded.older],
      expected: ['loading', ['a', 'b', 'c', 'd'], null, '2026-10-05T08:00:00.000Z', 'idle'],
    });
  });

  test('failures', () => {
    const failed = run(initialThreadState('c1'), { type: 'failed', pageId: 'c1' });
    const olderFailed = run(
      initialThreadState('c1'),
      { type: 'loaded', pageId: 'c1', page: page(['a'], { nextCursor: 'cur-1' }) },
      { type: 'olderRequested', pageId: 'c1' },
      { type: 'olderFailed', pageId: 'c1' },
    );
    assert({
      given: 'the first page failing, and separately an older page failing',
      should: 'show the error, or keep the posts and the cursor with the older load failed',
      actual: [failed.status, olderFailed.status, olderFailed.posts.length, olderFailed.nextCursor, olderFailed.older],
      expected: ['error', 'ready', 1, 'cur-1', 'error'],
    });
  });

  test('answers for another channel', () => {
    const state = initialThreadState('c2');
    assert({
      given: 'answers arriving for a channel the viewer has already left',
      should: 'leave the open channel untouched',
      actual: run(
        state,
        { type: 'loaded', pageId: 'c1', page: page(['a']) },
        { type: 'failed', pageId: 'c1' },
        { type: 'olderLoaded', pageId: 'c1', page: page(['a']) },
      ),
      expected: state,
    });
  });

  test('switching channel', () => {
    const state = run(initialThreadState('c1'), { type: 'loaded', pageId: 'c1', page: page(['a']) }, { type: 'opened', pageId: 'c2' });
    assert({
      given: 'another channel opened',
      should: 'start over loading it',
      actual: state,
      expected: initialThreadState('c2'),
    });
  });
});
