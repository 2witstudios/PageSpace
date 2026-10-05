import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { ApiError } from '@/api/errors';
import { fakeWeb } from '@/ui/test-support/fake-web';
import { channelMessage } from '../message-model/fixtures';
import { channelPaths, fetchChannelPage, markChannelRead } from './channel-api';

const caught = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
};

describe('channelPaths', () => {
  test('routes', () => {
    assert({
      given: 'a channel page id and an older-page cursor',
      should: "address apps/web's channel routes, encoded",
      actual: [
        channelPaths.messages('c 1'),
        channelPaths.messages('c1', '2026-10-05T09:00:00.000Z|m1'),
        channelPaths.read('c 1'),
      ],
      expected: [
        '/api/channels/c%201/messages?limit=50',
        '/api/channels/c1/messages?limit=50&cursor=2026-10-05T09%3A00%3A00.000Z%7Cm1',
        '/api/channels/c%201/read',
      ],
    });
  });
});

describe('fetchChannelPage()', () => {
  test('the newest page', async () => {
    const web = fakeWeb({
      [`GET ${channelPaths.messages('c1')}`]: () =>
        Response.json({
          messages: [channelMessage('m1'), channelMessage('m2', { userId: 'u1', user: { id: 'u1', name: 'Ada', image: null } })],
          nextCursor: '2026-10-05T09:00:00.000Z|m1',
          hasMore: true,
          lastReadAt: '2026-10-05T08:00:00.000Z',
        }),
    });
    const page = await fetchChannelPage(web.client, { pageId: 'c1', viewerId: 'u1' });
    assert({
      given: 'a channel with older posts and a read watermark',
      should: 'give its posts oldest first as the route orders them, the older cursor and the watermark',
      actual: [page.posts.map((post) => [post.id, post.countsAsUnread]), page.nextCursor, page.lastReadAt],
      expected: [
        [
          ['m1', true],
          ['m2', false],
        ],
        '2026-10-05T09:00:00.000Z|m1',
        '2026-10-05T08:00:00.000Z',
      ],
    });
  });

  test('an older page, and the last', async () => {
    const web = fakeWeb({
      [`GET ${channelPaths.messages('c1', 'cur-1')}`]: () =>
        Response.json({ messages: [], nextCursor: 'ignored', hasMore: false, lastReadAt: null }),
    });
    const page = await fetchChannelPage(web.client, { pageId: 'c1', viewerId: 'u1', cursor: 'cur-1' });
    assert({
      given: 'a cursor, answered with the oldest page',
      should: 'ask with the cursor and report no older page, whatever cursor the body carries',
      actual: [web.requests.map((request) => request.url), page.nextCursor],
      expected: [[channelPaths.messages('c1', 'cur-1')], null],
    });
  });

  test('a server without lastReadAt', async () => {
    const web = fakeWeb({
      [`GET ${channelPaths.messages('c1')}`]: () => Response.json({ messages: [], nextCursor: null, hasMore: false }),
    });
    assert({
      given: 'an answer that carries no lastReadAt',
      should: 'read it as never read',
      actual: (await fetchChannelPage(web.client, { pageId: 'c1', viewerId: 'u1' })).lastReadAt,
      expected: null,
    });
  });

  test('no access', async () => {
    const web = fakeWeb({
      [`GET ${channelPaths.messages('c1')}`]: () =>
        Response.json({ error: 'You need view permission to access this channel' }, { status: 403 }),
    });
    const error = await caught(fetchChannelPage(web.client, { pageId: 'c1', viewerId: 'u1' }));
    assert({
      given: 'a channel the viewer may not see',
      should: "reject with apps/web's error",
      actual: error instanceof ApiError ? [error.status, error.message] : error,
      expected: [403, 'You need view permission to access this channel'],
    });
  });
});

describe('markChannelRead()', () => {
  test('a CSRF-guarded write', async () => {
    const web = fakeWeb({
      [`POST ${channelPaths.read('c1')}`]: () => Response.json({ success: true, notificationsMarkedRead: 0 }),
    });
    await markChannelRead(web.client, 'c1');
    assert({
      given: 'a channel viewed',
      should: 'POST its read route once with the CSRF token',
      actual: web.writes(),
      expected: [{ method: 'POST', url: '/api/channels/c1/read', csrf: 'tok-1', body: {} }],
    });
  });
});
