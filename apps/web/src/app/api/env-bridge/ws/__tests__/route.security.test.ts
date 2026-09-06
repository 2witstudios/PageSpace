/**
 * Security suite for the env-bridge WebSocket route — the checks mirrored
 * one-for-one from `mcp-ws/route.security.test.ts`, then the bridge's own:
 * exact scope, token↔env binding, token→enrollment binding (C8), the signed
 * hello, the handshake window, direction, heartbeat throttling, and results
 * delivered only after their machine signature verifies (invariant 7).
 *
 * The registry, correlator and bridge client are REAL (in-memory); the session
 * service, audit log, store, key ring and ws-security helpers are mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WebSocket, WebSocketServer } from 'ws';
import type { NextRequest } from 'next/server';
import { generateKeyPairSync, createPrivateKey, createPublicKey, createHash, sign as nodeSign } from 'node:crypto';

vi.mock('@pagespace/lib/auth/session-service', () => ({ sessionService: { validateSession: vi.fn() } }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/services/drive-envs/local-envs-enabled', () => ({ isLocalEnvsEnabled: vi.fn(() => true) }));
vi.mock('@/lib/websocket/ws-security', () => ({
  getConnectionFingerprint: vi.fn(() => 'fp-1'),
  validateMessageSize: vi.fn(() => ({ valid: true })),
  isSecureConnection: vi.fn(() => true),
}));
vi.mock('@/lib/drive-envs/drive-envs-runtime', () => ({ getDriveEnvStore: vi.fn() }));
vi.mock('@pagespace/lib/auth/env-bridge-signing-key', () => ({ loadServerSigningKeyring: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { sessionService } from '@pagespace/lib/auth/session-service';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { isLocalEnvsEnabled } from '@pagespace/lib/services/drive-envs/local-envs-enabled';
import { getConnectionFingerprint, isSecureConnection, validateMessageSize } from '@/lib/websocket/ws-security';
import { getDriveEnvStore } from '@/lib/drive-envs/drive-envs-runtime';
import { loadServerSigningKeyring } from '@pagespace/lib/auth/env-bridge-signing-key';
import { LOCAL_ENV_HEARTBEAT_WINDOW_MS } from '@pagespace/lib/services/drive-envs/drive-envs';
import { decodeFrame, encodeFrame, type Frame } from '@pagespace/lib/env-bridge/frame-codec';
import { encodeHelloForSigning, encodeResultForSigning, resultHashForFrame, type MachineResultFrame } from '@pagespace/lib/env-bridge/machine-signatures';
import { parseServerSigningKeyring, type SigningKeyPrimitives } from '@pagespace/lib/env-bridge/server-signing-key';
import { clearAllEnvConnectionsForTesting, getEnvConnection, readEnvLiveConnection, ENV_SUPERSEDED_CLOSE_CODE, ENV_SUPERSEDED_CLOSE_REASON } from '@/lib/websocket/ws-env-connections';
import { getEnvBridgeClient } from '@/lib/env-bridge/bridge-client';
import { envBridgeHash } from '@/lib/env-bridge/crypto';
import { ENV_BRIDGE_HELLO_TIMEOUT_MS, ENV_BRIDGE_PING_INTERVAL_MS } from '@/lib/env-bridge/ws-route-config';
import { UPGRADE, GET } from '../route';

// ---- keys -------------------------------------------------------------------
const primitives: SigningKeyPrimitives = {
  importPrivateKey: (pkcs8) => {
    const privateKey = createPrivateKey({ key: Buffer.from(pkcs8), type: 'pkcs8', format: 'der' });
    return { publicKey: new Uint8Array(createPublicKey(privateKey).export({ type: 'spki', format: 'der' })), sign: (m) => new Uint8Array(nodeSign(null, m, privateKey)) };
  },
  hash: (bytes) => createHash('sha256').update(bytes).digest('hex'),
};
const ringVerdict = parseServerSigningKeyring({ single: generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'), multi: undefined }, primitives);
if (!ringVerdict.ok) throw new Error('ring');
const ring = ringVerdict.keyring;
const machine = generateKeyPairSync('ed25519');
const machineB = generateKeyPairSync('ed25519');
const rogue = generateKeyPairSync('ed25519');
const spkiB64 = (k: typeof machine) => k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

// ---- fixtures -----------------------------------------------------------------
const NOW = new Date('2026-09-06T12:00:00.000Z');
const ENV = 'env_a';
const ENV_B = 'env_b';
const USER = 'user-1';
const CAPS = { shell: true, pty: false, fs: true, checkpoint: false };

function claimsFor(over: Record<string, unknown> = {}) {
  return { sessionId: 'sess-1', userId: USER, userRole: 'user', tokenVersion: 1, adminRoleVersion: 0, type: 'mcp', scopes: ['env:bridge'], expiresAt: new Date(NOW.getTime() + 3600_000), resourceType: 'drive_env', resourceId: ENV, ...over };
}

type LocalRow = { envId: string; ownerId: string; enrollmentId: string; machinePublicKey: string | null; serverKeyId: string | null; enrolledAt: Date | null; revokedAt: Date | null };
function rowFor(over: Partial<LocalRow> = {}): LocalRow {
  return { envId: ENV, ownerId: USER, enrollmentId: 'enr_a', machinePublicKey: spkiB64(machine), serverKeyId: ring.current.keyId, enrolledAt: NOW, revokedAt: null, ...over };
}

type FakeSocket = WebSocket & { readyState: number; sent: string[]; handlers: Record<string, (...args: unknown[]) => void>; emit: (event: string, ...args: unknown[]) => void };
function socket(): FakeSocket {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    sent,
    handlers,
    send: vi.fn((data: string) => sent.push(data)),
    close: vi.fn(function (this: { readyState: number }) {
      ws.readyState = 3;
    }),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers[event] = handler;
    }),
    emit: (event: string, ...args: unknown[]) => handlers[event]?.(...args),
  } as unknown as FakeSocket;
  return ws;
}

function request(over: { headers?: Record<string, string>; url?: string } = {}): NextRequest {
  return {
    headers: new Headers({ 'user-agent': 'pagespace-cli/1.0', 'x-forwarded-for': '203.0.113.7', authorization: 'Bearer mcp_opaque_token', ...over.headers }),
    url: over.url ?? `wss://example.com/api/env-bridge/ws?envId=${ENV}`,
  } as unknown as NextRequest;
}

function signedHello(envId = ENV, key = machine, over: Partial<{ capabilities: typeof CAPS; policyDigest: string }> = {}): string {
  const body = { envId, capabilities: over.capabilities ?? CAPS, policyDigest: over.policyDigest ?? 'sha256:policy' };
  return encodeFrame({ type: 'hello', ...body, sig: Buffer.from(nodeSign(null, encodeHelloForSigning(body), key.privateKey)).toString('base64') });
}

/** Distributive: `Omit` over the union would collapse it to the common keys. */
type UnsignedResult<T = MachineResultFrame> = T extends unknown ? Omit<T, 'sig'> : never;

function signedResult(body: UnsignedResult, key = machine): string {
  const resultHash = resultHashForFrame({ ...body, sig: '' } as MachineResultFrame, envBridgeHash);
  return encodeFrame({ ...body, sig: Buffer.from(nodeSign(null, encodeResultForSigning({ grantId: body.grantId, resultHash }), key.privateKey)).toString('base64') } as MachineResultFrame);
}

const events = () => vi.mocked(auditRequest).mock.calls.map((call) => (call[1] as { details?: { originalEvent?: string } }).details?.originalEvent);
const lastSent = (ws: FakeSocket): Frame => {
  const decoded = decodeFrame(ws.sent[ws.sent.length - 1]!, { maxFrameBytes: 1024 * 1024 });
  if (!decoded.ok) throw new Error(decoded.reason);
  return decoded.frame;
};
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('env-bridge ws route', () => {
  let rows: Map<string, LocalRow>;
  let store: { findLocalByEnvId: ReturnType<typeof vi.fn>; recordHello: ReturnType<typeof vi.fn>; recordHeartbeat: ReturnType<typeof vi.fn> };
  const server = {} as unknown as WebSocketServer;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    clearAllEnvConnectionsForTesting();
    rows = new Map([[ENV, rowFor()], [ENV_B, rowFor({ envId: ENV_B, enrollmentId: 'enr_b', machinePublicKey: spkiB64(machineB) })]]);
    store = {
      findLocalByEnvId: vi.fn(async (envId: string) => rows.get(envId) ?? null),
      recordHello: vi.fn(async ({ envId }: { envId: string }) => {
        const row = rows.get(envId);
        return !!row && row.enrolledAt !== null && row.revokedAt === null;
      }),
      recordHeartbeat: vi.fn(async ({ envId }: { envId: string }) => {
        const row = rows.get(envId);
        return !!row && row.enrolledAt !== null && row.revokedAt === null;
      }),
    };
    vi.mocked(getDriveEnvStore).mockResolvedValue(store as never);
    vi.mocked(sessionService.validateSession).mockResolvedValue(claimsFor() as never);
    vi.mocked(isLocalEnvsEnabled).mockReturnValue(true);
    vi.mocked(isSecureConnection).mockReturnValue(true);
    vi.mocked(getConnectionFingerprint).mockReturnValue('fp-1');
    vi.mocked(validateMessageSize).mockReturnValue({ valid: true } as never);
    vi.mocked(loadServerSigningKeyring).mockReturnValue(ring);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Upgrade + signed hello ⇒ an authorized socket. */
  async function connectAuthorized(envId = ENV, key = machine, req = request({ url: `wss://example.com/api/env-bridge/ws?envId=${envId}` })): Promise<FakeSocket> {
    const ws = socket();
    await UPGRADE(ws, server, req);
    ws.emit('message', Buffer.from(signedHello(envId, key)));
    await flush();
    return ws;
  }

  // ---- mirrored from mcp-ws ------------------------------------------------------
  describe('checks mirrored one-for-one from mcp-ws/route.ts', () => {
    it('SECURITY CHECK 1: given an insecure connection, should close 1008 "Secure connection required" and audit', async () => {
      vi.mocked(isSecureConnection).mockReturnValue(false);
      const ws = socket();
      await UPGRADE(ws, server, request());
      expect(ws.close).toHaveBeenCalledWith(1008, 'Secure connection required');
      expect(events()).toContain('ws_insecure_connection_rejected');
      expect(sessionService.validateSession).not.toHaveBeenCalled();
    });

    it('SECURITY CHECK 2: given no Authorization header, should close 1008 "Authorization required" and audit', async () => {
      const ws = socket();
      await UPGRADE(ws, server, { headers: new Headers({ 'user-agent': 'x' }), url: `wss://example.com/api/env-bridge/ws?envId=${ENV}` } as unknown as NextRequest);
      expect(ws.close).toHaveBeenCalledWith(1008, 'Authorization required');
      expect(events()).toContain('ws_authentication_failed');
    });

    it('SECURITY CHECK 2: should validate the opaque token with expectedType mcp; an invalid token closes 1008, a thrown validation closes 1008 "Authentication error"', async () => {
      vi.mocked(sessionService.validateSession).mockResolvedValueOnce(null);
      const ws = socket();
      await UPGRADE(ws, server, request());
      expect(sessionService.validateSession).toHaveBeenCalledWith('mcp_opaque_token', { expectedType: 'mcp' });
      expect(ws.close).toHaveBeenCalledWith(1008, 'Invalid or expired token');
      vi.mocked(sessionService.validateSession).mockRejectedValueOnce(new Error('db down'));
      const ws2 = socket();
      await UPGRADE(ws2, server, request());
      expect(ws2.close).toHaveBeenCalledWith(1008, 'Authentication error');
      expect(events()).toContain('ws_session_validation_error');
    });

    it.each([['mcp:*'], ['*'], ['mcp:ws'], ['env:bridge:read']])('SECURITY CHECK 3: given scope %s (not exactly env:bridge), should close 1008 "Insufficient permissions"', async (scope) => {
      vi.mocked(sessionService.validateSession).mockResolvedValue(claimsFor({ scopes: [scope] }) as never);
      const ws = socket();
      await UPGRADE(ws, server, request());
      expect(ws.close).toHaveBeenCalledWith(1008, 'Insufficient permissions');
      expect(events()).toContain('ws_insufficient_permissions');
      expect(getEnvConnection(ENV)).toBeUndefined();
    });

    it('SECURITY CHECK 4: should register the socket with the request fingerprint, session expiry and token (for revalidation), in hello_pending', async () => {
      const ws = socket();
      await UPGRADE(ws, server, request());
      expect(getConnectionFingerprint).toHaveBeenCalled();
      expect(getEnvConnection(ENV)).toBe(ws);
      expect(readEnvLiveConnection(ENV)).toBe('connecting');
      expect(events()).toContain('env_bridge_connection_pending');
      expect(ws.sent).toHaveLength(0);
    });

    it('SECURITY CHECK 5: given an oversized message once authorized, should audit and drop it without closing', async () => {
      const ws = await connectAuthorized();
      vi.mocked(validateMessageSize).mockReturnValueOnce({ valid: false, size: 2_000_000, maxSize: 1_048_576 } as never);
      ws.emit('message', Buffer.from('x'));
      expect(events()).toContain('ws_message_too_large');
      expect(ws.readyState).toBe(1);
    });

    it('SECURITY CHECK 5: given invalid JSON / an unknown frame type once authorized, should audit and drop it without closing (invariant 6)', async () => {
      const ws = await connectAuthorized();
      ws.emit('message', Buffer.from('{not json'));
      ws.emit('message', Buffer.from(JSON.stringify({ type: 'become_admin', isAdmin: true })));
      expect(events().filter((e) => e === 'ws_message_validation_failed')).toHaveLength(2);
      expect(ws.readyState).toBe(1);
    });

    it('SECURITY CHECK 6: given a pong whose fingerprint no longer matches, should close 1008 "Security violation" and audit', async () => {
      const ws = await connectAuthorized();
      vi.mocked(getConnectionFingerprint).mockReturnValue('fp-hijacked');
      ws.emit('message', Buffer.from(encodeFrame({ type: 'pong', ts: 1 })));
      await flush();
      expect(ws.close).toHaveBeenCalledWith(1008, 'Security violation');
      expect(events()).toContain('ws_fingerprint_mismatch');
    });

    it('SECURITY CHECK 7: given a result on a socket whose session has expired, should drop it and audit rather than accept it', async () => {
      vi.mocked(sessionService.validateSession).mockResolvedValue(claimsFor({ expiresAt: new Date(NOW.getTime() + 1_000) }) as never);
      const ws = await connectAuthorized();
      vi.setSystemTime(new Date(NOW.getTime() + 2_000));
      ws.emit('message', Buffer.from(signedResult({ type: 'grant_denied', grantId: 'g', reason: 'x' })));
      expect(events()).toContain('ws_unhealthy_connection_result');
    });

    it('should audit abnormal closes (not 1000/1001) and errors', async () => {
      const ws = await connectAuthorized();
      ws.emit('close', 1006, Buffer.from(''));
      expect(events()).toContain('ws_connection_closed');
      vi.mocked(sessionService.validateSession).mockResolvedValue(claimsFor({ resourceId: ENV_B, sessionId: 'sess-2' }) as never);
      const ws2 = await connectAuthorized(ENV_B, machineB);
      ws2.emit('error', new Error('boom'));
      expect(events()).toContain('ws_error');
      ws2.emit('close', 1000, Buffer.from(''));
      expect(events().filter((e) => e === 'ws_connection_closed')).toHaveLength(1);
    });

    it('GET should answer 426 Upgrade Required with hardening headers', () => {
      const response = GET();
      expect(response.status).toBe(426);
      expect(response.headers.get('Upgrade')).toBe('websocket');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    });
  });

  // ---- bridge-specific -------------------------------------------------------------
  describe('invariant 11 — the cloud opt-in', () => {
    it('given LOCAL_ENVS_ENABLED off, should close 1008 before touching the session service and audit', async () => {
      vi.mocked(isLocalEnvsEnabled).mockReturnValue(false);
      const ws = socket();
      await UPGRADE(ws, server, request());
      expect(ws.close).toHaveBeenCalledWith(1008, 'Not available');
      expect(sessionService.validateSession).not.toHaveBeenCalled();
      expect(events()).toContain('env_bridge_disabled');
    });
  });

  describe('token ↔ env binding', () => {
    it('given a token whose resourceId is another env, should refuse the upgrade 1008 and audit', async () => {
      vi.mocked(sessionService.validateSession).mockResolvedValue(claimsFor({ resourceId: ENV_B }) as never);
      const ws = socket();
      await UPGRADE(ws, server, request());
      expect(ws.close).toHaveBeenCalledWith(1008, 'Token not bound to this environment');
      expect(events()).toContain('env_bridge_token_env_mismatch');
      expect(store.findLocalByEnvId).not.toHaveBeenCalled();
    });

    it('given a token whose resourceType is not drive_env, or no envId in the URL, should refuse the upgrade', async () => {
      vi.mocked(sessionService.validateSession).mockResolvedValue(claimsFor({ resourceType: 'drive' }) as never);
      const ws = socket();
      await UPGRADE(ws, server, request());
      expect(ws.close).toHaveBeenCalledWith(1008, 'Token not bound to this environment');
      vi.mocked(sessionService.validateSession).mockResolvedValue(claimsFor() as never);
      const ws2 = socket();
      await UPGRADE(ws2, server, request({ url: 'wss://example.com/api/env-bridge/ws' }));
      expect(ws2.close).toHaveBeenCalledWith(1008, 'Token not bound to this environment');
    });
  });

  describe('Codex C8 — token → enrollment binding', () => {
    it.each([
      ['no row', () => rows.delete(ENV), 'not_found'],
      ['not enrolled', () => rows.set(ENV, rowFor({ enrolledAt: null, machinePublicKey: null })), 'not_enrolled'],
      ['revoked', () => rows.set(ENV, rowFor({ revokedAt: NOW })), 'revoked'],
      ['owned by another user', () => rows.set(ENV, rowFor({ ownerId: 'user-2' })), 'owner_mismatch'],
    ] as Array<[string, () => void, string]>)('given the enrollment row is %s, should refuse the upgrade 1008 and audit the reason', async (_label, arrange, reason) => {
      arrange();
      const ws = socket();
      await UPGRADE(ws, server, request());
      expect(ws.close).toHaveBeenCalledWith(1008, 'Environment not enrolled');
      expect(vi.mocked(auditRequest).mock.calls.some((c) => (c[1] as { details?: { reason?: string } }).details?.reason === reason)).toBe(true);
      expect(getEnvConnection(ENV)).toBeUndefined();
    });

    it('should verify the hello under THAT row\'s pinned key: a hello signed by another enrolled machine\'s key is refused', async () => {
      const ws = socket();
      await UPGRADE(ws, server, request());
      ws.emit('message', Buffer.from(signedHello(ENV, machineB)));
      await flush();
      expect(ws.close).toHaveBeenCalledWith(1008, 'Invalid hello');
      expect(events()).toContain('env_bridge_hello_invalid');
    });
  });

  describe('the signed hello', () => {
    it('given a hello signed by the pinned machine key for THIS env, should authorize: recordHello(capabilities), state connected, and the first server frame is a ping (the ack)', async () => {
      const ws = await connectAuthorized();
      expect(store.recordHello).toHaveBeenCalledWith({ envId: ENV, capabilities: CAPS, now: NOW });
      expect(readEnvLiveConnection(ENV)).toBe('connected');
      expect(events()).toContain('env_bridge_connection_established');
      expect(ws.sent).toHaveLength(1);
      expect(lastSent(ws).type).toBe('ping');
    });

    it('given a hello signed by a rogue key, should close 1008 "Invalid hello", audit at high risk, persist nothing', async () => {
      const ws = socket();
      await UPGRADE(ws, server, request());
      ws.emit('message', Buffer.from(signedHello(ENV, rogue)));
      await flush();
      expect(ws.close).toHaveBeenCalledWith(1008, 'Invalid hello');
      expect(store.recordHello).not.toHaveBeenCalled();
      expect(readEnvLiveConnection(ENV)).toBeNull();
    });

    it('given a correctly signed hello for ANOTHER env id, should close 1008 (wrong_env) before crypto', async () => {
      const ws = socket();
      await UPGRADE(ws, server, request());
      ws.emit('message', Buffer.from(signedHello(ENV_B, machine)));
      await flush();
      expect(ws.close).toHaveBeenCalledWith(1008, 'Invalid hello');
      expect(vi.mocked(auditRequest).mock.calls.some((c) => (c[1] as { details?: { reason?: string } }).details?.reason === 'wrong_env')).toBe(true);
    });

    it('given a tampered hello (capabilities changed after signing), should close 1008', async () => {
      const ws = socket();
      await UPGRADE(ws, server, request());
      const genuine = JSON.parse(signedHello()) as { capabilities: typeof CAPS };
      ws.emit('message', Buffer.from(JSON.stringify({ ...genuine, capabilities: { ...genuine.capabilities, pty: true } })));
      await flush();
      expect(ws.close).toHaveBeenCalledWith(1008, 'Invalid hello');
      expect(store.recordHello).not.toHaveBeenCalled();
    });

    it('given a first frame that is not a hello (a pong), should close 1008 "Hello required"', async () => {
      const ws = socket();
      await UPGRADE(ws, server, request());
      ws.emit('message', Buffer.from(encodeFrame({ type: 'pong', ts: 1 })));
      expect(ws.close).toHaveBeenCalledWith(1008, 'Hello required');
      expect(events()).toContain('env_bridge_hello_required');
    });

    it('given a malformed first frame, should close 1008 within the handshake', async () => {
      const ws = socket();
      await UPGRADE(ws, server, request());
      ws.emit('message', Buffer.from('garbage'));
      expect(ws.close).toHaveBeenCalledWith(1008, 'Hello required');
    });

    it('given no hello within the handshake window, should close 1008 "Handshake timeout" (fake timers)', async () => {
      const ws = socket();
      await UPGRADE(ws, server, request());
      await vi.advanceTimersByTimeAsync(ENV_BRIDGE_HELLO_TIMEOUT_MS - 1);
      expect(ws.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(ws.close).toHaveBeenCalledWith(1008, 'Handshake timeout');
      expect(events()).toContain('env_bridge_hello_timeout');
    });

    it('given the machine was revoked between the upgrade and the hello (recordHello CAS loses), should close 1008 "Environment revoked"', async () => {
      const ws = socket();
      await UPGRADE(ws, server, request());
      rows.set(ENV, rowFor({ revokedAt: NOW }));
      ws.emit('message', Buffer.from(signedHello()));
      await flush();
      expect(ws.close).toHaveBeenCalledWith(1008, 'Environment revoked');
      expect(readEnvLiveConnection(ENV)).toBeNull();
    });

    it('given a second hello once authorized, should drop it (never re-run the handshake)', async () => {
      const ws = await connectAuthorized();
      ws.emit('message', Buffer.from(signedHello()));
      await flush();
      expect(store.recordHello).toHaveBeenCalledTimes(1);
      expect(ws.readyState).toBe(1);
      expect(vi.mocked(auditRequest).mock.calls.some((c) => (c[1] as { details?: { reason?: string } }).details?.reason === 'duplicate_hello')).toBe(true);
    });
  });

  describe('heartbeat', () => {
    it('should ping every ENV_BRIDGE_PING_INTERVAL_MS once authorized', async () => {
      const ws = await connectAuthorized();
      expect(ws.sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(ENV_BRIDGE_PING_INTERVAL_MS);
      expect(ws.sent).toHaveLength(2);
      expect(lastSent(ws).type).toBe('ping');
    });

    it('given pongs, should persist lastSeenAt at most once per heartbeat window — not on every ping', async () => {
      const ws = await connectAuthorized();
      const pong = () => ws.emit('message', Buffer.from(encodeFrame({ type: 'pong', ts: Date.now() })));
      pong();
      await flush();
      await vi.advanceTimersByTimeAsync(30_000);
      pong();
      await flush();
      expect(store.recordHeartbeat).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(LOCAL_ENV_HEARTBEAT_WINDOW_MS - 30_000);
      pong();
      await flush();
      expect(store.recordHeartbeat).toHaveBeenCalledTimes(1);
      pong();
      await flush();
      expect(store.recordHeartbeat).toHaveBeenCalledTimes(1);
    });
  });

  describe('invariant 6 — direction and unknown frames', () => {
    it('given a server→machine frame type arriving FROM the machine (grant_exec), should drop + audit and keep the socket', async () => {
      const ws = await connectAuthorized();
      ws.emit('message', Buffer.from(encodeFrame({ type: 'grant_exec', grant: {}, sig: '', cmd: 'rm' })));
      expect(events()).toContain('env_bridge_wrong_direction_frame');
      expect(ws.readyState).toBe(1);
    });

    it('given a PTY frame in M1, should drop it as unsupported without crashing', async () => {
      const ws = await connectAuthorized();
      ws.emit('message', Buffer.from(encodeFrame({ type: 'pty_data', sessionId: 's', seq: 0, dataB64: '' })));
      expect(vi.mocked(auditRequest).mock.calls.some((c) => (c[1] as { details?: { reason?: string } }).details?.reason === 'unsupported_in_m1')).toBe(true);
      expect(ws.readyState).toBe(1);
    });
  });

  describe('invariant 7 — results reach the agent only after their machine signature verifies', () => {
    const principal = { userId: USER, sessionId: 'sess-1', conversationId: 'conv-1' };

    it('given a pending grant and an exec_result signed by the pinned machine key, should deliver it', async () => {
      const ws = await connectAuthorized();
      const pending = getEnvBridgeClient().sendGrant({ envId: ENV, frame: { type: 'grant_exec', cmd: 'ls' }, principal });
      const grantFrame = lastSent(ws);
      if (grantFrame.type !== 'grant_exec') throw new Error('grant not sent');
      const grantId = (grantFrame.grant as { grantId: string }).grantId;
      ws.emit('message', Buffer.from(signedResult({ type: 'exec_result', grantId, exitCode: 0, stdoutB64: 'b2s=', stderrB64: '', truncated: false })));
      await expect(pending).resolves.toMatchObject({ type: 'exec_result', grantId, exitCode: 0 });
    });

    it('given an exec_result whose machine signature does not verify, should NOT deliver it: typed unverified_result to the caller and a high-risk audit', async () => {
      const ws = await connectAuthorized();
      const pending = getEnvBridgeClient().sendGrant({ envId: ENV, frame: { type: 'grant_exec', cmd: 'ls' }, principal });
      const grantFrame = lastSent(ws);
      if (grantFrame.type !== 'grant_exec') throw new Error('grant not sent');
      const grantId = (grantFrame.grant as { grantId: string }).grantId;
      ws.emit('message', Buffer.from(signedResult({ type: 'exec_result', grantId, exitCode: 0, stdoutB64: 'cHduZWQ=', stderrB64: '', truncated: false }, rogue)));
      await expect(pending).rejects.toMatchObject({ kind: 'unverified_result' });
      expect(events()).toContain('env_bridge_result_unverified');
    });

    it('given a result for a grant nothing is waiting on, should drop it and audit', async () => {
      const ws = await connectAuthorized();
      ws.emit('message', Buffer.from(signedResult({ type: 'grant_denied', grantId: 'g-nobody', reason: 'x' })));
      expect(events()).toContain('env_bridge_result_dropped');
    });
  });

  describe('the per-env registry through the route', () => {
    const principal = { userId: USER, sessionId: 'sess-1', conversationId: 'conv-1' };

    it('given two envs for one user, both should be authorized and connected at once', async () => {
      const a = await connectAuthorized(ENV, machine);
      vi.mocked(sessionService.validateSession).mockResolvedValue(claimsFor({ resourceId: ENV_B, sessionId: 'sess-2' }) as never);
      const b = await connectAuthorized(ENV_B, machineB);
      expect(readEnvLiveConnection(ENV)).toBe('connected');
      expect(readEnvLiveConnection(ENV_B)).toBe('connected');
      expect(a.close).not.toHaveBeenCalled();
      expect(b.close).not.toHaveBeenCalled();
    });

    it('given a second socket for the same env, the newer wins, the older closes env_superseded, and its late close cancels nothing', async () => {
      const older = await connectAuthorized();
      const pending = getEnvBridgeClient().sendGrant({ envId: ENV, frame: { type: 'grant_exec', cmd: 'ls' }, principal });
      let state = 'pending';
      pending.then(() => (state = 'resolved'), () => (state = 'rejected'));
      const newer = await connectAuthorized();
      expect(older.close).toHaveBeenCalledWith(ENV_SUPERSEDED_CLOSE_CODE, ENV_SUPERSEDED_CLOSE_REASON);
      older.emit('close', ENV_SUPERSEDED_CLOSE_CODE, Buffer.from(ENV_SUPERSEDED_CLOSE_REASON));
      await flush();
      expect(state).toBe('pending');
      expect(getEnvConnection(ENV)).toBe(newer);
      expect(readEnvLiveConnection(ENV)).toBe('connected');
    });

    it('given the LIVE socket closes, its in-flight requests fail with typed disconnected and the env reads disconnected', async () => {
      const ws = await connectAuthorized();
      const pending = getEnvBridgeClient().sendGrant({ envId: ENV, frame: { type: 'grant_exec', cmd: 'ls' }, principal });
      ws.emit('close', 1006, Buffer.from(''));
      await expect(pending).rejects.toMatchObject({ kind: 'disconnected' });
      expect(readEnvLiveConnection(ENV)).toBeNull();
    });
  });
});
