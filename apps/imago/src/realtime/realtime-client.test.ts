import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io, type ManagerOptions, type SocketOptions } from 'socket.io-client';
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { createApiClient } from '@/api/client';
import { ApiError } from '@/api/errors';
import {
  RETRY_DELAY_MAX_MS,
  RETRY_DELAY_MS,
  createRealtimeClient,
  type ConnectSocket,
  type RealtimeClient,
  type RealtimeSocket,
} from './realtime-client';
import { SOCKET_TOKEN_ENDPOINT, fetchSocketToken } from './socket-token';

type SocketOpts = Partial<ManagerOptions & SocketOptions>;
type AuthCallback = (data: object) => void;

const clients: RealtimeClient[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const track = (client: RealtimeClient): RealtimeClient => {
  clients.push(client);
  return client;
};

// ---------------------------------------------------------------------------
// The real path: real socket.io-client, real HTTP, real token fetch through
// the imago API client. Only the two servers are stand-ins: apps/web's
// socket-token route (a fake fetch minting ps_sock_1, ps_sock_2, …) and the
// realtime server (a minimal Engine.IO v4 long-polling endpoint that records
// every Socket.IO CONNECT and its auth payload).
// ---------------------------------------------------------------------------

type ConnectDecision = (auth: unknown, nth: number) => string;

const ACCEPT: ConnectDecision = (_auth, nth) => `40{"sid":"socket-${nth}"}`;

/** A realtime stand-in speaking just enough Engine.IO v4 polling for socket.io-client. */
const startRealtimeStandIn = async (log: string[], decide: ConnectDecision = ACCEPT) => {
  type Session = { queue: string[]; poll: ServerResponse | null };
  const sessions = new Map<string, Session>();
  const connects: unknown[] = [];
  let nextSid = 0;

  const send = (res: ServerResponse, body: string) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=UTF-8' });
    res.end(body);
  };
  const flush = (session: Session) => {
    if (!session.poll || session.queue.length === 0) return;
    const poll = session.poll;
    session.poll = null;
    send(poll, session.queue.splice(0).join('\x1e'));
  };
  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => resolve(body));
    });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://stand-in');
    const sid = url.searchParams.get('sid');
    if (url.pathname !== '/socket.io/') return void res.writeHead(404).end();
    if (!sid) {
      nextSid += 1;
      const id = `eio-${nextSid}`;
      sessions.set(id, { queue: [], poll: null });
      return send(res, `0${JSON.stringify({ sid: id, upgrades: [], pingInterval: 60000, pingTimeout: 60000, maxPayload: 1000000 })}`);
    }
    const session = sessions.get(sid);
    if (!session) return void res.writeHead(400).end();
    if (req.method === 'POST') {
      for (const packet of (await readBody(req)).split('\x1e')) {
        if (!packet.startsWith('40')) continue;
        const auth: unknown = packet.length > 2 ? JSON.parse(packet.slice(2)) : undefined;
        connects.push(auth);
        log.push(`CONNECT ${JSON.stringify(auth)}`);
        session.queue.push(decide(auth, connects.length));
      }
      send(res, 'ok');
      return flush(session);
    }
    session.poll = res;
    flush(session);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  /** Ends the transport from the server side, the way a realtime restart would. */
  const dropTransport = () => {
    log.push('server dropped the transport');
    for (const session of sessions.values()) {
      if (session.poll) send(session.poll, '1');
      session.poll = null;
    }
  };

  cleanups.push(async () => {
    for (const session of sessions.values()) session.poll?.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  return {
    url,
    connects,
    dropTransport,
    hasOpenPoll: () => [...sessions.values()].some((s) => s.poll !== null),
  };
};

/** The imago API client on a fake fetch whose socket-token route mints ps_sock_1, ps_sock_2, … */
const tokenMintingApi = (log: string[]) => {
  let minted = 0;
  return createApiClient({
    fetch: async (input) => {
      if (input !== SOCKET_TOKEN_ENDPOINT) throw new Error(`unexpected fetch ${input}`);
      minted += 1;
      log.push(`token ps_sock_${minted}`);
      return Response.json({ token: `ps_sock_${minted}`, expiresAt: '2026-10-05T00:05:00.000Z' });
    },
    navigate: () => {},
    location: () => ({ origin: 'http://localhost:3006', pathname: '/imago' }),
  });
};

/** The real io(), with reconnection delays shortened so the test does not wait seconds. */
const fastIo: ConnectSocket = (url, options) =>
  io(url, { ...options, reconnectionDelay: 5, reconnectionDelayMax: 5, randomizationFactor: 0 });

const waitFor = (check: () => void) => vi.waitFor(check, { timeout: 3000, interval: 5 });

describe('createRealtimeClient over a real socket.io-client', () => {
  test('a signed-in session connects with a ps_sock_ token', async () => {
    const log: string[] = [];
    const realtime = await startRealtimeStandIn(log);
    const api = tokenMintingApi(log);
    const client = track(
      createRealtimeClient({
        url: realtime.url,
        fetchToken: () => fetchSocketToken(api),
        connectSocket: fastIo,
      }),
    );

    const socket = client.socket();
    let connected = false;
    socket.on('connect', () => {
      connected = true;
    });
    await waitFor(() => {
      if (!connected) throw new Error('not connected yet');
    });

    assert({
      given: 'a session and NEXT_PUBLIC_REALTIME_URL',
      should: 'fetch a socket token, then connect to that URL with exactly { token } as auth',
      actual: log,
      expected: ['token ps_sock_1', 'CONNECT {"token":"ps_sock_1"}'],
    });
  });

  test('a reconnect fetches a fresh token first', async () => {
    const log: string[] = [];
    const realtime = await startRealtimeStandIn(log);
    const api = tokenMintingApi(log);
    const client = track(
      createRealtimeClient({
        url: realtime.url,
        fetchToken: () => fetchSocketToken(api),
        connectSocket: fastIo,
      }),
    );

    const socket = client.socket();
    let connects = 0;
    socket.on('connect', () => {
      connects += 1;
    });
    await waitFor(() => {
      if (connects !== 1 || !realtime.hasOpenPoll()) throw new Error('not connected yet');
    });
    realtime.dropTransport();
    await waitFor(() => {
      if (connects !== 2) throw new Error('not reconnected yet');
    });

    assert({
      given: 'the transport dropped and socket.io reconnecting on its own',
      should: 'fetch a new token before the second CONNECT and send that one, not the first',
      actual: log,
      expected: [
        'token ps_sock_1',
        'CONNECT {"token":"ps_sock_1"}',
        'server dropped the transport',
        'token ps_sock_2',
        'CONNECT {"token":"ps_sock_2"}',
      ],
    });
  });

  test('a token realtime rejects is replaced, not resent', async () => {
    const log: string[] = [];
    const realtime = await startRealtimeStandIn(log, (auth, nth) =>
      nth === 1
        ? '44{"message":"Authentication error: Invalid or expired socket token."}'
        : ACCEPT(auth, nth),
    );
    const api = tokenMintingApi(log);
    const client = track(
      createRealtimeClient({
        url: realtime.url,
        fetchToken: () => fetchSocketToken(api),
        connectSocket: fastIo,
        schedule: (run) => {
          const timer = setTimeout(run, 5);
          return () => clearTimeout(timer);
        },
      }),
    );

    const socket = client.socket();
    let connected = false;
    socket.on('connect', () => {
      connected = true;
    });
    await waitFor(() => {
      if (!connected) throw new Error('not connected yet');
    });

    assert({
      given: "realtime's auth middleware rejecting the first token",
      should: 'retry with a freshly fetched token',
      actual: log,
      expected: [
        'token ps_sock_1',
        'CONNECT {"token":"ps_sock_1"}',
        'token ps_sock_2',
        'CONNECT {"token":"ps_sock_2"}',
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// Lifecycle and retry rules, on a fake socket: what the client does with
// socket.io's callbacks, which a real server cannot be made to hit on cue.
// ---------------------------------------------------------------------------

type FakeSocket = RealtimeSocket & {
  url: string | undefined;
  options: SocketOpts;
  calls: string[];
  emit: (event: string, ...args: unknown[]) => void;
  /** What socket.io does before each CONNECT: ask `auth` for the payload. */
  handshake: () => Promise<object | null>;
};

const fakeSockets = () => {
  const made: FakeSocket[] = [];
  const connectSocket: ConnectSocket = (url, options) => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const socket: FakeSocket = {
      url,
      options,
      calls: [],
      on: (event, listener) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)?.add(listener);
        return socket;
      },
      off: (event, listener) => {
        listeners.get(event)?.delete(listener);
        return socket;
      },
      connect: () => {
        socket.calls.push('connect');
        return socket;
      },
      disconnect: () => {
        socket.calls.push('disconnect');
        return socket;
      },
      emit: (event, ...args) => {
        for (const listener of listeners.get(event) ?? []) listener(...args);
      },
      handshake: () =>
        new Promise((resolve) => {
          const auth = options.auth;
          if (typeof auth !== 'function') throw new Error('auth is not a function');
          const callback: AuthCallback = (data) => resolve(data);
          auth(callback);
          // A callback that never fires is a handshake that never happens.
          setTimeout(() => resolve(null), 20);
        }),
    };
    made.push(socket);
    return socket;
  };
  return { made, connectSocket };
};

const fakeTimers = () => {
  const pending: Array<{ run: () => void; delay: number; cancelled: boolean }> = [];
  return {
    pending,
    schedule: (run: () => void, delay: number) => {
      const timer = { run, delay, cancelled: false };
      pending.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    live: () => pending.filter((t) => !t.cancelled),
    runAll: () => {
      for (const timer of pending.splice(0)) if (!timer.cancelled) timer.run();
    },
  };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createRealtimeClient lifecycle', () => {
  test('one socket per client', () => {
    const sockets = fakeSockets();
    const client = track(
      createRealtimeClient({ url: 'http://localhost:3001', fetchToken: async () => 'ps_sock_1', connectSocket: sockets.connectSocket }),
    );

    assert({
      given: 'socket() asked for three times',
      should: 'create one socket and hand back the same one',
      actual: [client.socket() === client.socket(), client.socket() === sockets.made[0], sockets.made.length],
      expected: [true, true, 1],
    });

    assert({
      given: 'the socket options',
      should: 'target NEXT_PUBLIC_REALTIME_URL, authenticate by token function and send no cookies',
      actual: {
        url: sockets.made[0]?.url,
        auth: typeof sockets.made[0]?.options.auth,
        withCredentials: sockets.made[0]?.options.withCredentials,
        reconnection: sockets.made[0]?.options.reconnection,
      },
      expected: { url: 'http://localhost:3001', auth: 'function', withCredentials: false, reconnection: true },
    });
  });

  test('no realtime URL', () => {
    const sockets = fakeSockets();
    const client = track(createRealtimeClient({ url: '', fetchToken: async () => 'ps_sock_1', connectSocket: sockets.connectSocket }));
    client.socket();

    assert({
      given: 'an empty NEXT_PUBLIC_REALTIME_URL (production path-routes /socket.io on the app origin)',
      should: 'let socket.io connect to the page origin',
      actual: sockets.made[0]?.url,
      expected: undefined,
    });
  });

  test('each handshake asks for a new token', async () => {
    const sockets = fakeSockets();
    let minted = 0;
    const client = track(
      createRealtimeClient({
        url: 'http://localhost:3001',
        fetchToken: async () => `ps_sock_${(minted += 1)}`,
        connectSocket: sockets.connectSocket,
      }),
    );
    const socket = client.socket() as FakeSocket;

    assert({
      given: 'socket.io running the auth callback before each of three CONNECTs',
      should: 'send a newly fetched token each time',
      actual: [await socket.handshake(), await socket.handshake(), await socket.handshake()],
      expected: [{ token: 'ps_sock_1' }, { token: 'ps_sock_2' }, { token: 'ps_sock_3' }],
    });
  });

  test('a token fetch that fails on the network', async () => {
    const sockets = fakeSockets();
    const timers = fakeTimers();
    const client = track(
      createRealtimeClient({
        url: 'http://localhost:3001',
        fetchToken: () => Promise.reject(new TypeError('Failed to fetch')),
        connectSocket: sockets.connectSocket,
        schedule: timers.schedule,
      }),
    );
    const socket = client.socket() as FakeSocket;

    assert({
      given: 'the token fetch rejecting with a network error',
      should: 'never send a CONNECT without a token',
      actual: await socket.handshake(),
      expected: null,
    });

    assert({
      given: 'the failed token fetch',
      should: 'stop the stalled attempt and schedule a retry after the first delay',
      actual: { calls: socket.calls, delays: timers.live().map((t) => t.delay) },
      expected: { calls: ['disconnect'], delays: [RETRY_DELAY_MS] },
    });

    timers.runAll();

    assert({
      given: 'the retry firing',
      should: 'connect the same socket again (socket.io then asks auth for a new token)',
      actual: socket.calls,
      expected: ['disconnect', 'connect'],
    });
  });

  test('a session that is gone', async () => {
    const sockets = fakeSockets();
    const timers = fakeTimers();
    const client = track(
      createRealtimeClient({
        url: 'http://localhost:3001',
        fetchToken: () => Promise.reject(new ApiError({ status: 401, code: null, message: 'Unauthorized' })),
        connectSocket: sockets.connectSocket,
        schedule: timers.schedule,
      }),
    );
    const socket = client.socket() as FakeSocket;
    await socket.handshake();

    assert({
      given: 'a 401 for the token (the API client is already sending the page to sign-in)',
      should: 'stop the socket and not retry',
      actual: { calls: socket.calls, retries: timers.live().length },
      expected: { calls: ['disconnect'], retries: 0 },
    });
  });

  test('connect errors', () => {
    const cases: Array<{ message: string; retries: number }> = [
      { message: 'Authentication error: Invalid or expired socket token.', retries: 1 },
      { message: 'Authentication error: No token provided.', retries: 1 },
      { message: 'Origin not allowed', retries: 0 },
      { message: 'xhr poll error', retries: 0 },
    ];
    for (const { message, retries } of cases) {
      const sockets = fakeSockets();
      const timers = fakeTimers();
      const client = track(
        createRealtimeClient({
          url: 'http://localhost:3001',
          fetchToken: async () => 'ps_sock_1',
          connectSocket: sockets.connectSocket,
          schedule: timers.schedule,
        }),
      );
      const socket = client.socket() as FakeSocket;
      socket.emit('connect_error', new Error(message));

      assert({
        given: `connect_error "${message}"`,
        should:
          retries === 1
            ? 'schedule a reconnect, which fetches a fresh token'
            : 'leave it to socket.io (network) or to configuration (origin)',
        actual: timers.live().length,
        expected: retries,
      });
    }
  });

  test('backoff', () => {
    const sockets = fakeSockets();
    const timers = fakeTimers();
    const client = track(
      createRealtimeClient({
        url: 'http://localhost:3001',
        fetchToken: async () => 'ps_sock_1',
        connectSocket: sockets.connectSocket,
        schedule: timers.schedule,
      }),
    );
    const socket = client.socket() as FakeSocket;
    const delays: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      socket.emit('connect_error', new Error('Authentication error: Invalid or expired socket token.'));
      delays.push(...timers.live().map((t) => t.delay));
      timers.runAll();
    }
    socket.emit('connect');
    socket.emit('connect_error', new Error('Authentication error: Invalid or expired socket token.'));
    const afterConnect = timers.live().map((t) => t.delay);

    assert({
      given: 'repeated auth rejections',
      should: 'double the delay up to the cap',
      actual: delays,
      expected: [2000, 4000, 8000, 16000, RETRY_DELAY_MAX_MS, RETRY_DELAY_MAX_MS, RETRY_DELAY_MAX_MS],
    });

    assert({
      given: 'a successful connect in between',
      should: 'start again from the first delay',
      actual: afterConnect,
      expected: [RETRY_DELAY_MS],
    });
  });

  test('disconnect', async () => {
    const sockets = fakeSockets();
    const timers = fakeTimers();
    let release: (token: string) => void = () => {};
    const client = createRealtimeClient({
      url: 'http://localhost:3001',
      fetchToken: () => new Promise<string>((resolve) => (release = resolve)),
      connectSocket: sockets.connectSocket,
      schedule: timers.schedule,
    });
    const first = client.socket() as FakeSocket;
    first.emit('connect_error', new Error('Authentication error: Invalid or expired socket token.'));
    const handshake = first.handshake();
    client.disconnect();
    release('ps_sock_late');
    await tick();

    assert({
      given: 'disconnect() while a token fetch and a retry are pending',
      should: 'disconnect, cancel the retry and drop the late token instead of connecting with it',
      actual: { calls: first.calls, retries: timers.live().length, sent: await handshake },
      expected: { calls: ['disconnect'], retries: 0, sent: null },
    });

    assert({
      given: 'socket() after disconnect()',
      should: 'create a new socket',
      actual: [client.socket() !== first, sockets.made.length],
      expected: [true, 2],
    });
    client.disconnect();
  });
});
