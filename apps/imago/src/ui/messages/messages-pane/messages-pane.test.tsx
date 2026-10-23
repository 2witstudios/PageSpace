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
import { HomeDriveProvider } from '../../frame/drives/home-drive-context';
import { DRIVES } from '../../frame/drives/drives';
import { setUiState } from '../../store/store';
import { createInitialState } from '../../store/state';
import { COLLAPSED_GROUPS_KEY } from './message-groups';
import { MessagesPane, type MessagesPaneProps } from './messages-pane';

afterEach(() => {
  unmountAll();
  setUiState(createInitialState());
  window.localStorage.clear();
});

const CHANNELS = `GET ${messagePaths.driveChannels('d1')}`;
const CONVERSATIONS = `GET ${messagePaths.conversations()}`;
const ALL_CHANNELS = `GET ${messagePaths.channels()}`;

const inbox =
  (items: () => readonly InboxItem[]): FakeRoute =>
  () =>
    Response.json({ items: items(), pagination: { hasMore: false, nextCursor: null } });

const channels = inbox;

const dms =
  (rows: () => readonly ConversationResponse[]): FakeRoute =>
  () =>
    Response.json({ conversations: rows(), pagination: { hasMore: false, nextCursor: null, limit: 100 } });

const drives = (): FakeRoute => () =>
  Response.json([
    { id: 'd2', name: 'Beta', kind: 'STANDARD' },
    { id: 'd1', name: 'Alpha', kind: 'STANDARD' },
    { id: 'home', name: 'Home', kind: 'HOME' },
  ]);

const show = (routes: Record<string, FakeRoute>, props: Partial<MessagesPaneProps> = {}, homeDriveId: string | null = 'home') => {
  const web = fakeWeb({ [`GET ${DRIVES}`]: drives(), ...routes });
  const rt = fakeRealtime();
  const container = mount(
    <ImagoSWRProvider client={web.client}>
      <RealtimeProvider client={rt.client}>
        <HomeDriveProvider value={homeDriveId}>
          <MessagesPane driveId="d1" selectedPageId={null} selectedConversationId={null} {...props} />
        </HomeDriveProvider>
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

const rowsLoaded = (container: HTMLElement, count: number) =>
  settle(() => {
    if (container.querySelectorAll('a').length !== count) throw new Error('rows not loaded');
  });

const fold = (container: HTMLElement, label: string) =>
  act(() => {
    container.querySelector<HTMLButtonElement>(`section[aria-label="${label}"] button[aria-expanded]`)?.click();
  });

describe('MessagesPane in a drive', () => {
  test('nothing open: the compact groups, the same as with a thread open', async () => {
    const { container, web } = show({
      [CHANNELS]: channels(() => [inboxChannel('c1', { name: 'launch', unreadCount: 2 }), inboxChannel('c2', { name: 'general' })]),
      [CONVERSATIONS]: dms(() => [conversation('m1')]),
    });
    await rowsLoaded(container, 3);

    assert({
      given: 'the Messages index of a drive, with nothing open',
      should: 'list the drive’s channels then the DMs in the compact groups, without loading every drive’s channels',
      actual: [sections(container), web.count(ALL_CHANNELS)],
      expected: [
        [
          [
            'Channels',
            [
              ['launch', '/d1/messages/c1', '2', null],
              ['general', '/d1/messages/c2', null, null],
            ],
            null,
          ],
          ['Direct messages', [['Grace', '/dm/m1', null, null]], null],
        ],
        0,
      ],
    });
  });

  test('a live post moves its row up and counts it', async () => {
    const { container, rt, web } = show({
      [CHANNELS]: channels(() => [inboxChannel('c1', { name: 'launch', lastMessageAt: '2026-10-12T08:00:00.000Z' }), inboxChannel('c2', { name: 'general' })]),
      [CONVERSATIONS]: dms(() => []),
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
      given: 'a post in a channel the drive lists',
      should: 'count it on the row, move the row to the top, and not refetch',
      actual: [[...container.querySelectorAll('a')].map((link) => link.getAttribute('aria-label')), web.count(CHANNELS)],
      expected: [['general, 1 unread', 'launch'], 1],
    });
  });

  test('a failed load is retried', async () => {
    let calls = 0;
    const { container, web } = show({
      [CHANNELS]: (request) => {
        calls += 1;
        return calls === 1 ? Response.json({ error: 'Failed' }, { status: 503 }) : channels(() => [inboxChannel('c1', { name: 'launch' })])(request);
      },
      [CONVERSATIONS]: dms(() => []),
    });
    await settle(() => {
      if (!container.querySelector('[role="alert"]')) throw new Error('no alert');
    });
    act(() => {
      [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Try again')?.click();
    });
    await rowsLoaded(container, 1);

    assert({
      given: 'channels that failed, then Try again',
      should: 'ask the server again and list what it answers',
      actual: [web.count(CHANNELS), container.querySelector('a')?.getAttribute('href')],
      expected: [2, '/d1/messages/c1'],
    });
  });
});

describe('MessagesPane across every drive', () => {
  const everyDrive = () =>
    inbox(() => [
      inboxChannel('c3', { name: 'other', driveId: 'd2', unreadCount: 1 }),
      { ...inboxChannel('m9', { name: 'Ignored' }), type: 'dm' },
      inboxChannel('c1', { name: 'launch', driveId: 'd1' }),
      inboxChannel('c2', { name: 'general', driveId: 'd1' }),
    ]);

  test('Home: one group per drive, named for it, then the DMs', async () => {
    const { container, web } = show(
      { [ALL_CHANNELS]: everyDrive(), [CONVERSATIONS]: dms(() => [conversation('m1')]) },
      { driveId: 'home', selectedPageId: 'c1' },
    );
    await settle(() => {
      if (!container.querySelector('section[aria-label="Alpha"]')) throw new Error('drive names not loaded');
    });
    await rowsLoaded(container, 4);

    assert({
      given: 'the Home drive with a channel open',
      should: 'group every drive’s channels under the drive’s name in the drives’ order, then the DMs, with the open row current',
      actual: [sections(container), web.count(CHANNELS)],
      expected: [
        [
          [
            'Alpha',
            [
              ['launch', '/d1/messages/c1', null, 'page'],
              ['general', '/d1/messages/c2', null, null],
            ],
            null,
          ],
          ['Beta', [['other', '/d2/messages/c3', '1', null]], null],
          ['Direct messages', [['Grace', '/dm/m1', null, null]], null],
        ],
        0,
      ],
    });
  });

  test('a user-level DM route reads the same as Home', async () => {
    const { container } = show(
      { [ALL_CHANNELS]: everyDrive(), [CONVERSATIONS]: dms(() => [conversation('m1')]) },
      { driveId: null, selectedConversationId: 'm1' },
    );
    await settle(() => {
      if (!container.querySelector('section[aria-label="Alpha"]')) throw new Error('drive names not loaded');
    });
    await rowsLoaded(container, 4);

    assert({
      given: 'no drive (/dm/[conversationId]) with a conversation open',
      should: 'list every drive’s channels and the DMs, with the open conversation current',
      actual: sections(container).map(([label]) => label),
      expected: ['Alpha', 'Beta', 'Direct messages'],
    });
  });

  test('no channels anywhere', async () => {
    const { container } = show({ [ALL_CHANNELS]: inbox(() => []), [CONVERSATIONS]: dms(() => []) }, { driveId: null });
    await settle(() => {
      if (!container.textContent?.includes('No channels yet.')) throw new Error('not loaded');
    });

    assert({
      given: 'no channels in any drive',
      should: 'keep one Channels group that says so',
      actual: sections(container).map(([label, , note]) => [label, note]),
      expected: [
        ['Channels', 'No channels yet.'],
        ['Direct messages', 'No direct messages yet.'],
      ],
    });
  });
});

describe('MessagesPane folds', () => {
  const routes = () => ({
    [CHANNELS]: channels(() => [inboxChannel('c1', { name: 'launch', unreadCount: 2 })]),
    [CONVERSATIONS]: dms(() => [conversation('m1')]),
  });

  test('folding a group', async () => {
    const { container } = show(routes());
    await rowsLoaded(container, 2);
    fold(container, 'Channels');
    const toggle = container.querySelector('section[aria-label="Channels"] button');

    assert({
      given: 'the Channels label clicked',
      should: 'hide its rows, mark it collapsed with its unread on the label, keep the DMs, and save the fold',
      actual: [
        [...container.querySelectorAll('a')].map((link) => link.getAttribute('href')),
        toggle?.getAttribute('aria-expanded'),
        toggle?.getAttribute('aria-label'),
        window.localStorage.getItem(COLLAPSED_GROUPS_KEY),
      ],
      expected: [['/dm/m1'], 'false', 'Channels, 2 unread', '["drive:d1"]'],
    });
  });

  test('a saved fold', async () => {
    window.localStorage.setItem(COLLAPSED_GROUPS_KEY, '["direct"]');
    const { container } = show(routes());
    await rowsLoaded(container, 1);
    fold(container, 'Direct messages');
    await rowsLoaded(container, 2);

    assert({
      given: 'Direct messages folded in an earlier visit, then opened again',
      should: 'start folded, then show the DMs and save that nothing is folded',
      actual: window.localStorage.getItem(COLLAPSED_GROUPS_KEY),
      expected: '[]',
    });
  });
});

describe('MessagesPane with an object open', () => {
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
        web.count(ALL_CHANNELS),
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
