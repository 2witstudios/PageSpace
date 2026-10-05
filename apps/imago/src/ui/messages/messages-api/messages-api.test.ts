import { describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { fakeWeb } from '@/ui/tasks/task-api/fake-web';
import { ApiError } from '@/api/errors';
import { fetchDirectThreads, fetchDriveChannels, messagePaths } from './messages-api';
import { conversation, inboxChannel } from '../message-model/fixtures';

const caught = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
};

describe('messagePaths', () => {
  test('routes', () => {
    assert({
      given: 'a drive id and a cursor',
      should: "address apps/web's existing routes, encoded",
      actual: [
        messagePaths.driveChannels('d 1'),
        messagePaths.driveChannels('d1', '2026-10-05T10:00:00.000Z'),
        messagePaths.conversations(),
        messagePaths.conversations('2026-10-05T10:00:00.000Z'),
        messagePaths.badges,
      ],
      expected: [
        '/api/inbox?type=channel&driveId=d%201&limit=100',
        '/api/inbox?type=channel&driveId=d1&limit=100&cursor=2026-10-05T10%3A00%3A00.000Z',
        '/api/messages/conversations?limit=100',
        '/api/messages/conversations?limit=100&cursor=2026-10-05T10%3A00%3A00.000Z',
        '/api/sidebar/badges',
      ],
    });
  });
});

describe('fetchDriveChannels()', () => {
  test('one page', async () => {
    const web = fakeWeb({
      [`GET ${messagePaths.driveChannels('d1')}`]: () =>
        Response.json({
          items: [inboxChannel('c1', { unreadCount: 2 }), inboxChannel('c2')],
          pagination: { hasMore: false, nextCursor: 'id:c2' },
        }),
    });

    assert({
      given: 'a drive whose channels fit one page',
      should: 'give its CHANNEL pages with their unread counts from /api/inbox',
      actual: (await fetchDriveChannels(web.client, 'd1')).map(({ id, unreadCount }) => ({ id, unreadCount })),
      expected: [
        { id: 'c1', unreadCount: 2 },
        { id: 'c2', unreadCount: 0 },
      ],
    });
  });

  test('more than a page', async () => {
    const web = fakeWeb({
      [`GET ${messagePaths.driveChannels('d1')}`]: () =>
        Response.json({
          items: [inboxChannel('c1', { lastMessageAt: '2026-10-05T10:00:00.000Z' })],
          pagination: { hasMore: true, nextCursor: '2026-10-05T10:00:00.000Z' },
        }),
      [`GET ${messagePaths.driveChannels('d1', '2026-10-05T10:00:00.000Z')}`]: () =>
        Response.json({ items: [inboxChannel('c2')], pagination: { hasMore: true, nextCursor: 'id:c2' } }),
      [`GET ${messagePaths.driveChannels('d1', 'id:c2')}`]: () =>
        Response.json({ items: [inboxChannel('c3')], pagination: { hasMore: false, nextCursor: 'id:c3' } }),
    });

    assert({
      given: 'a drive with more channels than one page',
      should: 'follow the cursor until the server says there are no more',
      actual: (await fetchDriveChannels(web.client, 'd1')).map((thread) => thread.id),
      expected: ['c1', 'c2', 'c3'],
    });
  });

  test('a server that never stops paging', async () => {
    let served = 0;
    const web = fakeWeb({});
    const endless = () => {
      served += 1;
      return Response.json({
        items: [inboxChannel(`c${served}`)],
        pagination: { hasMore: true, nextCursor: `id:c${served}` },
      });
    };
    web.routes[`GET ${messagePaths.driveChannels('d1')}`] = endless;
    for (let n = 1; n <= 20; n += 1) web.routes[`GET ${messagePaths.driveChannels('d1', `id:c${n}`)}`] = endless;

    assert({
      given: 'hasMore that never turns false',
      should: 'stop after ten pages',
      actual: [(await fetchDriveChannels(web.client, 'd1')).length, served],
      expected: [10, 10],
    });
  });

  test('a refusal', async () => {
    const web = fakeWeb({
      [`GET ${messagePaths.driveChannels('d1')}`]: () => Response.json({ error: 'Forbidden' }, { status: 403 }),
    });
    const error = await caught(fetchDriveChannels(web.client, 'd1'));

    assert({
      given: 'apps/web refusing the request',
      should: 'reject with its ApiError',
      actual: error instanceof ApiError ? [error.status, error.message] : error,
      expected: [403, 'Forbidden'],
    });
  });
});

describe('fetchDirectThreads()', () => {
  test('pages', async () => {
    const web = fakeWeb({
      [`GET ${messagePaths.conversations()}`]: () =>
        Response.json({
          conversations: [conversation('m1', { unreadCount: 1 })],
          pagination: { hasMore: true, nextCursor: '2026-10-05T10:00:00.000Z', limit: 100 },
        }),
      [`GET ${messagePaths.conversations('2026-10-05T10:00:00.000Z')}`]: () =>
        Response.json({
          conversations: [conversation('m2', { lastMessageAt: null })],
          pagination: { hasMore: true, nextCursor: null, limit: 100 },
        }),
    });

    assert({
      given: "the viewer's conversations over two pages, the last ending on one never messaged in",
      should: 'give every DM from /api/messages/conversations and stop where there is no cursor',
      actual: (await fetchDirectThreads(web.client)).map(({ id, unreadCount }) => ({ id, unreadCount })),
      expected: [
        { id: 'm1', unreadCount: 1 },
        { id: 'm2', unreadCount: 0 },
      ],
    });
  });

  test('no conversations', async () => {
    const web = fakeWeb({
      [`GET ${messagePaths.conversations()}`]: () =>
        Response.json({ conversations: [], pagination: { hasMore: false, nextCursor: null, limit: 100 } }),
    });

    assert({
      given: 'a viewer with no DMs',
      should: 'give an empty list',
      actual: await fetchDirectThreads(web.client),
      expected: [],
    });
  });
});
