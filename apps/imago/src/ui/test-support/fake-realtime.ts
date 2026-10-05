// A fake apps/realtime for the imago data tests: the real realtime client
// (createRealtimeClient) over sockets that never touch the network.

import { act } from 'react';
import { createRealtimeClient, type RealtimeSocket } from '@/realtime/realtime-client';

type Listener = (...args: unknown[]) => void;

/** A socket.io stand-in that records listeners and whether it is still the live one. */
export type FakeSocket = RealtimeSocket & {
  live: boolean;
  listeners: Map<string, Set<Listener>>;
  /** Every event this tab sent to realtime, with its arguments. */
  emitted: unknown[][];
};

/**
 * Every socket the client opens is recorded, so a test can see which one is
 * live and what is subscribed on each, and relay events to the live one.
 */
export const fakeRealtime = () => {
  const sockets: FakeSocket[] = [];
  const client = createRealtimeClient({
    url: undefined,
    fetchToken: () => Promise.resolve('ps_sock_1'),
    connectSocket: () => {
      const listeners = new Map<string, Set<Listener>>();
      const emitted: unknown[][] = [];
      const socket: FakeSocket = {
        live: true,
        listeners,
        emitted,
        connected: true,
        emit: (event, ...args) => {
          emitted.push([event, ...args]);
          return socket;
        },
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
  /** realtime relaying an event (or socket.io firing `connect`): only the live socket receives it. */
  const emit = (event: string, ...args: unknown[]) =>
    act(() => {
      for (const socket of live()) for (const listener of socket.listeners.get(event) ?? []) listener(...args);
    });
  const count = (socket: FakeSocket, event: string) => socket.listeners.get(event)?.size ?? 0;
  return { client, sockets, live, emit, count };
};
