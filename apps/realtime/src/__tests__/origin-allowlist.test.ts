/**
 * The origin allowlist realtime enforces, tested on the real module that
 * index.ts wires into Socket.IO's CORS check and its connection middleware.
 *
 * Imago (apps/imago) runs on its own dev origin, http://localhost:3006, so
 * realtime only accepts it once ADDITIONAL_ALLOWED_ORIGINS lists it
 * (apps/realtime/.env.example). The last block proves that end to end: a real
 * Socket.IO server on a real port, handshaken over HTTP long-polling with the
 * browser's Origin header.
 */

import { createServer, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { Server } from 'socket.io';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    realtime: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

import {
  corsOrigin,
  getAllowedOrigins,
  isOriginAllowed,
  normalizeOrigin,
  validateAndLogWebSocketOrigin,
} from '../origin-allowlist';

const IMAGO_DEV_ORIGIN = 'http://localhost:3006';
const WEB_DEV_ORIGIN = 'http://localhost:3000';
const ENV_KEYS = ['CORS_ORIGIN', 'WEB_APP_URL', 'ADDITIONAL_ALLOWED_ORIGINS', 'NODE_ENV'] as const;

const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const meta = { socketId: 's1', ip: '127.0.0.1', userAgent: 'test' };

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** What corsOrigin answers for `origin`: allowed, or the error it rejects with. */
const askCors = (origin: string | undefined): { error: Error | null; allow: boolean | undefined } => {
  let answer: { error: Error | null; allow: boolean | undefined } = { error: null, allow: undefined };
  corsOrigin(origin, (error, allow) => {
    answer = { error, allow };
  });
  return answer;
};

describe('normalizeOrigin', () => {
  it('given a URL with a path, should return scheme, host and port only', () => {
    expect(normalizeOrigin('http://localhost:3006/imago/x')).toBe(IMAGO_DEV_ORIGIN);
  });

  it('given something that is not a URL, should return an empty string', () => {
    expect(normalizeOrigin('not a url')).toBe('');
  });
});

describe('getAllowedOrigins', () => {
  it('given only CORS_ORIGIN, should allow just the web origin', () => {
    process.env.CORS_ORIGIN = WEB_DEV_ORIGIN;
    expect(getAllowedOrigins()).toEqual([WEB_DEV_ORIGIN]);
  });

  it('given the imago dev origin in ADDITIONAL_ALLOWED_ORIGINS, should allow it beside the web origin', () => {
    process.env.CORS_ORIGIN = WEB_DEV_ORIGIN;
    process.env.ADDITIONAL_ALLOWED_ORIGINS = ` ${IMAGO_DEV_ORIGIN} , https://admin.example.com,not a url`;
    expect(getAllowedOrigins()).toEqual([WEB_DEV_ORIGIN, IMAGO_DEV_ORIGIN, 'https://admin.example.com']);
  });

  it('given WEB_APP_URL and no CORS_ORIGIN, should use WEB_APP_URL', () => {
    process.env.WEB_APP_URL = `${WEB_DEV_ORIGIN}/dashboard`;
    expect(getAllowedOrigins()).toEqual([WEB_DEV_ORIGIN]);
  });

  it('given both, should prefer CORS_ORIGIN', () => {
    process.env.CORS_ORIGIN = 'https://pagespace.ai';
    process.env.WEB_APP_URL = WEB_DEV_ORIGIN;
    expect(getAllowedOrigins()).toEqual(['https://pagespace.ai']);
  });

  it('given unparsable primary origins, should skip them', () => {
    process.env.CORS_ORIGIN = 'nope';
    expect(getAllowedOrigins()).toEqual([]);
    delete process.env.CORS_ORIGIN;
    process.env.WEB_APP_URL = 'nope';
    expect(getAllowedOrigins()).toEqual([]);
  });

  it('given nothing configured, should allow nothing', () => {
    expect(getAllowedOrigins()).toEqual([]);
  });
});

describe('isOriginAllowed', () => {
  it('given an exact origin match, should allow it', () => {
    expect(isOriginAllowed(IMAGO_DEV_ORIGIN, [WEB_DEV_ORIGIN, IMAGO_DEV_ORIGIN])).toBe(true);
  });

  it('given another port on the same host, should refuse it', () => {
    expect(isOriginAllowed('http://localhost:3007', [WEB_DEV_ORIGIN, IMAGO_DEV_ORIGIN])).toBe(false);
  });

  it('given a malformed origin, should refuse it', () => {
    expect(isOriginAllowed('garbage', [IMAGO_DEV_ORIGIN])).toBe(false);
  });
});

describe('corsOrigin', () => {
  it('given the imago dev origin listed in ADDITIONAL_ALLOWED_ORIGINS, should allow it', () => {
    process.env.CORS_ORIGIN = WEB_DEV_ORIGIN;
    process.env.ADDITIONAL_ALLOWED_ORIGINS = IMAGO_DEV_ORIGIN;
    expect(askCors(IMAGO_DEV_ORIGIN)).toEqual({ error: null, allow: true });
  });

  it('given the imago dev origin not listed, should reject it', () => {
    process.env.CORS_ORIGIN = WEB_DEV_ORIGIN;
    const { error, allow } = askCors(IMAGO_DEV_ORIGIN);
    expect(error?.message).toBe('Origin not allowed');
    expect(allow).toBeUndefined();
  });

  it('given no Origin header, should allow it (non-browser clients authenticate by token)', () => {
    process.env.CORS_ORIGIN = WEB_DEV_ORIGIN;
    expect(askCors(undefined)).toEqual({ error: null, allow: true });
  });

  it('given nothing configured, should allow any origin (the middleware decides)', () => {
    expect(askCors('https://anything.example')).toEqual({ error: null, allow: true });
  });
});

describe('validateAndLogWebSocketOrigin', () => {
  it('given the imago dev origin listed in ADDITIONAL_ALLOWED_ORIGINS, should accept the connection', () => {
    process.env.CORS_ORIGIN = WEB_DEV_ORIGIN;
    process.env.ADDITIONAL_ALLOWED_ORIGINS = IMAGO_DEV_ORIGIN;
    expect(validateAndLogWebSocketOrigin(IMAGO_DEV_ORIGIN, meta)).toBe(true);
  });

  it('given the imago dev origin not listed, should reject the connection', () => {
    process.env.CORS_ORIGIN = WEB_DEV_ORIGIN;
    expect(validateAndLogWebSocketOrigin(IMAGO_DEV_ORIGIN, meta)).toBe(false);
  });

  it('given no Origin header, should accept the connection', () => {
    process.env.CORS_ORIGIN = WEB_DEV_ORIGIN;
    expect(validateAndLogWebSocketOrigin(undefined, meta)).toBe(true);
  });

  it('given nothing configured outside production, should accept the connection', () => {
    process.env.NODE_ENV = 'development';
    expect(validateAndLogWebSocketOrigin(IMAGO_DEV_ORIGIN, meta)).toBe(true);
  });

  it('given nothing configured in production, should reject the connection', () => {
    process.env.NODE_ENV = 'production';
    expect(validateAndLogWebSocketOrigin(IMAGO_DEV_ORIGIN, meta)).toBe(false);
  });
});

describe('a real Socket.IO server with the realtime origin checks', () => {
  let http: HttpServer;
  let io: Server;
  let base: string;

  beforeEach(async () => {
    process.env.CORS_ORIGIN = WEB_DEV_ORIGIN;
    http = createServer();
    // The same two checks index.ts installs: Socket.IO CORS, then the
    // connection middleware's origin check (the token check that follows it
    // in index.ts is out of this test's scope, so any origin-valid socket is
    // admitted here).
    io = new Server(http, { cors: { origin: corsOrigin, credentials: true } });
    io.use((socket, next) => {
      const ok = validateAndLogWebSocketOrigin(socket.handshake.headers.origin, meta);
      next(ok ? undefined : new Error('Origin not allowed'));
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/socket.io/?EIO=4&transport=polling`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => io.close(() => resolve()));
  });

  /**
   * An Engine.IO v4 polling handshake followed by a Socket.IO CONNECT, sent
   * the way a browser on `origin` would. Returns the handshake's status and
   * CORS header, and the Socket.IO answer to CONNECT (null when the
   * handshake was refused and no session exists to connect on).
   */
  const handshake = async (
    origin: string,
  ): Promise<{ status: number; allowOrigin: string | null; connectReply: string | null }> => {
    const open = await fetch(base, { headers: { Origin: origin } });
    const allowOrigin = open.headers.get('access-control-allow-origin');
    const openBody = await open.text();
    if (!open.ok) return { status: open.status, allowOrigin, connectReply: null };
    const { sid } = JSON.parse(openBody.slice(1)) as { sid: string };
    const url = `${base}&sid=${sid}`;
    await fetch(url, { method: 'POST', headers: { Origin: origin }, body: '40' });
    const reply = await fetch(url, { headers: { Origin: origin } });
    return { status: open.status, allowOrigin, connectReply: await reply.text() };
  };

  it('given ADDITIONAL_ALLOWED_ORIGINS with the imago dev origin, should complete the handshake from it', async () => {
    process.env.ADDITIONAL_ALLOWED_ORIGINS = IMAGO_DEV_ORIGIN;
    const { status, allowOrigin, connectReply } = await handshake(IMAGO_DEV_ORIGIN);
    expect(status).toBe(200);
    expect(allowOrigin).toBe(IMAGO_DEV_ORIGIN);
    expect(connectReply).toMatch(/^40\{"sid":"[^"]+"\}$/);
  });

  it('given ADDITIONAL_ALLOWED_ORIGINS without it, should refuse the imago dev origin at the handshake', async () => {
    process.env.ADDITIONAL_ALLOWED_ORIGINS = 'https://admin.example.com';
    const { status, allowOrigin, connectReply } = await handshake(IMAGO_DEV_ORIGIN);
    expect(status).toBe(400);
    expect(allowOrigin).toBeNull();
    expect(connectReply).toBeNull();
  });

  it('given the CORS check passes, should still reject an unlisted origin in the connection middleware', async () => {
    // An empty allowlist lets CORS through; outside development the
    // middleware then fails closed.
    delete process.env.CORS_ORIGIN;
    process.env.NODE_ENV = 'production';
    const { status, connectReply } = await handshake(IMAGO_DEV_ORIGIN);
    expect(status).toBe(200);
    expect(connectReply).toBe('44{"message":"Origin not allowed"}');
  });
});
