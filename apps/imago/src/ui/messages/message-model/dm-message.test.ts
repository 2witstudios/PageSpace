import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { channelReaction, dmMessage } from './fixtures';
import type { Post } from './post';
import { dmPostsFrom, dmReceivedFrom, liveDmPost, namedPosts } from './dm-message';

describe('dmPostsFrom()', () => {
  test('messages as posts', () => {
    const [theirs, mine, unnamed] = dmPostsFrom(
      [
        dmMessage('m1', {
          sender: { id: 'u2', name: 'Grace Hopper', image: 'https://img/grace.png' },
          reactions: [channelReaction('r1', '👍', { id: 'u1', name: 'Ada Lovelace' })],
        }),
        dmMessage('m2', { senderId: 'u1', sender: { id: 'u1', name: 'Ada Lovelace', image: null }, isEdited: true }),
        dmMessage('m3', { sender: null, editedAt: '2026-10-05T09:05:00.000Z' }),
      ],
      'u1',
    );
    assert({
      given: 'the other person’s message with a reaction, the viewer’s edited one, and one with no sender joined',
      should: 'key each by sender, count only the other person’s as unread, mark edits, and leave an unjoined author unnamed',
      actual: [theirs, [mine?.authorName, mine?.countsAsUnread, mine?.edited], [unnamed?.authorName, unnamed?.edited]],
      expected: [
        {
          id: 'm1',
          authorKey: 'u2',
          authorName: 'Grace Hopper',
          authorImage: 'https://img/grace.png',
          agent: false,
          countsAsUnread: true,
          at: '2026-10-05T09:00:00.000Z',
          text: 'message m1',
          edited: false,
          reactions: [{ emoji: '👍', count: 1, names: ['Ada Lovelace'], mine: true }],
        },
        ['Ada Lovelace', false, true],
        ['', true],
      ],
    });
  });
});

describe('dmReceivedFrom()', () => {
  test('the nonce and who sent it', () => {
    assert({
      given: 'the viewer’s stored message with its nonce echoed, and the other person’s without one',
      should: 'carry the nonce and say whose each is',
      actual: [
        (({ nonce, mine }) => ({ nonce, mine }))(dmReceivedFrom({ ...dmMessage('m1', { senderId: 'u1' }), clientNonce: 'n1' }, 'u1')),
        (({ mine, ...rest }) => ({ mine, hasNonce: 'nonce' in rest }))(dmReceivedFrom(dmMessage('m2'), 'u1')),
      ],
      expected: [
        { nonce: 'n1', mine: true },
        { mine: false, hasNonce: false },
      ],
    });
  });
});

describe('liveDmPost()', () => {
  const address = { conversationId: 'dm1', viewerId: 'u1' };
  const { sender: _sender, reactions: _reactions, ...bare } = dmMessage('m9', { content: 'hello' });

  test('a broadcast of the open conversation', () => {
    assert({
      given: 'a new_dm_message broadcast as the bare row realtime relays',
      should: 'read it as a post of the open conversation, unnamed until the thread names it',
      actual: liveDmPost(bare, address),
      expected: {
        post: {
          id: 'm9',
          authorKey: 'u2',
          authorName: '',
          authorImage: null,
          agent: false,
          countsAsUnread: true,
          at: '2026-10-05T09:00:00.000Z',
          text: 'hello',
          edited: false,
          reactions: [],
        },
        mine: false,
      },
    });
  });

  test('broadcasts the thread does not show', () => {
    assert({
      given: 'another conversation’s message, a thread reply, a payload missing fields, and not an object',
      should: 'ignore each',
      actual: [
        liveDmPost({ ...bare, conversationId: 'dm2' }, address),
        liveDmPost({ ...bare, parentId: 'm1' }, address),
        liveDmPost({ id: 'm9', content: 'hello' }, address),
        liveDmPost('hello', address),
      ],
      expected: [null, null, null, null],
    });
  });
});

describe('namedPosts()', () => {
  const post = (id: string, authorKey: string, authorName: string, overrides: Partial<Post> = {}): Post => ({
    id,
    authorKey,
    authorName,
    authorImage: null,
    agent: false,
    countsAsUnread: authorKey !== 'u1',
    at: '2026-10-05T09:00:00.000Z',
    text: id,
    edited: false,
    reactions: [],
    ...overrides,
  });
  const people = { u2: { name: 'Grace', image: 'https://img/grace.png' } };

  test('naming each author', () => {
    const named = namedPosts(
      [
        post('a', 'u2', ''),
        post('b', 'u1', 'Ada Lovelace'),
        post('c', 'u1', ''),
        post('d', 'u9', ''),
        post('temp-n1', 'u1', 'You', { pending: true }),
      ],
      { viewerId: 'u1', people },
    );
    assert({
      given: 'unnamed posts by the other person, the viewer (named elsewhere) and a stranger, and a sending post guessing "You"',
      should: 'name the other person from the DM list, the viewer from their stored post, and the stranger as unknown',
      actual: named.map((each) => [each.authorName, each.authorImage]),
      expected: [
        ['Grace', 'https://img/grace.png'],
        ['Ada Lovelace', null],
        ['Ada Lovelace', null],
        ['Unknown user', null],
        ['You', null],
      ],
    });
  });

  test('a name the server gave wins', () => {
    assert({
      given: 'the other person named by a stored post, and an unnamed one of theirs',
      should: 'use the stored name over the DM list’s, and keep the viewer as "You" when nothing names them',
      actual: namedPosts([post('a', 'u2', 'Grace Hopper'), post('b', 'u2', ''), post('c', 'u1', '')], { viewerId: 'u1', people }).map(
        (each) => each.authorName,
      ),
      expected: ['Grace Hopper', 'Grace Hopper', 'You'],
    });
  });
});
