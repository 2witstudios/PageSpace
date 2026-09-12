/**
 * The bridge client: one granted request end to end against fake sockets and
 * fake timers. The exit-criterion row lives here — a result whose machine
 * signature does not verify is NOT delivered, the pending request fails with
 * a typed `unverified_result`, and nothing the machine sent reaches the caller.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WebSocket } from 'ws';
import { generateKeyPairSync, createPrivateKey, createPublicKey, createHash, sign as nodeSign } from 'node:crypto';

vi.mock('@pagespace/lib/logging/logger-config', () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } }));
vi.mock('@/lib/websocket/ws-env-connections', () => ({ getAuthorizedEnvConnection: vi.fn(), getEnvConnectionMetadata: vi.fn(), onEnvConnectionLost: vi.fn() }));
vi.mock('@pagespace/lib/auth/env-bridge-signing-key', () => ({ loadServerSigningKeyring: vi.fn() }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@/lib/drive-envs/drive-envs-runtime', () => ({ getDriveEnvStore: vi.fn() }));

import { decodeFrame, type Frame } from '@pagespace/lib/env-bridge/frame-codec';
import { createMemoryNonceStore, verifyGrant } from '@pagespace/lib/env-bridge/grant';
import { grantRequestForFrame } from '@pagespace/lib/env-bridge/grant-args';
import { ed25519Verify } from '../crypto';
import { encodeResultForSigning, machineResultBindingId, resultHashForFrame, type MachineResultFrame } from '@pagespace/lib/env-bridge/machine-signatures';
import { parseServerSigningKeyring, type SigningKeyPrimitives } from '@pagespace/lib/env-bridge/server-signing-key';
import { DEFAULT_TIMEOUT_DEFAULTS } from '@pagespace/lib/env-bridge/resolve-timeout';
import { RequestCorrelator } from '../correlator';
import { EnvBridgeClient, EnvBridgeError, type EnvBridgeClientDeps, type EnvSocketFacts, type SigningSibling } from '../bridge-client';
import { envBridgeHash } from '../crypto';
import { verifyResultFromMachine } from '../result-verifier';
import type { DriveEnvGrantAuditRecord, GrantAuditRefusalInput, GrantAuditResultInput, GrantAuditSignInput } from '@pagespace/lib/services/drive-envs/grant-audit-store';

const primitives: SigningKeyPrimitives = {
  importPrivateKey: (pkcs8) => {
    const privateKey = createPrivateKey({ key: Buffer.from(pkcs8), type: 'pkcs8', format: 'der' });
    return { publicKey: new Uint8Array(createPublicKey(privateKey).export({ type: 'spki', format: 'der' })), sign: (m) => new Uint8Array(nodeSign(null, m, privateKey)) };
  },
  hash: (bytes) => createHash('sha256').update(bytes).digest('hex'),
};
const serverRaw = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const ringVerdict = parseServerSigningKeyring({ single: serverRaw, multi: undefined }, primitives);
if (!ringVerdict.ok) throw new Error('ring');
const ring = ringVerdict.keyring;
const machine = generateKeyPairSync('ed25519');
const rogue = generateKeyPairSync('ed25519');
const machinePublicKey = machine.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

type FakeSocket = WebSocket & { readyState: number; sent: string[] };
function socket(): FakeSocket {
  const sent: string[] = [];
  return { readyState: 1, sent, send: (data: string) => sent.push(data), close: vi.fn(), on: vi.fn() } as unknown as FakeSocket;
}

const principal = { userId: 'user-1', sessionId: 'sess-1', conversationId: 'conv-1' };
const flushPromises = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

/** Distributive: `Omit` over the union would collapse it to the common keys. */
type UnsignedResult<T = MachineResultFrame> = T extends unknown ? Omit<T, 'sig'> : never;

function signedResult(body: UnsignedResult, key = machine): MachineResultFrame {
  const resultHash = resultHashForFrame({ ...body, sig: '' } as MachineResultFrame, envBridgeHash);
  return { ...body, sig: Buffer.from(nodeSign(null, encodeResultForSigning({ grantId: machineResultBindingId({ ...body, sig: '' } as MachineResultFrame), resultHash }), key.privateKey)).toString('base64') } as MachineResultFrame;
}

describe('EnvBridgeClient', () => {
  let counter: number;
  let sockets: Map<string, FakeSocket>;
  let facts: Map<FakeSocket, EnvSocketFacts>;
  let unverified: Array<{ envId: string; grantId: string; reason: string }>;
  let client: EnvBridgeClient;
  let correlator: RequestCorrelator<MachineResultFrame>;
  /** The sibling `sendGrant` consults BEFORE signing; tests override per env. */
  let siblings: Map<string, SigningSibling | null>;
  let flagEnabled: boolean;
  let keyGet: ReturnType<typeof vi.fn>;
  let signRefusals: Array<{ envId: string; op: string; reason: string; userId: string }>;
  /** The server-side audit (GA wave 3): every write the client makes, in order, and a switch that makes the sign-time write fail. */
  let auditWrites: Array<{ kind: 'sign'; input: GrantAuditSignInput } | { kind: 'refusal'; input: GrantAuditRefusalInput } | { kind: 'result'; input: GrantAuditResultInput }>;
  let auditRows: Map<string, DriveEnvGrantAuditRecord>;
  let auditSignFails: boolean;
  let activity: Array<{ ownerId: string; grantId: string | null; verdict: string; resultAt: Date | null }>;
  const auditRow = (over: Partial<DriveEnvGrantAuditRecord>): DriveEnvGrantAuditRecord => ({ id: 'row', envId: 'env-1', grantId: null, userId: 'user-1', sessionId: 'sess-1', conversationId: 'conv-1', op: 'exec', argsHash: '', summary: '', verdict: 'signed', exitCode: null, challengeId: null, approvalScope: null, ts: new Date(0), resultAt: null, ...over });

  function connect(envId: string, over: Partial<EnvSocketFacts> = {}): FakeSocket {
    const ws = socket();
    sockets.set(envId, ws);
    facts.set(ws, { envId, machinePublicKey, serverKeyId: ring.current.keyId, ...over });
    return ws;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    counter = 0;
    sockets = new Map();
    facts = new Map();
    unverified = [];
    siblings = new Map();
    flagEnabled = true;
    signRefusals = [];
    auditWrites = [];
    auditRows = new Map();
    auditSignFails = false;
    activity = [];
    keyGet = vi.fn((keyId: string) => ring.get(keyId));
    correlator = new RequestCorrelator<MachineResultFrame>();
    const deps: EnvBridgeClientDeps = {
      correlator,
      getAuthorizedConnection: (envId) => sockets.get(envId),
      getSocketFacts: (ws) => facts.get(ws as FakeSocket),
      keyring: () => ({ get: keyGet as (keyId: string) => ReturnType<typeof ring.get> }),
      // Default: an enrolled, live sibling that allows every op — every existing row keeps its meaning.
      findLocalByEnvId: async (envId) => (siblings.has(envId) ? siblings.get(envId)! : { ownerId: 'owner-1', pausedAt: null, revokedAt: null, serverPolicy: { ops: ['exec', 'fs_read', 'fs_write', 'pty_open'], checkpoint: false } }),
      flagEnabled: () => flagEnabled,
      onSignRefused: (info) => signRefusals.push({ envId: info.envId, op: info.op, reason: info.reason, userId: info.principal.userId }),
      now: () => 1_760_000_000_000,
      ids: { grantId: () => `g-${++counter}`, nonce: () => `n-${counter}` },
      onUnverified: (info) => unverified.push({ envId: info.envId, grantId: info.grantId, reason: info.reason }),
      grantAudit: {
        async recordSign(input) {
          if (auditSignFails) throw new Error('audit db down');
          auditWrites.push({ kind: 'sign', input });
          const row = auditRow({ envId: input.envId, grantId: input.grantId, op: input.op, argsHash: input.argsHash, summary: input.summary, verdict: 'signed', challengeId: input.approval?.challengeId ?? null, approvalScope: input.approval?.scope ?? null, ts: input.now });
          auditRows.set(input.grantId, row);
          return row;
        },
        async recordRefusal(input) {
          auditWrites.push({ kind: 'refusal', input });
          return auditRow({ envId: input.envId, op: input.op, argsHash: input.argsHash, summary: input.summary, verdict: `refused:${input.reason}`, ts: input.now, resultAt: input.now });
        },
        async recordResult(input) {
          auditWrites.push({ kind: 'result', input });
          const row = auditRows.get(input.grantId);
          if (!row || row.resultAt !== null) return null;
          const updated = { ...row, verdict: input.verdict, exitCode: input.exitCode, resultAt: input.now };
          auditRows.set(input.grantId, updated);
          return updated;
        },
      },
      onActivity: (row, ownerId) => activity.push({ ownerId, grantId: row.grantId, verdict: row.verdict, resultAt: row.resultAt }),
    };
    client = new EnvBridgeClient(deps);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function sentFrame(ws: FakeSocket, index = 0): Frame {
    const decoded = decodeFrame(ws.sent[index]!, { maxFrameBytes: 1024 * 1024 });
    if (!decoded.ok) throw new Error(decoded.reason);
    return decoded.frame;
  }

  it('given an authorized socket, should sign the grant with the pinned key and send the encoded frame over THAT socket', async () => {
    const ws = connect('env-1');
    const pending = client.sendGrant({ envId: 'env-1', frame: { type: 'grant_fs_read', paths: ['/a'] }, principal });
    await flushPromises();
    pending.catch(() => {});
    expect(ws.sent).toHaveLength(1);
    const frame = sentFrame(ws);
    expect(frame.type).toBe('grant_fs_read');
    if (frame.type !== 'grant_fs_read') throw new Error('type');
    expect(frame.grant).toMatchObject({ grantId: 'g-1', envId: 'env-1', op: 'fs_read', principal });
    expect(frame.sig.length).toBeGreaterThan(0);
    expect(client.pendingCountForEnv('env-1')).toBe(1);
  });

  it('given a result signed by the pinned machine key, should deliver it to the caller', async () => {
    const ws = connect('env-1');
    const pending = client.sendGrant({ envId: 'env-1', frame: { type: 'grant_exec', cmd: 'ls' }, principal });
    await flushPromises();
    const result = signedResult({ type: 'exec_result', grantId: 'g-1', exitCode: 0, stdoutB64: 'b2s=', stderrB64: '', truncated: false });
    expect(client.handleMachineResult(ws, result)).toBe('delivered');
    await expect(pending).resolves.toEqual(result);
    expect(unverified).toEqual([]);
  });

  describe('GA wave 2 — the pending click', () => {
    const PENDING = { challengeId: 'ch_1', expiresAt: 1_760_000_030_000, request: { op: 'exec' as const, cmd: 'ls', args: [], cwd: '/p', paths: [], env: {}, timeoutMs: 1000, maxBytes: 1024, clamped: false } };

    it('given the machine answers ask_pending:<id> with a signed frozen request, should deliver it AND remember what re-issuing needs under that id, for the grant\'s exp', async () => {
      const store = { entries: [] as unknown[], remember: vi.fn((entry: unknown) => { store.entries.push(entry); return true; }), get: vi.fn(), take: vi.fn(), evictExpired: vi.fn(), size: () => store.entries.length };
      const c = new EnvBridgeClient({ ...(client as unknown as { deps: EnvBridgeClientDeps }).deps, pendingApprovals: store });
      const ws = connect('env-1');
      const frame = { type: 'grant_exec' as const, cmd: 'ls', cwd: '/p' };
      const pending = c.sendGrant({ envId: 'env-1', frame, principal });
      await flushPromises();
      const denied = signedResult({ type: 'grant_denied', grantId: 'g-1', reason: 'ask_pending:ch_1', pending: PENDING });
      expect(c.handleMachineResult(ws, denied)).toBe('delivered');
      await expect(pending).resolves.toEqual(denied);
      expect(store.remember).toHaveBeenCalledTimes(1);
      expect(store.entries[0]).toMatchObject({ challengeId: 'ch_1', envId: 'env-1', frame, principal, expiresAt: 1_760_000_060_000, pending: PENDING });
    });

    it('given an ask_pending whose reason id and pending id disagree, or with no pending body, should deliver but remember NOTHING', async () => {
      const store = { remember: vi.fn(() => true), get: vi.fn(), take: vi.fn(), evictExpired: vi.fn(), size: () => 0 };
      const c = new EnvBridgeClient({ ...(client as unknown as { deps: EnvBridgeClientDeps }).deps, pendingApprovals: store });
      const ws = connect('env-1');
      const p1 = c.sendGrant({ envId: 'env-1', frame: { type: 'grant_exec', cmd: 'ls' }, principal });
      await flushPromises();
      c.handleMachineResult(ws, signedResult({ type: 'grant_denied', grantId: 'g-1', reason: 'ask_pending:ch_other', pending: PENDING }));
      await p1;
      const p2 = c.sendGrant({ envId: 'env-1', frame: { type: 'grant_exec', cmd: 'ls' }, principal });
      await flushPromises();
      c.handleMachineResult(ws, signedResult({ type: 'grant_denied', grantId: 'g-2', reason: 'ask_pending:ch_1' }));
      await p2;
      expect(store.remember).not.toHaveBeenCalled();
    });

    it('given an approvalIntent, should sign it INTO the grant on the wire (the daemon verifies it with the pinned key)', async () => {
      const ws = connect('env-1');
      const intent = { challengeId: 'ch_1', scope: '30d' as const, expiresAt: 1_760_000_030_000 };
      const pending = client.sendGrant({ envId: 'env-1', frame: { type: 'grant_exec', cmd: 'ls' }, principal, approvalIntent: intent });
      await flushPromises();
      pending.catch(() => {});
      const frame = sentFrame(ws);
      if (frame.type !== 'grant_exec') throw new Error('type');
      expect(frame.grant).toMatchObject({ approvalIntent: intent });
      // Under the pinned key: the daemon's own gate accepts it.
      const verdict = verifyGrant({ grant: frame.grant, signature: frame.sig, serverPublicKey: ring.current.publicKey, now: 1_760_000_001_000, nonces: createMemoryNonceStore(), expectedEnvId: 'env-1', request: grantRequestForFrame(frame), verify: ed25519Verify, hash: envBridgeHash });
      expect(verdict).toMatchObject({ ok: true, grant: { approvalIntent: intent } });
    });
  });

  it('EXIT CRITERION — given an exec_result whose machine signature does not verify, should NOT deliver it: the request fails with typed unverified_result and the event is surfaced', async () => {
    const ws = connect('env-1');
    const pending = client.sendGrant({ envId: 'env-1', frame: { type: 'grant_exec', cmd: 'ls' }, principal });
    await flushPromises();
    const forged = signedResult({ type: 'exec_result', grantId: 'g-1', exitCode: 0, stdoutB64: 'cHduZWQ=', stderrB64: '', truncated: false }, rogue);
    expect(client.handleMachineResult(ws, forged)).toBe('unverified');
    await expect(pending).rejects.toMatchObject({ kind: 'unverified_result' });
    await expect(pending).rejects.toBeInstanceOf(EnvBridgeError);
    expect(unverified).toEqual([{ envId: 'env-1', grantId: 'g-1', reason: 'bad_signature' }]);
    expect(client.pendingCountForEnv('env-1')).toBe(0);
  });

  it('given a correctly signed result whose payload was edited in flight, should NOT deliver it either (every field is under the hash)', async () => {
    const ws = connect('env-1');
    const pending = client.sendGrant({ envId: 'env-1', frame: { type: 'grant_exec', cmd: 'ls' }, principal });
    await flushPromises();
    const genuine = signedResult({ type: 'exec_result', grantId: 'g-1', exitCode: 1, stdoutB64: '', stderrB64: 'ZGVuaWVk', truncated: false }) as Extract<MachineResultFrame, { type: 'exec_result' }>;
    expect(client.handleMachineResult(ws, { ...genuine, exitCode: 0 })).toBe('unverified');
    await expect(pending).rejects.toMatchObject({ kind: 'unverified_result' });
  });

  it('given a grant_denied signed by the machine, should deliver it as the (typed) answer', async () => {
    const ws = connect('env-1');
    const pending = client.sendGrant({ envId: 'env-1', frame: { type: 'grant_fs_write', files: [{ path: '/a', contentB64: 'aGk=' }] }, principal });
    await flushPromises();
    const denied = signedResult({ type: 'grant_denied', grantId: 'g-1', reason: 'policy_denied' });
    expect(client.handleMachineResult(ws, denied)).toBe('delivered');
    await expect(pending).resolves.toEqual(denied);
  });

  it('given a result for a grant that is not pending, should drop it WITHOUT doing crypto and resolve nothing', () => {
    const ws = connect('env-1');
    const result = signedResult({ type: 'exec_result', grantId: 'g-unknown', exitCode: 0, stdoutB64: '', stderrB64: '', truncated: false });
    expect(client.handleMachineResult(ws, result)).toBe('dropped_unknown_grant');
    // And from a socket the registry does not know: dropped before anything else.
    expect(client.handleMachineResult(socket(), result)).toBe('dropped_unregistered_socket');
  });

  it('given env B signs a result for env A\'s pending grant WITH ITS OWN pinned key and sends it on its own socket, should refuse it before crypto and leave A\'s request pending (Codex P1: the sending socket must be the env that owns the grant)', async () => {
    const wsA = connect('env-a');
    const wsB = connect('env-b', { machinePublicKey: rogue.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') });
    const pending = client.sendGrant({ envId: 'env-a', frame: { type: 'grant_exec', cmd: 'ls' }, principal });
    await flushPromises();
    let state = 'pending';
    pending.then(() => (state = 'resolved'), () => (state = 'rejected'));
    // B's key is the one pinned for B's socket — this WOULD verify if the socket's key were the only check.
    const forgedByB = signedResult({ type: 'exec_result', grantId: 'g-1', exitCode: 0, stdoutB64: 'cHduZWQ=', stderrB64: '', truncated: false }, rogue);
    expect(client.handleMachineResult(wsB, forgedByB)).toBe('dropped_wrong_env');
    await flushPromises();
    expect(state).toBe('pending');
    expect(client.pendingCountForEnv('env-a')).toBe(1);
    expect(unverified).toEqual([{ envId: 'env-b', grantId: 'g-1', reason: 'wrong_env' }]);
    // The real owner can still answer.
    const genuine = signedResult({ type: 'exec_result', grantId: 'g-1', exitCode: 0, stdoutB64: 'b2s=', stderrB64: '', truncated: false });
    expect(client.handleMachineResult(wsA, genuine)).toBe('delivered');
    await expect(pending).resolves.toEqual(genuine);
  });

  it('given a result for env A\'s pending grant arriving on env B\'s socket but signed with A\'s key, should still be refused as wrong env (the socket, not the signature, names the sender)', async () => {
    connect('env-a');
    const wsB = connect('env-b', { machinePublicKey: rogue.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') });
    const pending = client.sendGrant({ envId: 'env-a', frame: { type: 'grant_exec', cmd: 'ls' }, principal });
    await flushPromises();
    pending.catch(() => {});
    const signedByA = signedResult({ type: 'exec_result', grantId: 'g-1', exitCode: 0, stdoutB64: '', stderrB64: '', truncated: false });
    expect(client.handleMachineResult(wsB, signedByA)).toBe('dropped_wrong_env');
    expect(client.pendingCountForEnv('env-a')).toBe(1);
  });

  it('given no authorized socket for the env, should fail typed not_connected and send nothing', async () => {
    await expect(client.sendGrant({ envId: 'env-x', frame: { type: 'grant_exec', cmd: 'ls' }, principal })).rejects.toMatchObject({ kind: 'not_connected' });
  });

  it('given an enrollment pinned to a key that is no longer loaded, should fail typed signing_key_unavailable and send nothing', async () => {
    const ws = connect('env-1', { serverKeyId: 'rotated-out' });
    await expect(client.sendGrant({ envId: 'env-1', frame: { type: 'grant_exec', cmd: 'ls' }, principal })).rejects.toMatchObject({ kind: 'signing_key_unavailable' });
    expect(ws.sent).toHaveLength(0);
  });

  it('given a grant_exec with timeoutMs 120_000, should wait ≥120 s (resolveTimeout), never the MCP bridge\'s 30 s', async () => {
    connect('env-1');
    const pending = client.sendGrant({ envId: 'env-1', frame: { type: 'grant_exec', cmd: 'sleep', args: ['100'], timeoutMs: 120_000 }, principal });
    await flushPromises();
    let state = 'pending';
    pending.then(() => (state = 'resolved'), () => (state = 'rejected'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(state).toBe('pending');
    await vi.advanceTimersByTimeAsync(90_000 - 1);
    expect(state).toBe('pending');
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_DEFAULTS.correlatorMarginMs + 1);
    expect(state).toBe('rejected');
    await expect(pending).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('given the env\'s live socket is lost, cancelEnv should fail its in-flight requests with typed disconnected and leave other envs alone', async () => {
    connect('env-a');
    connect('env-b');
    const a = client.sendGrant({ envId: 'env-a', frame: { type: 'grant_exec', cmd: 'ls' }, principal });
    const b = client.sendGrant({ envId: 'env-b', frame: { type: 'grant_exec', cmd: 'ls' }, principal });
    b.catch(() => {});
    await flushPromises();
    expect(client.cancelEnv('env-a')).toBe(1);
    await expect(a).rejects.toMatchObject({ kind: 'disconnected' });
    expect(client.pendingCountForEnv('env-b')).toBe(1);
  });

  it('given a socket whose send throws, should fail typed send_failed and leave nothing pending', async () => {
    const ws = connect('env-1');
    (ws as unknown as { send: () => void }).send = () => {
      throw new Error('EPIPE');
    };
    await expect(client.sendGrant({ envId: 'env-1', frame: { type: 'grant_exec', cmd: 'ls' }, principal })).rejects.toMatchObject({ kind: 'send_failed' });
    expect(client.pendingCountForEnv('env-1')).toBe(0);
  });

  describe('decideSign before signGrantFrame — serverPolicy is enforced where the capability is minted', () => {
    const exec = { type: 'grant_exec' as const, cmd: 'ls' };

    it('EXIT CRITERION — given exec is NOT in serverPolicy.ops, should reject typed server_denied, never touch the signing key, send nothing, and leave nothing pending', async () => {
      const ws = connect('env-1');
      siblings.set('env-1', { ownerId: 'owner-1', pausedAt: null, revokedAt: null, serverPolicy: { ops: ['fs_read', 'fs_write'], checkpoint: false } });
      const pending = client.sendGrant({ envId: 'env-1', frame: exec, principal });
      await flushPromises();
      await expect(pending).rejects.toBeInstanceOf(EnvBridgeError);
      await expect(pending).rejects.toMatchObject({ kind: 'server_denied', detail: { envId: 'env-1', op: 'exec', reason: 'server_denied' } });
      expect(keyGet).not.toHaveBeenCalled();
      expect(ws.sent).toHaveLength(0);
      expect(client.pendingCountForEnv('env-1')).toBe(0);
      // No grant id was minted either: the gate ran before anything that belongs to signing.
      expect(counter).toBe(0);
      expect(signRefusals).toEqual([{ envId: 'env-1', op: 'exec', reason: 'server_denied', userId: 'user-1' }]);
    });

    it('given the same policy, should still sign fs_read (the policy is per op, not per env)', async () => {
      const ws = connect('env-1');
      siblings.set('env-1', { ownerId: 'owner-1', pausedAt: null, revokedAt: null, serverPolicy: { ops: ['fs_read', 'fs_write'], checkpoint: false } });
      const pending = client.sendGrant({ envId: 'env-1', frame: { type: 'grant_fs_read', paths: ['/a'] }, principal });
      await flushPromises();
      pending.catch(() => {});
      expect(ws.sent).toHaveLength(1);
      expect(keyGet).toHaveBeenCalledWith(ring.current.keyId);
      expect(signRefusals).toEqual([]);
    });

    it('given the sibling is revoked, should reject server_denied with reason revoked — ahead of the policy, key untouched', async () => {
      const ws = connect('env-1');
      siblings.set('env-1', { ownerId: 'owner-1', pausedAt: null, revokedAt: new Date(1_760_000_000_000), serverPolicy: { ops: ['exec'], checkpoint: false } });
      await expect(client.sendGrant({ envId: 'env-1', frame: exec, principal })).rejects.toMatchObject({ kind: 'server_denied', detail: { reason: 'revoked' } });
      expect(keyGet).not.toHaveBeenCalled();
      expect(ws.sent).toHaveLength(0);
    });

    it('given NO sibling row (a dead local env), should reject as revoked — a missing row is never a permissive default', async () => {
      const ws = connect('env-1');
      siblings.set('env-1', null);
      await expect(client.sendGrant({ envId: 'env-1', frame: exec, principal })).rejects.toMatchObject({ kind: 'server_denied', detail: { reason: 'revoked' } });
      expect(keyGet).not.toHaveBeenCalled();
      expect(ws.sent).toHaveLength(0);
    });

    it('given LOCAL_ENVS_ENABLED is off, should reject with reason flag_disabled first — even with a live socket and an allowing policy', async () => {
      const ws = connect('env-1');
      flagEnabled = false;
      await expect(client.sendGrant({ envId: 'env-1', frame: exec, principal })).rejects.toMatchObject({ kind: 'server_denied', detail: { reason: 'flag_disabled' } });
      expect(keyGet).not.toHaveBeenCalled();
      expect(ws.sent).toHaveLength(0);
    });

    it('given a stored policy the strict parser refuses (an op outside the union), should reject server_denied — drift denies', async () => {
      const ws = connect('env-1');
      siblings.set('env-1', { ownerId: 'owner-1', pausedAt: null, revokedAt: null, serverPolicy: { ops: ['exec', 'rm_rf'], checkpoint: false } });
      await expect(client.sendGrant({ envId: 'env-1', frame: exec, principal })).rejects.toMatchObject({ kind: 'server_denied', detail: { reason: 'server_denied' } });
      expect(keyGet).not.toHaveBeenCalled();
      expect(ws.sent).toHaveLength(0);
    });

    it('given the DB backstop default {ops:[]} (a row minted without an explicit policy), should refuse every op', async () => {
      const ws = connect('env-1');
      siblings.set('env-1', { ownerId: 'owner-1', pausedAt: null, revokedAt: null, serverPolicy: { ops: [], checkpoint: false } });
      await expect(client.sendGrant({ envId: 'env-1', frame: { type: 'grant_fs_read', paths: ['/a'] }, principal })).rejects.toMatchObject({ kind: 'server_denied' });
      expect(ws.sent).toHaveLength(0);
    });

    it('GA wave 3 (Stop) — given a sibling with pausedAt set, should refuse server_denied with reason paused AHEAD of the policy, key untouched, nothing sent, and audit the refusal', async () => {
      const ws = connect('env-1');
      siblings.set('env-1', { ownerId: 'owner-1', pausedAt: new Date(1_760_000_000_000), revokedAt: null, serverPolicy: { ops: ['exec', 'fs_read'], checkpoint: false } });
      await expect(client.sendGrant({ envId: 'env-1', frame: exec, principal })).rejects.toMatchObject({ kind: 'server_denied', detail: { reason: 'paused' } });
      expect(keyGet).not.toHaveBeenCalled();
      expect(ws.sent).toHaveLength(0);
      expect(auditWrites).toEqual([expect.objectContaining({ kind: 'refusal', input: expect.objectContaining({ reason: 'paused' }) })]);
    });

    it("GA wave 3 (Stop) — pauseEnv fails the env's IN-FLIGHT requests with typed paused (never left to time out), records failed:paused, and leaves other envs alone", async () => {
      const ws1 = connect('env-1');
      const ws2 = connect('env-2');
      const stopped = client.sendGrant({ envId: 'env-1', frame: { type: 'grant_exec', cmd: 'sleep', args: ['100'], timeoutMs: 120_000 }, principal });
      const other = client.sendGrant({ envId: 'env-2', frame: exec, principal });
      await flushPromises();
      expect(ws1.sent).toHaveLength(1);
      expect(ws2.sent).toHaveLength(1);
      expect(client.pauseEnv('env-1')).toBe(1);
      await expect(stopped).rejects.toMatchObject({ kind: 'paused', detail: { envId: 'env-1' } });
      await flushPromises();
      expect(client.pendingCountForEnv('env-1')).toBe(0);
      expect(client.pendingCountForEnv('env-2')).toBe(1);
      expect(auditWrites.filter((w) => w.kind === 'result').map((w) => w.input)).toEqual([expect.objectContaining({ grantId: 'g-1', verdict: 'failed:paused' })]);
      other.catch(() => {});
    });

    it('given a refusal, the gate should have run BEFORE the socket was consulted (a disconnected env still learns the policy answer)', async () => {
      siblings.set('env-x', { ownerId: 'owner-1', pausedAt: null, revokedAt: null, serverPolicy: { ops: [], checkpoint: false } });
      await expect(client.sendGrant({ envId: 'env-x', frame: exec, principal })).rejects.toMatchObject({ kind: 'server_denied' });
    });
  });
  describe('GA wave 3 — the server side of the audit (invariant 10: a row per grant, keyed by grantId, written at sign and updated at result)', () => {
    const exec = { type: 'grant_exec' as const, cmd: 'sh', args: ['-c', 'git status'], cwd: '/home/o/proj' };
    const sent = (ws: FakeSocket) => sentFrame(ws) as Extract<Frame, { type: 'grant_exec' }>;

    it('given a signed grant, should write the sign row BEFORE the frame goes out, with the grant\'s own id, principal, op and argsHash, and a readable summary', async () => {
      const ws = connect('env-1');
      const pending = client.sendGrant({ envId: 'env-1', frame: exec, principal });
      await flushPromises();
      pending.catch(() => {});
      expect(ws.sent).toHaveLength(1);
      const frame = sent(ws);
      expect(auditWrites).toHaveLength(1);
      const write = auditWrites[0]!;
      if (write.kind !== 'sign') throw new Error(write.kind);
      expect(write.input).toMatchObject({ envId: 'env-1', grantId: frame.grant.grantId, principal, op: 'exec', argsHash: frame.grant.argsHash, summary: "exec: sh -c 'git status' in /home/o/proj", now: new Date(1_760_000_000_000) });
      expect(write.input.approval).toBeUndefined();
      // The owner learns a grant is running: the sign row reaches the activity hook under the OWNER's id (not the principal's).
      expect(activity).toEqual([{ ownerId: 'owner-1', grantId: 'g-1', verdict: 'signed', resultAt: null }]);
    });

    it('given the sign-time write FAILS, should not send the frame, mint nothing pending, and fail typed audit_unavailable (no silent degradation — invariant 12)', async () => {
      const ws = connect('env-1');
      auditSignFails = true;
      await expect(client.sendGrant({ envId: 'env-1', frame: exec, principal })).rejects.toMatchObject({ kind: 'audit_unavailable', detail: { envId: 'env-1' } });
      expect(ws.sent).toHaveLength(0);
      expect(client.pendingCountForEnv('env-1')).toBe(0);
      expect(activity).toEqual([]);
    });

    it('given a REFUSED sign, should write a refusal row with the typed reason, the same argsHash projection, and NO grant id', async () => {
      connect('env-1');
      siblings.set('env-1', { ownerId: 'owner-1', pausedAt: null, revokedAt: null, serverPolicy: { ops: ['fs_read'], checkpoint: false } });
      await expect(client.sendGrant({ envId: 'env-1', frame: exec, principal })).rejects.toMatchObject({ kind: 'server_denied' });
      expect(auditWrites).toHaveLength(1);
      const write = auditWrites[0]!;
      if (write.kind !== 'refusal') throw new Error(write.kind);
      expect(write.input).toMatchObject({ envId: 'env-1', principal, op: 'exec', reason: 'server_denied', summary: "exec: sh -c 'git status' in /home/o/proj" });
      expect(write.input.argsHash).toMatch(/^[0-9a-f]{64}$/);
      expect('grantId' in write.input).toBe(false);
      expect(activity).toEqual([{ ownerId: 'owner-1', grantId: null, verdict: 'refused:server_denied', resultAt: new Date(1_760_000_000_000) }]);
    });

    it('given a refusal for a DEAD local env (no sibling), should still write the refusal row but notify nobody (there is no owner to tell)', async () => {
      siblings.set('env-1', null);
      await expect(client.sendGrant({ envId: 'env-1', frame: exec, principal })).rejects.toMatchObject({ kind: 'server_denied', detail: { reason: 'revoked' } });
      expect(auditWrites.map((w) => w.kind)).toEqual(['refusal']);
      expect(activity).toEqual([]);
    });

    it('given a verified exec_result, should update the row: verdict completed with the child\'s exit code, and surface it to the owner', async () => {
      const ws = connect('env-1');
      const pending = client.sendGrant({ envId: 'env-1', frame: exec, principal });
      await flushPromises();
      client.handleMachineResult(ws, signedResult({ type: 'exec_result', grantId: 'g-1', exitCode: 7, stdoutB64: '', stderrB64: '', truncated: false }));
      await pending;
      await flushPromises();
      expect(auditWrites.map((w) => w.kind)).toEqual(['sign', 'result']);
      expect(auditWrites[1]).toMatchObject({ kind: 'result', input: { grantId: 'g-1', verdict: 'completed', exitCode: 7 } });
      expect(activity.at(-1)).toEqual({ ownerId: 'owner-1', grantId: 'g-1', verdict: 'completed', resultAt: new Date(1_760_000_000_000) });
    });

    it('given a grant_denied, should record denied:<reason>; given ask_pending, should record ask_pending:<challengeId>', async () => {
      const ws = connect('env-1');
      const denied = client.sendGrant({ envId: 'env-1', frame: exec, principal });
      await flushPromises();
      client.handleMachineResult(ws, signedResult({ type: 'grant_denied', grantId: 'g-1', reason: 'not_allowed' }));
      await denied;
      const asked = client.sendGrant({ envId: 'env-1', frame: exec, principal });
      await flushPromises();
      const request = { op: 'exec' as const, cmd: 'sh', args: ['-c', 'git status'], cwd: '/home/o/proj', paths: [], env: {}, timeoutMs: 120_000, maxBytes: 1_048_576, clamped: false };
      client.handleMachineResult(ws, signedResult({ type: 'grant_denied', grantId: 'g-2', reason: 'ask_pending:ch_9', pending: { challengeId: 'ch_9', expiresAt: 1_760_000_060_000, request } }));
      await asked;
      await flushPromises();
      const results = auditWrites.filter((w) => w.kind === 'result').map((w) => w.input);
      expect(results).toEqual([
        expect.objectContaining({ grantId: 'g-1', verdict: 'denied:not_allowed', exitCode: null }),
        expect.objectContaining({ grantId: 'g-2', verdict: 'ask_pending:ch_9', exitCode: null }),
      ]);
    });

    it('given the owner\'s click re-issues a grant, should record the challengeId and scope on the sign row (the click is audited where it ran)', async () => {
      const ws = connect('env-1');
      const pending = client.sendGrant({ envId: 'env-1', frame: exec, principal, approvalIntent: { challengeId: 'ch_1', scope: '30d', expiresAt: 1_760_000_050_000 } });
      await flushPromises();
      pending.catch(() => {});
      expect(ws.sent).toHaveLength(1);
      expect(auditWrites[0]).toMatchObject({ kind: 'sign', input: { grantId: 'g-1', approval: { challengeId: 'ch_1', scope: '30d' } } });
    });

    it('given the wait ends in a typed failure (timeout, disconnect), should record failed:<kind> so a grant never stays "running" forever', async () => {
      const ws = connect('env-1');
      const timing = client.sendGrant({ envId: 'env-1', frame: { type: 'grant_exec', cmd: 'ls', timeoutMs: 1_000 }, principal });
      await flushPromises();
      timing.catch(() => {});
      await vi.advanceTimersByTimeAsync(1_000 + DEFAULT_TIMEOUT_DEFAULTS.correlatorMarginMs + 1);
      await expect(timing).rejects.toMatchObject({ kind: 'timeout' });
      await flushPromises();
      const dropped = client.sendGrant({ envId: 'env-1', frame: exec, principal });
      await flushPromises();
      client.cancelEnv('env-1');
      await expect(dropped).rejects.toMatchObject({ kind: 'disconnected' });
      await flushPromises();
      expect(ws.sent).toHaveLength(2);
      const results = auditWrites.filter((w) => w.kind === 'result').map((w) => w.input);
      expect(results).toEqual([
        expect.objectContaining({ grantId: 'g-1', verdict: 'failed:timeout' }),
        expect.objectContaining({ grantId: 'g-2', verdict: 'failed:disconnected' }),
      ]);
    });

    it('given the result-time write fails, should still deliver the verified result (the machine already ran it; the row is logged, not the answer withheld)', async () => {
      const ws = connect('env-1');
      const pending = client.sendGrant({ envId: 'env-1', frame: exec, principal });
      await flushPromises();
      const original = auditRows;
      auditRows = new Proxy(original, { get: (target, key) => (key === 'get' ? () => { throw new Error('audit db down'); } : Reflect.get(target, key)) }) as typeof auditRows;
      const result = signedResult({ type: 'exec_result', grantId: 'g-1', exitCode: 0, stdoutB64: '', stderrB64: '', truncated: false });
      client.handleMachineResult(ws, result);
      await expect(pending).resolves.toEqual(result);
    });
  });
});

describe('verifyResultFromMachine — the adapter', () => {
  it('given a pinned key that is not decodable, should answer bad_public_key rather than throw', () => {
    const frame = signedResult({ type: 'grant_denied', grantId: 'g', reason: 'x' });
    expect(verifyResultFromMachine({ frame, machinePublicKey: null })).toEqual({ ok: false, reason: 'bad_public_key' });
    expect(verifyResultFromMachine({ frame, machinePublicKey: '!!' })).toEqual({ ok: false, reason: 'bad_public_key' });
    expect(verifyResultFromMachine({ frame, machinePublicKey })).toMatchObject({ ok: true });
  });

  /**
   * GA wave 1 — the server's say becomes load-bearing at the ONE chokepoint:
   * signing. With `exec` off in `serverPolicy` the server refuses to sign an
   * exec grant, the signing key is never touched, and the daemon never sees
   * the frame.
   */
});
