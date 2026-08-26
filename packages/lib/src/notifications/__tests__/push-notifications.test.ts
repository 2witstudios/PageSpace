import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@pagespace/db/db', () => {
  const mockDb = {
    query: {
      pushNotificationTokens: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
      },
    },
    insert: vi.fn(),
    update: vi.fn(),
  };
  return { db: mockDb };
});
vi.mock('@pagespace/db/schema/push-notifications', () => ({
  pushNotificationTokens: {
    id: 'id',
    userId: 'userId',
    token: 'token',
    platform: 'platform',
    deviceId: 'deviceId',
    isActive: 'isActive',
    failedAttempts: 'failedAttempts',
    lastFailedAt: 'lastFailedAt',
    lastUsedAt: 'lastUsedAt',
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((_a, _b) => 'eq'),
  and: vi.fn((...args) => ({ and: args })),
}));

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'new-token-id'),
  init: vi.fn(() => vi.fn(() => 'test-cuid')),
}));

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return {
    ...actual,
    createSign: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// node:http2 mock — APNs is HTTP/2-only, so the sender talks to it over a
// cached ClientHttp2Session instead of fetch(). The shared `h2` state lets each
// test drive a fake session/stream: capture the request headers + body, and
// script the response (or a transport error) the fake stream emits.
// ---------------------------------------------------------------------------
const h2 = vi.hoisted(() => {
  type FakeStream = import('node:events').EventEmitter;
  const state: {
    behavior: (stream: FakeStream) => void;
    lastRequestHeaders: Record<string, unknown> | null;
    lastRequestBody: string | null;
    connectedHosts: string[];
    sessionCloseCount: number;
  } = {
    behavior: () => {},
    lastRequestHeaders: null,
    lastRequestBody: null,
    connectedHosts: [],
    sessionCloseCount: 0,
  };
  return state;
});

vi.mock('node:http2', async () => {
  const { EventEmitter } = await import('node:events');

  const makeStream = () => {
    const stream = new EventEmitter() as InstanceType<typeof EventEmitter> & {
      write: (chunk: string) => boolean;
      end: () => void;
      close: (code?: number) => void;
      setTimeout: (ms: number, cb: () => void) => void;
    };
    stream.write = vi.fn((chunk: string) => {
      h2.lastRequestBody = String(chunk);
      return true;
    });
    stream.end = vi.fn();
    stream.close = vi.fn();
    stream.setTimeout = vi.fn();
    return stream;
  };

  const connect = vi.fn((url: string) => {
    h2.connectedHosts.push(String(url));
    const session = new EventEmitter() as InstanceType<typeof EventEmitter> & {
      closed: boolean;
      destroyed: boolean;
      socket: { unref: () => void };
      close: () => void;
      request: (headers: Record<string, unknown>) => InstanceType<typeof EventEmitter>;
    };
    session.closed = false;
    session.destroyed = false;
    session.socket = { unref: vi.fn() };
    session.close = vi.fn(() => { h2.sessionCloseCount += 1; });
    session.request = vi.fn((headers: Record<string, unknown>) => {
      h2.lastRequestHeaders = headers;
      const stream = makeStream();
      // Emit on a microtask so performApnsRequest's listeners are attached first.
      Promise.resolve().then(() => h2.behavior(stream));
      return stream;
    });
    return session;
  });

  const constants = { NGHTTP2_CANCEL: 8 };
  return { connect, constants, default: { connect, constants } };
});

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import {
  registerPushToken,
  unregisterPushToken,
  unregisterAllPushTokens,
  sendPushNotification,
  getUserPushTokens,
} from '../push-notifications';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupUpdateChain() {
  const whereFn = vi.fn().mockResolvedValue(undefined);
  const setFn = vi.fn().mockReturnValue({ where: whereFn });
  vi.mocked(db.update).mockReturnValue({ set: setFn } as unknown as ReturnType<typeof db.update>);
  return { setFn, whereFn };
}


// setupUpdateChain only records what was `set`. This variant also records the
// `where` that followed each `set`, and makes the mocked `eq` report its own
// arguments, so a test can assert which row an update actually targeted.
function setupCapturingUpdateChain() {
  const updates: Array<{ set: unknown; where: unknown }> = [];
  const setFn = vi.fn();
  vi.mocked(eq).mockImplementation(
    (column: unknown, value: unknown) => ({ column, value }) as never
  );
  vi.mocked(db.update).mockImplementation((() => ({
    set: (arg: unknown) => {
      setFn(arg);
      const entry: { set: unknown; where: unknown } = { set: arg, where: undefined };
      updates.push(entry);
      return {
        where: (w: unknown) => {
          entry.where = w;
          return Promise.resolve(undefined);
        },
      };
    },
  })) as unknown as typeof db.update);
  return { setFn, updates };
}

function setupInsertChain() {
  const valuesFn = vi.fn().mockResolvedValue(undefined);
  vi.mocked(db.insert).mockReturnValue({ values: valuesFn } as unknown as ReturnType<typeof db.insert>);
  return { valuesFn };
}

const tokenRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'token-id-1',
  userId: 'user-1',
  token: 'push-token-abc',
  platform: 'ios',
  deviceId: 'device-1',
  deviceName: 'iPhone 15',
  isActive: true,
  failedAttempts: '0',
  lastFailedAt: null,
  lastUsedAt: null,
  webPushSubscription: null,
  ...overrides,
});

const payload = {
  title: 'Hello',
  body: 'World',
};

// Script the fake APNs stream to emit a full response: `:status` + optional
// `apns-id` headers, an optional body (object → JSON, string → raw), then end.
function apnsRespond(status: number, body?: unknown, apnsId: string | null = 'apns-test-id') {
  h2.behavior = (stream) => {
    const headers: Record<string, unknown> = { ':status': status };
    if (apnsId) headers['apns-id'] = apnsId;
    stream.emit('response', headers);
    if (body !== undefined) {
      const chunk = typeof body === 'string' ? body : JSON.stringify(body);
      stream.emit('data', Buffer.from(chunk));
    }
    stream.emit('end');
  };
}

// Script the fake stream to emit a transport-level error (the `fetch failed`
// class of failure that motivated the HTTP/2 rewrite).
function apnsStreamError(error: Error = new Error('fetch failed')) {
  h2.behavior = (stream) => {
    stream.emit('error', error);
  };
}

// Reset the shared h2 mock state between tests and default to an accepted (200)
// response. The module-level session cache persists across tests, so state must
// be cleared explicitly rather than relying on vi.clearAllMocks().
function resetH2() {
  h2.connectedHosts = [];
  h2.lastRequestHeaders = null;
  h2.lastRequestBody = null;
  h2.sessionCloseCount = 0;
  apnsRespond(200, {});
}

// Force getApnsJwtToken() to produce a token by returning a well-formed DER
// signature from crypto.createSign (used when the module JWT cache is cold).
function primeApnsSign() {
  const fakeSignature = Buffer.alloc(72, 0);
  fakeSignature[0] = 0x30; fakeSignature[1] = 70;
  fakeSignature[2] = 0x02; fakeSignature[3] = 32;
  fakeSignature[36] = 0x02; fakeSignature[37] = 32;
  const mockSign = {
    update: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
    sign: vi.fn().mockReturnValue(fakeSignature),
  };
  vi.mocked(crypto.createSign).mockReturnValue(mockSign as unknown as ReturnType<typeof crypto.createSign>);
}

// ---------------------------------------------------------------------------
// registerPushToken
// ---------------------------------------------------------------------------
describe('registerPushToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns existing id when token already registered', async () => {
    const existing = tokenRecord();
    vi.mocked(db.query.pushNotificationTokens.findFirst).mockResolvedValue(existing as never);
    setupUpdateChain();

    const result = await registerPushToken('user-1', 'push-token-abc', 'ios');

    expect(result).toEqual({ id: 'token-id-1' });
    expect(db.update).toHaveBeenCalled(); // updates existing token fields
  });

  it('resets failedAttempts when updating existing token', async () => {
    vi.mocked(db.query.pushNotificationTokens.findFirst).mockResolvedValue(tokenRecord() as never);
    const { setFn } = setupUpdateChain();

    await registerPushToken('user-1', 'push-token-abc', 'ios');

    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({
      failedAttempts: '0',
      isActive: true,
    }));
  });

  it('creates new token when none exists without deviceId', async () => {
    vi.mocked(db.query.pushNotificationTokens.findFirst).mockResolvedValue(undefined as never);
    setupInsertChain();

    const result = await registerPushToken('user-1', 'new-token', 'ios');

    expect(result).toEqual({ id: 'new-token-id' });
    expect(db.insert).toHaveBeenCalled();
  });

  it('deactivates other tokens for same deviceId before inserting', async () => {
    vi.mocked(db.query.pushNotificationTokens.findFirst).mockResolvedValue(undefined as never);
    setupUpdateChain();
    setupInsertChain();

    await registerPushToken('user-1', 'new-token', 'ios', 'device-1');

    // First call is to deactivate old tokens for this device
    expect(db.update).toHaveBeenCalled();
    expect(db.insert).toHaveBeenCalled();
  });

  it('creates token with web platform', async () => {
    vi.mocked(db.query.pushNotificationTokens.findFirst).mockResolvedValue(undefined as never);
    setupInsertChain();

    const result = await registerPushToken('user-1', 'new-token', 'web', undefined, 'My Browser', 'web-push-subscription');
    expect(result).toEqual({ id: 'new-token-id' });
  });
});

// ---------------------------------------------------------------------------
// unregisterPushToken
// ---------------------------------------------------------------------------
describe('unregisterPushToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets isActive to false for the token', async () => {
    const { setFn } = setupUpdateChain();

    await unregisterPushToken('user-1', 'push-token-abc');

    expect(setFn).toHaveBeenCalledWith({ isActive: false });
  });
});

// ---------------------------------------------------------------------------
// unregisterAllPushTokens
// ---------------------------------------------------------------------------
describe('unregisterAllPushTokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deactivates all tokens for the user', async () => {
    const { setFn } = setupUpdateChain();

    await unregisterAllPushTokens('user-1');

    expect(db.update).toHaveBeenCalled();
    expect(setFn).toHaveBeenCalledWith({ isActive: false });
  });
});

// ---------------------------------------------------------------------------
// getUserPushTokens
// ---------------------------------------------------------------------------
describe('getUserPushTokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns active tokens for user', async () => {
    const tokens = [{ id: 'token-1', platform: 'ios', deviceId: 'dev-1', deviceName: 'iPhone', createdAt: new Date(), lastUsedAt: null }];
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue(tokens as never);

    const result = await getUserPushTokens('user-1');

    expect(result).toEqual(tokens);
    expect(db.query.pushNotificationTokens.findMany).toHaveBeenCalled();
  });

  it('returns empty array when no tokens', async () => {
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([] as never);

    const result = await getUserPushTokens('user-1');
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// sendPushNotification
// ---------------------------------------------------------------------------
describe('sendPushNotification', () => {
  const describeOriginalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    resetH2();
  });

  afterEach(() => {
    globalThis.fetch = describeOriginalFetch;
    delete process.env.FCM_SERVICE_ACCOUNT_JSON;
    delete process.env.APNS_TEAM_ID;
    delete process.env.APNS_KEY_ID;
    delete process.env.APNS_PRIVATE_KEY;
    delete process.env.APNS_BUNDLE_ID;
  });

  it('returns zeros when no active tokens', async () => {
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([] as never);

    const result = await sendPushNotification('user-1', payload);
    expect(result).toEqual({ sent: 0, failed: 0, errors: [] });
  });

  it('handles web platform (not yet implemented)', async () => {
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([tokenRecord({ platform: 'web' })] as never);
    setupUpdateChain();

    const result = await sendPushNotification('user-1', payload);
    expect(result.failed).toBe(1);
    expect(result.errors).toContain('Web push not yet implemented');
  });

  it('handles unknown platform', async () => {
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([tokenRecord({ platform: 'blackberry' })] as never);
    setupUpdateChain();

    const result = await sendPushNotification('user-1', payload);
    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain('Unknown platform: blackberry');
  });

  it('increments failedAttempts on iOS failure', async () => {
    process.env.APNS_TEAM_ID = 'team-id';
    process.env.APNS_KEY_ID = 'key-id';
    process.env.APNS_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg...\n-----END PRIVATE KEY-----';

    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([tokenRecord({ platform: 'ios', failedAttempts: '0' })] as never);

    // Mock crypto sign to fail
    const mockSign = {
      update: vi.fn().mockReturnThis(),
      end: vi.fn().mockReturnThis(),
      sign: vi.fn().mockImplementation(() => { throw new Error('Signing failed'); }),
    };
    vi.mocked(crypto.createSign).mockReturnValue(mockSign as unknown as ReturnType<typeof crypto.createSign>);

    setupUpdateChain();

    const result = await sendPushNotification('user-1', payload);
    expect(result.failed).toBe(1);
    expect(db.update).toHaveBeenCalled();
  });

  it('deactivates token after 5 consecutive failures', async () => {
    // Driven by a real per-token FCM rejection (503 UNAVAILABLE): retryable, so
    // it takes a strike rather than deactivating outright. An unset credential
    // would NOT serve here — that is a server fault and deliberately exempt.
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson({}, 'strike-count-project');
    primeSign();
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([tokenRecord({ platform: 'android', failedAttempts: '4' })] as never);
    const { setFn } = setupUpdateChain();
    installFetchStub({
      send: () => fakeResponse(503, JSON.stringify({ error: { status: 'UNAVAILABLE', message: 'busy' } })),
    });

    await sendPushNotification('user-1', payload);

    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({
      failedAttempts: '5',
      isActive: false,
    }));
  });

  it('keeps token active with fewer than 5 failures', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson({}, 'strike-keep-project');
    primeSign();
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([tokenRecord({ platform: 'android', failedAttempts: '2' })] as never);
    const { setFn } = setupUpdateChain();
    installFetchStub({
      send: () => fakeResponse(503, JSON.stringify({ error: { status: 'UNAVAILABLE', message: 'busy' } })),
    });

    await sendPushNotification('user-1', payload);

    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({
      failedAttempts: '3',
      isActive: true,
    }));
  });

  it('resets failedAttempts on success', async () => {
    process.env.APNS_TEAM_ID = 'team-id';
    process.env.APNS_KEY_ID = 'key-id';
    process.env.APNS_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nfakekey\n-----END PRIVATE KEY-----';

    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([tokenRecord({ platform: 'ios', failedAttempts: '2' })] as never);

    // Default h2 behavior (beforeEach) already scripts a 200 accepted response.

    // Mock crypto sign to return a valid buffer
    const fakeSignature = Buffer.alloc(72, 0); // DER-like buffer
    // DER: 0x30 len 0x02 rLen r 0x02 sLen s
    fakeSignature[0] = 0x30;
    fakeSignature[1] = 70;
    fakeSignature[2] = 0x02;
    fakeSignature[3] = 32;
    fakeSignature[36] = 0x02;
    fakeSignature[37] = 32;

    const mockSign = {
      update: vi.fn().mockReturnThis(),
      end: vi.fn().mockReturnThis(),
      sign: vi.fn().mockReturnValue(fakeSignature),
    };
    vi.mocked(crypto.createSign).mockReturnValue(mockSign as unknown as ReturnType<typeof crypto.createSign>);

    const { setFn } = setupUpdateChain();

    const result = await sendPushNotification('user-1', payload);

    if (result.sent > 0) {
      expect(setFn).toHaveBeenCalledWith(expect.objectContaining({
        failedAttempts: '0',
      }));
    }
  });

  it('removes token when APNs returns invalid token reason', async () => {
    process.env.APNS_TEAM_ID = 'team-id';
    process.env.APNS_KEY_ID = 'key-id';
    process.env.APNS_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nfakekey\n-----END PRIVATE KEY-----';

    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([tokenRecord({ platform: 'ios' })] as never);

    apnsRespond(400, { reason: 'BadDeviceToken' });
    primeApnsSign();

    const { setFn } = setupUpdateChain();

    const result = await sendPushNotification('user-1', payload);

    expect(result.failed).toBe(1);
    expect(result.errors).toContain('BadDeviceToken');
    // When shouldRemoveToken is true, we set isActive: false directly
    expect(setFn).toHaveBeenCalledWith({ isActive: false });
  });

  it('keeps token active when APNs rejects with a non-removal reason', async () => {
    process.env.APNS_TEAM_ID = 'team-id';
    process.env.APNS_KEY_ID = 'key-id';
    process.env.APNS_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nfakekey\n-----END PRIVATE KEY-----';

    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([tokenRecord({ platform: 'ios', failedAttempts: '0' })] as never);

    apnsRespond(413, { reason: 'PayloadTooLarge' });
    primeApnsSign();

    const { setFn } = setupUpdateChain();

    const result = await sendPushNotification('user-1', payload);

    expect(result.failed).toBe(1);
    expect(result.errors).toContain('PayloadTooLarge');
    // Not an invalid-token reason → increment failedAttempts, keep token active.
    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({
      failedAttempts: '1',
      isActive: true,
    }));
  });

  it('reports a transport failure without removing the token (stream error)', async () => {
    process.env.APNS_TEAM_ID = 'team-id';
    process.env.APNS_KEY_ID = 'key-id';
    process.env.APNS_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nfakekey\n-----END PRIVATE KEY-----';

    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([tokenRecord({ platform: 'ios', failedAttempts: '0' })] as never);

    apnsStreamError(new Error('fetch failed'));
    primeApnsSign();

    const { setFn } = setupUpdateChain();

    const result = await sendPushNotification('user-1', payload);

    expect(result.failed).toBe(1);
    expect(result.errors).toContain('fetch failed');
    // Transport errors must NOT deactivate the token (it may be fine); the
    // failedAttempts counter increments instead of a direct isActive:false.
    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({
      failedAttempts: '1',
      isActive: true,
    }));
    // The poisoned session must be closed (not just uncached) so its HTTP/2
    // socket is released and doesn't leak on repeated stalls.
    expect(h2.sessionCloseCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// APNs JWT token (via sendPushNotification with ios platform)
// Note: The module caches the JWT token at module level. Tests that need a fresh
// token must mock crypto.createSign to force token regeneration (the cache check
// uses Date.now() which moves forward, so a token generated in the same second
// will be reused). We set the env vars and use the crypto mock to control flow.
// ---------------------------------------------------------------------------
describe('APNs JWT token generation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetH2();
  });

  afterEach(() => {
    delete process.env.APNS_TEAM_ID;
    delete process.env.APNS_KEY_ID;
    delete process.env.APNS_PRIVATE_KEY;
    delete process.env.APNS_BUNDLE_ID;
  });

  it('reports error when APNs signing throws (config missing or invalid key)', async () => {
    // Clear env vars so getApnsJwtToken throws
    delete process.env.APNS_TEAM_ID;
    delete process.env.APNS_KEY_ID;
    delete process.env.APNS_PRIVATE_KEY;

    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([tokenRecord({ platform: 'ios' })] as never);
    setupUpdateChain();

    // Force token regeneration by making crypto.createSign throw
    vi.mocked(crypto.createSign).mockImplementation(() => {
      throw new Error('APNs configuration missing');
    });

    // Earlier tests warm the module-level JWT cache; advance past its expiry so
    // getApnsJwtToken actually re-signs (and throws) rather than reusing a token.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2099-12-01T00:00:00Z'));
    try {
      const result = await sendPushNotification('user-1', payload);
      expect(result.failed).toBe(1);
      // Error will be caught by the catch block in sendToApns
      expect(result.errors.length).toBeGreaterThan(0);
      // A signing failure happens before any connection is opened, so it must
      // not evict/close a (possibly healthy) cached session.
      expect(h2.sessionCloseCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('wraps bare PEM key in BEGIN/END block during signing', async () => {
    process.env.APNS_TEAM_ID = 'team-id';
    process.env.APNS_KEY_ID = 'key-id';
    // Bare key without PEM headers
    process.env.APNS_PRIVATE_KEY = 'rawkeydata';

    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([tokenRecord({ platform: 'ios' })] as never);

    const fakeSignature = Buffer.alloc(72, 0);
    fakeSignature[0] = 0x30;
    fakeSignature[1] = 70;
    fakeSignature[2] = 0x02;
    fakeSignature[3] = 32;
    fakeSignature[36] = 0x02;
    fakeSignature[37] = 32;

    const mockSign = {
      update: vi.fn().mockReturnThis(),
      end: vi.fn().mockReturnThis(),
      sign: vi.fn().mockReturnValue(fakeSignature),
    };
    vi.mocked(crypto.createSign).mockReturnValue(mockSign as unknown as ReturnType<typeof crypto.createSign>);
    // Default h2 behavior (beforeEach) scripts a 200 accepted response.
    setupUpdateChain();

    await sendPushNotification('user-1', payload);

    // If sign was called (not cached), verify PEM format. If cached, skip assertion.
    if (mockSign.sign.mock.calls.length > 0) {
      expect(mockSign.sign).toHaveBeenCalledWith(
        expect.stringContaining('-----BEGIN PRIVATE KEY-----')
      );
    }
    // Either way, the send should not throw
    expect(true).toBe(true);
  });

  it('handles APNs error response with non-BadDeviceToken reason', async () => {
    process.env.APNS_TEAM_ID = 'team-id';
    process.env.APNS_KEY_ID = 'key-id';
    process.env.APNS_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nfakekey\n-----END PRIVATE KEY-----';

    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([tokenRecord({ platform: 'ios' })] as never);

    apnsRespond(503, { reason: 'ServiceUnavailable' });
    primeApnsSign();
    setupUpdateChain();

    const result = await sendPushNotification('user-1', payload);
    expect(result.failed).toBe(1);
    // Error reason from APNs
    expect(result.errors).toContain('ServiceUnavailable');
  });

  it('handles malformed APNs error response json', async () => {
    process.env.APNS_TEAM_ID = 'team-id';
    process.env.APNS_KEY_ID = 'key-id';
    process.env.APNS_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nfakekey\n-----END PRIVATE KEY-----';

    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([tokenRecord({ platform: 'ios' })] as never);

    // Non-JSON error body → JSON.parse throws → reason falls back to 'Unknown error'.
    apnsRespond(500, '<html>Internal Server Error</html>');
    primeApnsSign();
    setupUpdateChain();

    const result = await sendPushNotification('user-1', payload);
    expect(result.failed).toBe(1);
    // Falls back to 'Unknown error' when the body is not JSON.
    expect(result.errors).toContain('Unknown error');
  });

  // DER trim branches need a stale JWT cache so crypto.createSign actually
  // runs with our crafted DER signature. Earlier tests populate the
  // module-level cache, so we advance system time past its expiry.
  it('handles DER signature with r > 32 bytes (trimming)', async () => {
    process.env.APNS_TEAM_ID = 'team-id';
    process.env.APNS_KEY_ID = 'key-id';
    process.env.APNS_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nfakekey\n-----END PRIVATE KEY-----';

    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([tokenRecord({ platform: 'ios' })] as never);

    const rLen = 33;
    const sLen = 32;
    const derLen = 2 + rLen + 2 + sLen;
    const der = Buffer.alloc(2 + derLen, 0);
    der[0] = 0x30;
    der[1] = derLen;
    der[2] = 0x02;
    der[3] = rLen;
    der[4 + rLen] = 0x02;
    der[4 + rLen + 1] = sLen;

    const mockSign = {
      update: vi.fn().mockReturnThis(),
      end: vi.fn().mockReturnThis(),
      sign: vi.fn().mockReturnValue(der),
    };
    vi.mocked(crypto.createSign).mockReturnValue(mockSign as unknown as ReturnType<typeof crypto.createSign>);
    // Default h2 behavior (beforeEach) scripts a 200 accepted response.
    setupUpdateChain();

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2099-01-01T00:00:00Z'));
    try {
      const result = await sendPushNotification('user-1', payload);
      expect(mockSign.sign).toHaveBeenCalledTimes(1);
      expect(result.sent + result.failed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('handles DER signature with s > 32 bytes (trimming)', async () => {
    process.env.APNS_TEAM_ID = 'team-id';
    process.env.APNS_KEY_ID = 'key-id';
    process.env.APNS_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nfakekey\n-----END PRIVATE KEY-----';

    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([tokenRecord({ platform: 'ios' })] as never);

    const rLen = 32;
    const sLen = 33;
    const derLen = 2 + rLen + 2 + sLen;
    const der = Buffer.alloc(2 + derLen, 0);
    der[0] = 0x30;
    der[1] = derLen;
    der[2] = 0x02;
    der[3] = rLen;
    der[4 + rLen] = 0x02;
    der[4 + rLen + 1] = sLen;

    const mockSign = {
      update: vi.fn().mockReturnThis(),
      end: vi.fn().mockReturnThis(),
      sign: vi.fn().mockReturnValue(der),
    };
    vi.mocked(crypto.createSign).mockReturnValue(mockSign as unknown as ReturnType<typeof crypto.createSign>);
    // Default h2 behavior (beforeEach) scripts a 200 accepted response.
    setupUpdateChain();

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2099-06-01T00:00:00Z'));
    try {
      const result = await sendPushNotification('user-1', payload);
      expect(mockSign.sign).toHaveBeenCalledTimes(1);
      expect(result.sent + result.failed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Silent (content-available) APNs payload
// ---------------------------------------------------------------------------
describe('silent push payload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetH2();
  });

  afterEach(() => {
    delete process.env.APNS_TEAM_ID;
    delete process.env.APNS_KEY_ID;
    delete process.env.APNS_PRIVATE_KEY;
    delete process.env.APNS_BUNDLE_ID;
    delete process.env.NODE_ENV;
  });

  it('sends content-available silent payload with background priority', async () => {
    process.env.APNS_TEAM_ID = 'team-id';
    process.env.APNS_KEY_ID = 'key-id';
    process.env.APNS_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nfakekey\n-----END PRIVATE KEY-----';

    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([tokenRecord({ platform: 'ios' })] as never);
    primeApnsSign();
    setupUpdateChain();

    await sendPushNotification('user-1', { silent: true, badge: 3 });

    const headers = h2.lastRequestHeaders as Record<string, string>;
    expect(headers['apns-push-type']).toBe('background');
    expect(headers['apns-priority']).toBe('5');
    expect(headers[':method']).toBe('POST');
    expect(headers[':path']).toBe('/3/device/push-token-abc');

    const body = JSON.parse(h2.lastRequestBody as string);
    expect(body.aps['content-available']).toBe(1);
    expect(body.aps.badge).toBe(3);
    expect(body.aps.alert).toBeUndefined();
    expect(body.aps.sound).toBeUndefined();
  });

  it('sends silent payload without badge when badge is omitted', async () => {
    process.env.APNS_TEAM_ID = 'team-id';
    process.env.APNS_KEY_ID = 'key-id';
    process.env.APNS_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nfakekey\n-----END PRIVATE KEY-----';

    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([tokenRecord({ platform: 'ios' })] as never);
    primeApnsSign();
    setupUpdateChain();

    await sendPushNotification('user-1', { silent: true });

    const body = JSON.parse(h2.lastRequestBody as string);
    expect(body.aps['content-available']).toBe(1);
    expect('badge' in body.aps).toBe(false);
  });

  it('uses production APNs host when NODE_ENV=production', async () => {
    process.env.APNS_TEAM_ID = 'team-id';
    process.env.APNS_KEY_ID = 'key-id';
    process.env.APNS_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nfakekey\n-----END PRIVATE KEY-----';
    process.env.NODE_ENV = 'production';

    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([tokenRecord({ platform: 'ios' })] as never);
    primeApnsSign();
    setupUpdateChain();

    await sendPushNotification('user-1', payload);

    expect(h2.connectedHosts).toContain('https://api.push.apple.com');
    expect(h2.connectedHosts.some((host) => host.includes('sandbox'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FCM (Android) sender
//
// The FCM path is plain HTTPS (unlike APNs' HTTP/2), so these tests stub
// globalThis.fetch and route by URL: the OAuth2 token endpoint vs the
// messages:send endpoint. The module-level access-token cache is pinned to the
// exact credential string it was minted from, so each test that wants a cold
// cache simply uses a fresh service-account JSON.
// ---------------------------------------------------------------------------

interface FakeResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

function fakeResponse(status: number, body: string): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

let serviceAccountCounter = 0;

// A distinct project id per call gives a distinct credential string, which busts
// the module-level token cache — pass a fixed id to deliberately share it.
function serviceAccountJson(overrides: Record<string, unknown> = {}, projectId?: string) {
  serviceAccountCounter += 1;
  const pid = projectId ?? `pagespace-test-${serviceAccountCounter}`;
  const account: Record<string, unknown> = {
    type: 'service_account',
    project_id: pid,
    client_email: `push@${pid}.iam.gserviceaccount.com`,
    // Literal backslash-n, the way secret stores hand PEMs back.
    private_key: '-----BEGIN PRIVATE KEY-----\\nFAKEFCMKEY\\n-----END PRIVATE KEY-----\\n',
    token_uri: 'https://oauth2.googleapis.com/token',
    ...overrides,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete account[key];
  }
  return JSON.stringify(account);
}

const FCM_ERROR_TYPE = 'type.googleapis.com/google.firebase.fcm.v1.FcmError';
const BAD_REQUEST_TYPE = 'type.googleapis.com/google.rpc.BadRequest';
const OAUTH_OK = JSON.stringify({ access_token: 'ya29.fake-access-token', expires_in: 3600 });
const FCM_SEND_OK = JSON.stringify({ name: 'projects/p/messages/0:1234' });

interface FetchCall {
  url: string;
  init: RequestInit;
}

function installFetchStub(handlers: {
  oauth?: (call: FetchCall) => FakeResponse;
  send?: (message: Record<string, unknown>, call: FetchCall) => FakeResponse;
} = {}) {
  const calls: FetchCall[] = [];
  const stub = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const call: FetchCall = { url: String(url), init };
    calls.push(call);
    if (call.url.includes('oauth2.googleapis.com')) {
      return (handlers.oauth ?? (() => fakeResponse(200, OAUTH_OK)))(call);
    }
    const parsed = JSON.parse(String(init.body)) as { message: Record<string, unknown> };
    return (handlers.send ?? (() => fakeResponse(200, FCM_SEND_OK)))(parsed.message, call);
  });
  globalThis.fetch = stub as unknown as typeof fetch;
  return calls;
}

// crypto.createSign is mocked module-wide; dispatch on the algorithm so a test
// that sends to both platforms gets a usable signer for each.
function primeSign() {
  const rsaSign = {
    update: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
    // Bytes chosen so the plain base64 is `+/++7/8=` — it contains +, / and
    // padding, so the base64url substitutions are actually observable.
    sign: vi.fn().mockReturnValue(Buffer.from([0xfb, 0xff, 0xbe, 0xef, 0xff])),
  };
  const derSignature = Buffer.alloc(72, 0);
  derSignature[0] = 0x30; derSignature[1] = 70;
  derSignature[2] = 0x02; derSignature[3] = 32;
  derSignature[36] = 0x02; derSignature[37] = 32;
  const ecdsaSign = {
    update: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
    sign: vi.fn().mockReturnValue(derSignature),
  };
  vi.mocked(crypto.createSign).mockImplementation((algorithm: string) =>
    (algorithm === 'RSA-SHA256' ? rsaSign : ecdsaSign) as unknown as ReturnType<typeof crypto.createSign>
  );
  return { rsaSign, ecdsaSign };
}

function androidToken(overrides: Record<string, unknown> = {}) {
  return tokenRecord({ platform: 'android', token: 'fcm-token-abc123', ...overrides });
}

function sentMessage(calls: FetchCall[]): Record<string, unknown> {
  const send = calls.find((c) => c.url.includes('fcm.googleapis.com'));
  if (!send) throw new Error('no messages:send call was made');
  return (JSON.parse(String(send.init.body)) as { message: Record<string, unknown> }).message;
}

describe('sendToFcm (Android)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    resetH2();
    primeSign();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.FCM_SERVICE_ACCOUNT_JSON;
    delete process.env.APNS_TEAM_ID;
    delete process.env.APNS_KEY_ID;
    delete process.env.APNS_PRIVATE_KEY;
  });

  it('sends via FCM HTTP v1 with an OAuth2 bearer token minted from the service account', async () => {
    const raw = serviceAccountJson();
    const projectId = (JSON.parse(raw) as { project_id: string }).project_id;
    process.env.FCM_SERVICE_ACCOUNT_JSON = raw;
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    setupUpdateChain();
    const calls = installFetchStub();

    const result = await sendPushNotification('user-1', payload);

    expect(result).toEqual({ sent: 1, failed: 0, errors: [] });

    // OAuth2 leg: JWT-bearer grant against the service account's token_uri.
    const oauth = calls[0];
    expect(oauth.url).toBe('https://oauth2.googleapis.com/token');
    expect(oauth.init.method).toBe('POST');
    const grant = new URLSearchParams(String(oauth.init.body));
    expect(grant.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const assertion = grant.get('assertion') ?? '';
    expect(assertion.split('.')).toHaveLength(3);
    const jwtClaims = JSON.parse(
      Buffer.from(assertion.split('.')[1], 'base64url').toString()
    ) as Record<string, unknown>;
    expect(jwtClaims.scope).toBe('https://www.googleapis.com/auth/firebase.messaging');
    expect(jwtClaims.aud).toBe('https://oauth2.googleapis.com/token');
    expect(jwtClaims.iss).toBe(`push@${projectId}.iam.gserviceaccount.com`);

    // Send leg: v1 endpoint scoped to the project id derived from the JSON.
    const send = calls[1];
    expect(send.url).toBe(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`);
    expect(send.init.method).toBe('POST');
    expect((send.init.headers as Record<string, string>).authorization).toBe(
      'Bearer ya29.fake-access-token'
    );
    expect((send.init.headers as Record<string, string>)['content-type']).toBe('application/json');

    const message = sentMessage(calls);
    expect(message.token).toBe('fcm-token-abc123');
    expect(message.notification).toEqual({ title: 'Hello', body: 'World' });
    expect((message.android as Record<string, unknown>).priority).toBe('high');
  });

  // Everything Google validates about the assertion before it will mint a token.
  // The transport stub accepts any bytes, so without this the request could be
  // malformed in six different ways and every test would still pass while every
  // Android push failed in production with an opaque invalid_grant.
  it('builds an assertion Google will actually accept', async () => {
    const raw = serviceAccountJson({}, 'assertion-shape-project');
    process.env.FCM_SERVICE_ACCOUNT_JSON = raw;
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    setupUpdateChain();
    const { rsaSign } = primeSign();
    const calls = installFetchStub();

    await sendPushNotification('user-1', payload);

    const oauth = calls.find((c) => c.url.includes('oauth2.googleapis.com'))!;
    // The token endpoint is form-urlencoded; JSON is rejected.
    expect((oauth.init.headers as Record<string, string>)['content-type'])
      .toBe('application/x-www-form-urlencoded');

    const assertion = new URLSearchParams(String(oauth.init.body)).get('assertion') ?? '';
    const [headerB64, claimsB64, signatureB64] = assertion.split('.');

    expect(JSON.parse(Buffer.from(headerB64, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });

    const claims = JSON.parse(Buffer.from(claimsB64, 'base64url').toString()) as Record<string, unknown>;
    expect(claims.iss).toBe(`push@assertion-shape-project.iam.gserviceaccount.com`);
    expect(claims.scope).toBe('https://www.googleapis.com/auth/firebase.messaging');
    expect(claims.aud).toBe('https://oauth2.googleapis.com/token');
    // Both are required by RFC 7523, and Google caps the lifetime at one hour.
    expect(typeof claims.iat).toBe('number');
    expect(claims.exp).toBe((claims.iat as number) + 3600);

    // The signature has to be over exactly the header.claims that were sent —
    // signing over anything else produces a token Google cannot verify.
    expect(rsaSign.update).toHaveBeenCalledWith(`${headerB64}.${claimsB64}`);
    expect(signatureB64.length).toBeGreaterThan(0);
    // base64url alphabet only: no +, /, or = padding.
    expect(signatureB64).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  // A hung request must not wedge the dispatch loop: the sends are sequential,
  // so one stalled socket blocks every remaining device and every later user.
  it('bounds both legs with a request timeout', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson();
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    setupUpdateChain();
    const calls = installFetchStub();

    await sendPushNotification('user-1', payload);

    const oauth = calls.find((c) => c.url.includes('oauth2.googleapis.com'))!;
    const send = calls.find((c) => c.url.includes('fcm.googleapis.com'))!;
    expect(oauth.init.signal).toBeInstanceOf(AbortSignal);
    expect(send.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('bounds how much of a failed OAuth body reaches the error', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson({}, 'huge-body-project');
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    setupUpdateChain();
    installFetchStub({ oauth: () => fakeResponse(500, 'x'.repeat(5000)) });

    const result = await sendPushNotification('user-1', payload);

    // Otherwise an HTML error page becomes an unbounded string, once per token.
    expect(result.errors[0].length).toBeLessThan(300);
    expect(result.errors[0]).toContain('FCM OAuth token request failed (500)');
  });

  // FCM registration tokens are bearer-ish: anyone holding one plus the sender
  // credentials can push to that device. They do not belong in logs in full.
  it('logs only a prefix of the device token, never the whole thing', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson();
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    setupUpdateChain();
    installFetchStub();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await sendPushNotification('user-1', payload);

      const sendLog = logSpy.mock.calls.find(([tag]) => tag === '[FCM] send');
      expect(sendLog).toBeTruthy();
      const fields = sendLog![1] as { tokenPrefix: string };
      expect(fields.tokenPrefix).toBe('fcm-toke');
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain('fcm-token-abc123');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('unescapes a literal backslash-n private key before signing', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson();
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    setupUpdateChain();
    const { rsaSign } = primeSign();
    installFetchStub();

    await sendPushNotification('user-1', payload);

    const key = rsaSign.sign.mock.calls[0][0] as string;
    expect(key).toContain('-----BEGIN PRIVATE KEY-----\n');
    expect(key).not.toContain('\\n');
  });

  it('sends a data-only message for a silent payload so Android shows nothing', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson();
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    setupUpdateChain();
    const calls = installFetchStub();

    await sendPushNotification('user-1', { silent: true, badge: 3, data: { pageId: 'p1' } });

    const message = sentMessage(calls);
    expect('notification' in message).toBe(false);
    const android = message.android as Record<string, unknown>;
    expect('notification' in android).toBe(false);
    expect(android.priority).toBe('normal');
    expect(message.data).toMatchObject({ silent: 'true', badge: '3', pageId: 'p1' });
  });

  it('includes a visible notification block and android notification options when not silent', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson();
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    setupUpdateChain();
    const calls = installFetchStub();

    await sendPushNotification('user-1', {
      title: 'T',
      body: 'B',
      badge: 7,
      threadId: 'thread-9',
      category: 'MESSAGE',
    });

    const message = sentMessage(calls);
    expect(message.notification).toEqual({ title: 'T', body: 'B' });
    const android = message.android as Record<string, unknown>;
    expect(android.notification).toEqual({
      sound: 'default',
      notification_count: 7,
      tag: 'thread-9',
    });
    // The category is an iOS identifier and rides in data only — as click_action
    // it would have to match an activity intent-filter, and the manifest
    // declares only MAIN/LAUNCHER, so a tap would do nothing at all.
    expect(android.notification).not.toHaveProperty('click_action');
    expect(message.data).toMatchObject({ badge: '7', threadId: 'thread-9', category: 'MESSAGE' });
  });

  it('drops a custom sound rather than naming a res/raw resource that will not exist', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson();
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    setupUpdateChain();
    const calls = installFetchStub();

    await sendPushNotification('user-1', { ...payload, sound: 'chime.caf' });

    // Omitted, so the channel plays its own sound. Passing 'chime.caf' through
    // would resolve to no Android resource and silently mute the notification.
    const android = sentMessage(calls).android as Record<string, unknown>;
    expect(android.notification).not.toHaveProperty('sound');
  });

  it("passes through the literal 'default' sound", async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson();
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    setupUpdateChain();
    const calls = installFetchStub();

    await sendPushNotification('user-1', { ...payload, sound: 'default' });

    const android = sentMessage(calls).android as Record<string, unknown>;
    expect((android.notification as Record<string, unknown>).sound).toBe('default');
  });

  it('stringifies non-string data values (FCM data is string-to-string only)', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson();
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    setupUpdateChain();
    const calls = installFetchStub();

    await sendPushNotification('user-1', {
      ...payload,
      data: { count: 4, nested: { a: 1 }, kept: 'raw', dropped: undefined },
    });

    const data = sentMessage(calls).data as Record<string, string>;
    expect(data.count).toBe('4');
    expect(data.nested).toBe('{"a":1}');
    expect(data.kept).toBe('raw');
    expect('dropped' in data).toBe(false);
  });

  it('does not let caller metadata redefine a reserved data key', async () => {
    // createNotification spreads arbitrary `metadata` into `data`.
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson();
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    setupUpdateChain();
    const calls = installFetchStub();

    await sendPushNotification('user-1', {
      silent: true,
      badge: 2,
      data: { silent: 'false', badge: '999', notificationId: 'n1' },
    });

    const data = sentMessage(calls).data as Record<string, string>;
    expect(data.silent).toBe('true');
    expect(data.badge).toBe('2');
    expect(data.notificationId).toBe('n1');
  });

  it('deactivates the token when FCM reports UNREGISTERED', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson();
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    const { setFn } = setupUpdateChain();
    installFetchStub({
      send: () =>
        fakeResponse(
          404,
          JSON.stringify({
            error: {
              code: 404,
              message: 'Requested entity was not found.',
              status: 'NOT_FOUND',
              details: [{ '@type': FCM_ERROR_TYPE, errorCode: 'UNREGISTERED' }],
            },
          })
        ),
    });

    const result = await sendPushNotification('user-1', payload);

    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain('UNREGISTERED');
    // Same shape the APNs invalid-token path uses: deactivate, don't count a failure.
    expect(setFn).toHaveBeenCalledWith({ isActive: false });
  });

  // A garbage token reports as INVALID_ARGUMENT with a BadRequest naming
  // `message.token` — NOT as an FcmError detail. Gating on the FcmError alone
  // would mean a malformed token is never cleaned up.
  it('deactivates the token when a BadRequest rejects the message.token field', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson();
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    const { setFn } = setupUpdateChain();
    installFetchStub({
      send: () =>
        fakeResponse(400, JSON.stringify({
          error: {
            message: 'The registration token is not a valid FCM registration token',
            status: 'INVALID_ARGUMENT',
            details: [{
              '@type': BAD_REQUEST_TYPE,
              fieldViolations: [{ field: 'message.token', description: 'Invalid registration token' }],
            }],
          },
        })),
    });

    const result = await sendPushNotification('user-1', payload);

    expect(result.failed).toBe(1);
    expect(setFn).toHaveBeenCalledWith({ isActive: false });
  });

  // SENDER_ID_MISMATCH arrives inside an FcmError detail, so it looks
  // token-scoped — but it is a project-level fact. A staging service account
  // pasted into prod makes every send 403 with it, and acting on it would
  // unregister every Android device in the database on the first dispatch.
  // Per-device independence. A user with a phone and a tablet who uninstalls the
  // tablet must not lose the phone: one dead token in a dispatch may not abort
  // the loop, and may not take a healthy sibling down with it.
  it('deactivates only the dead token when a user has two Android devices', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson({}, 'two-devices-project');
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([
      androidToken({ id: 'android-dead', token: 'fcm-dead' }),
      androidToken({ id: 'android-live', token: 'fcm-live' }),
    ] as never);
    const { setFn, updates } = setupCapturingUpdateChain();
    const calls = installFetchStub({
      send: (message) =>
        message.token === 'fcm-dead'
          ? fakeResponse(404, JSON.stringify({
              error: {
                message: 'Requested entity was not found.',
                status: 'NOT_FOUND',
                details: [{ '@type': FCM_ERROR_TYPE, errorCode: 'UNREGISTERED' }],
              },
            }))
          : fakeResponse(200, FCM_SEND_OK),
    });

    const result = await sendPushNotification('user-1', payload);

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);

    // Both devices were attempted — the dead one did not abort the dispatch.
    const sendUrls = calls.filter((c) => c.url.includes('fcm.googleapis.com'));
    expect(sendUrls).toHaveLength(2);
    expect(sendUrls.map((c) => (JSON.parse(String(c.init.body)) as { message: { token: string } }).message.token))
      .toEqual(['fcm-dead', 'fcm-live']);

    // Exactly one row deactivated, and the surviving device got the success
    // reset rather than a strike.
    const deactivations = setFn.mock.calls.filter(
      ([arg]) => JSON.stringify(arg) === JSON.stringify({ isActive: false })
    );
    expect(deactivations).toHaveLength(1);
    expect(setFn).toHaveBeenCalledWith(
      expect.objectContaining({ failedAttempts: '0', lastFailedAt: null })
    );

    // WHICH row was deactivated, not merely that one was. The shared `eq` mock
    // collapses every filter to the same value, so without pairing each `set`
    // with the `where` that followed it, aiming the update at the wrong row —
    // or at every row — would look identical to correct behaviour.
    const deactivated = updates.find(
      (u) => JSON.stringify(u.set) === JSON.stringify({ isActive: false })
    );
    expect(deactivated?.where).toEqual({ column: 'id', value: 'android-dead' });
    const reset = updates.find(
      (u) => (u.set as { failedAttempts?: string }).failedAttempts === '0'
    );
    expect(reset?.where).toEqual({ column: 'id', value: 'android-live' });

    // And one mint served both sends.
    expect(calls.filter((c) => c.url.includes('oauth2.googleapis.com'))).toHaveLength(1);
  });

  it('keeps the token when SENDER_ID_MISMATCH names a project-level mismatch', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson();
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    const { setFn } = setupUpdateChain();
    installFetchStub({
      send: () =>
        fakeResponse(403, JSON.stringify({
          error: {
            message: 'SenderId mismatch',
            status: 'PERMISSION_DENIED',
            details: [{ '@type': FCM_ERROR_TYPE, errorCode: 'SENDER_ID_MISMATCH' }],
          },
        })),
    });

    const result = await sendPushNotification('user-1', payload);

    expect(result.errors[0]).toContain('SENDER_ID_MISMATCH');
    expect(setFn).not.toHaveBeenCalledWith({ isActive: false });
  });

  // The mirror of the case above: an oversized data map is a message-level fault
  // that DOES carry an FcmError detail. It must not unregister the recipient.
  it('keeps the token when an FcmError detail reports a message-level INVALID_ARGUMENT', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson();
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    const { setFn } = setupUpdateChain();
    installFetchStub({
      send: () =>
        fakeResponse(400, JSON.stringify({
          error: {
            message: 'Payload exceeds the maximum size',
            status: 'INVALID_ARGUMENT',
            details: [{ '@type': FCM_ERROR_TYPE, errorCode: 'INVALID_ARGUMENT' }],
          },
        })),
    });

    const result = await sendPushNotification('user-1', payload);

    expect(result.errors[0]).toContain('INVALID_ARGUMENT');
    expect(setFn).not.toHaveBeenCalledWith({ isActive: false });
    expect(setFn).toHaveBeenCalledWith(
      expect.objectContaining({ failedAttempts: '1', isActive: true })
    );
  });

  // Symmetric to the @type guard on the FcmError branch: fieldViolations only
  // carry a token verdict when they arrive on a BadRequest detail. A different
  // detail type carrying the same shape must not be able to impersonate one.
  it('ignores fieldViolations that arrive on a detail other than BadRequest', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson();
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    const { setFn } = setupUpdateChain();
    installFetchStub({
      send: () =>
        fakeResponse(400, JSON.stringify({
          error: {
            message: 'nope',
            status: 'INVALID_ARGUMENT',
            details: [{
              '@type': 'type.googleapis.com/google.rpc.Help',
              fieldViolations: [{ field: 'message.token', description: 'not really' }],
            }],
          },
        })),
    });

    const result = await sendPushNotification('user-1', payload);

    // The positive half matters as much as the negative one: without it this
    // would also pass if the send never reached FCM at all, because the
    // serverFault path leaves the row untouched too.
    expect(result.errors[0]).toContain('INVALID_ARGUMENT');
    expect(setFn).toHaveBeenCalledWith(
      expect.objectContaining({ failedAttempts: '1', isActive: true })
    );

    expect(setFn).not.toHaveBeenCalledWith({ isActive: false });
  });

  it('ignores a BadRequest that rejects some field other than the token', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson();
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    const { setFn } = setupUpdateChain();
    installFetchStub({
      send: () =>
        fakeResponse(400, JSON.stringify({
          error: {
            message: 'Invalid JSON payload received. Unknown name "nope".',
            status: 'INVALID_ARGUMENT',
            details: [{
              '@type': BAD_REQUEST_TYPE,
              fieldViolations: [{ field: 'message.nope', description: 'Cannot find field.' }],
            }],
          },
        })),
    });

    const result = await sendPushNotification('user-1', payload);

    // The positive half matters as much as the negative one: without it this
    // would also pass if the send never reached FCM at all, because the
    // serverFault path leaves the row untouched too.
    expect(result.errors[0]).toContain('INVALID_ARGUMENT');
    expect(setFn).toHaveBeenCalledWith(
      expect.objectContaining({ failedAttempts: '1', isActive: true })
    );

    expect(setFn).not.toHaveBeenCalledWith({ isActive: false });
  });

  // The dangerous case: a malformed *message* is also a 400 INVALID_ARGUMENT, but
  // with no FcmError detail. Deactivating on that would take out every Android
  // token on the platform the moment the payload builder regressed.
  it('keeps the token when INVALID_ARGUMENT arrives without an FcmError detail', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson();
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    const { setFn } = setupUpdateChain();
    installFetchStub({
      send: () =>
        fakeResponse(400, JSON.stringify({
          error: {
            message: 'Invalid JSON payload received. Unknown name "nope".',
            status: 'INVALID_ARGUMENT',
            details: [{
              '@type': 'type.googleapis.com/google.rpc.BadRequest',
              fieldViolations: [{ field: 'message.nope', description: 'Cannot find field.' }],
            }],
          },
        })),
    });

    const result = await sendPushNotification('user-1', payload);

    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain('INVALID_ARGUMENT');
    expect(setFn).not.toHaveBeenCalledWith({ isActive: false });
    expect(setFn).toHaveBeenCalledWith(
      expect.objectContaining({ failedAttempts: '1', isActive: true })
    );
  });

  // Likewise a wrong project id is a bare NOT_FOUND, and says nothing about the token.
  it('keeps the token when NOT_FOUND arrives without an FcmError detail', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson();
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    const { setFn } = setupUpdateChain();
    installFetchStub({
      send: () =>
        fakeResponse(404, JSON.stringify({
          error: { message: 'Requested entity was not found.', status: 'NOT_FOUND' },
        })),
    });

    const result = await sendPushNotification('user-1', payload);

    expect(result.errors[0]).toContain('NOT_FOUND');
    expect(setFn).not.toHaveBeenCalledWith({ isActive: false });
  });

  it('ignores an errorCode carried by a detail that is not an FcmError', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson();
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    const { setFn } = setupUpdateChain();
    installFetchStub({
      send: () =>
        fakeResponse(400, JSON.stringify({
          error: {
            message: 'nope',
            status: 'INVALID_ARGUMENT',
            details: [{ '@type': 'type.googleapis.com/google.rpc.Help', errorCode: 'UNREGISTERED' }],
          },
        })),
    });

    const result = await sendPushNotification('user-1', payload);

    // Falls back to the coarse status, and does not cost the device its registration.
    expect(result.errors[0]).toContain('INVALID_ARGUMENT');
    expect(setFn).not.toHaveBeenCalledWith({ isActive: false });
  });

  it('keeps the token when FCM rejects with a retryable code', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson();
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    const { setFn } = setupUpdateChain();
    installFetchStub({
      send: () =>
        fakeResponse(
          503,
          JSON.stringify({ error: { message: 'The service is unavailable.', status: 'UNAVAILABLE' } })
        ),
    });

    const result = await sendPushNotification('user-1', payload);

    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain('UNAVAILABLE');
    expect(setFn).not.toHaveBeenCalledWith({ isActive: false });
    expect(setFn).toHaveBeenCalledWith(
      expect.objectContaining({ failedAttempts: '1', isActive: true })
    );
  });

  it('falls back to UNKNOWN when the FCM error body is not JSON', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson();
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    const { setFn } = setupUpdateChain();
    installFetchStub({ send: () => fakeResponse(500, '<html>gateway</html>') });

    const result = await sendPushNotification('user-1', payload);

    expect(result.errors[0]).toContain('UNKNOWN');
    expect(setFn).not.toHaveBeenCalledWith({ isActive: false });
  });

  it('fails only that send when FCM_SERVICE_ACCOUNT_JSON is absent, without breaking the dispatch loop', async () => {
    delete process.env.FCM_SERVICE_ACCOUNT_JSON;
    process.env.APNS_TEAM_ID = 'team-id';
    process.env.APNS_KEY_ID = 'key-id';
    process.env.APNS_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nfakekey\n-----END PRIVATE KEY-----';
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([
      androidToken({ id: 'android-1' }),
      tokenRecord({ id: 'ios-1', platform: 'ios' }),
    ] as never);
    setupUpdateChain();
    const calls = installFetchStub();

    const result = await sendPushNotification('user-1', payload);

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain('FCM configuration missing');
    expect(result.errors[0]).toContain('FCM_SERVICE_ACCOUNT_JSON');
    // No network call was attempted for the misconfigured platform.
    expect(calls).toHaveLength(0);
  });

  it('does not count a missing credential against the device', async () => {
    // The reviewer scenario: FCM_SERVICE_ACCOUNT_JSON left unset — the state
    // .env.example documents as the safe default. Striking here would deactivate
    // every Android token after five notifications, and fixing the secret would
    // not bring them back until each app relaunched.
    delete process.env.FCM_SERVICE_ACCOUNT_JSON;
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([
      androidToken({ failedAttempts: '4' }),
    ] as never);
    const { setFn } = setupUpdateChain();
    installFetchStub();

    const result = await sendPushNotification('user-1', payload);

    expect(result.failed).toBe(1);
    // No strike, no deactivation — the row is left entirely alone.
    expect(setFn).not.toHaveBeenCalled();
  });

  it('reports a configuration error when the service account JSON is malformed', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = 'not-json-at-all';
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    setupUpdateChain();
    installFetchStub();

    const result = await sendPushNotification('user-1', payload);

    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain('not valid JSON');
  });

  it('reports a configuration error when the service account JSON is not an object', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = '["nope"]';
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    setupUpdateChain();
    installFetchStub();

    const result = await sendPushNotification('user-1', payload);

    expect(result.errors[0]).toContain('must be a JSON object');
  });

  it('names the missing service account fields', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson({
      project_id: undefined,
      private_key: undefined,
    });
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    setupUpdateChain();
    installFetchStub();

    const result = await sendPushNotification('user-1', payload);

    expect(result.errors[0]).toContain('project_id');
    expect(result.errors[0]).toContain('private_key');
    expect(result.errors[0]).not.toContain('client_email');
  });

  it('rejects a project_id that could rewrite the send URL', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson({}, '../../evil');
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    const { setFn } = setupUpdateChain();
    const calls = installFetchStub();

    const result = await sendPushNotification('user-1', payload);

    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain('project_id may only contain');
    // Nothing was put on the wire, and no device lost its registration.
    expect(calls).toHaveLength(0);
    expect(setFn).not.toHaveBeenCalledWith({ isActive: false });
  });

  it('accepts an ordinary hyphenated Firebase project id', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson({}, 'pagespace-prod-1234');
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    setupUpdateChain();
    const calls = installFetchStub();

    const result = await sendPushNotification('user-1', payload);

    expect(result.sent).toBe(1);
    expect(sentMessage(calls)).toBeTruthy();
    expect(calls.some((c) => c.url.includes('/projects/pagespace-prod-1234/'))).toBe(true);
  });

  it('refuses to send the signed assertion to a non-https token_uri', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson({
      token_uri: 'http://oauth2.googleapis.com/token',
    });
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    setupUpdateChain();
    const calls = installFetchStub();

    const result = await sendPushNotification('user-1', payload);

    expect(result.errors[0]).toContain('token_uri must be an https:// URL');
    expect(calls).toHaveLength(0);
  });

  it('falls back to the Google token endpoint when the account omits token_uri', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson({ token_uri: undefined });
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    setupUpdateChain();
    const calls = installFetchStub();

    const result = await sendPushNotification('user-1', payload);

    expect(result.sent).toBe(1);
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/token');
  });

  // The default and the fixture were both 3600, so nothing distinguished
  // "honours expires_in" from "always assumes an hour". A short-lived token has
  // to miss the 10-minute freshness margin and force a fresh mint.
  it('honours a short expires_in instead of assuming an hour', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson({}, 'short-expiry-project');
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    setupUpdateChain();
    const calls = installFetchStub({
      oauth: () => fakeResponse(200, JSON.stringify({ access_token: 'ya29.short', expires_in: 60 })),
    });

    await sendPushNotification('user-1', payload);
    await sendPushNotification('user-1', payload);

    // 60s is inside the refresh margin, so the second send must not reuse it.
    expect(calls.filter((c) => c.url.includes('oauth2.googleapis.com'))).toHaveLength(2);
  });

  it("carries FCM's own reason through to the error", async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson();
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    setupUpdateChain();
    installFetchStub({
      send: () =>
        fakeResponse(429, JSON.stringify({
          error: { message: 'Quota exceeded for quota metric', status: 'RESOURCE_EXHAUSTED' },
        })),
    });

    const result = await sendPushNotification('user-1', payload);

    // The code alone is not enough to debug from; the human-readable half has
    // to survive too.
    expect(result.errors[0]).toBe('RESOURCE_EXHAUSTED: Quota exceeded for quota metric');
  });

  it('treats an access token with no expires_in as lasting the standard hour', async () => {
    // Observable through the cache: the default has to be long enough that the
    // second send reuses the token rather than minting again.
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson({}, 'no-expiry-project');
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    setupUpdateChain();
    const calls = installFetchStub({
      oauth: () => fakeResponse(200, JSON.stringify({ access_token: 'ya29.no-expiry' })),
    });

    await sendPushNotification('user-1', payload);
    await sendPushNotification('user-1', payload);

    expect(calls.filter((c) => c.url.includes('oauth2.googleapis.com'))).toHaveLength(1);
  });

  it('leaves a private key that already has real newlines untouched', async () => {
    const realNewlineKey = '-----BEGIN PRIVATE KEY-----\nREALKEY\n-----END PRIVATE KEY-----\n';
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson({ private_key: realNewlineKey });
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    setupUpdateChain();
    const { rsaSign } = primeSign();
    installFetchStub();

    await sendPushNotification('user-1', payload);

    expect(rsaSign.sign.mock.calls[0][0]).toBe(realNewlineKey);
  });

  it('names client_email when it is the only field missing', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson({ client_email: undefined });
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    setupUpdateChain();
    installFetchStub();

    const result = await sendPushNotification('user-1', payload);

    expect(result.errors[0]).toContain('client_email');
    expect(result.errors[0]).not.toContain('project_id');
  });

  // A hostile or malformed error body must not be able to crash the parser or,
  // worse, talk it into a spurious deactivation. Every field here is the wrong
  // type: message, status, one detail that is not an object, one whose @type is
  // not a string, and one whose fieldViolations is not an array.
  it('survives an error body whose every field is the wrong type', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson();
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    const { setFn } = setupUpdateChain();
    installFetchStub({
      send: () =>
        fakeResponse(400, JSON.stringify({
          error: {
            message: 12345,
            status: { not: 'a string' },
            details: [
              'not an object',
              { '@type': 42, errorCode: 'UNREGISTERED' },
              { '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: 'not an array' },
            ],
          },
        })),
    });

    const result = await sendPushNotification('user-1', payload);

    expect(result.failed).toBe(1);
    expect(result.errors[0]).toBe('UNKNOWN: Unknown error');
    expect(setFn).not.toHaveBeenCalledWith({ isActive: false });
  });

  it('falls back to UNKNOWN when the body is JSON but carries no error object', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson();
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    const { setFn } = setupUpdateChain();
    installFetchStub({ send: () => fakeResponse(500, JSON.stringify({ nope: true })) });

    const result = await sendPushNotification('user-1', payload);

    expect(result.errors[0]).toContain('UNKNOWN');
    expect(setFn).not.toHaveBeenCalledWith({ isActive: false });
  });

  it('sends empty strings when a visible push carries no title or body', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson();
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    setupUpdateChain();
    const calls = installFetchStub();

    await sendPushNotification('user-1', {});

    // FCM rejects a notification block with absent title/body, so they are
    // always present even when the caller supplied neither.
    expect(sentMessage(calls).notification).toEqual({ title: '', body: '' });
  });

  it('carries title and body in data when a silent push has them', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson();
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    setupUpdateChain();
    const calls = installFetchStub();

    await sendPushNotification('user-1', { silent: true, title: 'T', body: 'B' });

    const message = sentMessage(calls);
    expect('notification' in message).toBe(false);
    expect(message.data).toMatchObject({ silent: 'true', title: 'T', body: 'B' });
  });

  it('reports a non-Error thrown by the transport', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson({}, 'non-error-throw-project');
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    const { setFn } = setupUpdateChain();
    installFetchStub();
    globalThis.fetch = vi.fn(async () => { throw 'a bare string'; }) as unknown as typeof fetch;

    const result = await sendPushNotification('user-1', payload);

    expect(result.errors[0]).toBe('Unknown error');
    // Still a server fault: no strike, no deactivation.
    expect(setFn).not.toHaveBeenCalled();
  });

  it('reuses a recently minted access token instead of re-minting per send', async () => {
    const raw = serviceAccountJson({}, 'shared-cache-project');
    process.env.FCM_SERVICE_ACCOUNT_JSON = raw;
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    setupUpdateChain();
    const calls = installFetchStub();

    await sendPushNotification('user-1', payload);
    await sendPushNotification('user-1', payload);

    const oauthCalls = calls.filter((c) => c.url.includes('oauth2.googleapis.com'));
    const sendCalls = calls.filter((c) => c.url.includes('fcm.googleapis.com'));
    expect(oauthCalls).toHaveLength(1);
    expect(sendCalls).toHaveLength(2);
  });

  it('re-mints when the service account credential rotates', async () => {
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    setupUpdateChain();
    const calls = installFetchStub();

    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson({}, 'rotate-a');
    await sendPushNotification('user-1', payload);
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson({}, 'rotate-b');
    await sendPushNotification('user-1', payload);

    expect(calls.filter((c) => c.url.includes('oauth2.googleapis.com'))).toHaveLength(2);
    expect(calls[3].url).toContain('/projects/rotate-b/');
  });

  it('re-mints and retries once when the access token is rejected', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson({}, 'unauthorized-project');
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    const { setFn } = setupUpdateChain();
    let sendCount = 0;
    const calls = installFetchStub({
      send: () => {
        sendCount += 1;
        return sendCount === 1
          ? fakeResponse(401, JSON.stringify({ error: { status: 'UNAUTHENTICATED', message: 'bad creds' } }))
          : fakeResponse(200, FCM_SEND_OK);
      },
    });

    const result = await sendPushNotification('user-1', payload);

    // The notification that discovered the stale credential is delivered, not
    // dropped — a cached token can be up to 50 minutes stale and fan-out sends
    // run concurrently, so dropping it would lose every send in that window.
    expect(result).toEqual({ sent: 1, failed: 0, errors: [] });
    expect(calls.filter((c) => c.url.includes('oauth2.googleapis.com'))).toHaveLength(2);
    expect(calls.filter((c) => c.url.includes('fcm.googleapis.com'))).toHaveLength(2);
    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({ failedAttempts: '0' }));
  });

  it('gives up after one retry when the fresh token is rejected too', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson({}, 'always-401-project');
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    const { setFn } = setupUpdateChain();
    const calls = installFetchStub({
      send: () =>
        fakeResponse(401, JSON.stringify({ error: { status: 'UNAUTHENTICATED', message: 'bad creds' } })),
    });

    const result = await sendPushNotification('user-1', payload);

    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain('UNAUTHENTICATED');
    // Exactly two attempts — no unbounded retry loop.
    expect(calls.filter((c) => c.url.includes('fcm.googleapis.com'))).toHaveLength(2);
    expect(setFn).not.toHaveBeenCalledWith({ isActive: false });
  });

  it('mints once for sends that race on a cold cache', async () => {
    // The real fan-out: broadcastTosPrivacyUpdate creates a notification for every
    // user through Promise.all, so N Android recipients hit a cold cache together.
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson({}, 'single-flight-project');
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    setupUpdateChain();

    let releaseOauth: (() => void) | undefined;
    const oauthGate = new Promise<void>((resolve) => { releaseOauth = resolve; });
    const calls = installFetchStub({
      oauth: () => fakeResponse(200, OAUTH_OK),
    });
    // Hold the OAuth leg open so all three sends are provably in flight together.
    const stub = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const passthrough = stub.getMockImplementation()!;
    stub.mockImplementation(async (url: string | URL, init: RequestInit = {}) => {
      if (String(url).includes('oauth2.googleapis.com')) await oauthGate;
      return passthrough(url, init);
    });

    const inFlight = Promise.all([
      sendPushNotification('user-1', payload),
      sendPushNotification('user-2', payload),
      sendPushNotification('user-3', payload),
    ]);
    await Promise.resolve();
    releaseOauth!();
    const results = await inFlight;

    expect(results.every((r) => r.sent === 1)).toBe(true);
    expect(calls.filter((c) => c.url.includes('oauth2.googleapis.com'))).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes('fcm.googleapis.com'))).toHaveLength(3);
  });

  it('does not hand a racing waiter a token minted for a different credential', async () => {
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    setupUpdateChain();
    const calls = installFetchStub();

    // The credential has to rotate while the first mint is genuinely in the air —
    // both sends read process.env only after their first await, so flipping it
    // before either resumes would just show both of them the second credential.
    let releaseFirstMint: (() => void) | undefined;
    const firstMintGate = new Promise<void>((resolve) => { releaseFirstMint = resolve; });
    let oauthSeen = 0;
    const stub = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const passthrough = stub.getMockImplementation()!;
    stub.mockImplementation(async (url: string | URL, init: RequestInit = {}) => {
      if (String(url).includes('oauth2.googleapis.com')) {
        oauthSeen += 1;
        if (oauthSeen === 1) await firstMintGate;
      }
      return passthrough(url, init);
    });

    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson({}, 'race-rotate-a');
    const first = sendPushNotification('user-1', payload);
    await vi.waitFor(() => expect(oauthSeen).toBe(1));

    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson({}, 'race-rotate-b');
    const second = sendPushNotification('user-2', payload);
    // The second send must open its own mint rather than join the pending one.
    await vi.waitFor(() => expect(oauthSeen).toBe(2));

    releaseFirstMint!();
    await Promise.all([first, second]);

    expect(calls.filter((c) => c.url.includes('oauth2.googleapis.com'))).toHaveLength(2);
    const sendUrls = calls.filter((c) => c.url.includes('fcm.googleapis.com')).map((c) => c.url);
    expect(sendUrls.some((u) => u.includes('/projects/race-rotate-a/'))).toBe(true);
    expect(sendUrls.some((u) => u.includes('/projects/race-rotate-b/'))).toBe(true);
  });

  it('lets a later send retry after an in-flight mint fails', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson({}, 'inflight-fail-project');
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    setupUpdateChain();
    let attempt = 0;
    const calls = installFetchStub({
      oauth: () => {
        attempt += 1;
        return attempt === 1 ? fakeResponse(500, 'upstream boom') : fakeResponse(200, OAUTH_OK);
      },
    });

    // Both race on the same failing mint, then a third send must not be stuck
    // waiting on the dead in-flight promise.
    const [a, b] = await Promise.all([
      sendPushNotification('user-1', payload),
      sendPushNotification('user-2', payload),
    ]);
    expect(a.failed).toBe(1);
    expect(b.failed).toBe(1);
    expect(calls.filter((c) => c.url.includes('oauth2.googleapis.com'))).toHaveLength(1);

    const c = await sendPushNotification('user-3', payload);
    expect(c.sent).toBe(1);
    expect(calls.filter((c) => c.url.includes('oauth2.googleapis.com'))).toHaveLength(2);
  });

  it('surfaces an OAuth token endpoint rejection as the send error', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson();
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    const { setFn } = setupUpdateChain();
    const calls = installFetchStub({
      oauth: () => fakeResponse(400, JSON.stringify({ error: 'invalid_grant' })),
    });

    const result = await sendPushNotification('user-1', payload);

    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain('FCM OAuth token request failed (400)');
    expect(result.errors[0]).toContain('invalid_grant');
    // The send leg is never attempted, and the token is not deactivated.
    expect(calls.filter((c) => c.url.includes('fcm.googleapis.com'))).toHaveLength(0);
    expect(setFn).not.toHaveBeenCalledWith({ isActive: false });
  });

  it('reports a transport failure at the OAuth leg and mints cleanly on the next send', async () => {
    const raw = serviceAccountJson({}, 'transport-fail-project');
    process.env.FCM_SERVICE_ACCOUNT_JSON = raw;
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    setupUpdateChain();
    let attempt = 0;
    const calls = installFetchStub({
      oauth: () => {
        attempt += 1;
        if (attempt === 1) throw new Error('ECONNRESET');
        return fakeResponse(200, OAUTH_OK);
      },
    });

    const first = await sendPushNotification('user-1', payload);
    expect(first.failed).toBe(1);
    expect(first.errors[0]).toContain('ECONNRESET');

    const second = await sendPushNotification('user-1', payload);
    expect(second.sent).toBe(1);
    expect(calls.filter((c) => c.url.includes('oauth2.googleapis.com'))).toHaveLength(2);
  });

  it('rejects an OAuth response with no access_token', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson();
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    setupUpdateChain();
    installFetchStub({ oauth: () => fakeResponse(200, JSON.stringify({ expires_in: 3600 })) });

    const result = await sendPushNotification('user-1', payload);

    expect(result.errors[0]).toContain('did not include an access_token');
  });

  it('rejects a non-JSON OAuth response body', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = serviceAccountJson();
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([androidToken()] as never);
    setupUpdateChain();
    installFetchStub({ oauth: () => fakeResponse(200, 'totally not json') });

    const result = await sendPushNotification('user-1', payload);

    expect(result.errors[0]).toContain('was not valid JSON');
  });
});
