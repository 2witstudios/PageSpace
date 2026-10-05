// Imago's one connection to apps/realtime.
//
// socket.io calls a function-valued `auth` before every CONNECT it sends: the
// first connect, each automatic reconnect after the transport drops, and a
// manual connect(). Fetching the token there means every handshake carries a
// `ps_sock_` token minted just before it, so a 5-minute token is never
// replayed after it may have expired, and nothing else is ever sent.
//
// socket.io reconnects on its own only after transport failures. When
// realtime's middleware refuses the token, or the token fetch itself fails,
// the socket stops; this client retries it with backoff, and the retry
// fetches a new token through `auth` again.

import { io, type ManagerOptions, type SocketOptions } from 'socket.io-client';
import { getBrowserApiClient } from '@/api/client';
import { ApiError } from '@/api/errors';
import { fetchSocketToken } from './socket-token';

/** The part of a socket.io Socket imago uses; tests stand a fake in for it. */
export type RealtimeSocket = {
  connected: boolean;
  /** Sends an event to realtime (socket.io buffers it until the socket connects). */
  emit(event: string, ...args: unknown[]): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  connect(): unknown;
  disconnect(): unknown;
};

export type ConnectSocket = (
  url: string | undefined,
  options: Partial<ManagerOptions & SocketOptions>,
) => RealtimeSocket;

export type RealtimeClient = {
  /** The tab's socket, created and connecting on first use. */
  socket: () => RealtimeSocket;
  /** Closes the socket and cancels any retry; the next socket() starts over. */
  disconnect: () => void;
};

export const RETRY_DELAY_MS = 2000;
export const RETRY_DELAY_MAX_MS = 30000;

/** realtime's middleware prefixes every token rejection with this (apps/realtime/src/index.ts). */
const AUTH_REJECTION = 'Authentication error';

const defaultSchedule = (run: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
};

export function createRealtimeClient({
  url,
  fetchToken,
  connectSocket,
  schedule = defaultSchedule,
}: {
  /** NEXT_PUBLIC_REALTIME_URL; empty means the page's own origin. */
  url: string | undefined;
  fetchToken: () => Promise<string>;
  connectSocket: ConnectSocket;
  schedule?: (run: () => void, delayMs: number) => () => void;
}): RealtimeClient {
  let current: RealtimeSocket | null = null;
  let cancelRetry: (() => void) | null = null;
  let retryDelay = RETRY_DELAY_MS;

  const retryLater = (socket: RealtimeSocket) => {
    if (cancelRetry) return;
    cancelRetry = schedule(() => {
      cancelRetry = null;
      if (current === socket) socket.connect();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, RETRY_DELAY_MAX_MS);
  };

  const open = (): RealtimeSocket => {
    const socket = connectSocket(url || undefined, {
      auth: (send) => {
        fetchToken().then(
          (token) => {
            // A token that lands after disconnect() must not revive the socket.
            if (current === socket) send({ token });
          },
          (error: unknown) => {
            if (current !== socket) return;
            // No CONNECT goes out without a token: stop this attempt.
            socket.disconnect();
            // A 401 has already sent the page to sign-in.
            if (!(error instanceof ApiError && error.status === 401)) retryLater(socket);
          },
        );
      },
      // Token auth only: the session cookie is not realtime's to see.
      withCredentials: false,
      reconnection: true,
      reconnectionDelay: RETRY_DELAY_MS,
      reconnectionDelayMax: RETRY_DELAY_MAX_MS,
      randomizationFactor: 0.5,
    });

    socket.on('connect', () => {
      retryDelay = RETRY_DELAY_MS;
    });
    // Transport errors are socket.io's to retry; a refused origin is a
    // configuration error that retrying cannot fix.
    socket.on('connect_error', (error) => {
      if (current !== socket || !(error instanceof Error)) return;
      if (error.message.startsWith(AUTH_REJECTION)) retryLater(socket);
    });

    return socket;
  };

  return {
    socket: () => {
      current ??= open();
      return current;
    },
    disconnect: () => {
      cancelRetry?.();
      cancelRetry = null;
      retryDelay = RETRY_DELAY_MS;
      const socket = current;
      current = null;
      socket?.disconnect();
    },
  };
}

let browserClient: RealtimeClient | null = null;

/** The tab's realtime client; creating it touches neither window nor the network. */
export function getBrowserRealtimeClient(): RealtimeClient {
  browserClient ??= createRealtimeClient({
    // Dot access: Next inlines NEXT_PUBLIC_* only when referenced literally.
    url: process.env.NEXT_PUBLIC_REALTIME_URL,
    fetchToken: () => fetchSocketToken(getBrowserApiClient()),
    connectSocket: (url, options) => io(url, options),
  });
  return browserClient;
}
