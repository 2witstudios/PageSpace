import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { channelMessage, channelReaction } from './fixtures';
import { postsFrom } from './posts-from-api';

const ada = { id: 'u1', name: 'Ada Lovelace' };
const grace = { id: 'u2', name: 'Grace Hopper' };

describe('postsFrom()', () => {
  test('a person’s post', () => {
    assert({
      given: 'a top-level post by another member, edited once',
      should: 'carry its author, time, text and edit, and count toward the viewer’s unread',
      actual: postsFrom(
        [
          channelMessage('m1', {
            content: 'shipping @[Ada](u1:user)',
            createdAt: '2026-10-05T09:00:00.000Z',
            editedAt: '2026-10-05T09:02:00.000Z',
            user: { id: 'u2', name: 'Grace Hopper', image: 'https://img/grace.png' },
          }),
        ],
        'u1',
      ),
      expected: [
        {
          id: 'm1',
          authorKey: 'u2',
          authorName: 'Grace Hopper',
          authorImage: 'https://img/grace.png',
          agent: false,
          countsAsUnread: true,
          at: '2026-10-05T09:00:00.000Z',
          text: 'shipping @[Ada](u1:user)',
          edited: true,
          reactions: [],
        },
      ],
    });
  });

  test('the viewer’s own post', () => {
    assert({
      given: 'a post the viewer wrote',
      should: 'never count toward their unread, as the server counts it',
      actual: postsFrom([channelMessage('m1', { userId: 'u1', user: { id: 'u1', name: 'Ada', image: null } })], 'u1').map(
        (post) => post.countsAsUnread,
      ),
      expected: [false],
    });
  });

  test('agent and webhook posts', () => {
    const [agent, webhook] = postsFrom(
      [
        channelMessage('m1', {
          userId: 'u1',
          user: { id: 'u1', name: 'Ada', image: null },
          aiMeta: { senderType: 'agent', senderName: 'Planner', agentPageId: 'a1' },
        }),
        channelMessage('m2', {
          userId: 'u1',
          user: { id: 'u1', name: 'Ada', image: null },
          aiMeta: { senderType: 'webhook', senderName: 'CI' },
        }),
      ],
      'u1',
    );
    assert({
      given: 'an agent post and a webhook post sent under the viewer’s user id',
      should: 'name each by its sender, draw both as agents, keep them apart from the viewer, and count only the agent’s as unread (the server’s rule)',
      actual: [agent, webhook].map((post) => post && [post.authorName, post.authorKey, post.agent, post.countsAsUnread]),
      expected: [
        ['Planner', 'u1:agent:a1', true, true],
        ['CI', 'u1:webhook:CI', true, false],
      ],
    });
  });

  test('a deleted user', () => {
    assert({
      given: 'a post whose author has no name',
      should: 'still be attributed to someone',
      actual: postsFrom([channelMessage('m1', { user: { id: 'u2', name: null, image: null } })], 'u1')[0]?.authorName,
      expected: 'Unknown user',
    });
  });

  test('reactions', () => {
    const [post] = postsFrom(
      [
        channelMessage('m1', {
          reactions: [
            channelReaction('r2', '🎉', grace, '2026-10-05T09:03:00.000Z'),
            channelReaction('r1', '👍', grace, '2026-10-05T09:01:00.000Z'),
            channelReaction('r3', '👍', ada, '2026-10-05T09:02:00.000Z'),
            channelReaction('r4', '👀', { id: 'u3', name: null }, '2026-10-05T09:04:00.000Z'),
          ],
        }),
      ],
      'u1',
    );
    assert({
      given: 'reactions in no particular order, two on one emoji, one by the viewer, one by a nameless user',
      should: 'group them by emoji in the order each was first used, with a count, the names and whether the viewer is among them',
      actual: post?.reactions,
      expected: [
        { emoji: '👍', count: 2, names: ['Grace Hopper', 'Ada Lovelace'], mine: true },
        { emoji: '🎉', count: 1, names: ['Grace Hopper'], mine: false },
        { emoji: '👀', count: 1, names: ['Unknown user'], mine: false },
      ],
    });
  });
});
