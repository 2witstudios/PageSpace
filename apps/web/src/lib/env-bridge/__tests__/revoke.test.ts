/**
 * Revoke through the production seams: the row stamp, EVERY env:bridge session
 * for the env, and the machine's socket — signed by the key the enrollment
 * pinned, verified with the pure `verifyRevoke` (so t08's daemon agrees by
 * construction), closed 1008, and its in-flight requests failed at once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WebSocket } from 'ws';
import { generateKeyPairSync, createPrivateKey, createPublicKey, createHash, sign as nodeSign } from 'node:crypto';

vi.mock('@pagespace/lib/logging/logger-config', () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } }));
vi.mock('@pagespace/lib/auth/session-service', () => ({ sessionService: { revokeResourceSessions: vi.fn(async () => 2), validateSession: vi.fn() } }));
vi.mock('@pagespace/lib/auth/env-bridge-signing-key', () => ({ loadServerSigningKeyring: vi.fn() }));
vi.mock('@/lib/drive-envs/drive-envs-runtime', () => ({ getDriveEnvStore: vi.fn() }));

import { sessionService } from '@pagespace/lib/auth/session-service';
import { loadServerSigningKeyring } from '@pagespace/lib/auth/env-bridge-signing-key';
import { getDriveEnvStore } from '@/lib/drive-envs/drive-envs-runtime';
import { decodeFrame } from '@pagespace/lib/env-bridge/frame-codec';
import { verifyRevoke } from '@pagespace/lib/env-bridge/machine-signatures';
import { parseServerSigningKeyring, type SigningKeyPrimitives } from '@pagespace/lib/env-bridge/server-signing-key';
import { clearAllEnvConnectionsForTesting, getEnvConnection, markEnvAuthorized, registerEnvConnection } from '@/lib/websocket/ws-env-connections';
import { getEnvBridgeClient } from '@/lib/env-bridge/bridge-client';
import { ed25519Verify } from '@/lib/env-bridge/crypto';
import { revokeLocalEnv, buildRevokeFrame, ENV_REVOKED_CLOSE_CODE, ENV_REVOKED_CLOSE_REASON } from '../revoke';

const primitives: SigningKeyPrimitives = {
  importPrivateKey: (pkcs8) => {
    const privateKey = createPrivateKey({ key: Buffer.from(pkcs8), type: 'pkcs8', format: 'der' });
    return { publicKey: new Uint8Array(createPublicKey(privateKey).export({ type: 'spki', format: 'der' })), sign: (m) => new Uint8Array(nodeSign(null, m, privateKey)) };
  },
  hash: (bytes) => createHash('sha256').update(bytes).digest('hex'),
};
const pkcs8 = () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const ringVerdict = parseServerSigningKeyring({ single: undefined, multi: `${pkcs8()},${pkcs8()}` }, primitives);
if (!ringVerdict.ok) throw new Error('ring');
const ring = ringVerdict.keyring;
const [currentId, previousId] = ring.keyIds as [string, string];

const NOW = new Date('2026-09-06T12:00:00.000Z');
const ENV = 'env_a';

type FakeSocket = WebSocket & { readyState: number; sent: string[] };
function socket(): FakeSocket {
  const sent: string[] = [];
  const ws = { readyState: 1, sent, send: vi.fn((d: string) => sent.push(d)), close: vi.fn(() => { ws.readyState = 3; }), on: vi.fn() } as unknown as FakeSocket;
  return ws;
}

describe('revokeLocalEnv — all three legs through the production seams', () => {
  let row: { envId: string; enrollmentId: string; serverKeyId: string | null; revokedAt: Date | null } | null;
  let store: { findLocalByEnvId: ReturnType<typeof vi.fn>; revokeLocal: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    clearAllEnvConnectionsForTesting();
    row = { envId: ENV, enrollmentId: 'enr_a', serverKeyId: currentId, revokedAt: null };
    store = {
      findLocalByEnvId: vi.fn(async () => row),
      revokeLocal: vi.fn(async ({ now }: { now: Date }) => {
        if (!row || row.revokedAt !== null) return false;
        row.revokedAt = now;
        return true;
      }),
    };
    vi.mocked(getDriveEnvStore).mockResolvedValue(store as never);
    vi.mocked(loadServerSigningKeyring).mockReturnValue(ring);
    vi.mocked(sessionService.revokeResourceSessions).mockResolvedValue(2);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function liveSocket(serverKeyId: string | null = currentId, authorized = true): FakeSocket {
    const ws = socket();
    registerEnvConnection(ENV, ws, { userId: 'u', sessionId: 's', enrollmentId: 'enr_a', machinePublicKey: 'pk', serverKeyId, sessionExpiresAt: new Date(NOW.getTime() + 3600_000) });
    if (authorized) markEnvAuthorized(ws);
    return ws;
  }

  it('given an authorized socket, should stamp the row, revoke every drive_env session for the env, push a revoke frame the daemon can verify under the pinned key, close 1008 and unregister', async () => {
    const ws = liveSocket();
    const result = await revokeLocalEnv({ envId: ENV, reason: 'owner_revoked' });
    expect(result).toEqual({ ok: true, alreadyRevoked: false, revokedAt: NOW, sessionsRevoked: 2, machine: 'sent_and_closed' });
    expect(store.revokeLocal).toHaveBeenCalledWith({ envId: ENV, now: NOW });
    expect(sessionService.revokeResourceSessions).toHaveBeenCalledWith('drive_env', ENV, 'env_bridge_owner_revoked');
    expect(ws.sent).toHaveLength(1);
    const decoded = decodeFrame(ws.sent[0]!, { maxFrameBytes: 65536 });
    if (!decoded.ok || decoded.frame.type !== 'revoke') throw new Error('no revoke frame');
    expect(decoded.frame.issuedAt).toBe(NOW.getTime());
    expect(decoded.frame.reason).toBe('owner_revoked');
    // The daemon's check, by construction: the frame binds {envId, enrollmentId, keyId, issuedAt} under the pinned key.
    expect(verifyRevoke({ frame: decoded.frame, envId: ENV, enrollmentId: 'enr_a', keyId: currentId, issuedAt: NOW.getTime(), serverPublicKey: ring.get(currentId)!.publicKey, verify: ed25519Verify })).toEqual({ ok: true });
    expect(verifyRevoke({ frame: decoded.frame, envId: ENV, enrollmentId: 'enr_OTHER', keyId: currentId, issuedAt: NOW.getTime(), serverPublicKey: ring.get(currentId)!.publicKey, verify: ed25519Verify })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(ws.close).toHaveBeenCalledWith(ENV_REVOKED_CLOSE_CODE, ENV_REVOKED_CLOSE_REASON);
    expect(getEnvConnection(ENV)).toBeUndefined();
  });

  it('should fail the env\'s in-flight requests immediately with typed disconnected (the unregister runs through the lost listener)', async () => {
    liveSocket();
    const pending = getEnvBridgeClient().sendGrant({ envId: ENV, frame: { type: 'grant_exec', cmd: 'ls' }, principal: { userId: 'u', sessionId: 's', conversationId: 'c' } });
    await revokeLocalEnv({ envId: ENV, reason: 'owner_revoked' });
    await expect(pending).rejects.toMatchObject({ kind: 'disconnected' });
  });

  it('given an enrollment pinned to the PREVIOUS key (the ROW is the source of truth), should sign the revoke with THAT key', async () => {
    row!.serverKeyId = previousId;
    const ws = liveSocket(previousId);
    await revokeLocalEnv({ envId: ENV, reason: 'r' });
    const decoded = decodeFrame(ws.sent[0]!, { maxFrameBytes: 65536 });
    if (!decoded.ok || decoded.frame.type !== 'revoke') throw new Error('no revoke frame');
    expect(verifyRevoke({ frame: decoded.frame, envId: ENV, enrollmentId: 'enr_a', keyId: previousId, issuedAt: NOW.getTime(), serverPublicKey: ring.get(previousId)!.publicKey, verify: ed25519Verify })).toEqual({ ok: true });
    expect(verifyRevoke({ frame: decoded.frame, envId: ENV, enrollmentId: 'enr_a', keyId: currentId, issuedAt: NOW.getTime(), serverPublicKey: ring.get(currentId)!.publicKey, verify: ed25519Verify })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('given the pinned key is no longer loaded, should still stamp + revoke sessions, close 1008 WITHOUT a frame, and say so', async () => {
    row!.serverKeyId = 'rotated-out';
    const ws = liveSocket('rotated-out');
    const result = await revokeLocalEnv({ envId: ENV, reason: 'r' });
    expect(result).toMatchObject({ ok: true, machine: 'closed_unsigned_key_unavailable', sessionsRevoked: 2 });
    expect(ws.sent).toHaveLength(0);
    expect(ws.close).toHaveBeenCalledWith(ENV_REVOKED_CLOSE_CODE, ENV_REVOKED_CLOSE_REASON);
    expect(row?.revokedAt).toEqual(NOW);
  });

  it('given no key ring is configured at all, should still complete legs 1 and 2 and close the socket', async () => {
    vi.mocked(loadServerSigningKeyring).mockImplementation(() => {
      throw new Error('ENV_BRIDGE_SIGNING_KEY is required');
    });
    const ws = liveSocket();
    const result = await revokeLocalEnv({ envId: ENV, reason: 'r' });
    expect(result).toMatchObject({ ok: true, machine: 'closed_unsigned_key_unavailable' });
    expect(ws.close).toHaveBeenCalled();
    expect(sessionService.revokeResourceSessions).toHaveBeenCalled();
  });

  it('given a socket that has not completed its hello, should close it WITHOUT a frame (nothing is sent to an unauthorized socket)', async () => {
    const ws = liveSocket(currentId, false);
    const result = await revokeLocalEnv({ envId: ENV, reason: 'r' });
    expect(result).toMatchObject({ ok: true, machine: 'closed_unauthorized_socket' });
    expect(ws.sent).toHaveLength(0);
    expect(ws.close).toHaveBeenCalledWith(ENV_REVOKED_CLOSE_CODE, ENV_REVOKED_CLOSE_REASON);
  });

  it('given no socket on this replica, should report no_live_socket and still complete legs 1 and 2', async () => {
    const result = await revokeLocalEnv({ envId: ENV, reason: 'r' });
    expect(result).toEqual({ ok: true, alreadyRevoked: false, revokedAt: NOW, sessionsRevoked: 2, machine: 'no_live_socket' });
  });

  it('given a Sprite env (no drive_env_local row), should answer not_found and touch nothing', async () => {
    row = null;
    expect(await revokeLocalEnv({ envId: ENV, reason: 'r' })).toEqual({ ok: false, reason: 'not_found' });
    expect(sessionService.revokeResourceSessions).not.toHaveBeenCalled();
  });

  it('buildRevokeFrame: given a null serverKeyId (never enrolled), should answer signing_key_unavailable', () => {
    expect(buildRevokeFrame({ envId: ENV, enrollmentId: 'e', serverKeyId: null, issuedAt: 1, reason: 'r' }, ring)).toEqual({ ok: false, reason: 'signing_key_unavailable' });
  });
});
