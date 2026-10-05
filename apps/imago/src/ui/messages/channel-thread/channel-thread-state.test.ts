import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import type { Post } from '../message-model/post';
import { initialThreadState, threadPosts, threadReducer, type ChannelPage, type ThreadState } from './channel-thread-state';

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
      expected: {
        pageId: 'c1',
        status: 'loading',
        posts: [],
        sending: [],
        heard: 0,
        lastReadAt: null,
        nextCursor: null,
        older: 'idle',
      },
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
        sending: [],
        heard: 0,
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

/** The viewer's own post as the server confirms it. */
const mine = (id: string, at: string, text: string): Post => ({
  ...post(id, at),
  authorKey: 'u1',
  authorName: 'Ada',
  countsAsUnread: false,
  text,
});

/** The viewer's post as the composer shows it before the server answers. */
const pending = (nonce: string, at: string, text: string): Post => ({
  ...mine(`temp-${nonce}`, at, text),
  pending: true,
});

const ready = (ids: readonly string[]) =>
  run(initialThreadState('c1'), { type: 'loaded', pageId: 'c1', page: page(ids) });

const ids = (state: ThreadState) => threadPosts(state).map((entry) => `${entry.id}${entry.pending ? ' (sending)' : ''}`);

describe('sending and receiving', () => {
  test('sending shows the post at once', () => {
    const state = run(ready(['a']), {
      type: 'sent',
      pageId: 'c1',
      post: pending('n1', '2026-10-05T10:00:00.000Z', 'hello'),
    });
    assert({
      given: 'the viewer sending a post',
      should: 'show it after the channel’s posts, marked as sending',
      actual: ids(state),
      expected: ['a', 'temp-n1 (sending)'],
    });
  });

  test('the response first, then the socket echo', () => {
    const sent = run(ready(['a']), { type: 'sent', pageId: 'c1', post: pending('n1', '2026-10-05T10:00:00.000Z', 'hi') });
    const confirmed = mine('m9', '2026-10-05T10:00:01.000Z', 'hi @[Grace](u2:user)');
    const answered = run(sent, { type: 'received', pageId: 'c1', post: confirmed, nonce: 'n1', mine: true });
    const echoed = run(answered, { type: 'received', pageId: 'c1', post: confirmed, nonce: 'n1', mine: true });
    assert({
      given: 'the POST answering with the server copy, then the broadcast of the same post',
      should: 'replace the sending post with the server’s (its id, time and stored text), and ignore the echo',
      actual: [ids(answered), threadPosts(answered).at(-1), ids(echoed)],
      expected: [['a', 'm9'], confirmed, ['a', 'm9']],
    });
  });

  test('the socket echo first, then the response', () => {
    const sent = run(ready(['a']), { type: 'sent', pageId: 'c1', post: pending('n1', '2026-10-05T10:00:00.000Z', 'hi') });
    const confirmed = mine('m9', '2026-10-05T10:00:01.000Z', 'hi');
    const echoed = run(sent, { type: 'received', pageId: 'c1', post: confirmed, nonce: 'n1', mine: true });
    const answered = run(echoed, { type: 'received', pageId: 'c1', post: confirmed, nonce: 'n1', mine: true });
    assert({
      given: 'the broadcast landing before the POST resolves',
      should: 'retire the sending post on the echo, and ignore the response',
      actual: [ids(echoed), ids(answered)],
      expected: [
        ['a', 'm9'],
        ['a', 'm9'],
      ],
    });
  });

  test('two sends in flight', () => {
    const state = run(
      ready([]),
      { type: 'sent', pageId: 'c1', post: pending('n1', '2026-10-05T10:00:00.000Z', 'one') },
      { type: 'sent', pageId: 'c1', post: pending('n2', '2026-10-05T10:00:00.000Z', 'two') },
      { type: 'received', pageId: 'c1', post: mine('m2', '2026-10-05T10:00:02.000Z', 'two'), nonce: 'n2', mine: true },
    );
    assert({
      given: 'two posts sending and the second confirmed first',
      should: 'retire exactly the second, keeping the first sending',
      actual: ids(state),
      expected: ['m2', 'temp-n1 (sending)'],
    });
  });

  test('someone else replaying the viewer’s nonce', () => {
    const state = run(
      ready([]),
      { type: 'sent', pageId: 'c1', post: pending('n1', '2026-10-05T10:00:00.000Z', 'mine') },
      { type: 'received', pageId: 'c1', post: post('x1', '2026-10-05T10:00:01.000Z'), nonce: 'n1', mine: false },
    );
    assert({
      given: 'another member’s post carrying the nonce the viewer’s send went out with',
      should: 'show their post and keep the viewer’s still sending',
      actual: ids(state),
      expected: ['x1', 'temp-n1 (sending)'],
    });
  });

  test('a post from someone else', () => {
    const state = run(ready(['a']), {
      type: 'received',
      pageId: 'c1',
      post: post('b', '2026-10-05T10:00:00.000Z'),
      mine: false,
    });
    const again = run(state, { type: 'received', pageId: 'c1', post: post('b', '2026-10-05T10:00:00.000Z'), mine: false });
    assert({
      given: 'another member’s post arriving live, then delivered again',
      should: 'add it once, in time order, and count it heard once',
      actual: [ids(state), state.heard, ids(again), again.heard],
      expected: [['a', 'b'], 1, ['a', 'b'], 1],
    });
  });

  test('a post that is older than the newest', () => {
    const state = run(
      ready([]),
      { type: 'received', pageId: 'c1', post: post('late', '2026-10-05T10:00:05.000Z'), mine: false },
      { type: 'received', pageId: 'c1', post: post('early', '2026-10-05T10:00:01.000Z'), mine: false },
    );
    assert({
      given: 'two live posts arriving out of order',
      should: 'keep the thread in time order',
      actual: ids(state),
      expected: ['early', 'late'],
    });
  });

  test('a post that lands while the channel loads', () => {
    const state = run(
      initialThreadState('c1'),
      { type: 'received', pageId: 'c1', post: post('live', '2026-10-05T11:00:00.000Z'), mine: false },
      { type: 'loaded', pageId: 'c1', page: page(['a']) },
    );
    assert({
      given: 'a live post before the first page answers, from before it was posted',
      should: 'keep the live post after the page’s',
      actual: ids(state),
      expected: ['a', 'live'],
    });
  });

  test('a failed send', () => {
    const state = run(
      ready(['a']),
      { type: 'sent', pageId: 'c1', post: pending('n1', '2026-10-05T10:00:00.000Z', 'hi') },
      { type: 'sendFailed', pageId: 'c1', nonce: 'n1' },
    );
    assert({
      given: 'the POST failing',
      should: 'take the sending post back out',
      actual: ids(state),
      expected: ['a'],
    });
  });

  test('another channel’s traffic', () => {
    const state = ready(['a']);
    assert({
      given: 'sends and posts for a channel the viewer has left',
      should: 'leave the open channel untouched',
      actual: run(
        state,
        { type: 'sent', pageId: 'c2', post: pending('n1', '2026-10-05T10:00:00.000Z', 'hi') },
        { type: 'received', pageId: 'c2', post: post('b'), mine: false },
        { type: 'sendFailed', pageId: 'c2', nonce: 'n1' },
      ),
      expected: state,
    });
  });
});
