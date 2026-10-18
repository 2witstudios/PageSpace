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
const INBOX = `GET ${messagePaths.inbox()}`;

const inbox =
  (items: () => readonly InboxItem[]): FakeRoute =>
  () =>
    Response.json({ items: items(), pagination: { hasMore: false, nextCursor: null } });

const channels = inbox;

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

/** Each compact section's label and its rows as [name, href, unread pill, current]. */
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

/** The unified rows as [accessible name, href], in the order drawn. */
const rows = (container: HTMLElement) => [...container.querySelectorAll('ul a')].map((link) => [link.getAttribute('aria-label'), link.getAttribute('href')]);

const rowsLoaded = (container: HTMLElement, count: number) =>
  settle(() => {
    if (container.querySelectorAll('a').length !== count) throw new Error('rows not loaded');
  });

const clickShow = (container: HTMLElement, label: string) =>
  act(() => {
    [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((radio) => radio.textContent === label)?.click();
  });

describe('MessagesPane on the index', () => {
  test('the unified inbox', async () => {
    const { container, web } = show({
      [INBOX]: inbox(() => [
        inboxChannel('c1', { name: 'launch', unreadCount: 2, lastMessageAt: '2026-10-12T09:00:00.000Z', lastMessagePreview: 'ship it', lastMessageSender: 'Sam', driveId: 'd1' }),
        inboxChannel('c3', { name: 'other', driveId: 'd2', lastMessageAt: '2026-10-12T08:00:00.000Z', lastMessagePreview: 'hi', lastMessageSender: 'Dana' }),
        { ...inboxChannel('c4', { name: 'empty' }), type: 'dm', lastMessageAt: null, lastMessagePreview: null, name: 'Grace' },
      ]),
    });
    await rowsLoaded(container, 3);

    assert({
      given: 'a viewer with two channels in different drives and one DM with no messages',
      should: 'merge them in the server order, each linked to its own drive, with the unread count on the row',
      actual: [rows(container), web.count(CHANNELS), web.count(CONVERSATIONS)],
      expected: [
        [
          ['launch, 2 unread', '/d1/messages/c1'],
          ['other', '/d2/messages/c3'],
          ['Grace', '/dm/c4'],
        ],
        0,
        0,
      ],
    });
  });

  test('the Show filter', async () => {
    const { container } = show({
      [INBOX]: inbox(() => [inboxChannel('c1', { name: 'launch' }), { ...inboxChannel('m1', { name: 'Grace' }), type: 'dm' }]),
    });
    await rowsLoaded(container, 2);
    const names = () => rows(container).map(([, href]) => href);

    clickShow(container, 'Channels');
    const channelsOnly = names();
    clickShow(container, 'Direct');
    const directOnly = names();
    clickShow(container, 'All');

    assert({
      given: 'the Show control set to Channels, then Direct, then All',
      should: 'show only that kind, and everything again under All',
      actual: [channelsOnly, directOnly, names(), container.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')],
      expected: [['/d1/messages/c1'], ['/dm/m1'], ['/d1/messages/c1', '/dm/m1'], 'Show'],
    });
  });

  test('an empty filter says what is missing', async () => {
    const { container } = show({ [INBOX]: inbox(() => [inboxChannel('c1', { name: 'launch' })]) });
    await rowsLoaded(container, 1);
    clickShow(container, 'Direct');

    assert({
      given: 'the Direct filter with no direct messages',
      should: 'say there are no direct messages yet',
      actual: container.querySelector('p')?.textContent,
      expected: 'No direct messages yet.',
    });
  });

  test('a live post moves its row up and counts it', async () => {
    const { container, rt, web } = show({
      [INBOX]: inbox(() => [inboxChannel('c1', { name: 'launch', lastMessageAt: '2026-10-12T08:00:00.000Z' }), inboxChannel('c2', { name: 'general' })]),
    });
    await rowsLoaded(container, 2);

    rt.emit('inbox:channel_updated', {
      operation: 'channel_updated',
      type: 'channel',
      id: 'c2',
      driveId: 'd1',
      lastMessageAt: '2026-10-12T12:00:00.000Z',
      lastMessagePreview: 'shipped',
    });

    assert({
      given: 'a post in a channel the unified inbox lists',
      should: 'count it on the row, move the row to the top, and not refetch',
      actual: [rows(container), web.count(INBOX)],
      expected: [
        [
          ['general, 1 unread', '/d1/messages/c2'],
          ['launch', '/d1/messages/c1'],
        ],
        1,
      ],
    });
  });

  test('a failed load is retried', async () => {
    let calls = 0;
    const { container, web } = show({
      [INBOX]: (request) => {
        calls += 1;
        return calls === 1 ? Response.json({ error: 'Failed' }, { status: 503 }) : inbox(() => [inboxChannel('c1', { name: 'launch' })])(request);
      },
    });
    await settle(() => {
      if (!container.querySelector('[role="alert"]')) throw new Error('no alert');
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('button:not([role="radio"])')?.click();
    });
    await rowsLoaded(container, 1);

    assert({
      given: 'an inbox that failed, then Try again',
      should: 'ask the server again and list what it answers',
      actual: [web.count(INBOX), rows(container)],
      expected: [2, [['launch', '/d1/messages/c1']]],
    });
  });
});

describe('MessagesPane with an object open or on a user-level route', () => {
  test('a channel open: the compact groups, with the open one current', async () => {
    const { container, web } = show(
      {
        [CHANNELS]: channels(() => [inboxChannel('c1', { name: 'launch' }), inboxChannel('c2', { name: 'general' })]),
        [CONVERSATIONS]: dms(() => [conversation('m1', { unreadCount: 1 })]),
      },
      { selectedPageId: 'c2' },
    );
    await rowsLoaded(container, 3);

    assert({
      given: 'a channel open as the object',
      should: 'list the drive’s channels and DMs in the compact groups, with only the open row current',
      actual: [
        sections(container),
        web.count(INBOX),
      ],
      expected: [
        [
          [
            'Channels',
            [
              ['launch', '/d1/messages/c1', null, null],
              ['general', '/d1/messages/c2', null, 'page'],
            ],
            null,
          ],
          ['Direct messages', [['Grace', '/dm/m1', '1', null]], null],
        ],
        0,
      ],
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

  test('a DM whose other person is gone', async () => {
    const gone = { id: null, name: null, email: null, image: null, username: null, displayName: null, avatarUrl: null };
    const { container } = show(
      {
        [CHANNELS]: channels(() => []),
        [CONVERSATIONS]: dms(() => [conversation('m1', { otherUser: gone })]),
      },
      { selectedPageId: 'c1' },
    );
    await rowsLoaded(container, 1);

    assert({
      given: 'a conversation whose other user row is missing, in the compact groups',
      should: 'still name the row',
      actual: container.querySelector('a')?.getAttribute('aria-label'),
      expected: 'Unknown user',
    });
  });
});
