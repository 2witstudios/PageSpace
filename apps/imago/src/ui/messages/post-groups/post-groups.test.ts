import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import type { Post } from '../message-model/post';
import { groupPosts, type PostItem } from './post-groups';

const post = (id: string, at: string, overrides: Partial<Post> = {}): Post => ({
  id,
  authorKey: 'u2',
  authorName: 'Grace Hopper',
  authorImage: null,
  agent: false,
  countsAsUnread: true,
  at,
  text: id,
  edited: false,
  reactions: [],
  ...overrides,
});

const mine = (id: string, at: string): Post =>
  post(id, at, { authorKey: 'u1', authorName: 'Ada Lovelace', countsAsUnread: false });

/** Each row as a short string: `day:<label>[+new]`, `new`, `lead:<id>` or `-:<id>`. */
const shape = (items: readonly PostItem[]): readonly string[] =>
  items.map((item) => {
    if (item.kind === 'day') return `day:${item.label}${item.unread ? '+new' : ''}`;
    if (item.kind === 'new') return 'new';
    return `${item.lead ? 'lead' : '-'}:${item.id}`;
  });

const today = '2026-10-05';
const allRead = '2026-10-05T23:00:00.000Z';

describe('groupPosts()', () => {
  test('no posts', () => {
    assert({
      given: 'an empty channel',
      should: 'render no rows',
      actual: groupPosts([], { today, lastReadAt: allRead }),
      expected: [],
    });
  });

  test('five-minute groups', () => {
    assert({
      given: 'one author posting at 0, +5 and +10:01 minutes, then another author, then the first again',
      should: 'group posts that follow within five minutes, and start a group on a longer gap or a new author',
      actual: shape(
        groupPosts(
          [
            post('a', '2026-10-05T09:00:00.000Z'),
            post('b', '2026-10-05T09:05:00.000Z'),
            post('c', '2026-10-05T09:10:01.000Z'),
            mine('d', '2026-10-05T09:10:30.000Z'),
            post('e', '2026-10-05T09:11:00.000Z'),
          ],
          { today, lastReadAt: allRead },
        ),
      ),
      expected: ['day:Today', 'lead:a', '-:b', 'lead:c', 'lead:d', 'lead:e'],
    });
  });

  test('day dividers', () => {
    assert({
      given: 'posts across two UTC days by one author within minutes of midnight',
      should: 'divide the days, each labelled, and start a new group after each divider',
      actual: shape(
        groupPosts(
          [post('a', '2026-10-03T12:00:00.000Z'), post('b', '2026-10-04T23:58:00.000Z'), post('c', '2026-10-05T00:01:00.000Z')],
          { today, lastReadAt: allRead },
        ),
      ),
      expected: ['day:Oct 3', 'lead:a', 'day:Yesterday', 'lead:b', 'day:Today', 'lead:c'],
    });
  });

  test('the New divider', () => {
    assert({
      given: 'a read watermark between two of one author’s grouped posts',
      should: 'put New before the first post after it and break the group there',
      actual: shape(
        groupPosts(
          [post('a', '2026-10-05T09:00:00.000Z'), post('b', '2026-10-05T09:01:00.000Z'), post('c', '2026-10-05T09:02:00.000Z')],
          { today, lastReadAt: '2026-10-05T09:00:30.000Z' },
        ),
      ),
      expected: ['day:Today', 'lead:a', 'new', 'lead:b', '-:c'],
    });
  });

  test('New on a new day', () => {
    assert({
      given: 'unread beginning with the first post of a day',
      should: 'say both on one divider',
      actual: shape(
        groupPosts([post('a', '2026-10-04T09:00:00.000Z'), post('b', '2026-10-05T09:00:00.000Z')], {
          today,
          lastReadAt: '2026-10-04T10:00:00.000Z',
        }),
      ),
      expected: ['day:Yesterday', 'lead:a', 'day:Today+new', 'lead:b'],
    });
  });

  test('the viewer’s own posts', () => {
    assert({
      given: 'the viewer’s own post after the watermark, then someone else’s',
      should: 'not mark the viewer’s post as new, only the other person’s',
      actual: shape(
        groupPosts([mine('a', '2026-10-05T09:00:00.000Z'), post('b', '2026-10-05T09:01:00.000Z')], {
          today,
          lastReadAt: '2026-10-05T08:00:00.000Z',
        }),
      ),
      expected: ['day:Today', 'lead:a', 'new', 'lead:b'],
    });
  });

  test('never read', () => {
    assert({
      given: 'a channel the viewer has never read',
      should: 'mark New at the first post by someone else',
      actual: shape(
        groupPosts([mine('a', '2026-10-05T09:00:00.000Z'), post('b', '2026-10-05T09:01:00.000Z')], { today, lastReadAt: null }),
      ),
      expected: ['day:Today', 'lead:a', 'new', 'lead:b'],
    });
  });

  test('all read', () => {
    assert({
      given: 'a watermark after every post',
      should: 'show no New divider',
      actual: shape(groupPosts([post('a', '2026-10-05T09:00:00.000Z')], { today, lastReadAt: allRead })),
      expected: ['day:Today', 'lead:a'],
    });
  });

  test('ids', () => {
    assert({
      given: 'a day divider, a New divider and posts',
      should: 'key every row uniquely',
      actual: groupPosts([post('a', '2026-10-05T09:00:00.000Z'), post('b', '2026-10-05T09:01:00.000Z')], {
        today,
        lastReadAt: '2026-10-05T09:00:30.000Z',
      }).map((item) => item.id),
      expected: ['day-a', 'a', 'new', 'b'],
    });
  });
});
