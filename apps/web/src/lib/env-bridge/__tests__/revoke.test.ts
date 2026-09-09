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
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
// The signing gate refuses everything while the deployment flag is off; this suite is about a LIVE env's revoke.
vi.mock('@pagespace/lib/services/drive-envs/local-envs-enabled', () => ({ isLocalEnvsEnabled: vi.fn(() => true) }));
vi.mock('@/lib/drive-envs/drive-envs-runtime', () => ({ getDriveEnvStore: vi.fn(), getGrantAuditStore: vi.fn() }));

import { sessionService } from '@pagespace/lib/auth/session-service';
import { loadServerSigningKeyring } from '@pagespace/lib/auth/env-bridge-signing-key';
import { getDriveEnvStore, getGrantAuditStore } from '@/lib/drive-envs/drive-envs-runtime';
import { createGrantAuditFake } from '@/test/grant-audit-fake';
import { decodeFrame } from '@pagespace/lib/env-bridge/frame-codec';
import { encodeResultForSigning, machineResultBindingId, resultHashForFrame, verifyRevoke, type MachineResultFrame } from '@pagespace/lib/env-bridge/machine-signatures';
import { envBridgeHash } from '@/lib/env-bridge/crypto';
import { parseServerSigningKeyring, type SigningKeyPrimitives } from '@pagespace/lib/env-bridge/server-signing-key';
import { clearAllEnvConnectionsForTesting, getEnvConnection, markEnvAuthorized, registerEnvConnection } from '@/lib/websocket/ws-env-connections';
import { getEnvBridgeClient } from '@/lib/env-bridge/bridge-client';
import { ed25519Verify } from '@/lib/env-bridge/crypto';
import { revokeLocalEnv, buildRevokeFrame, ENV_REVOKED_CLOSE_CODE, ENV_REVOKED_CLOSE_REASON, revokeLocalEnvApproval, APPROVAL_REVOKE_ACK_TIMEOUT_MS } from '../revoke';

const primitives: SigningKeyPrimitives = {
  importPrivateKey: (pkcs8) => {
    const privateKey = createPrivateKey({ key: Buffer.from(pkcs8), type: 'pkcs8', format: 'der' });
    return { publicKey: new Uint8Array(createPublicKey(privateKey).export({ type: 'spki', format: 'der' })), sign: (m) => new Uint8Array(nodeSign(null, m, privateKey)) };
  },
  hash: (bytes) => createHash('sha256').update(bytes).digest('hex'),
};
const pkcs8 = () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
/** The machine key an ack must be signed with (pinned on the socket), and a rogue one. */
const machine = generateKeyPairSync('ed25519');
const rogue = generateKeyPairSync('ed25519');
const machinePublicKeyB64 = machine.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
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
  let row: { envId: string; enrollmentId: string; serverKeyId: string | null; revokedAt: Date | null; pausedAt: Date | null; serverPolicy: { ops: string[]; checkpoint: boolean } } | null;
  let store: { findLocalByEnvId: ReturnType<typeof vi.fn>; revokeLocal: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.mocked(getGrantAuditStore).mockResolvedValue(createGrantAuditFake());
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    clearAllEnvConnectionsForTesting();
    // The sibling `sendGrant` consults before signing (decideSign): live, and allowing the op under test.
    row = { envId: ENV, enrollmentId: 'enr_a', serverKeyId: currentId, revokedAt: null, pausedAt: null, serverPolicy: { ops: ['exec', 'fs_read', 'fs_write'], checkpoint: false } };
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
    // The gate reads the sibling before the frame goes out; let that settle so the request is really pending.
    await vi.dynamicImportSettled();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
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

describe('GA wave 2 · leaf 8 — revoking ONE approval rides the signed revoke frame; the socket stays open, the key stays', () => {
  let row: { envId: string; enrollmentId: string; serverKeyId: string | null; revokedAt: Date | null } | null;
  let store: { findLocalByEnvId: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    clearAllEnvConnectionsForTesting();
    row = { envId: ENV, enrollmentId: 'enr_a', serverKeyId: currentId, revokedAt: null };
    store = { findLocalByEnvId: vi.fn(async () => row) };
    vi.mocked(getDriveEnvStore).mockResolvedValue(store as never);
    vi.mocked(loadServerSigningKeyring).mockReturnValue(ring);
  });
  afterEach(() => vi.useRealTimers());

  function liveSocket(serverKeyId: string | null = currentId, authorized = true): FakeSocket {
    const ws = socket();
    registerEnvConnection(ENV, ws, { userId: 'u', sessionId: 's', enrollmentId: 'enr_a', machinePublicKey: machinePublicKeyB64, serverKeyId, sessionExpiresAt: new Date(NOW.getTime() + 3600_000) });
    if (authorized) markEnvAuthorized(ws);
    return ws;
  }

  /** The daemon's signed ack, as the machine would produce it (or forge, with `key`). */
  const ack = (approvalId: string, removed: number, key = machine): MachineResultFrame => {
    const body = { type: 'approval_revoke_result' as const, approvalId, removed };
    const frame = { ...body, sig: '' } as MachineResultFrame;
    const resultHash = resultHashForFrame(frame, envBridgeHash);
    return { ...body, sig: Buffer.from(nodeSign(null, encodeResultForSigning({ grantId: machineResultBindingId(frame), resultHash }), key.privateKey)).toString('base64') } as MachineResultFrame;
  };
  const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

  it('Codex P2 on #2583: given the machine answers with its SIGNED ack, should report acknowledged with the count the machine signed — the socket stays open, the row is not stamped', async () => {
    const ws = liveSocket();
    const pending = revokeLocalEnvApproval({ envId: ENV, approvalId: 'ch_1', reason: 'owner' });
    await settle();
    expect(ws.sent).toHaveLength(1);
    expect(getEnvBridgeClient().handleMachineResult(ws, ack('ch_1', 2))).toBe('delivered');
    expect(await pending).toEqual({ ok: true, machine: { kind: 'acknowledged', removed: 2 } });
    expect(ws.close).not.toHaveBeenCalled();
    expect(getEnvConnection(ENV)).toBe(ws);
  });

  it('Codex P2 on #2583: given the socket drops after the send (no ack), should report unacknowledged — never a revoke it cannot prove', async () => {
    const ws = liveSocket();
    const pending = revokeLocalEnvApproval({ envId: ENV, approvalId: 'ch_1', reason: 'owner' });
    await settle();
    expect(ws.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(APPROVAL_REVOKE_ACK_TIMEOUT_MS + 1);
    expect(await pending).toEqual({ ok: true, machine: { kind: 'unacknowledged', reason: 'timeout' } });
  });

  it('Codex P2 on #2583: given only a FORGED ack (wrong key, or the count edited), it is ignored and the revoke is still unacknowledged', async () => {
    const ws = liveSocket();
    const pending = revokeLocalEnvApproval({ envId: ENV, approvalId: 'ch_1', reason: 'owner' });
    await settle();
    expect(getEnvBridgeClient().handleMachineResult(ws, ack('ch_1', 2, rogue))).toBe('unverified');
    const genuine = ack('ch_1', 2);
    expect(getEnvBridgeClient().handleMachineResult(ws, { ...genuine, removed: 99 } as MachineResultFrame)).toBe('unverified');
    await vi.advanceTimersByTimeAsync(APPROVAL_REVOKE_ACK_TIMEOUT_MS + 1);
    expect(await pending).toEqual({ ok: true, machine: { kind: 'unacknowledged', reason: 'timeout' } });
  });

  it('given an authorized socket, should send a revoke frame carrying approvalId that the daemon verifies under the approval domain, and NOT close the socket or stamp the row', async () => {
    const ws = liveSocket();
    const pending = revokeLocalEnvApproval({ envId: ENV, approvalId: 'ch_1', reason: 'owner' });
    await settle();
    getEnvBridgeClient().handleMachineResult(ws, ack('ch_1', 1));
    expect(await pending).toEqual({ ok: true, machine: { kind: 'acknowledged', removed: 1 } });
    const decoded = decodeFrame(ws.sent[0]!, { maxFrameBytes: 65536 });
    if (!decoded.ok || decoded.frame.type !== 'revoke') throw new Error('no revoke frame');
    expect(decoded.frame.approvalId).toBe('ch_1');
    const binding = { envId: ENV, enrollmentId: 'enr_a', keyId: currentId, issuedAt: NOW.getTime(), serverPublicKey: ring.get(currentId)!.publicKey, verify: ed25519Verify };
    expect(verifyRevoke({ frame: decoded.frame, ...binding })).toEqual({ ok: true });
    // Stripping the id does NOT yield a valid enrollment revoke; another id does not verify either.
    const { approvalId: _dropped, ...stripped } = decoded.frame;
    expect(verifyRevoke({ frame: stripped as typeof decoded.frame, ...binding })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyRevoke({ frame: { ...decoded.frame, approvalId: 'ch_2' }, ...binding })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(ws.close).not.toHaveBeenCalled();
    expect(getEnvConnection(ENV)).toBe(ws);
  });

  it('given no live socket, should say so (no_live_socket) rather than claim a revoke the machine never received', async () => {
    expect(await revokeLocalEnvApproval({ envId: ENV, approvalId: 'ch_1', reason: 'owner' })).toEqual({ ok: true, machine: { kind: 'no_live_socket' } });
  });

  it('given an unauthorized socket, should send NOTHING to it', async () => {
    const ws = liveSocket(currentId, false);
    expect(await revokeLocalEnvApproval({ envId: ENV, approvalId: 'ch_1', reason: 'owner' })).toEqual({ ok: true, machine: { kind: 'unauthorized_socket' } });
    expect(ws.sent).toHaveLength(0);
  });

  it('given the pinned key (the ROW\'s serverKeyId) is not loaded, should not sign under another key', async () => {
    row = { envId: ENV, enrollmentId: 'enr_a', serverKeyId: 'gone-key', revokedAt: null };
    const ws = liveSocket('gone-key');
    expect(await revokeLocalEnvApproval({ envId: ENV, approvalId: 'ch_1', reason: 'owner' })).toEqual({ ok: true, machine: { kind: 'signing_key_unavailable' } });
    expect(ws.sent).toHaveLength(0);
  });

  it('given a missing or revoked env, should answer the typed refusal', async () => {
    row = null;
    expect(await revokeLocalEnvApproval({ envId: ENV, approvalId: 'ch_1', reason: 'owner' })).toEqual({ ok: false, reason: 'not_found' });
    row = { envId: ENV, enrollmentId: 'enr_a', serverKeyId: currentId, revokedAt: NOW };
    expect(await revokeLocalEnvApproval({ envId: ENV, approvalId: 'ch_1', reason: 'owner' })).toEqual({ ok: false, reason: 'revoked' });
  });
});
