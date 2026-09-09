/**
 * STOP reaches the machine (GA wave 3, leaf 3 amendment) — the pause adapter
 * through the production seams: a signed `pause` under its own domain over
 * the live AUTHORIZED socket, the machine's SIGNED `pause_result` correlated
 * on `pause:<envId>:<pausedAt>`, honesty about reach, and once-per-pause.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { generateKeyPairSync, createPrivateKey, createPublicKey, createHash, sign as nodeSign } from 'node:crypto';

vi.mock('@pagespace/lib/logging/logger-config', () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/auth/env-bridge-signing-key', () => ({ loadServerSigningKeyring: vi.fn() }));
vi.mock('@/lib/drive-envs/drive-envs-runtime', () => ({ getDriveEnvStore: vi.fn(), getGrantAuditStore: vi.fn() }));

import { loadServerSigningKeyring } from '@pagespace/lib/auth/env-bridge-signing-key';
import { getDriveEnvStore, getGrantAuditStore } from '@/lib/drive-envs/drive-envs-runtime';
import { createGrantAuditFake } from '@/test/grant-audit-fake';
import { decodeFrame } from '@pagespace/lib/env-bridge/frame-codec';
import { encodeResultForSigning, machineResultBindingId, resultHashForFrame, verifyPause, verifyRevoke, type MachineResultFrame } from '@pagespace/lib/env-bridge/machine-signatures';
import { parseServerSigningKeyring, type SigningKeyPrimitives } from '@pagespace/lib/env-bridge/server-signing-key';
import { clearAllEnvConnectionsForTesting, getEnvConnection, getEnvConnectionMetadata, markEnvAuthorized, registerEnvConnection } from '@/lib/websocket/ws-env-connections';
import { getEnvBridgeClient } from '@/lib/env-bridge/bridge-client';
import { ed25519Verify, envBridgeHash } from '@/lib/env-bridge/crypto';
import { pauseLocalEnvMachine, PAUSE_ACK_TIMEOUT_MS } from '../pause';

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
const currentId = ring.current.keyId;
const machine = generateKeyPairSync('ed25519');
const rogue = generateKeyPairSync('ed25519');
const machinePublicKeyB64 = machine.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

const ENV = 'env_a';
const NOW = new Date('2026-09-09T12:00:00.000Z');
const PAUSED_AT = new Date(NOW.getTime() - 250);

type FakeSocket = WebSocket & { readyState: number; sent: string[] };
function socket(): FakeSocket {
  const sent: string[] = [];
  return { readyState: 1, sent, send: (data: string) => sent.push(data), close: vi.fn(), on: vi.fn() } as unknown as FakeSocket;
}

let row: { envId: string; enrollmentId: string; serverKeyId: string | null; revokedAt: Date | null; pausedAt: Date | null } | null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  clearAllEnvConnectionsForTesting();
  row = { envId: ENV, enrollmentId: 'enr_a', serverKeyId: currentId, revokedAt: null, pausedAt: PAUSED_AT };
  vi.mocked(getDriveEnvStore).mockResolvedValue({ findLocalByEnvId: vi.fn(async () => row) } as never);
  vi.mocked(getGrantAuditStore).mockResolvedValue(createGrantAuditFake());
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
const ack = (killed: number, key = machine, pausedAt = PAUSED_AT.getTime(), envId = ENV): MachineResultFrame => {
  const body = { type: 'pause_result' as const, envId, pausedAt, killed };
  const frame = { ...body, sig: '' } as MachineResultFrame;
  const resultHash = resultHashForFrame(frame, envBridgeHash);
  return { ...body, sig: Buffer.from(nodeSign(null, encodeResultForSigning({ grantId: machineResultBindingId(frame), resultHash }), key.privateKey)).toString('base64') } as MachineResultFrame;
};
const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
const sentPause = (ws: FakeSocket) => {
  const decoded = decodeFrame(ws.sent[0]!, { maxFrameBytes: 65536 });
  if (!decoded.ok || decoded.frame.type !== 'pause') throw new Error('no pause frame');
  return decoded.frame;
};

describe('pauseLocalEnvMachine — the signed pause over the live socket, acked by the machine', () => {
  it('given the machine answers with its SIGNED ack, should report acknowledged with the count the machine signed; the socket stays open, the row untouched', async () => {
    const ws = liveSocket();
    const pending = pauseLocalEnvMachine({ envId: ENV });
    await settle();
    expect(ws.sent).toHaveLength(1);
    expect(getEnvBridgeClient().handleMachineResult(ws, ack(3))).toBe('delivered');
    expect(await pending).toEqual({ ok: true, machine: { kind: 'acknowledged', killed: 3 } });
    expect(ws.close).not.toHaveBeenCalled();
    expect(getEnvConnection(ENV)).toBe(ws);
  });

  it('the frame verifies under the PAUSE domain for this enrollment and pausedAt, and never as an enrollment or approval revoke', async () => {
    const ws = liveSocket();
    const pending = pauseLocalEnvMachine({ envId: ENV });
    await settle();
    const frame = sentPause(ws);
    expect(frame.pausedAt).toBe(PAUSED_AT.getTime());
    const binding = { envId: ENV, enrollmentId: 'enr_a', keyId: currentId, issuedAt: frame.issuedAt, serverPublicKey: ring.get(currentId)!.publicKey, verify: ed25519Verify };
    expect(verifyPause({ frame, ...binding })).toEqual({ ok: true });
    expect(verifyPause({ frame: { ...frame, pausedAt: frame.pausedAt + 1 }, ...binding })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyRevoke({ frame: { type: 'revoke', issuedAt: frame.issuedAt, sig: frame.sig }, ...binding })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyRevoke({ frame: { type: 'revoke', issuedAt: frame.issuedAt, sig: frame.sig, approvalId: 'ch_1' }, ...binding })).toEqual({ ok: false, reason: 'bad_signature' });
    getEnvBridgeClient().handleMachineResult(ws, ack(0));
    await pending;
  });

  it('given no ack before the deadline, should report unacknowledged — never a stop it cannot prove', async () => {
    const ws = liveSocket();
    const pending = pauseLocalEnvMachine({ envId: ENV });
    await settle();
    expect(ws.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(PAUSE_ACK_TIMEOUT_MS + 1);
    expect(await pending).toEqual({ ok: true, machine: { kind: 'unacknowledged', reason: 'timeout' } });
  });

  it('given only FORGED acks (rogue key, count edited, another pause, another env), they are ignored and the pause is still unacknowledged', async () => {
    const ws = liveSocket();
    const pending = pauseLocalEnvMachine({ envId: ENV });
    await settle();
    expect(getEnvBridgeClient().handleMachineResult(ws, ack(1, rogue))).toBe('unverified');
    const genuine = ack(1);
    expect(getEnvBridgeClient().handleMachineResult(ws, { ...genuine, killed: 99 } as MachineResultFrame)).toBe('unverified');
    expect(getEnvBridgeClient().handleMachineResult(ws, ack(1, machine, PAUSED_AT.getTime() - 5000))).toBe('dropped_unknown_grant');
    expect(getEnvBridgeClient().handleMachineResult(ws, ack(1, machine, PAUSED_AT.getTime(), 'env_b'))).toBe('dropped_unknown_grant');
    await vi.advanceTimersByTimeAsync(PAUSE_ACK_TIMEOUT_MS + 1);
    expect(await pending).toEqual({ ok: true, machine: { kind: 'unacknowledged', reason: 'timeout' } });
  });

  it('sends ONCE per pause: a second delivery of the same pausedAt is already_sent; a NEW pause (new pausedAt) is delivered again', async () => {
    const ws = liveSocket();
    const first = pauseLocalEnvMachine({ envId: ENV });
    await settle();
    getEnvBridgeClient().handleMachineResult(ws, ack(1));
    expect(await first).toEqual({ ok: true, machine: { kind: 'acknowledged', killed: 1 } });
    expect(getEnvConnectionMetadata(ws)?.pauseSentForMs).toBe(PAUSED_AT.getTime());
    expect(await pauseLocalEnvMachine({ envId: ENV })).toEqual({ ok: true, machine: { kind: 'already_sent' } });
    expect(ws.sent).toHaveLength(1);
    row = { ...row!, pausedAt: new Date(NOW.getTime() + 60_000) };
    const again = pauseLocalEnvMachine({ envId: ENV });
    await settle();
    expect(ws.sent).toHaveLength(2);
    getEnvBridgeClient().handleMachineResult(ws, ack(0, machine, NOW.getTime() + 60_000));
    expect(await again).toEqual({ ok: true, machine: { kind: 'acknowledged', killed: 0 } });
  });

  it('given no live socket on this replica, says no_live_socket (the holder delivers on its next heartbeat)', async () => {
    expect(await pauseLocalEnvMachine({ envId: ENV })).toEqual({ ok: true, machine: { kind: 'no_live_socket' } });
  });

  it('given an unauthorized socket, sends NOTHING to it', async () => {
    const unauthorized = liveSocket(currentId, false);
    expect(await pauseLocalEnvMachine({ envId: ENV })).toEqual({ ok: true, machine: { kind: 'unauthorized_socket' } });
    expect(unauthorized.sent).toHaveLength(0);
  });

  it('given a pinned key no longer loaded (the ROW says which key), refuses to sign under another key and sends nothing', async () => {
    row = { ...row!, serverKeyId: 'gone-key' };
    const rotated = liveSocket('gone-key');
    expect(await pauseLocalEnvMachine({ envId: ENV })).toEqual({ ok: true, machine: { kind: 'signing_key_unavailable' } });
    expect(rotated.sent).toHaveLength(0);
  });

  it('given a row that is not paused, revoked, or missing, delivers nothing and says which', async () => {
    liveSocket();
    row = { ...row!, pausedAt: null };
    expect(await pauseLocalEnvMachine({ envId: ENV })).toEqual({ ok: false, reason: 'not_paused' });
    row = { ...row!, pausedAt: PAUSED_AT, revokedAt: NOW };
    expect(await pauseLocalEnvMachine({ envId: ENV })).toEqual({ ok: false, reason: 'revoked' });
    row = null;
    expect(await pauseLocalEnvMachine({ envId: ENV })).toEqual({ ok: false, reason: 'not_found' });
  });
});
