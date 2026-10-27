import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { ApiError } from '@/api/errors';
import { fakeWeb } from '@/ui/test-support/fake-web';
import { dmMessage } from '../message-model/fixtures';
import { dmPaths, dmThread, fetchDmPage, markDmRead, sendDmMessage } from './dm-api';

const caught = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
};

describe('dmPaths', () => {
  test('routes', () => {
    assert({
      given: 'a conversation id and an older-page time',
      should: "address apps/web's DM routes, encoded",
      actual: [dmPaths.messages('dm 1'), dmPaths.messages('dm1', '2026-10-05T09:00:00.000Z'), dmPaths.conversation('dm 1')],
      expected: [
        '/api/messages/dm%201?limit=50',
        '/api/messages/dm1?limit=50&before=2026-10-05T09%3A00%3A00.000Z',
        '/api/messages/dm%201',
      ],
    });
  });
});

describe('fetchDmPage()', () => {
  test('a short page', async () => {
    const web = fakeWeb({
      [`GET ${dmPaths.messages('dm1')}`]: () =>
        Response.json({
          messages: [dmMessage('m1'), dmMessage('m2', { createdAt: '2026-10-05T09:05:00.000Z' })],
          notificationsMarkedRead: 0,
        }),
    });
    const page = await fetchDmPage(web.client, { conversationId: 'dm1', viewerId: 'u1' });
    assert({
      given: 'fewer messages than a page',
      should: 'map them, offer nothing older, and count the newest as read to',
      actual: [page.posts.map((post) => post.id), page.nextCursor, page.lastReadAt],
      expected: [['m1', 'm2'], null, '2026-10-05T09:05:00.000Z'],
    });
  });

  test('a full page, then the one before it', async () => {
    const full = Array.from({ length: 50 }, (_, index) =>
      dmMessage(`m${index}`, { createdAt: new Date(Date.UTC(2026, 9, 5, 9, index)).toISOString() }),
    );
    const web = fakeWeb({
      [`GET ${dmPaths.messages('dm1')}`]: () => Response.json({ messages: full, notificationsMarkedRead: 0 }),
      [`GET ${dmPaths.messages('dm1', '2026-10-05T09:00:00.000Z')}`]: () => Response.json({ messages: [], notificationsMarkedRead: 0 }),
    });
    const newest = await fetchDmPage(web.client, { conversationId: 'dm1', viewerId: 'u1' });
    const before = await dmThread.fetchPage(web.client, { threadId: 'dm1', viewerId: 'u1', cursor: newest.nextCursor ?? '' });
    assert({
      given: 'a full page of 50, then the page before its oldest message',
      should: 'reach older messages by the oldest one’s time, and stop at an empty page',
      actual: [newest.nextCursor, before.posts, before.nextCursor, before.lastReadAt],
      expected: ['2026-10-05T09:00:00.000Z', [], null, null],
    });
  });

  test('not a participant', async () => {
    const web = fakeWeb({
      [`GET ${dmPaths.messages('dm1')}`]: () => Response.json({ error: 'Conversation not found' }, { status: 404 }),
    });
    const error = await caught(fetchDmPage(web.client, { conversationId: 'dm1', viewerId: 'u1' }));
    assert({
      given: 'apps/web answering 404',
      should: 'reject with its ApiError',
      actual: [error instanceof ApiError, (error as ApiError).status],
      expected: [true, 404],
    });
  });
});

describe('sendDmMessage()', () => {
  test('posting with CSRF', async () => {
    const { sender: _sender, ...row } = dmMessage('m9', { senderId: 'u1', content: 'hi' });
    const web = fakeWeb({
      [`POST ${dmPaths.conversation('dm1')}`]: () => Response.json({ message: { ...row, clientNonce: 'n1' } }),
    });
    const received = await sendDmMessage(web.client, { conversationId: 'dm1', viewerId: 'u1', content: 'hi', clientNonce: 'n1' });
    assert({
      given: 'a message sent to a conversation',
      should: 'POST its text and nonce with the CSRF token, and read the stored message back as the viewer’s with the nonce',
      actual: [web.writes(), received.post.id, received.nonce, received.mine],
      expected: [
        [{ method: 'POST', url: '/api/messages/dm1', csrf: 'tok-1', body: { content: 'hi', clientNonce: 'n1' } }],
        'm9',
        'n1',
        true,
      ],
    });
  });
});

describe('markDmRead()', () => {
  test('marking read with CSRF', async () => {
    const web = fakeWeb({
      [`PATCH ${dmPaths.conversation('dm1')}`]: () => Response.json({ success: true, notificationsMarkedRead: 0 }),
    });
    await markDmRead(web.client, 'dm1');
    assert({
      given: 'the conversation read',
      should: 'PATCH it with the CSRF token',
      actual: web.writes().map(({ method, url, csrf }) => ({ method, url, csrf })),
      expected: [{ method: 'PATCH', url: '/api/messages/dm1', csrf: 'tok-1' }],
    });
  });
});
