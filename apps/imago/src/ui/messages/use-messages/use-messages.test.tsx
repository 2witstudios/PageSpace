// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { RealtimeProvider } from '@/realtime/realtime-provider';
import { createRealtimeClient, type RealtimeSocket } from '@/realtime/realtime-client';
import { fakeWeb, type FakeRoute } from '@/ui/test-support/fake-web';
import { useDirectThreads, useDriveChannels, useMessages, useUnreadBadges } from './use-messages';
import { messagePaths } from '../messages-api/messages-api';
import { badges, conversation, inboxChannel } from '../message-model/fixtures';
import type { ChannelThread, DirectThread, InboxItem, SidebarBadges } from '../message-model/message';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
});

// SWR resolves outside React's event loop; waiting inside act() flushes the
// state updates it causes.
const settle = (check: () => void, timeout = 1000): Promise<void> =>
  act(() => vi.waitFor(check, { timeout, interval: 5 }));

type Listener = (...args: unknown[]) => void;

/** A socket.io stand-in that records listeners and whether it is still the live one. */
type FakeSocket = RealtimeSocket & {
  live: boolean;
  listeners: Map<string, Set<Listener>>;
};

/**
 * The real realtime client (createRealtimeClient) over sockets that never
 * touch the network: every socket it opens is recorded, so a test can see
 * which one is live and what is subscribed on each.
 */
const realtime = () => {
  const sockets: FakeSocket[] = [];
  const client = createRealtimeClient({
    url: undefined,
    fetchToken: () => Promise.resolve('ps_sock_1'),
    connectSocket: () => {
      const listeners = new Map<string, Set<Listener>>();
      const socket: FakeSocket = {
        live: true,
        listeners,
        on: (event, listener) => {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event)?.add(listener);
          return socket;
        },
        off: (event, listener) => {
          listeners.get(event)?.delete(listener);
          return socket;
        },
        connect: () => socket,
        disconnect: () => {
          socket.live = false;
          return socket;
        },
      };
      sockets.push(socket);
      return socket;
    },
  });
  const live = () => sockets.filter((socket) => socket.live);
  /** realtime relaying an event: only the live socket receives it. */
  const emit = (event: string, payload: unknown) =>
    act(() => {
      for (const socket of live()) for (const listener of socket.listeners.get(event) ?? []) listener(payload);
    });
  const count = (socket: FakeSocket, event: string) => socket.listeners.get(event)?.size ?? 0;
  return { client, sockets, live, emit, count };
};

const CHANNELS = `GET ${messagePaths.driveChannels('d1')}`;
const CONVERSATIONS = `GET ${messagePaths.conversations()}`;
const BADGES = `GET ${messagePaths.badges}`;

const channelsRoute =
  (items: () => InboxItem[]): FakeRoute =>
  () =>
    Response.json({ items: items(), pagination: { hasMore: false, nextCursor: null } });

const mount = (
  routes: Record<string, FakeRoute>,
  probe: ReactNode,
  { strict = false }: { strict?: boolean } = {},
) => {
  const web = fakeWeb(routes);
  const rt = realtime();
  const tree = (
    <ImagoSWRProvider client={web.client}>
      <RealtimeProvider client={rt.client}>{probe}</RealtimeProvider>
    </ImagoSWRProvider>
  );
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  act(() => {
    root.render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  });
  return { web, rt, root };
};

type Seen = { channels?: readonly ChannelThread[]; threads?: readonly DirectThread[]; badges?: SidebarBadges };

const ChannelsProbe = ({ seen, driveId = 'd1' }: { seen: Seen; driveId?: string | null }) => {
  seen.channels = useDriveChannels(driveId).channels;
  return null;
};

const unread = (rows: readonly { id: string; unreadCount: number }[] | undefined) =>
  rows?.map(({ id, unreadCount }) => `${id}:${unreadCount}`);

const loaded = (seen: Seen, field: keyof Seen) =>
  settle(() => {
    if (seen[field] === undefined) throw new Error(`${field} not loaded`);
  });

const channelUpdated = (id: string, overrides: Record<string, unknown> = {}) => ({
  operation: 'channel_updated',
  type: 'channel',
  id,
  driveId: 'd1',
  lastMessageAt: '2026-10-05T12:00:00.000Z',
  lastMessagePreview: 'new post',
  lastMessageSender: 'Ada',
  ...overrides,
});

describe('useDriveChannels()', () => {
  test('loading', async () => {
    const seen: Seen = {};
    mount({ [CHANNELS]: channelsRoute(() => [inboxChannel('c1', { unreadCount: 2 }), inboxChannel('c2')]) }, <ChannelsProbe seen={seen} />);
    await loaded(seen, 'channels');

    assert({
      given: 'a drive',
      should: 'list its CHANNEL pages with unread counts from /api/inbox',
      actual: unread(seen.channels),
      expected: ['c1:2', 'c2:0'],
    });
  });

  test('no drive', () => {
    const seen: Seen = {};
    const { web } = mount({}, <ChannelsProbe seen={seen} driveId={null} />);

    assert({
      given: 'no drive yet',
      should: 'fetch nothing',
      actual: [seen.channels, web.requests.length],
      expected: [undefined, 0],
    });
  });

  test('live', async () => {
    const seen: Seen = {};
    const { rt, web } = mount(
      { [CHANNELS]: channelsRoute(() => [inboxChannel('c1'), inboxChannel('c2', { unreadCount: 1 })]) },
      <ChannelsProbe seen={seen} />,
    );
    await loaded(seen, 'channels');

    rt.emit('inbox:channel_updated', channelUpdated('c2'));

    assert({
      given: 'inbox:channel_updated for a channel of the drive',
      should: 'count it at once and move the channel to the top, without a request',
      actual: [unread(seen.channels), web.count(CHANNELS)],
      expected: [['c2:2', 'c1:0'], 1],
    });

    rt.emit('inbox:channel_updated', channelUpdated('c1', { driveId: 'd2' }));

    assert({
      given: 'inbox:channel_updated from another drive',
      should: 'change nothing',
      actual: unread(seen.channels),
      expected: ['c2:2', 'c1:0'],
    });

    rt.emit('inbox:read_status_changed', { operation: 'read_status_changed', type: 'channel', id: 'c2', driveId: 'd1', unreadCount: 0 });

    assert({
      given: 'inbox:read_status_changed for the channel',
      should: 'clear its unread count',
      actual: unread(seen.channels),
      expected: ['c2:0', 'c1:0'],
    });

    rt.emit('inbox:channel_updated', { garbage: true });

    assert({
      given: 'a payload that is not an inbox event',
      should: 'change nothing',
      actual: unread(seen.channels),
      expected: ['c2:0', 'c1:0'],
    });
  });

  test('a channel the list has not loaded', async () => {
    let items = [inboxChannel('c1')];
    const seen: Seen = {};
    const { rt, web } = mount({ [CHANNELS]: channelsRoute(() => items) }, <ChannelsProbe seen={seen} />);
    await loaded(seen, 'channels');

    items = [inboxChannel('c-new', { unreadCount: 1 }), inboxChannel('c1')];
    rt.emit('inbox:channel_updated', channelUpdated('c-new'));
    await settle(() => {
      if (seen.channels?.length !== 2) throw new Error('not refetched');
    });

    assert({
      given: 'a post in a channel created since the list loaded',
      should: 'refetch the list from the server',
      actual: [unread(seen.channels), web.count(CHANNELS)],
      expected: [['c-new:1', 'c1:0'], 2],
    });
  });

  test('an event before the list has loaded', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let served = 0;
    const seen: Seen = {};
    const { rt, web } = mount(
      {
        [CHANNELS]: async () => {
          served += 1;
          // The first answer is the one in flight when the event lands: it
          // predates the post.
          if (served === 1) {
            await gate;
            return Response.json({ items: [inboxChannel('c1')], pagination: { hasMore: false, nextCursor: null } });
          }
          return Response.json({ items: [inboxChannel('c1', { unreadCount: 1 })], pagination: { hasMore: false, nextCursor: null } });
        },
      },
      <ChannelsProbe seen={seen} />,
    );

    rt.emit('inbox:channel_updated', channelUpdated('c1'));
    release();
    await settle(() => {
      if (unread(seen.channels)?.[0] !== 'c1:1') throw new Error('not current');
    });

    assert({
      given: 'a post that lands while the first load is in flight',
      should: 'end on the server’s count after the post, not the stale answer',
      actual: [unread(seen.channels), web.count(CHANNELS)],
      expected: [['c1:1'], 2],
    });
  });

  test('two lists of the same drive', async () => {
    const first: Seen = {};
    const second: Seen = {};
    const { rt } = mount(
      { [CHANNELS]: channelsRoute(() => [inboxChannel('c1')]) },
      <>
        <ChannelsProbe seen={first} />
        <ChannelsProbe seen={second} />
      </>,
    );
    await loaded(first, 'channels');
    await loaded(second, 'channels');

    rt.emit('inbox:channel_updated', channelUpdated('c1'));

    assert({
      given: 'one post seen by two mounted lists sharing a cache entry',
      should: 'count it once',
      actual: [unread(first.channels), unread(second.channels)],
      expected: [['c1:1'], ['c1:1']],
    });
  });

  test('unmount', async () => {
    const seen: Seen = {};
    const { rt, root } = mount({ [CHANNELS]: channelsRoute(() => [inboxChannel('c1')]) }, <ChannelsProbe seen={seen} />);
    await loaded(seen, 'channels');
    act(() => root.unmount());
    roots = roots.filter((r) => r !== root);

    assert({
      given: 'the list unmounting',
      should: 'leave no inbox listener on any socket',
      actual: rt.sockets.flatMap((socket) =>
        ['inbox:channel_updated', 'inbox:read_status_changed'].map((event) => rt.count(socket, event)),
      ),
      expected: rt.sockets.flatMap(() => [0, 0]),
    });
  });
});

describe('useDirectThreads()', () => {
  const DmProbe = ({ seen }: { seen: Seen }) => {
    seen.threads = useDirectThreads().threads;
    return null;
  };

  test('loading and live', async () => {
    const seen: Seen = {};
    const { rt } = mount(
      {
        [CONVERSATIONS]: () =>
          Response.json({
            conversations: [
              conversation('m1', { lastMessageAt: '2026-10-05T11:00:00.000Z' }),
              conversation('m2', { lastMessageAt: '2026-10-05T10:00:00.000Z', unreadCount: 3 }),
            ],
            pagination: { hasMore: false, nextCursor: null, limit: 100 },
          }),
      },
      <DmProbe seen={seen} />,
    );
    await loaded(seen, 'threads');

    assert({
      given: 'the viewer',
      should: 'list their DM conversations from /api/messages/conversations',
      actual: unread(seen.threads),
      expected: ['m1:0', 'm2:3'],
    });

    rt.emit('inbox:dm_updated', { operation: 'dm_updated', type: 'dm', id: 'm2', lastMessageAt: '2026-10-05T12:00:00.000Z', lastMessagePreview: 'ping' });

    assert({
      given: 'inbox:dm_updated',
      should: 'count the message and move the conversation to the top',
      actual: unread(seen.threads),
      expected: ['m2:4', 'm1:0'],
    });

    rt.emit('inbox:read_status_changed', { operation: 'read_status_changed', type: 'dm', id: 'm2', unreadCount: 0 });

    assert({
      given: 'inbox:read_status_changed for the conversation',
      should: 'clear its unread count',
      actual: unread(seen.threads),
      expected: ['m2:0', 'm1:0'],
    });

    rt.emit('inbox:channel_updated', channelUpdated('m1'));

    assert({
      given: 'a channel event',
      should: 'leave the DMs alone',
      actual: unread(seen.threads),
      expected: ['m2:0', 'm1:0'],
    });
  });
});

describe('useUnreadBadges()', () => {
  const BadgesProbe = ({ seen }: { seen: Seen }) => {
    seen.badges = useUnreadBadges().badges;
    return null;
  };

  test('loading and live', async () => {
    let current = badges({ dms: 1, channels: 2 });
    const seen: Seen = {};
    const { rt, web } = mount({ [BADGES]: () => Response.json(current) }, <BadgesProbe seen={seen} />);
    await loaded(seen, 'badges');

    assert({
      given: 'the viewer',
      should: 'read unread totals from /api/sidebar/badges',
      actual: [seen.badges?.channels, seen.badges?.dms],
      expected: [2, 1],
    });

    current = badges({ dms: 1, channels: 5 });
    rt.emit('inbox:channel_updated', channelUpdated('c1'));
    rt.emit('inbox:channel_updated', channelUpdated('c1', { lastMessagePreview: 'second' }));
    await settle(() => {
      if (seen.badges?.channels !== 5) throw new Error('not refreshed');
    });

    assert({
      given: 'a burst of inbox:channel_updated',
      should: 'refetch the totals once',
      actual: [seen.badges?.channels, web.count(BADGES)],
      expected: [5, 2],
    });

    const each: Array<[string, Record<string, unknown>, SidebarBadges]> = [
      ['inbox:dm_updated', { operation: 'dm_updated', type: 'dm', id: 'm1' }, badges({ dms: 2, channels: 5 })],
      ['inbox:read_status_changed', { operation: 'read_status_changed', type: 'dm', id: 'm1', unreadCount: 0 }, badges({ dms: 0, channels: 5 })],
      ['inbox:thread_updated', { operation: 'thread_updated', type: 'channel', id: 'c1' }, badges({ dms: 0, channels: 6 })],
    ];
    const refreshed: Array<[string, number | undefined, number | undefined]> = [];
    for (const [event, payload, next] of each) {
      current = next;
      rt.emit(event, payload);
      await settle(() => {
        if (seen.badges?.dms !== next.dms || seen.badges?.channels !== next.channels) throw new Error('not refreshed');
      });
      refreshed.push([event, seen.badges?.dms, seen.badges?.channels]);
    }

    assert({
      given: 'inbox:dm_updated, inbox:read_status_changed and inbox:thread_updated, one at a time',
      should: 'refetch the totals after each',
      actual: [refreshed, web.count(BADGES)],
      expected: [
        [
          ['inbox:dm_updated', 2, 5],
          ['inbox:read_status_changed', 0, 5],
          ['inbox:thread_updated', 0, 6],
        ],
        5,
      ],
    });

    // Mentions, task assignments and RSVPs reach the files, tasks and
    // calendar totals only through notifications, as classic's
    // useSidebarBadges knows.
    current = badges({ dms: 0, channels: 6, files: 1, tasks: 1, calendar: 1 });
    rt.emit('notification:new', { type: 'TASK_ASSIGNED' });
    await settle(() => {
      if (seen.badges?.tasks !== 1) throw new Error('not refreshed');
    });

    assert({
      given: 'notification:new',
      should: 'refetch the totals, so no total it returns is stale',
      actual: [seen.badges?.files, seen.badges?.tasks, seen.badges?.calendar, web.count(BADGES)],
      expected: [1, 1, 1, 6],
    });

    current = badges({ dms: 9, channels: 9 });
    rt.emit('page:updated', {});
    await new Promise((resolve) => setTimeout(resolve, 400));

    assert({
      given: 'an event that changes no unread total',
      should: 'not refetch the totals',
      actual: web.count(BADGES),
      expected: 6,
    });
  });
});

describe('after a reconnect', () => {
  test('refetches what the dropped socket missed', async () => {
    let channelItems = [inboxChannel('c1')];
    let conversations = [conversation('m1')];
    let totals = badges();
    const seen: Seen = {};
    function Probe() {
      const messages = useMessages('d1');
      seen.channels = messages.channels;
      seen.threads = messages.threads;
      seen.badges = messages.badges;
      return null;
    }
    const { rt, web } = mount(
      {
        [CHANNELS]: channelsRoute(() => channelItems),
        [CONVERSATIONS]: () =>
          Response.json({ conversations, pagination: { hasMore: false, nextCursor: null, limit: 100 } }),
        [BADGES]: () => Response.json(totals),
      },
      <Probe />,
    );
    await loaded(seen, 'channels');
    await loaded(seen, 'threads');
    await loaded(seen, 'badges');

    // Posts land while the transport is down: their inbox events are lost.
    channelItems = [inboxChannel('c1', { unreadCount: 2 })];
    conversations = [conversation('m1', { unreadCount: 1 })];
    totals = badges({ channels: 2, dms: 1 });
    rt.emit('connect');
    await settle(() => {
      if (unread(seen.channels)?.[0] !== 'c1:2') throw new Error('channels not refetched');
      if (unread(seen.threads)?.[0] !== 'm1:1') throw new Error('DMs not refetched');
      if (seen.badges?.channels !== 2) throw new Error('totals not refetched');
    });

    assert({
      given: 'the socket connecting again after the lists and totals loaded',
      should: 'refetch the channels, the DMs and the totals once each',
      actual: [unread(seen.channels), unread(seen.threads), seen.badges?.dms, [CHANNELS, CONVERSATIONS, BADGES].map(web.count)],
      expected: [['c1:2'], ['m1:1'], 1, [2, 2, 2]],
    });
  });

  test('a first connect before anything has loaded', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: Seen = {};
    const { rt, web } = mount(
      {
        [CHANNELS]: async () => {
          await gate;
          return Response.json({ items: [inboxChannel('c1')], pagination: { hasMore: false, nextCursor: null } });
        },
      },
      <ChannelsProbe seen={seen} />,
    );

    rt.emit('connect');
    release();
    await loaded(seen, 'channels');

    assert({
      given: 'the socket connecting while the first load is still in flight',
      should: 'not fetch the list a second time',
      actual: web.count(CHANNELS),
      expected: 1,
    });
  });
});

describe('useMessages()', () => {
  test('under StrictMode with the real realtime client', async () => {
    const seen: Seen = {};
    function Probe() {
      const messages = useMessages('d1');
      seen.channels = messages.channels;
      seen.threads = messages.threads;
      seen.badges = messages.badges;
      return null;
    }
    const { rt } = mount(
      {
        [CHANNELS]: channelsRoute(() => [inboxChannel('c1')]),
        [CONVERSATIONS]: () =>
          Response.json({ conversations: [conversation('m1')], pagination: { hasMore: false, nextCursor: null, limit: 100 } }),
        [BADGES]: () => Response.json(badges()),
      },
      <Probe />,
      { strict: true },
    );
    await loaded(seen, 'channels');
    await loaded(seen, 'threads');
    await loaded(seen, 'badges');

    const events = ['inbox:channel_updated', 'inbox:dm_updated', 'inbox:read_status_changed', 'inbox:thread_updated'];
    const [live] = rt.live();

    assert({
      given: "React's double mount, which makes the real client close its first socket and open another",
      should: 'leave every subscription on the one live socket and none on the dead one',
      actual: {
        sockets: rt.sockets.length,
        live: rt.live().length,
        dead: rt.sockets.filter((socket) => !socket.live).map((socket) => events.map((e) => rt.count(socket, e))),
        subscribed: events.map((event) => rt.count(live, event) > 0),
      },
      expected: {
        sockets: 2,
        live: 1,
        dead: [[0, 0, 0, 0]],
        subscribed: [true, true, true, true],
      },
    });

    rt.emit('inbox:channel_updated', channelUpdated('c1'));

    assert({
      given: 'a post relayed on the live socket',
      should: 'update the unread count once',
      actual: unread(seen.channels),
      expected: ['c1:1'],
    });
  });
});
