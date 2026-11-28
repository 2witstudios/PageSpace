import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { channelMessage, channelReaction } from './fixtures';
import { liveChannelPost, receivedFrom } from './received';

const options = { pageId: 'c1', viewerId: 'u1' };

describe('receivedFrom()', () => {
  test('the server copy of a post', () => {
    const message = { ...channelMessage('m1', { userId: 'u1', user: { id: 'u1', name: 'Ada', image: null } }), clientNonce: 'n1' };
    assert({
      given: "the viewer's post as the route or the broadcast carries it, with the nonce it was sent with",
      should: 'give the post, the nonce and that it is the viewer’s',
      actual: [receivedFrom(message, 'u1').nonce, receivedFrom(message, 'u1').mine, receivedFrom(message, 'u1').post.id],
      expected: ['n1', true, 'm1'],
    });
  });

  test('someone else’s post', () => {
    assert({
      given: 'another member’s post with no nonce',
      should: 'not be the viewer’s and carry no nonce',
      actual: receivedFrom(channelMessage('m2'), 'u1'),
      expected: {
        post: {
          id: 'm2',
          authorKey: 'u2',
          authorName: 'Grace Hopper',
          authorImage: null,
          agent: false,
          countsAsUnread: true,
          at: '2026-10-05T09:00:00.000Z',
          text: 'post m2',
          edited: false,
          reactions: [],
        },
        mine: false,
      },
    });
  });
});

describe('liveChannelPost()', () => {
  test('a new_message broadcast for the open channel', () => {
    const payload = {
      ...channelMessage('m3', { reactions: [channelReaction('r1', '🎉', { id: 'u1', name: 'Ada' })] }),
      clientNonce: 'n7',
      attachments: [],
    };
    const live = liveChannelPost(payload, options);
    assert({
      given: 'a top-level post on the open channel',
      should: 'read it as a post, with its reactions and nonce',
      actual: live && [live.post.id, live.post.reactions.map((reaction) => reaction.emoji), live.nonce, live.mine],
      expected: ['m3', ['🎉'], 'n7', false],
    });
  });

  test('a broadcast without relations', () => {
    const { reactions: _reactions, ...bare } = channelMessage('m4');
    assert({
      given: 'a post whose payload carries no reactions list',
      should: 'read it with none',
      actual: liveChannelPost(bare, options)?.post.reactions,
      expected: [],
    });
  });

  test('what the thread does not show', () => {
    assert({
      given: 'another channel’s post, a thread reply, and payloads that are not posts',
      should: 'ignore each',
      actual: [
        liveChannelPost(channelMessage('m5', { pageId: 'c2' }), options),
        liveChannelPost(channelMessage('m6', { parentId: 'm1' }), options),
        liveChannelPost(null, options),
        liveChannelPost('m7', options),
        liveChannelPost({ id: 'm8', pageId: 'c1' }, options),
        liveChannelPost({ ...channelMessage('m9'), user: null }, options),
      ],
      expected: [null, null, null, null, null, null],
    });
  });
});
