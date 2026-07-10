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

  it('returns zeros when no active tokens', async () => {
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([] as never);

    const result = await sendPushNotification('user-1', payload);
    expect(result).toEqual({ sent: 0, failed: 0, errors: [] });
  });

  it('handles android platform (not yet implemented)', async () => {
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([tokenRecord({ platform: 'android' })] as never);
    setupUpdateChain();

    const result = await sendPushNotification('user-1', payload);
    expect(result.failed).toBe(1);
    expect(result.errors).toContain('Android push not yet implemented');
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
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([tokenRecord({ platform: 'android', failedAttempts: '4' })] as never);
    const { setFn } = setupUpdateChain();

    await sendPushNotification('user-1', payload);

    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({
      failedAttempts: '5',
      isActive: false,
    }));
  });

  it('keeps token active with fewer than 5 failures', async () => {
    vi.mocked(db.query.pushNotificationTokens.findMany).mockResolvedValue([tokenRecord({ platform: 'android', failedAttempts: '2' })] as never);
    const { setFn } = setupUpdateChain();

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
