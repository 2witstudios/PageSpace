// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { RealtimeProvider } from '@/realtime/realtime-provider';
import { mount, unmountAll } from '@/ui/test-support/dom';
import { fakeRealtime } from '@/ui/test-support/fake-realtime';
import { fakeWeb, type FakeRoute } from '@/ui/test-support/fake-web';
import { messagePaths } from '../messages-api/messages-api';
import { conversation, inboxChannel } from '../message-model/fixtures';
import type { ConversationResponse, InboxItem } from '../message-model/message';
import { MessagesPane, type MessagesPaneProps } from './messages-pane';

afterEach(unmountAll);

const CHANNELS = `GET ${messagePaths.driveChannels('d1')}`;
const CONVERSATIONS = `GET ${messagePaths.conversations()}`;

const channels =
  (items: () => readonly InboxItem[]): FakeRoute =>
  () =>
    Response.json({ items: items(), pagination: { hasMore: false, nextCursor: null } });

const dms =
  (rows: () => readonly ConversationResponse[]): FakeRoute =>
  () =>
    Response.json({ conversations: rows(), pagination: { hasMore: false, nextCursor: null, limit: 100 } });

const show = (routes: Record<string, FakeRoute>, props: Partial<MessagesPaneProps> = {}) => {
  const web = fakeWeb(routes);
  const rt = fakeRealtime();
  const container = mount(
    <ImagoSWRProvider client={web.client}>
      <RealtimeProvider client={rt.client}>
        <MessagesPane driveId="d1" selectedPageId={null} selectedConversationId={null} {...props} />
      </RealtimeProvider>
    </ImagoSWRProvider>,
  );
  return { web, rt, container };
};

const settle = (check: () => void): Promise<void> =>
  act(() => vi.waitFor(check, { timeout: 1000, interval: 5 }));

/** Each section's label and its rows as [name, href, unread pill, current]. */
const sections = (container: HTMLElement) =>
  [...container.querySelectorAll('section')].map((section) => [
    section.getAttribute('aria-label'),
    [...section.querySelectorAll('a')].map((link) => [
      link.querySelector('.truncate')?.textContent,
      link.getAttribute('href'),
      link.querySelector('[aria-hidden="true"].tabular-nums')?.textContent ?? null,
      link.getAttribute('aria-current'),
    ]),
    section.querySelector('p')?.textContent ?? null,
  ]);

const rowsLoaded = (container: HTMLElement, count: number) =>
  settle(() => {
    if (container.querySelectorAll('a').length !== count) throw new Error('rows not loaded');
  });

describe('MessagesPane', () => {
  test('a drive', async () => {
    const { container } = show({
      [CHANNELS]: channels(() => [inboxChannel('c1', { name: 'launch', unreadCount: 2 }), inboxChannel('c2', { name: 'general' })]),
      [CONVERSATIONS]: dms(() => [conversation('m1', { unreadCount: 1 })]),
    });
    await rowsLoaded(container, 3);

    assert({
      given: 'a drive with two channels and the viewer’s one DM',
      should: 'list the drive’s channels and the viewer’s DMs in their sections, each linking to its route with its unread count',
      actual: sections(container),
      expected: [
        [
          'Channels',
          [
            ['launch', '/d1/messages/c1', '2', null],
            ['general', '/d1/messages/c2', null, null],
          ],
          null,
        ],
        ['Direct messages', [['Grace', '/dm/m1', '1', null]], null],
      ],
    });
  });

  test('live unread counts', async () => {
    const { container, rt, web } = show({
      [CHANNELS]: channels(() => [inboxChannel('c1', { name: 'launch' }), inboxChannel('c2', { name: 'general' })]),
      [CONVERSATIONS]: dms(() => [conversation('m1')]),
    });
    await rowsLoaded(container, 3);

    rt.emit('inbox:channel_updated', {
      operation: 'channel_updated',
      type: 'channel',
      id: 'c2',
      driveId: 'd1',
      lastMessageAt: '2026-10-05T12:00:00.000Z',
      lastMessagePreview: 'shipped',
    });
    const posted = sections(container)[0];

    rt.emit('inbox:read_status_changed', { operation: 'read_status_changed', type: 'channel', id: 'c2', driveId: 'd1', unreadCount: 0 });
    const read = sections(container)[0];

    assert({
      given: 'a post in a channel of the drive, then the viewer reading it',
      should: 'count it on the row and move the row up at once, then clear the count, without refetching',
      actual: [posted, read, web.count(CHANNELS)],
      expected: [
        [
          'Channels',
          [
            ['general', '/d1/messages/c2', '1', null],
            ['launch', '/d1/messages/c1', null, null],
          ],
          null,
        ],
        [
          'Channels',
          [
            ['general', '/d1/messages/c2', null, null],
            ['launch', '/d1/messages/c1', null, null],
          ],
          null,
        ],
        1,
      ],
    });
  });

  test('the open channel', async () => {
    const { container } = show(
      {
        [CHANNELS]: channels(() => [inboxChannel('c1', { name: 'launch' }), inboxChannel('c2', { name: 'general' })]),
        [CONVERSATIONS]: dms(() => [conversation('m1')]),
      },
      { selectedPageId: 'c2' },
    );
    await rowsLoaded(container, 3);

    assert({
      given: 'a channel open as the object',
      should: 'mark only its row current',
      actual: [...container.querySelectorAll('a')].map((link) => link.getAttribute('aria-current')),
      expected: [null, 'page', null],
    });
  });

  test('a user-level DM route', async () => {
    const { container, web } = show(
      { [CONVERSATIONS]: dms(() => [conversation('m1'), conversation('m2', { otherUser: { ...conversation('m2').otherUser, displayName: null, name: 'Ada' } })]) },
      { driveId: null, selectedConversationId: 'm2' },
    );
    await rowsLoaded(container, 2);

    assert({
      given: 'no drive (/dm/[conversationId]) with a conversation open',
      should: 'fetch no channels, say channels belong to a drive, and list the DMs with the open one current',
      actual: [web.count(CHANNELS), sections(container)],
      expected: [
        0,
        [
          ['Channels', [], 'Open a drive to see its channels.'],
          [
            'Direct messages',
            [
              ['Grace', '/dm/m1', null, null],
              ['Ada', '/dm/m2', null, 'page'],
            ],
            null,
          ],
        ],
      ],
    });
  });

  test('empty and failing sections', async () => {
    const { container } = show({
      [CHANNELS]: () => Response.json({ error: 'Failed' }, { status: 500 }),
      [CONVERSATIONS]: dms(() => []),
    });
    await settle(() => {
      if (!container.querySelector('[role="alert"]')) throw new Error('no alert');
      if (!container.textContent?.includes('No direct messages yet.')) throw new Error('DMs not loaded');
    });

    assert({
      given: 'channels that will not load and a viewer with no DMs',
      should: 'say the channels could not load and that there are no DMs yet',
      actual: sections(container),
      expected: [
        ['Channels', [], 'Could not load channels.'],
        ['Direct messages', [], 'No direct messages yet.'],
      ],
    });
  });

  test('a DM whose other person is gone', async () => {
    const gone = { id: null, name: null, email: null, image: null, username: null, displayName: null, avatarUrl: null };
    const { container } = show({
      [CHANNELS]: channels(() => []),
      [CONVERSATIONS]: dms(() => [conversation('m1', { otherUser: gone })]),
    });
    await rowsLoaded(container, 1);

    assert({
      given: 'a conversation whose other user row is missing',
      should: 'still name the row',
      actual: container.querySelector('a')?.getAttribute('aria-label'),
      expected: 'Unknown user',
    });
  });
});
