/**
 * @scaffold - index.ts Tests
 *
 * Tests the main realtime server module: validateSocketToken, normalizeOrigin,
 * getAllowedOrigins, isOriginAllowed, validateWebSocketOrigin,
 * validateAndLogWebSocketOrigin, requestListener, populateUserMetadata,
 * the Socket.IO middleware, and the connection handler.
 *
 * @REVIEW ORM chain mock (db.select().from().where().limit()) is used for
 * DM conversation and user profile queries. index.ts directly uses the ORM
 * with no repository seam. To fix: extract DB queries into a repository module.
 *
 * Strategy: mock all external dependencies at module level, then use
 * dynamic import so the module-level side-effects use mocked modules.
 * Captured callbacks are invoked directly for testing.
 *
 * Suggested integration tests:
 * - Socket.IO client integration test: full auth flow with real token validation
 * - Socket.IO client integration test: broadcast request with signature verification
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// 1. Mock all external modules BEFORE any dynamic import of index.ts
// ---------------------------------------------------------------------------

// Mock dotenv so the config call is a no-op
vi.mock('dotenv', () => ({ config: vi.fn() }));

// Logger mock
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    realtime: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  },
}));

// broadcast-auth mock
vi.mock('@pagespace/lib/auth/broadcast-auth', () => ({
  verifyBroadcastSignature: vi.fn(),
}));

// permissions mock
vi.mock('@pagespace/lib/permissions', () => ({
  getUserAccessLevel: vi.fn(),
  getUserDriveAccess: vi.fn(),
}));

// auth/session mock
vi.mock('@pagespace/lib/auth', () => ({
  sessionService: {
    validateSession: vi.fn(),
  },
}));

// DB mock – need query.socketTokens.findFirst and chained select().from().where().limit()
const mockDbFindFirst = vi.fn();
const mockDbSelect = vi.fn();
const mockDbFrom = vi.fn();
const mockDbWhere = vi.fn();
const mockDbLimit = vi.fn();

mockDbSelect.mockReturnValue({ from: mockDbFrom });
mockDbFrom.mockReturnValue({ where: mockDbWhere });
mockDbWhere.mockReturnValue({ limit: mockDbLimit });
mockDbLimit.mockResolvedValue([]);

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      socketTokens: {
        findFirst: mockDbFindFirst,
      },
    },
    select: mockDbSelect,
  },
  eq: vi.fn((a, b) => ({ eq: [a, b] })),
  gt: vi.fn((a, b) => ({ gt: [a, b] })),
  and: vi.fn((...args) => ({ and: args })),
  or: vi.fn((...args) => ({ or: args })),
  socketTokens: { tokenHash: 'tokenHash', expiresAt: 'expiresAt' },
  users: { id: 'id', name: 'name', image: 'image' },
  userProfiles: { userId: 'userId', displayName: 'displayName', avatarUrl: 'avatarUrl' },
  pages: { id: 'id', driveId: 'driveId' },
  dmConversations: {
    id: 'id',
    participant1Id: 'participant1Id',
    participant2Id: 'participant2Id',
  },
}));

// validation mock – pass through to real module but track calls
vi.mock('../validation', () => ({
  validatePageId: vi.fn((input: unknown) => {
    if (typeof input === 'string' && /^[a-z][a-z0-9]{1,31}$/.test(input)) {
      return { ok: true, value: input };
    }
    return { ok: false, error: 'invalid Page ID format' };
  }),
  validateDriveId: vi.fn((input: unknown) => {
    if (typeof input === 'string' && /^[a-z][a-z0-9]{1,31}$/.test(input)) {
      return { ok: true, value: input };
    }
    return { ok: false, error: 'Drive ID must be a valid ID' };
  }),
  validateConversationId: vi.fn((input: unknown) => {
    if (typeof input === 'string' && /^[a-z][a-z0-9]{1,31}$/.test(input)) {
      return { ok: true, value: input };
    }
    return { ok: false, error: 'Conversation ID must be a valid ID' };
  }),
  validatePresencePagePayload: vi.fn((input: unknown) => {
    if (input && typeof input === 'object' && 'pageId' in (input as object)) {
      const pageId = (input as { pageId: unknown }).pageId;
      if (typeof pageId === 'string' && /^[a-z][a-z0-9]{1,31}$/.test(pageId)) {
        return { ok: true, value: pageId };
      }
      return { ok: false, error: 'invalid Page ID format' };
    }
    return { ok: false, error: 'Invalid payload: pageId required' };
  }),
  emitValidationError: vi.fn(),
}));

// socket-registry mock
const mockSocketRegistry = {
  registerSocket: vi.fn(),
  unregisterSocket: vi.fn(),
  trackRoomJoin: vi.fn(),
  trackRoomLeave: vi.fn(),
  getSocketsForUser: vi.fn().mockReturnValue([]),
  getRoomsForSocket: vi.fn().mockReturnValue([]),
};

vi.mock('../socket-registry', () => ({
  socketRegistry: mockSocketRegistry,
  SocketRegistry: vi.fn(),
}));

// presence-tracker mock
const mockPresenceTracker = {
  addViewer: vi.fn(),
  removeViewer: vi.fn(),
  removeSocket: vi.fn().mockReturnValue([]),
  getUniqueViewers: vi.fn().mockReturnValue([]),
  getDriveId: vi.fn().mockReturnValue(undefined),
  getViewers: vi.fn().mockReturnValue([]),
  getPagesForSocket: vi.fn().mockReturnValue([]),
};

vi.mock('../presence-tracker', () => ({
  presenceTracker: mockPresenceTracker,
}));

// per-event-auth mock
const mockWithPerEventAuth = vi.fn((socket: unknown, event: unknown, handler: (...args: unknown[]) => unknown, opts: unknown) => {
  // return async handler that calls the real handler directly for testing
  return async (payload: unknown) => handler(socket, payload);
});

vi.mock('../per-event-auth', () => ({
  withPerEventAuth: mockWithPerEventAuth,
  isSensitiveEvent: vi.fn().mockReturnValue(false),
}));

// kick-handler mock
const mockHandleKickRequest = vi.fn().mockReturnValue({
  status: 200,
  body: { success: true, kickedCount: 0, rooms: [] },
});

vi.mock('../kick-handler', () => ({
  handleKickRequest: mockHandleKickRequest,
}));

// ---------------------------------------------------------------------------
// 2. Mock http.createServer and Socket.IO Server to capture callbacks
// ---------------------------------------------------------------------------

// We need to capture: the requestListener, io.use callback, and io.on('connection') callback
let capturedRequestListener: ((req: unknown, res: unknown) => void) | null = null;
let capturedIoUseCallback: ((socket: unknown, next: (err?: Error) => void) => Promise<void>) | null = null;
let capturedIoConnectionCallback: ((socket: unknown) => void) | null = null;

const mockHttpServer = {
  listen: vi.fn((port: unknown, cb: () => void) => { if (cb) cb(); }),
};

vi.mock('http', () => ({
  createServer: vi.fn((listener: (req: unknown, res: unknown) => void) => {
    capturedRequestListener = listener;
    return mockHttpServer;
  }),
}));

// Mocked io object - tracks calls to use() and on()
const mockIo = {
  to: vi.fn().mockReturnThis(),
  emit: vi.fn(),
  sockets: { sockets: new Map() },
  use: vi.fn((cb: (socket: unknown, next: (err?: Error) => void) => Promise<void>) => {
    capturedIoUseCallback = cb;
  }),
  on: vi.fn((event: string, cb: (socket: unknown) => void) => {
    if (event === 'connection') {
      capturedIoConnectionCallback = cb;
    }
  }),
};

vi.mock('socket.io', () => ({
  Server: vi.fn().mockImplementation(() => mockIo),
}));

// ---------------------------------------------------------------------------
// 3. Import dependencies that will be tested
// ---------------------------------------------------------------------------
import { loggers } from '@pagespace/lib/logging/logger-config';
import { verifyBroadcastSignature } from '@pagespace/lib/auth/broadcast-auth';
import { getUserAccessLevel, getUserDriveAccess } from '@pagespace/lib/permissions/permissions';
import { sessionService } from '@pagespace/lib/auth/session-service';
import { emitValidationError } from '../validation';

// ---------------------------------------------------------------------------
// 4. Dynamically import index.ts (runs module-level code with mocks in place)
// ---------------------------------------------------------------------------
// We do this at the top level outside describe so it runs once
await import('../index');

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

function createMockSocket(overrides: Partial<{
  id: string;
  data: { user?: { id: string; name: string; avatarUrl: string | null } };
  handshake: {
    auth: { token?: string };
    headers: { origin?: string; cookie?: string; 'user-agent'?: string };
    address: string;
  };
  join: ReturnType<typeof vi.fn>;
  leave: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  to: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}> = {}) {
  // Event handler map - captured via socket.on() calls
  const eventHandlers: Record<string, (...args: unknown[]) => unknown> = {};
  const onFn = vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
    eventHandlers[event] = handler;
  });

  const socket = {
    id: 'test-socket-id',
    data: { user: { id: 'user-1', name: 'Test User', avatarUrl: null } },
    handshake: {
      auth: { token: 'ps_sess_test' },
      headers: { origin: undefined as string | undefined, cookie: undefined as string | undefined, 'user-agent': 'TestAgent/1.0' },
      address: '127.0.0.1',
    },
    join: vi.fn(),
    leave: vi.fn(),
    emit: vi.fn(),
    to: vi.fn().mockReturnValue({ emit: vi.fn() }),
    disconnect: vi.fn(),
    on: onFn,
    // Helper to invoke registered event handlers by name
    _trigger: (event: string, ...args: unknown[]) => {
      if (eventHandlers[event]) {
        return eventHandlers[event](...args);
      }
    },
    _handlers: eventHandlers,
    ...overrides,
  };

  return socket;
}

function createMockReq(overrides: Partial<{
  method: string;
  url: string;
  headers: Record<string, string>;
  socket: { remoteAddress: string };
  on: ReturnType<typeof vi.fn>;
}> = {}) {
  const listeners: Record<string, ((chunk: unknown) => void)[]> = {};
  return {
    method: 'POST',
    url: '/api/broadcast',
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    on: vi.fn((event: string, cb: (chunk: unknown) => void) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(cb);
    }),
    _listeners: listeners,
    _emit: (event: string, data?: unknown) => {
      (listeners[event] || []).forEach(cb => cb(data as Parameters<typeof cb>[0]));
    },
    ...overrides,
  };
}

function createMockRes() {
  const res = {
    writeHead: vi.fn(),
    end: vi.fn(),
  };
  return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('index.ts module loading', () => {
  it('should create the HTTP server with a request listener', () => {
    expect(capturedRequestListener).not.toBeNull();
  });

  it('should register Socket.IO middleware', () => {
    expect(capturedIoUseCallback).not.toBeNull();
  });

  it('should register Socket.IO connection handler', () => {
    expect(capturedIoConnectionCallback).not.toBeNull();
  });
});

describe('requestListener - /api/broadcast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIo.to.mockReturnThis();
    mockIo.emit.mockReset();
  });

  it('given POST /api/broadcast with valid signature, should emit to channelId and return 200', async () => {
    vi.mocked(verifyBroadcastSignature).mockReturnValue(true);

    const body = JSON.stringify({ channelId: 'channel-1', event: 'test-event', payload: { key: 'val' } });
    const req = createMockReq({
      method: 'POST',
      url: '/api/broadcast',
      headers: { 'x-broadcast-signature': 'valid-sig' },
    });
    const res = createMockRes();

    capturedRequestListener!(req, res);
    req._emit('data', Buffer.from(body));
    req._emit('end');

    await new Promise(resolve => setTimeout(resolve, 0));

    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ success: true }));
  });

  it('given POST /api/broadcast with missing signature, should return 401', async () => {
    const body = JSON.stringify({ channelId: 'c1', event: 'e1', payload: {} });
    const req = createMockReq({
      method: 'POST',
      url: '/api/broadcast',
      headers: {}, // no x-broadcast-signature
    });
    const res = createMockRes();

    capturedRequestListener!(req, res);
    req._emit('data', Buffer.from(body));
    req._emit('end');

    await new Promise(resolve => setTimeout(resolve, 0));

    expect(res.writeHead).toHaveBeenCalledWith(401, { 'Content-Type': 'application/json' });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: 'Authentication failed' }));
  });

  it('given POST /api/broadcast with invalid signature, should return 401', async () => {
    vi.mocked(verifyBroadcastSignature).mockReturnValue(false);

    const body = JSON.stringify({ channelId: 'c1', event: 'e1', payload: {} });
    const req = createMockReq({
      method: 'POST',
      url: '/api/broadcast',
      headers: { 'x-broadcast-signature': 'bad-sig' },
    });
    const res = createMockRes();

    capturedRequestListener!(req, res);
    req._emit('data', Buffer.from(body));
    req._emit('end');

    await new Promise(resolve => setTimeout(resolve, 0));

    expect(res.writeHead).toHaveBeenCalledWith(401, { 'Content-Type': 'application/json' });
  });

  it('given POST /api/broadcast with invalid JSON body, should return 400', async () => {
    vi.mocked(verifyBroadcastSignature).mockReturnValue(true);

    const req = createMockReq({
      method: 'POST',
      url: '/api/broadcast',
      headers: { 'x-broadcast-signature': 'sig' },
    });
    const res = createMockRes();

    capturedRequestListener!(req, res);
    req._emit('data', Buffer.from('not-json'));
    req._emit('end');

    await new Promise(resolve => setTimeout(resolve, 0));

    expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: 'Invalid JSON' }));
  });

  it('given POST /api/broadcast with missing channelId, should return 400', async () => {
    vi.mocked(verifyBroadcastSignature).mockReturnValue(true);

    const body = JSON.stringify({ event: 'e1', payload: {} }); // missing channelId
    const req = createMockReq({
      method: 'POST',
      url: '/api/broadcast',
      headers: { 'x-broadcast-signature': 'sig' },
    });
    const res = createMockRes();

    capturedRequestListener!(req, res);
    req._emit('data', Buffer.from(body));
    req._emit('end');

    await new Promise(resolve => setTimeout(resolve, 0));

    expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: 'Invalid broadcast payload' }));
  });
});

describe('requestListener - /api/kick', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHandleKickRequest.mockReturnValue({
      status: 200,
      body: { success: true, kickedCount: 0, rooms: [] },
    });
  });

  it('given POST /api/kick with valid signature, should delegate to handleKickRequest', async () => {
    vi.mocked(verifyBroadcastSignature).mockReturnValue(true);

    const body = JSON.stringify({ userId: 'u1', roomPattern: 'drive:*', reason: 'member_removed' });
    const req = createMockReq({
      method: 'POST',
      url: '/api/kick',
      headers: { 'x-broadcast-signature': 'valid-sig' },
    });
    const res = createMockRes();

    capturedRequestListener!(req, res);
    req._emit('data', Buffer.from(body));
    req._emit('end');

    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockHandleKickRequest).toHaveBeenCalledWith(mockIo, body);
    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
  });

  it('given POST /api/kick with missing signature, should return 401', async () => {
    const body = JSON.stringify({ userId: 'u1', roomPattern: 'drive:*', reason: 'member_removed' });
    const req = createMockReq({
      method: 'POST',
      url: '/api/kick',
      headers: {},
    });
    const res = createMockRes();

    capturedRequestListener!(req, res);
    req._emit('data', Buffer.from(body));
    req._emit('end');

    await new Promise(resolve => setTimeout(resolve, 0));

    expect(res.writeHead).toHaveBeenCalledWith(401, { 'Content-Type': 'application/json' });
    expect(mockHandleKickRequest).not.toHaveBeenCalled();
  });

  it('given POST /api/kick with invalid signature, should return 401', async () => {
    vi.mocked(verifyBroadcastSignature).mockReturnValue(false);

    const body = JSON.stringify({ userId: 'u1', roomPattern: 'drive:*', reason: 'member_removed' });
    const req = createMockReq({
      method: 'POST',
      url: '/api/kick',
      headers: { 'x-broadcast-signature': 'bad-sig' },
    });
    const res = createMockRes();

    capturedRequestListener!(req, res);
    req._emit('data', Buffer.from(body));
    req._emit('end');

    await new Promise(resolve => setTimeout(resolve, 0));

    expect(res.writeHead).toHaveBeenCalledWith(401, { 'Content-Type': 'application/json' });
    expect(mockHandleKickRequest).not.toHaveBeenCalled();
  });
});

describe('requestListener - 404', () => {
  it('given unknown route, should return 404', () => {
    const req = createMockReq({
      method: 'GET',
      url: '/unknown',
    });
    const res = createMockRes();

    capturedRequestListener!(req, res);

    expect(res.writeHead).toHaveBeenCalledWith(404);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('given GET /api/broadcast, should return 404 (only POST supported)', () => {
    const req = createMockReq({
      method: 'GET',
      url: '/api/broadcast',
    });
    const res = createMockRes();

    capturedRequestListener!(req, res);

    expect(res.writeHead).toHaveBeenCalledWith(404);
  });
});

describe('Socket.IO middleware - auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default env
    delete process.env.CORS_ORIGIN;
    delete process.env.WEB_APP_URL;
    delete process.env.NODE_ENV;
  });

  it('given no token, should call next with authentication error', async () => {
    const socket = createMockSocket({
      handshake: {
        auth: { token: undefined },
        headers: { origin: undefined },
        address: '127.0.0.1',
      },
    });
    const next = vi.fn();

    await capturedIoUseCallback!(socket, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('No token provided'),
    }));
  });

  it('given invalid origin in production, should call next with origin error', async () => {
    process.env.WEB_APP_URL = 'https://app.example.com';
    process.env.NODE_ENV = 'production';

    const socket = createMockSocket({
      handshake: {
        auth: { token: 'ps_sess_test' },
        headers: { origin: 'https://evil.example.com' },
        address: '127.0.0.1',
      },
    });
    const next = vi.fn();

    await capturedIoUseCallback!(socket, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('Origin not allowed'),
    }));
  });

  it('given valid ps_sock_* token, should authenticate and call next()', async () => {
    mockDbFindFirst.mockResolvedValue({ userId: 'user-from-sock-token' });
    mockDbLimit.mockResolvedValueOnce([{ name: 'Test User', image: null }])
               .mockResolvedValueOnce([]);

    const socket = createMockSocket({
      handshake: {
        auth: { token: 'ps_sock_validtoken123' },
        headers: { origin: undefined },
        address: '127.0.0.1',
      },
    });
    const next = vi.fn();

    await capturedIoUseCallback!(socket, next);

    expect(next).toHaveBeenCalledWith(/* no error */);
    expect(next.mock.calls[0]).toHaveLength(0);
  });

  it('given ps_sock_* token not found in DB, should reject with error', async () => {
    mockDbFindFirst.mockResolvedValue(null);

    const socket = createMockSocket({
      handshake: {
        auth: { token: 'ps_sock_invalidtoken' },
        headers: { origin: undefined },
        address: '127.0.0.1',
      },
    });
    const next = vi.fn();

    await capturedIoUseCallback!(socket, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('Invalid or expired socket token'),
    }));
  });

  it('given ps_sock_* token DB error, should reject with error', async () => {
    mockDbFindFirst.mockRejectedValue(new Error('DB connection failed'));

    const socket = createMockSocket({
      handshake: {
        auth: { token: 'ps_sock_dbfailtoken' },
        headers: { origin: undefined },
        address: '127.0.0.1',
      },
    });
    const next = vi.fn();

    await capturedIoUseCallback!(socket, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('Invalid or expired socket token'),
    }));
  });

  it('given valid ps_sess_* token, should authenticate and call next()', async () => {
    vi.mocked(sessionService.validateSession).mockResolvedValue({
      userId: 'user-from-session',
      sessionId: 'sess-1',
      expiresAt: new Date(),
    } as Parameters<typeof sessionService.validateSession>[0] extends string
      ? Awaited<ReturnType<typeof sessionService.validateSession>>
      : never);
    mockDbLimit.mockResolvedValue([]);

    const socket = createMockSocket({
      handshake: {
        auth: { token: 'ps_sess_valid123' },
        headers: { origin: undefined },
        address: '127.0.0.1',
      },
    });
    const next = vi.fn();

    await capturedIoUseCallback!(socket, next);

    expect(next).toHaveBeenCalledWith(/* no error */);
    expect(next.mock.calls[0]).toHaveLength(0);
  });

  it('given ps_sess_* token that fails validation, should reject', async () => {
    vi.mocked(sessionService.validateSession).mockResolvedValue(null);

    const socket = createMockSocket({
      handshake: {
        auth: { token: 'ps_sess_invalid' },
        headers: { origin: undefined },
        address: '127.0.0.1',
      },
    });
    const next = vi.fn();

    await capturedIoUseCallback!(socket, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('Invalid or expired session'),
    }));
  });

  it('given ps_sess_* token throws error, should reject with server error', async () => {
    vi.mocked(sessionService.validateSession).mockRejectedValue(new Error('Session service error'));

    const socket = createMockSocket({
      handshake: {
        auth: { token: 'ps_sess_throws' },
        headers: { origin: undefined },
        address: '127.0.0.1',
      },
    });
    const next = vi.fn();

    await capturedIoUseCallback!(socket, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('Server failed'),
    }));
  });

  it('given unknown token format, should reject with invalid token format error', async () => {
    const socket = createMockSocket({
      handshake: {
        auth: { token: 'unknown_format_token' },
        headers: { origin: undefined },
        address: '127.0.0.1',
      },
    });
    const next = vi.fn();

    await capturedIoUseCallback!(socket, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('Invalid token format'),
    }));
  });

  it('given no origin and no configuration, should allow connection', async () => {
    vi.mocked(sessionService.validateSession).mockResolvedValue({
      userId: 'user-1',
      sessionId: 'sess-1',
      expiresAt: new Date(),
    } as Parameters<typeof sessionService.validateSession>[0] extends string
      ? Awaited<ReturnType<typeof sessionService.validateSession>>
      : never);
    mockDbLimit.mockResolvedValue([]);

    const socket = createMockSocket({
      handshake: {
        auth: { token: 'ps_sess_test' },
        headers: { origin: undefined }, // no origin header
        address: '127.0.0.1',
      },
    });
    const next = vi.fn();

    await capturedIoUseCallback!(socket, next);

    // With no CORS_ORIGIN/WEB_APP_URL configured, origin=undefined passes through
    expect(next).toHaveBeenCalledWith(/* no error */);
    expect(next.mock.calls[0]).toHaveLength(0);
  });
});

describe('Socket.IO middleware - origin blocking in production', () => {
  afterEach(() => {
    delete process.env.WEB_APP_URL;
    delete process.env.CORS_ORIGIN;
    delete process.env.NODE_ENV;
    delete process.env.ADDITIONAL_ALLOWED_ORIGINS;
  });

  it('given valid origin matching configured URL, should allow connection', async () => {
    process.env.WEB_APP_URL = 'http://localhost:3000';
    vi.mocked(sessionService.validateSession).mockResolvedValue({
      userId: 'user-1',
    } as Awaited<ReturnType<typeof sessionService.validateSession>>);
    mockDbLimit.mockResolvedValue([]);

    const socket = createMockSocket({
      handshake: {
        auth: { token: 'ps_sess_test' },
        headers: { origin: 'http://localhost:3000' },
        address: '127.0.0.1',
      },
    });
    const next = vi.fn();

    await capturedIoUseCallback!(socket, next);

    expect(next.mock.calls[0]).toHaveLength(0);
  });

  it('given production mode with no allowed origins, should reject', async () => {
    delete process.env.WEB_APP_URL;
    delete process.env.CORS_ORIGIN;
    process.env.NODE_ENV = 'production';

    const socket = createMockSocket({
      handshake: {
        auth: { token: 'ps_sess_test' },
        headers: { origin: 'https://some-origin.example.com' },
        address: '127.0.0.1',
      },
    });
    const next = vi.fn();

    await capturedIoUseCallback!(socket, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('Origin not allowed'),
    }));
  });

  it('given development mode with no allowed origins, should allow (with warning)', async () => {
    delete process.env.WEB_APP_URL;
    delete process.env.CORS_ORIGIN;
    process.env.NODE_ENV = 'development';

    vi.mocked(sessionService.validateSession).mockResolvedValue({
      userId: 'user-1',
    } as Awaited<ReturnType<typeof sessionService.validateSession>>);
    mockDbLimit.mockResolvedValue([]);

    const socket = createMockSocket({
      handshake: {
        auth: { token: 'ps_sess_test' },
        headers: { origin: 'http://localhost:3000' },
        address: '127.0.0.1',
      },
    });
    const next = vi.fn();

    await capturedIoUseCallback!(socket, next);

    expect(next.mock.calls[0]).toHaveLength(0);
  });

  it('given CORS_ORIGIN configured, should use CORS_ORIGIN for validation', async () => {
    process.env.CORS_ORIGIN = 'https://cors.example.com';

    vi.mocked(sessionService.validateSession).mockResolvedValue({
      userId: 'user-1',
    } as Awaited<ReturnType<typeof sessionService.validateSession>>);
    mockDbLimit.mockResolvedValue([]);

    const socket = createMockSocket({
      handshake: {
        auth: { token: 'ps_sess_test' },
        headers: { origin: 'https://cors.example.com' },
        address: '127.0.0.1',
      },
    });
    const next = vi.fn();

    await capturedIoUseCallback!(socket, next);

    expect(next.mock.calls[0]).toHaveLength(0);
  });

  it('given ADDITIONAL_ALLOWED_ORIGINS configured, should include them', async () => {
    process.env.WEB_APP_URL = 'https://app.example.com';
    process.env.ADDITIONAL_ALLOWED_ORIGINS = 'https://staging.example.com,https://dev.example.com';

    vi.mocked(sessionService.validateSession).mockResolvedValue({
      userId: 'user-1',
    } as Awaited<ReturnType<typeof sessionService.validateSession>>);
    mockDbLimit.mockResolvedValue([]);

    const socket = createMockSocket({
      handshake: {
        auth: { token: 'ps_sess_test' },
        headers: { origin: 'https://staging.example.com' },
        address: '127.0.0.1',
      },
    });
    const next = vi.fn();

    await capturedIoUseCallback!(socket, next);

    expect(next.mock.calls[0]).toHaveLength(0);
  });

  it('given malformed origin that fails normalization, should block connection', async () => {
    process.env.WEB_APP_URL = 'https://app.example.com';

    const socket = createMockSocket({
      handshake: {
        auth: { token: 'ps_sess_test' },
        headers: { origin: 'not-a-valid-origin' },
        address: '127.0.0.1',
      },
    });
    const next = vi.fn();

    await capturedIoUseCallback!(socket, next);

    // Malformed origin doesn't match any allowed origin
    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('Origin not allowed'),
    }));
  });

  it('given CORS_ORIGIN with invalid URL, should produce empty origins list and allow in dev', async () => {
    process.env.CORS_ORIGIN = 'not-a-url';
    process.env.NODE_ENV = 'development';

    vi.mocked(sessionService.validateSession).mockResolvedValue({
      userId: 'user-1',
    } as Awaited<ReturnType<typeof sessionService.validateSession>>);
    mockDbLimit.mockResolvedValue([]);

    // With bad CORS_ORIGIN, normalizeOrigin returns '', so origins list is empty
    // With no WEB_APP_URL either, we get no_config in dev - allowed
    const socket = createMockSocket({
      handshake: {
        auth: { token: 'ps_sess_test' },
        headers: { origin: 'http://localhost:3000' },
        address: '127.0.0.1',
      },
    });
    const next = vi.fn();

    await capturedIoUseCallback!(socket, next);

    // In dev with no valid config, should warn but allow
    expect(next.mock.calls[0]).toHaveLength(0);
  });
});

describe('Socket.IO connection handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIo.to.mockReturnThis();
    mockPresenceTracker.removeSocket.mockReturnValue([]);
    mockPresenceTracker.getUniqueViewers.mockReturnValue([]);
    mockPresenceTracker.getDriveId.mockReturnValue(undefined);
    mockSocketRegistry.getSocketsForUser.mockReturnValue([]);
    mockSocketRegistry.getRoomsForSocket.mockReturnValue([]);
  });

  it('given connected user with id, should register socket and join personal rooms', () => {
    const socket = createMockSocket({
      id: 'socket-conn-1',
      data: { user: { id: 'user-conn-1', name: 'Test', avatarUrl: null } },
    });

    capturedIoConnectionCallback!(socket);

    expect(mockSocketRegistry.registerSocket).toHaveBeenCalledWith('user-conn-1', 'socket-conn-1');
    expect(socket.join).toHaveBeenCalledWith('notifications:user-conn-1');
    expect(socket.join).toHaveBeenCalledWith('user:user-conn-1:tasks');
    expect(socket.join).toHaveBeenCalledWith('user:user-conn-1:calendar');
    expect(socket.join).toHaveBeenCalledWith('user:user-conn-1:drives');
    expect(mockSocketRegistry.trackRoomJoin).toHaveBeenCalledWith('socket-conn-1', 'notifications:user-conn-1');
  });

  it('given no user on socket, should not register or join rooms', () => {
    const socket = createMockSocket({
      data: { user: undefined },
    });

    capturedIoConnectionCallback!(socket);

    expect(mockSocketRegistry.registerSocket).not.toHaveBeenCalled();
    expect(socket.join).not.toHaveBeenCalled();
  });

  describe('join_channel event', () => {
    it('given valid pageId and access, should join channel room', async () => {
      vi.mocked(getUserAccessLevel).mockResolvedValue({
        canView: true,
        canEdit: true,
        canShare: false,
        canDelete: false,
      });

      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      await socket._trigger('join_channel', 'athmieqpwr4ax1t2e0i4lmor');

      expect(socket.join).toHaveBeenCalledWith('athmieqpwr4ax1t2e0i4lmor');
    });

    it('given no access, should disconnect socket', async () => {
      vi.mocked(getUserAccessLevel).mockResolvedValue(null);

      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      await socket._trigger('join_channel', 'athmieqpwr4ax1t2e0i4lmor');

      expect(socket.disconnect).toHaveBeenCalledTimes(1);
    });

    it('given invalid pageId, should emit validation error', async () => {
      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      await socket._trigger('join_channel', 'invalid-id!');

      expect(emitValidationError).toHaveBeenCalledWith(socket, 'join_channel', 'invalid Page ID format');
    });

    it('given getUserAccessLevel throws, should disconnect', async () => {
      vi.mocked(getUserAccessLevel).mockRejectedValue(new Error('DB error'));

      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      await socket._trigger('join_channel', 'athmieqpwr4ax1t2e0i4lmor');

      expect(socket.disconnect).toHaveBeenCalledTimes(1);
    });
  });

  describe('join_drive event', () => {
    it('given valid driveId and access, should join drive and drive calendar rooms', async () => {
      vi.mocked(getUserDriveAccess).mockResolvedValue(true);

      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      await socket._trigger('join_drive', 'athmieqpwr4ax1t2e0i4lmor');

      expect(socket.join).toHaveBeenCalledWith('drive:athmieqpwr4ax1t2e0i4lmor');
      expect(socket.join).toHaveBeenCalledWith('drive:athmieqpwr4ax1t2e0i4lmor:calendar');
    });

    it('given no access, should not join drive rooms', async () => {
      vi.mocked(getUserDriveAccess).mockResolvedValue(false);

      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      const joinCallsBefore = socket.join.mock.calls.length;
      await socket._trigger('join_drive', 'athmieqpwr4ax1t2e0i4lmor');
      const joinCallsAfter = socket.join.mock.calls.length;

      // No new joins for drive rooms
      expect(joinCallsAfter).toBe(joinCallsBefore);
    });

    it('given invalid driveId, should emit validation error', async () => {
      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      await socket._trigger('join_drive', 12345);

      expect(emitValidationError).toHaveBeenCalledWith(socket, 'join_drive', 'Drive ID must be a valid ID');
    });

    it('given getUserDriveAccess throws, should log error', async () => {
      vi.mocked(getUserDriveAccess).mockRejectedValue(new Error('DB error'));

      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      await socket._trigger('join_drive', 'athmieqpwr4ax1t2e0i4lmor');

      expect(vi.mocked(loggers.realtime.error)).toHaveBeenCalledWith('Error joining drive', expect.objectContaining({ message: 'DB error' }), { driveId: 'athmieqpwr4ax1t2e0i4lmor' });
    });
  });

  describe('join_dm_conversation event', () => {
    it('given valid conversationId and participant, should join DM room', async () => {
      mockDbLimit.mockResolvedValue([{ id: 'conv-1' }]);

      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      await socket._trigger('join_dm_conversation', 'athmieqpwr4ax1t2e0i4lmor');

      expect(socket.join).toHaveBeenCalledWith('dm:athmieqpwr4ax1t2e0i4lmor');
    });

    it('given not participant (empty result), should not join room', async () => {
      mockDbLimit.mockResolvedValue([]);

      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      const joinCountBefore = socket.join.mock.calls.length;
      await socket._trigger('join_dm_conversation', 'athmieqpwr4ax1t2e0i4lmor');
      const joinCountAfter = socket.join.mock.calls.length;

      expect(joinCountAfter).toBe(joinCountBefore);
    });

    it('given invalid conversationId, should emit validation error', async () => {
      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      await socket._trigger('join_dm_conversation', { not: 'a string' });

      expect(emitValidationError).toHaveBeenCalledWith(socket, 'join_dm_conversation', 'Conversation ID must be a valid ID');
    });

    it('given DB error, should log error', async () => {
      mockDbLimit.mockRejectedValue(new Error('DB error'));

      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      await socket._trigger('join_dm_conversation', 'athmieqpwr4ax1t2e0i4lmor');

      expect(vi.mocked(loggers.realtime.error)).toHaveBeenCalledWith('Error joining DM conversation', expect.objectContaining({ message: 'DB error' }), { conversationId: 'athmieqpwr4ax1t2e0i4lmor' });
    });
  });

  describe('leave_dm_conversation event', () => {
    it('given valid conversationId, should leave DM room', () => {
      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      socket._trigger('leave_dm_conversation', 'athmieqpwr4ax1t2e0i4lmor');

      expect(socket.leave).toHaveBeenCalledWith('dm:athmieqpwr4ax1t2e0i4lmor');
    });

    it('given invalid conversationId, should emit validation error', () => {
      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      socket._trigger('leave_dm_conversation', null);

      expect(emitValidationError).toHaveBeenCalledWith(socket, 'leave_dm_conversation', 'Conversation ID must be a valid ID');
    });
  });

  describe('leave_drive event', () => {
    it('given valid driveId, should leave drive rooms', () => {
      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      socket._trigger('leave_drive', 'athmieqpwr4ax1t2e0i4lmor');

      expect(socket.leave).toHaveBeenCalledWith('drive:athmieqpwr4ax1t2e0i4lmor');
      expect(socket.leave).toHaveBeenCalledWith('drive:athmieqpwr4ax1t2e0i4lmor:calendar');
    });

    it('given invalid driveId, should emit validation error', () => {
      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      socket._trigger('leave_drive', 42);

      expect(emitValidationError).toHaveBeenCalledWith(socket, 'leave_drive', 'Drive ID must be a valid ID');
    });
  });

  describe('join_activity_drive event', () => {
    it('given valid driveId and access, should join activity drive room', async () => {
      vi.mocked(getUserDriveAccess).mockResolvedValue(true);

      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      await socket._trigger('join_activity_drive', 'athmieqpwr4ax1t2e0i4lmor');

      expect(socket.join).toHaveBeenCalledWith('activity:drive:athmieqpwr4ax1t2e0i4lmor');
    });

    it('given no access, should not join activity drive room', async () => {
      vi.mocked(getUserDriveAccess).mockResolvedValue(false);

      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      const joinsBefore = socket.join.mock.calls.length;
      await socket._trigger('join_activity_drive', 'athmieqpwr4ax1t2e0i4lmor');
      const joinsAfter = socket.join.mock.calls.length;

      expect(joinsAfter).toBe(joinsBefore);
    });

    it('given invalid driveId, should emit validation error', async () => {
      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      await socket._trigger('join_activity_drive', null);

      expect(emitValidationError).toHaveBeenCalledWith(socket, 'join_activity_drive', 'Drive ID must be a valid ID');
    });

    it('given getUserDriveAccess throws, should log error', async () => {
      vi.mocked(getUserDriveAccess).mockRejectedValue(new Error('DB error'));

      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      await socket._trigger('join_activity_drive', 'athmieqpwr4ax1t2e0i4lmor');

      expect(vi.mocked(loggers.realtime.error)).toHaveBeenCalledWith('Error joining activity drive', expect.objectContaining({ message: 'DB error' }), { driveId: 'athmieqpwr4ax1t2e0i4lmor' });
    });
  });

  describe('join_activity_page event', () => {
    it('given valid pageId and access, should join activity page room', async () => {
      vi.mocked(getUserAccessLevel).mockResolvedValue({
        canView: true,
        canEdit: true,
        canShare: false,
        canDelete: false,
      });

      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      await socket._trigger('join_activity_page', 'athmieqpwr4ax1t2e0i4lmor');

      expect(socket.join).toHaveBeenCalledWith('activity:page:athmieqpwr4ax1t2e0i4lmor');
    });

    it('given no access, should not join activity page room', async () => {
      vi.mocked(getUserAccessLevel).mockResolvedValue(null);

      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      const joinsBefore = socket.join.mock.calls.length;
      await socket._trigger('join_activity_page', 'athmieqpwr4ax1t2e0i4lmor');
      const joinsAfter = socket.join.mock.calls.length;

      expect(joinsAfter).toBe(joinsBefore);
    });

    it('given invalid pageId, should emit validation error', async () => {
      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      await socket._trigger('join_activity_page', null);

      expect(emitValidationError).toHaveBeenCalledWith(socket, 'join_activity_page', 'invalid Page ID format');
    });

    it('given getUserAccessLevel throws, should log error', async () => {
      vi.mocked(getUserAccessLevel).mockRejectedValue(new Error('DB error'));

      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      await socket._trigger('join_activity_page', 'athmieqpwr4ax1t2e0i4lmor');

      expect(vi.mocked(loggers.realtime.error)).toHaveBeenCalledWith('Error joining activity page', expect.objectContaining({ message: 'DB error' }), { pageId: 'athmieqpwr4ax1t2e0i4lmor' });
    });
  });

  describe('leave_activity_drive event', () => {
    it('given valid driveId, should leave activity drive room', () => {
      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      socket._trigger('leave_activity_drive', 'athmieqpwr4ax1t2e0i4lmor');

      expect(socket.leave).toHaveBeenCalledWith('activity:drive:athmieqpwr4ax1t2e0i4lmor');
    });

    it('given invalid driveId, should emit validation error', () => {
      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      socket._trigger('leave_activity_drive', true);

      expect(emitValidationError).toHaveBeenCalledWith(socket, 'leave_activity_drive', 'Drive ID must be a valid ID');
    });
  });

  describe('leave_activity_page event', () => {
    it('given valid pageId, should leave activity page room', () => {
      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      socket._trigger('leave_activity_page', 'athmieqpwr4ax1t2e0i4lmor');

      expect(socket.leave).toHaveBeenCalledWith('activity:page:athmieqpwr4ax1t2e0i4lmor');
    });

    it('given invalid pageId, should emit validation error', () => {
      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      socket._trigger('leave_activity_page', null);

      expect(emitValidationError).toHaveBeenCalledWith(socket, 'leave_activity_page', 'invalid Page ID format');
    });
  });

  describe('presence:join_page event', () => {
    it('given valid pageId, access, and page found, should add viewer and emit', async () => {
      vi.mocked(getUserAccessLevel).mockResolvedValue({
        canView: true,
        canEdit: true,
        canShare: false,
        canDelete: false,
      });
      mockDbLimit.mockResolvedValue([{ driveId: 'drive-1' }]);
      mockPresenceTracker.getUniqueViewers.mockReturnValue([
        { userId: 'user-1', socketId: 'socket-1', name: 'Test', avatarUrl: null },
      ]);

      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'Test', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      await socket._trigger('presence:join_page', { pageId: 'athmieqpwr4ax1t2e0i4lmor' });

      expect(mockPresenceTracker.addViewer).toHaveBeenCalledWith('athmieqpwr4ax1t2e0i4lmor', 'drive-1', {
        userId: 'user-1',
        socketId: 'socket-1',
        name: 'Test',
        avatarUrl: null,
      });
      expect(mockIo.to).toHaveBeenCalledWith('athmieqpwr4ax1t2e0i4lmor');
    });

    it('given no access, should not add viewer', async () => {
      vi.mocked(getUserAccessLevel).mockResolvedValue(null);

      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      await socket._trigger('presence:join_page', { pageId: 'athmieqpwr4ax1t2e0i4lmor' });

      expect(mockPresenceTracker.addViewer).not.toHaveBeenCalled();
    });

    it('given page not found in DB, should not add viewer', async () => {
      vi.mocked(getUserAccessLevel).mockResolvedValue({
        canView: true,
        canEdit: true,
        canShare: false,
        canDelete: false,
      });
      mockDbLimit.mockResolvedValue([]); // no page

      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      await socket._trigger('presence:join_page', { pageId: 'athmieqpwr4ax1t2e0i4lmor' });

      expect(mockPresenceTracker.addViewer).not.toHaveBeenCalled();
    });

    it('given invalid presence payload, should emit validation error', async () => {
      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      await socket._trigger('presence:join_page', null);

      expect(emitValidationError).toHaveBeenCalledWith(socket, 'presence:join_page', 'Invalid payload: pageId required');
    });

    it('given error in presence join, should log error', async () => {
      vi.mocked(getUserAccessLevel).mockRejectedValue(new Error('DB error'));

      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      await socket._trigger('presence:join_page', { pageId: 'athmieqpwr4ax1t2e0i4lmor' });

      expect(vi.mocked(loggers.realtime.error)).toHaveBeenCalledWith('Error joining page presence', expect.objectContaining({ message: 'DB error' }), { pageId: 'athmieqpwr4ax1t2e0i4lmor' });
    });
  });

  describe('presence:leave_page event', () => {
    it('given valid pageId, should remove viewer and emit updated list', () => {
      mockPresenceTracker.getDriveId.mockReturnValue('drive-1');
      mockPresenceTracker.getUniqueViewers.mockReturnValue([]);

      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      socket._trigger('presence:leave_page', { pageId: 'athmieqpwr4ax1t2e0i4lmor' });

      expect(mockPresenceTracker.removeViewer).toHaveBeenCalledWith('socket-1', 'athmieqpwr4ax1t2e0i4lmor');
      expect(mockIo.to).toHaveBeenCalledWith('athmieqpwr4ax1t2e0i4lmor');
    });

    it('given no driveId cached, should only emit to page room', () => {
      mockPresenceTracker.getDriveId.mockReturnValue(undefined);
      mockPresenceTracker.getUniqueViewers.mockReturnValue([]);

      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      socket._trigger('presence:leave_page', { pageId: 'athmieqpwr4ax1t2e0i4lmor' });

      expect(mockPresenceTracker.removeViewer).toHaveBeenCalledWith('socket-1', 'athmieqpwr4ax1t2e0i4lmor');
      // io.to called only with the page id (not a drive room)
      expect(mockIo.to).toHaveBeenCalledWith('athmieqpwr4ax1t2e0i4lmor');
    });

    it('given invalid payload, should emit validation error', () => {
      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      socket._trigger('presence:leave_page', { noPageId: true });

      expect(emitValidationError).toHaveBeenCalledWith(socket, 'presence:leave_page', 'Invalid payload: pageId required');
    });
  });

  describe('disconnect event', () => {
    it('given disconnect, should remove socket from presence tracker and unregister', () => {
      mockPresenceTracker.removeSocket.mockReturnValue([
        { pageId: 'page-1', driveId: 'drive-1' },
      ]);
      mockPresenceTracker.getUniqueViewers.mockReturnValue([]);

      const socket = createMockSocket({ id: 'socket-dc', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      socket._trigger('disconnect', 'transport close');

      expect(mockPresenceTracker.removeSocket).toHaveBeenCalledWith('socket-dc');
      expect(mockSocketRegistry.unregisterSocket).toHaveBeenCalledWith('socket-dc');
      expect(mockIo.to).toHaveBeenCalledWith('page-1');
    });

    it('given disconnect with no affected pages, should still unregister socket', () => {
      mockPresenceTracker.removeSocket.mockReturnValue([]);

      const socket = createMockSocket({ id: 'socket-dc2', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      socket._trigger('disconnect', 'transport close');

      expect(mockSocketRegistry.unregisterSocket).toHaveBeenCalledWith('socket-dc2');
    });

    it('given disconnect with affected page but no driveId, should only broadcast to page room', () => {
      mockPresenceTracker.removeSocket.mockReturnValue([
        { pageId: 'page-1', driveId: '' }, // empty driveId (falsy)
      ]);
      mockPresenceTracker.getUniqueViewers.mockReturnValue([]);

      const socket = createMockSocket({ id: 'socket-dc3', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      socket._trigger('disconnect', 'client disconnect');

      expect(mockIo.to).toHaveBeenCalledWith('page-1');
      // No drive room broadcast
      const toCalls = (mockIo.to as ReturnType<typeof vi.fn>).mock.calls;
      const driveRoomCalls = toCalls.filter((c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).startsWith('drive:'));
      expect(driveRoomCalls).toHaveLength(0);
    });
  });

  describe('document_update event', () => {
    it('given document_update, should be wrapped with withPerEventAuth', () => {
      const socket = createMockSocket({ id: 'socket-1', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      expect(mockWithPerEventAuth).toHaveBeenCalledTimes(1);
      const [authSocket, eventName, handler, opts] = mockWithPerEventAuth.mock.calls[0];
      expect(authSocket).toBe(socket);
      expect(eventName).toBe('document_update');
      expect(typeof handler).toBe('function');
      expect(typeof opts.pageIdExtractor).toBe('function');
    });

    it('given document_update handler invoked, should forward to room', async () => {
      const socket = createMockSocket({ id: 'socket-doc', data: { user: { id: 'user-1', name: 'T', avatarUrl: null } } });
      capturedIoConnectionCallback!(socket);

      // The document_update handler is passed to withPerEventAuth
      // Our mock of withPerEventAuth calls the handler directly
      await socket._trigger('document_update', { pageId: 'athmieqpwr4ax1t2e0i4lmor', content: 'test' });

      // Should forward to the page room
      expect(socket.to).toHaveBeenCalledWith('athmieqpwr4ax1t2e0i4lmor');
    });
  });

  describe('event handlers - no user early return', () => {
    // Tests the `if (!user?.id) return` branches in event handlers
    // These fire when the socket has no user data (shouldn't happen after auth middleware, but defensive)

    it('given join_channel with no user, should return early without making DB calls', async () => {
      const socket = createMockSocket({ data: { user: undefined } });
      capturedIoConnectionCallback!(socket);

      await socket._trigger('join_channel', 'athmieqpwr4ax1t2e0i4lmor');

      expect(getUserAccessLevel).not.toHaveBeenCalled();
    });

    it('given leave_drive with no user, should return early', () => {
      const socket = createMockSocket({ data: { user: undefined } });
      capturedIoConnectionCallback!(socket);

      socket._trigger('leave_drive', 'athmieqpwr4ax1t2e0i4lmor');

      expect(socket.leave).not.toHaveBeenCalled();
    });

    it('given join_activity_drive with no user, should return early', async () => {
      const socket = createMockSocket({ data: { user: undefined } });
      capturedIoConnectionCallback!(socket);

      await socket._trigger('join_activity_drive', 'athmieqpwr4ax1t2e0i4lmor');

      expect(getUserDriveAccess).not.toHaveBeenCalled();
    });

    it('given join_activity_page with no user, should return early', async () => {
      const socket = createMockSocket({ data: { user: undefined } });
      capturedIoConnectionCallback!(socket);

      await socket._trigger('join_activity_page', 'athmieqpwr4ax1t2e0i4lmor');

      expect(getUserAccessLevel).not.toHaveBeenCalled();
    });

    it('given leave_activity_drive with no user, should return early', () => {
      const socket = createMockSocket({ data: { user: undefined } });
      capturedIoConnectionCallback!(socket);

      socket._trigger('leave_activity_drive', 'athmieqpwr4ax1t2e0i4lmor');

      expect(socket.leave).not.toHaveBeenCalled();
    });

    it('given leave_activity_page with no user, should return early', () => {
      const socket = createMockSocket({ data: { user: undefined } });
      capturedIoConnectionCallback!(socket);

      socket._trigger('leave_activity_page', 'athmieqpwr4ax1t2e0i4lmor');

      expect(socket.leave).not.toHaveBeenCalled();
    });

    it('given presence:join_page with no user, should return early', async () => {
      const socket = createMockSocket({ data: { user: undefined } });
      capturedIoConnectionCallback!(socket);

      await socket._trigger('presence:join_page', { pageId: 'athmieqpwr4ax1t2e0i4lmor' });

      expect(mockPresenceTracker.addViewer).not.toHaveBeenCalled();
    });

    it('given presence:leave_page with no user, should return early', () => {
      const socket = createMockSocket({ data: { user: undefined } });
      capturedIoConnectionCallback!(socket);

      socket._trigger('presence:leave_page', { pageId: 'athmieqpwr4ax1t2e0i4lmor' });

      expect(mockPresenceTracker.removeViewer).not.toHaveBeenCalled();
    });

    it('given join_dm_conversation with no user, should return early', async () => {
      const socket = createMockSocket({ data: { user: undefined } });
      capturedIoConnectionCallback!(socket);

      await socket._trigger('join_dm_conversation', 'athmieqpwr4ax1t2e0i4lmor');

      expect(socket.join).not.toHaveBeenCalled();
    });

    it('given leave_dm_conversation with no user, should return early', () => {
      const socket = createMockSocket({ data: { user: undefined } });
      capturedIoConnectionCallback!(socket);

      socket._trigger('leave_dm_conversation', 'athmieqpwr4ax1t2e0i4lmor');

      expect(socket.leave).not.toHaveBeenCalled();
    });
  });
});

describe('populateUserMetadata', () => {
  // populateUserMetadata is called from the auth middleware after successful authentication.
  // It runs two DB queries in parallel (Promise.all): users and userProfiles.
  // We test it by going through the auth middleware with a session token.

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbSelect.mockReturnValue({ from: mockDbFrom });
    mockDbFrom.mockReturnValue({ where: mockDbWhere });
    mockDbWhere.mockReturnValue({ limit: mockDbLimit });
  });

  it('given successful DB lookup with profile data, should set name and avatarUrl from profile', async () => {
    // Promise.all runs both queries in parallel; each call to limit() returns the result
    mockDbLimit
      .mockResolvedValueOnce([{ name: 'DB Name', image: 'db-image.jpg' }]) // users query
      .mockResolvedValueOnce([{ displayName: 'Profile Name', avatarUrl: 'profile-avatar.jpg' }]); // userProfiles query

    vi.mocked(sessionService.validateSession).mockResolvedValue({
      userId: 'user-meta-1',
    } as Awaited<ReturnType<typeof sessionService.validateSession>>);

    const socket = createMockSocket({
      id: 'socket-meta',
      data: { user: { id: 'user-meta-1', name: 'Unknown', avatarUrl: null } },
      handshake: {
        auth: { token: 'ps_sess_meta' },
        headers: { origin: undefined },
        address: '127.0.0.1',
      },
    });
    const next = vi.fn();

    await capturedIoUseCallback!(socket, next);

    expect(next).toHaveBeenCalledTimes(1);
    // Profile name takes precedence - socket data should be updated
    expect((socket.data.user as { name: string }).name).toBe('Profile Name');
  });

  it('given no profile but user has name, should fall back to user name', async () => {
    mockDbLimit
      .mockResolvedValueOnce([{ name: 'User Name', image: null }]) // users query
      .mockResolvedValueOnce([]); // no profile

    vi.mocked(sessionService.validateSession).mockResolvedValue({
      userId: 'user-meta-2',
    } as Awaited<ReturnType<typeof sessionService.validateSession>>);

    const socket = createMockSocket({
      data: { user: { id: 'user-meta-2', name: 'Unknown', avatarUrl: null } },
      handshake: {
        auth: { token: 'ps_sess_meta2' },
        headers: { origin: undefined },
        address: '127.0.0.1',
      },
    });
    const next = vi.fn();

    await capturedIoUseCallback!(socket, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((socket.data.user as { name: string }).name).toBe('User Name');
  });

  it('given no user data at all, should use Unknown fallback', async () => {
    mockDbLimit
      .mockResolvedValueOnce([]) // no user
      .mockResolvedValueOnce([]); // no profile

    vi.mocked(sessionService.validateSession).mockResolvedValue({
      userId: 'user-meta-3',
    } as Awaited<ReturnType<typeof sessionService.validateSession>>);

    const socket = createMockSocket({
      data: { user: { id: 'user-meta-3', name: 'Unknown', avatarUrl: null } },
      handshake: {
        auth: { token: 'ps_sess_meta3' },
        headers: { origin: undefined },
        address: '127.0.0.1',
      },
    });
    const next = vi.fn();

    await capturedIoUseCallback!(socket, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((socket.data.user as { name: string }).name).toBe('Unknown');
  });

  it('given DB error during metadata population, should still call next() and use fallback', async () => {
    mockDbLimit.mockRejectedValue(new Error('DB error'));

    vi.mocked(sessionService.validateSession).mockResolvedValue({
      userId: 'user-meta-err',
    } as Awaited<ReturnType<typeof sessionService.validateSession>>);

    const socket = createMockSocket({
      data: { user: { id: 'user-meta-err', name: 'Unknown', avatarUrl: null } },
      handshake: {
        auth: { token: 'ps_sess_metaerr' },
        headers: { origin: undefined },
        address: '127.0.0.1',
      },
    });
    const next = vi.fn();

    await capturedIoUseCallback!(socket, next);

    // Should still proceed despite metadata error - fallback to Unknown
    expect(next).toHaveBeenCalledWith(/* no error */);
    expect(next.mock.calls[0]).toHaveLength(0);
    expect((socket.data.user as { name: string }).name).toBe('Unknown');
  });
});
