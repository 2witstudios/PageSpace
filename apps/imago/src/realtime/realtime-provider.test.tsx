// @vitest-environment jsdom
import { act, StrictMode, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import type { RealtimeClient, RealtimeSocket } from './realtime-client';
import { RealtimeProvider, useChannelRoom, useDriveRoom, useSocketEvent } from './realtime-provider';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
});

const mount = (tree: ReactNode): Root => {
  const root = createRoot(document.createElement('div'));
  roots.push(root);
  act(() => {
    root.render(tree);
  });
  return root;
};

const unmount = (root: Root): void => {
  act(() => root.unmount());
  roots = roots.filter((r) => r !== root);
};

type Listener = (...args: unknown[]) => void;

/**
 * A fake socket that records every on/off and every emit to the server, and
 * can deliver events to its listeners; delivering `connect` connects it.
 */
const fakeSocket = ({ connected = true }: { connected?: boolean } = {}) => {
  const listeners = new Map<string, Set<Listener>>();
  const log: string[] = [];
  const sent: unknown[][] = [];
  const socket: RealtimeSocket = {
    connected,
    emit: (event, ...args) => {
      sent.push([event, ...args]);
      return socket;
    },
    on: (event, listener) => {
      log.push(`on ${event}`);
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)?.add(listener);
      return socket;
    },
    off: (event, listener) => {
      log.push(listeners.get(event)?.delete(listener) ? `off ${event}` : `off ${event} (not subscribed)`);
      return socket;
    },
    connect: () => socket,
    disconnect: () => socket,
  };
  const deliver = (event: string, ...args: unknown[]) => {
    if (event === 'connect') socket.connected = true;
    if (event === 'disconnect') socket.connected = false;
    for (const listener of listeners.get(event) ?? []) listener(...args);
  };
  const count = (event: string) => listeners.get(event)?.size ?? 0;
  return { socket, log, sent, deliver, count };
};

/** A fake realtime client handing out one fake socket, recording its lifecycle calls. */
const fakeClient = (options: { connected?: boolean } = {}) => {
  const fake = fakeSocket(options);
  const lifecycle: string[] = [];
  const client: RealtimeClient = {
    socket: () => {
      lifecycle.push('socket');
      return fake.socket;
    },
    disconnect: () => {
      lifecycle.push('disconnect');
    },
  };
  return { client, lifecycle, ...fake };
};

describe('useSocketEvent', () => {
  test('subscribes once and unsubscribes on unmount', () => {
    const fake = fakeClient();
    const received: unknown[] = [];
    let rerender: () => void = () => {};

    function Listener() {
      const [renders, setRenders] = useState(0);
      rerender = () => setRenders((n) => n + 1);
      // A new handler identity on every render, as an inline arrow would be.
      useSocketEvent('page:updated', (payload: unknown) => {
        received.push({ renders, payload });
      });
      return null;
    }

    const root = mount(
      <RealtimeProvider client={fake.client}>
        <Listener />
      </RealtimeProvider>,
    );
    act(() => rerender());
    act(() => rerender());

    assert({
      given: 'a component re-rendered twice with a new handler each time',
      should: 'have subscribed exactly once',
      actual: { log: fake.log, listeners: fake.count('page:updated') },
      expected: { log: ['on page:updated'], listeners: 1 },
    });

    fake.deliver('page:updated', { id: 'p1' });

    assert({
      given: 'an event after the re-renders',
      should: 'call the latest handler with the payload',
      actual: received,
      expected: [{ renders: 2, payload: { id: 'p1' } }],
    });

    unmount(root);

    assert({
      given: 'the component unmounting',
      should: 'remove the very listener it added',
      actual: { log: fake.log, listeners: fake.count('page:updated') },
      expected: { log: ['on page:updated', 'off page:updated'], listeners: 0 },
    });

    fake.deliver('page:updated', { id: 'p2' });

    assert({
      given: 'an event after unmount',
      should: 'not call the handler',
      actual: received.length,
      expected: 1,
    });
  });

  test('a new event name', () => {
    const fake = fakeClient();
    let setEvent: (event: string) => void = () => {};

    function Listener() {
      const [event, set] = useState('page:updated');
      setEvent = set;
      useSocketEvent(event, () => {});
      return null;
    }

    mount(
      <RealtimeProvider client={fake.client}>
        <Listener />
      </RealtimeProvider>,
    );
    act(() => setEvent('page:moved'));

    assert({
      given: 'the event name changing',
      should: 'move the one subscription to the new event',
      actual: { log: fake.log, old: fake.count('page:updated'), next: fake.count('page:moved') },
      expected: { log: ['on page:updated', 'off page:updated', 'on page:moved'], old: 0, next: 1 },
    });
  });

  test('StrictMode', () => {
    const fake = fakeClient();

    function Listener() {
      useSocketEvent('page:updated', () => {});
      return null;
    }

    mount(
      <StrictMode>
        <RealtimeProvider client={fake.client}>
          <Listener />
        </RealtimeProvider>
      </StrictMode>,
    );

    assert({
      given: "React's development double-mount",
      should: 'end with one live subscription',
      actual: fake.count('page:updated'),
      expected: 1,
    });
  });
});

describe('RealtimeProvider', () => {
  test('connects for the life of the tab', () => {
    const fake = fakeClient();
    const root = mount(
      <RealtimeProvider client={fake.client}>
        <p>shell</p>
      </RealtimeProvider>,
    );

    assert({
      given: 'the provider mounting with no subscribers yet',
      should: 'open the socket',
      actual: fake.lifecycle,
      expected: ['socket'],
    });

    unmount(root);

    assert({
      given: 'the provider unmounting',
      should: 'disconnect',
      actual: fake.lifecycle,
      expected: ['socket', 'disconnect'],
    });
  });
});

describe('useDriveRoom', () => {
  function Room({ driveId }: { driveId: string | null }) {
    useDriveRoom(driveId);
    return null;
  }

  test('a connected socket', () => {
    const fake = fakeClient();
    mount(
      <RealtimeProvider client={fake.client}>
        <Room driveId="d1" />
      </RealtimeProvider>,
    );

    assert({
      given: 'a drive and a socket already connected',
      should: 'ask realtime to join that drive’s room once',
      actual: fake.sent,
      expected: [['join_drive', 'd1']],
    });
  });

  test('a socket still connecting', () => {
    const fake = fakeClient({ connected: false });
    mount(
      <RealtimeProvider client={fake.client}>
        <Room driveId="d1" />
      </RealtimeProvider>,
    );
    const before = [...fake.sent];
    act(() => fake.deliver('connect'));

    assert({
      given: 'a socket that connects after the drive is known',
      should: 'join only once it is connected',
      actual: [before, fake.sent],
      expected: [[], [['join_drive', 'd1']]],
    });
  });

  test('a reconnect', () => {
    const fake = fakeClient();
    mount(
      <RealtimeProvider client={fake.client}>
        <Room driveId="d1" />
      </RealtimeProvider>,
    );
    act(() => fake.deliver('disconnect'));
    act(() => fake.deliver('connect'));

    assert({
      given: 'the socket reconnecting (realtime forgets a socket’s rooms)',
      should: 'join the room again',
      actual: fake.sent,
      expected: [
        ['join_drive', 'd1'],
        ['join_drive', 'd1'],
      ],
    });
  });

  test('another drive', () => {
    const fake = fakeClient();
    let setDrive: (driveId: string | null) => void = () => {};
    function Switcher() {
      const [driveId, set] = useState<string | null>('d1');
      setDrive = set;
      return <Room driveId={driveId} />;
    }
    mount(
      <RealtimeProvider client={fake.client}>
        <Switcher />
      </RealtimeProvider>,
    );
    act(() => setDrive('d2'));
    act(() => fake.deliver('connect'));

    assert({
      given: 'the drive changing, then a reconnect',
      should: 'join the new drive, and rejoin only it',
      actual: fake.sent,
      expected: [
        ['join_drive', 'd1'],
        ['join_drive', 'd2'],
        ['join_drive', 'd2'],
      ],
    });
  });

  test('no drive and unmount', () => {
    const fake = fakeClient();
    const root = mount(
      <RealtimeProvider client={fake.client}>
        <Room driveId={null} />
        <Room driveId="d1" />
      </RealtimeProvider>,
    );
    unmount(root);
    fake.deliver('connect');

    assert({
      given: 'no drive yet, and a reconnect after unmounting',
      should: 'join nothing for the missing drive and stop rejoining once gone',
      actual: [fake.sent, fake.count('connect')],
      expected: [[['join_drive', 'd1']], 0],
    });
  });
});

describe('useChannelRoom', () => {
  function Room({ pageId }: { pageId: string }) {
    useChannelRoom(pageId);
    return null;
  }

  test('joining, and rejoining after a reconnect', () => {
    const fake = fakeClient({ connected: false });
    mount(
      <RealtimeProvider client={fake.client}>
        <Room pageId="c1" />
      </RealtimeProvider>,
    );
    const before = [...fake.sent];
    act(() => fake.deliver('connect'));
    act(() => fake.deliver('disconnect'));
    act(() => fake.deliver('connect'));

    assert({
      given: 'a channel open on a socket that connects, drops and reconnects',
      should: 'join its room once connected, and again after the reconnect',
      actual: [before, fake.sent],
      expected: [
        [],
        [
          ['join_channel', 'c1'],
          ['join_channel', 'c1'],
        ],
      ],
    });
  });

  test('another channel, then leaving', () => {
    const fake = fakeClient();
    let setPage: (pageId: string) => void = () => {};
    function Switcher() {
      const [pageId, set] = useState('c1');
      setPage = set;
      return <Room pageId={pageId} />;
    }
    const root = mount(
      <RealtimeProvider client={fake.client}>
        <Switcher />
      </RealtimeProvider>,
    );
    act(() => setPage('c2'));
    unmount(root);
    fake.deliver('connect');

    assert({
      given: 'the open channel changing, then the thread closing and the socket reconnecting',
      should: 'leave each room as its channel closes and rejoin nothing',
      actual: [fake.sent, fake.count('connect')],
      expected: [
        [
          ['join_channel', 'c1'],
          ['leave_channel', 'c1'],
          ['join_channel', 'c2'],
          ['leave_channel', 'c2'],
        ],
        0,
      ],
    });
  });

  test('closing while disconnected', () => {
    const fake = fakeClient();
    const root = mount(
      <RealtimeProvider client={fake.client}>
        <Room pageId="c1" />
      </RealtimeProvider>,
    );
    act(() => fake.deliver('disconnect'));
    unmount(root);

    assert({
      given: 'the socket dropped before the channel closed (realtime has already forgotten its rooms)',
      should: 'not queue a leave for the next connection',
      actual: fake.sent,
      expected: [['join_channel', 'c1']],
    });
  });
});
