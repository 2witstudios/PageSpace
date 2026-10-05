// @vitest-environment jsdom
import { act, StrictMode, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import type { RealtimeClient, RealtimeSocket } from './realtime-client';
import { RealtimeProvider, useSocketEvent } from './realtime-provider';

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

/** A fake socket that records every on/off and can deliver events to its listeners. */
const fakeSocket = () => {
  const listeners = new Map<string, Set<Listener>>();
  const log: string[] = [];
  const socket: RealtimeSocket = {
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
    for (const listener of listeners.get(event) ?? []) listener(...args);
  };
  const count = (event: string) => listeners.get(event)?.size ?? 0;
  return { socket, log, deliver, count };
};

/** A fake realtime client handing out one fake socket, recording its lifecycle calls. */
const fakeClient = () => {
  const fake = fakeSocket();
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
