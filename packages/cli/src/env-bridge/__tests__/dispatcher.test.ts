import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { canonicalizeArgs, decodeBase64, encodeGrant, verifyGrant, type Grant } from '@pagespace/lib/env-bridge/grant';
import { grantRequestForFrame, type GrantFrame } from '@pagespace/lib/env-bridge/grant-args';
import { decideExecution, type NormalizedRequest } from '@pagespace/lib/env-bridge/decide-execution';
import { encodeRevokeForSigning, verifyMachineResult, type MachineResultFrame } from '@pagespace/lib/env-bridge/machine-signatures';
import type { Frame } from '@pagespace/lib/env-bridge/frame-codec';
import type { MachinePolicy } from '@pagespace/lib/env-bridge/policy-types';
import type { PathProbe } from '@pagespace/lib/env-bridge/confine-path';
import { createDispatcher, DAEMON_CAPABILITIES, type DispatcherDeps } from '../dispatcher.js';
import { createDaemonNonceStore } from '../nonce-store.js';
import { generateMachineKeypair, signWithMachineKey } from '../keypair.js';
import { ed25519Verify, envBridgeHash } from '../crypto.js';
import type { AuditEntry } from '../audit-log.js';
import type { ExecRunner } from '../exec-runner.js';
import type { FsRunner } from '../fs-runner.js';
import type { AskPrompter } from '../ask.js';

// ---- a real server key and a real machine key -------------------------------
const serverPair = generateKeyPairSync('ed25519');
const serverPublicKey = new Uint8Array(serverPair.publicKey.export({ type: 'spki', format: 'der' }));
const serverKeyId = createHash('sha256').update(serverPublicKey).digest('hex').slice(0, 16);
const serverSign = (bytes: Uint8Array) => Buffer.from(nodeSign(null, bytes, serverPair.privateKey)).toString("base64");
const machine = generateMachineKeypair();
const machinePublicKey = decodeBase64(machine.publicKey)!;

const ENV_ID = 'env_1';
const ENROLLMENT_ID = 'enr_1';
const STARTED_AT = Date.parse('2026-09-06T10:00:00.000Z');
const NOW = STARTED_AT + 5_000;
const PRINCIPAL = { userId: 'u1', sessionId: 's1', conversationId: 'c1' };
const ROOT = '/real/proj';

const POLICY: MachinePolicy = { mode: 'allowlist', principals: ['u1'], ops: ['exec', 'fs_read', 'fs_write'], roots: [ROOT], envAllowlist: ['CI'], maxBytes: 4096, maxTimeoutMs: 10_000 };
const ASK_POLICY: MachinePolicy = { ...POLICY, mode: 'ask', ops: [] };

type UnsignedGrantFrame = { [K in GrantFrame['type']]: Omit<Extract<GrantFrame, { type: K }>, 'grant' | 'sig'> }[GrantFrame['type']];

let grantCounter = 0;
beforeEach(() => {
  grantCounter = 0;
});
function signedGrant(unsigned: UnsignedGrantFrame, overrides: Partial<Grant> = {}): GrantFrame {
  grantCounter += 1;
  const provisional = { ...unsigned, grant: {}, sig: '' } as unknown as GrantFrame;
  const request = grantRequestForFrame(provisional);
  const grant: Grant = {
    grantId: `grant_${grantCounter}`,
    envId: ENV_ID,
    principal: PRINCIPAL,
    op: request.op,
    argsHash: envBridgeHash(canonicalizeArgs(request.args)),
    iat: NOW - 1_000,
    exp: NOW + 30_000,
    nonce: `nonce_${grantCounter}`,
    ...overrides,
  };
  return { ...unsigned, grant: { ...grant, principal: { ...grant.principal } }, sig: serverSign(encodeGrant(grant)) } as unknown as GrantFrame;
}

const execFrame = (extra: Partial<Extract<GrantFrame, { type: 'grant_exec' }>> = {}) => signedGrant({ type: 'grant_exec', cmd: 'tool', args: ['a'], cwd: ROOT, env: { CI: '1' }, ...extra });

function fakeProbe(existing: Record<string, string> = { [ROOT]: ROOT, [`${ROOT}/file`]: `${ROOT}/file` }): PathProbe & { existing: Record<string, string> } {
  const probe = { existing, realpath: (path: string) => probe.existing[path] ?? null, isSymlink: () => false };
  return probe;
}

function harness(overrides: Partial<DispatcherDeps> = {}) {
  const audits: AuditEntry[] = [];
  const spawnRun = vi.fn(async (request: NormalizedRequest) => ({ exitCode: 0, stdout: Buffer.from(`ran ${request.cmd}`), stderr: Buffer.alloc(0), truncated: false, timedOut: false }));
  const execRunner: ExecRunner = { run: spawnRun, killAll: () => undefined, liveCount: () => 0 };
  const fsRunner: FsRunner = { read: vi.fn(async () => ({ kind: 'read' as const, found: true, contentB64: 'aGk=' })), write: vi.fn(async () => ({ kind: 'write' as const, ok: true })) };
  const deps: DispatcherDeps = {
    envId: ENV_ID,
    enrollmentId: ENROLLMENT_ID,
    serverKeyId,
    serverPublicKey,
    privateKey: machine.privateKey,
    sign: signWithMachineKey,
    verify: ed25519Verify,
    hash: envBridgeHash,
    now: () => NOW,
    startedAt: STARTED_AT,
    nonces: createDaemonNonceStore(),
    policy: () => POLICY,
    probe: fakeProbe(),
    execRunner,
    fsRunner,
    audit: { record: async (entry) => void audits.push(entry) },
    ask: null,
    log: () => undefined,
    ...overrides,
  };
  return { deps, audits, spawnRun, fsRunner, dispatcher: createDispatcher(deps) };
}

const verified = (frame: Frame) => verifyMachineResult({ frame: frame as MachineResultFrame, machinePublicKey, verify: ed25519Verify, hash: envBridgeHash });

describe('dispatcher — every grant: verifyGrant → decideExecution → runner ONLY on allow; every reply signed; every decision audited', () => {
  it('R1: given NO policy file (null), should deny every grant `no_policy`, audit it, answer a signed grant_denied, and never touch the runner', async () => {
    const h = harness({ policy: () => null });
    const result = await h.dispatcher.handle(execFrame());
    expect(result).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'no_policy', grantId: 'grant_1' } });
    expect(h.audits).toEqual([expect.objectContaining({ grantId: 'grant_1', op: 'exec', verdict: 'deny:no_policy', principal: PRINCIPAL })]);
    expect(h.spawnRun).not.toHaveBeenCalled();
    expect(verified((result as { frame: Frame }).frame)).toMatchObject({ ok: true });
  });

  it('R3: given a valid grant for a principal not in the policy, should deny `principal_not_allowed`, audit, and NOT call the runner (explicit negative)', async () => {
    const h = harness();
    const frame = signedGrant({ type: 'grant_exec', cmd: 'tool' }, { principal: { ...PRINCIPAL, userId: 'stranger' } });
    const result = await h.dispatcher.handle(frame);
    expect(result).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'principal_not_allowed' } });
    expect(h.audits[0]?.verdict).toBe('deny:principal_not_allowed');
    expect(h.spawnRun).not.toHaveBeenCalled();
  });

  it('CONTROL for R1/R3: the same harness DOES reach the runner on allow, so the negatives above are not vacuous', async () => {
    const h = harness();
    const result = await h.dispatcher.handle(execFrame());
    expect(h.spawnRun).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ kind: 'reply', frame: { type: 'exec_result', grantId: 'grant_1', exitCode: 0, truncated: false } });
    expect(Buffer.from((result as { frame: { stdoutB64: string } }).frame.stdoutB64, 'base64').toString()).toBe('ran tool');
    expect(h.audits[0]).toMatchObject({ verdict: 'allow', exitCode: 0, argsHash: expect.any(String) });
    expect(verified((result as { frame: Frame }).frame)).toMatchObject({ ok: true });
  });

  it('R6: given a grant whose env carries LD_PRELOAD, the runner must receive the NORMALIZED env only (scrubbed to the allowlist)', async () => {
    const h = harness();
    await h.dispatcher.handle(execFrame({ env: { CI: '1', LD_PRELOAD: '/evil.so', HOME: '/x' } }));
    expect(h.spawnRun).toHaveBeenCalledTimes(1);
    const request = h.spawnRun.mock.calls[0]![0];
    expect(request.env).toEqual({ CI: '1' });
    expect(request.cwd).toBe(ROOT);
    expect(request.timeoutMs).toBe(10_000);
    expect(request.maxBytes).toBe(4096);
  });

  it('given a tampered grant (signature over different bytes), should deny bad_signature and burn no nonce', async () => {
    const h = harness();
    const frame = execFrame();
    const tampered = { ...frame, grant: { ...frame.grant, exp: (frame.grant.exp as number) + 1 } } as GrantFrame;
    expect(await h.dispatcher.handle(tampered)).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'bad_signature' } });
    expect(h.deps.nonces.has('nonce_1')).toBe(false);
    expect(h.spawnRun).not.toHaveBeenCalled();
  });

  it('given a grant for another env, should deny wrong_env', async () => {
    const h = harness();
    expect(await h.dispatcher.handle(execFrame({}) && signedGrant({ type: 'grant_exec', cmd: 'tool' }, { envId: 'env_other' }))).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'wrong_env' } });
  });

  it('given a malformed grant (extra field), should deny `malformed` with the grantId it carried, or "unknown" when there is none', async () => {
    const h = harness();
    const frame = execFrame();
    expect(await h.dispatcher.handle({ ...frame, grant: { ...frame.grant, isAdmin: true } } as GrantFrame)).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'malformed', grantId: 'grant_1' } });
    expect(await h.dispatcher.handle({ ...frame, grant: {} } as GrantFrame)).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'malformed', grantId: 'unknown' } });
  });

  it('given the same grant twice, should run once and deny the replay', async () => {
    const h = harness();
    const frame = execFrame();
    await h.dispatcher.handle(frame);
    expect(await h.dispatcher.handle(frame)).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'replayed' } });
    expect(h.spawnRun).toHaveBeenCalledTimes(1);
  });

  it('C6: given a grant issued before this daemon started (minus skew), should deny `predates_daemon` even though its nonce is unknown here', async () => {
    const h = harness();
    const frame = signedGrant({ type: 'grant_exec', cmd: 'tool' }, { iat: STARTED_AT - 31_000, exp: NOW + 10_000 });
    expect(await h.dispatcher.handle(frame)).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'predates_daemon' } });
    expect(h.audits[0]?.verdict).toBe('deny:predates_daemon');
    expect(h.spawnRun).not.toHaveBeenCalled();
  });

  it('given a grant_pty_open (M2), should deny `unsupported` without verifying or burning anything; capabilities advertise pty:false', async () => {
    const h = harness();
    const frame = signedGrant({ type: 'grant_pty_open', cols: 80, rows: 24 });
    expect(await h.dispatcher.handle(frame)).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'unsupported' } });
    expect(h.deps.nonces.has('nonce_1')).toBe(false);
    expect(DAEMON_CAPABILITIES).toEqual({ shell: true, pty: false, fs: true, checkpoint: false });
  });

  it('given a cwd outside every root, should deny cwd_denied — nothing runs', async () => {
    const h = harness({ probe: fakeProbe({ [ROOT]: ROOT, '/etc': '/etc' }) });
    expect(await h.dispatcher.handle(execFrame({ cwd: '/etc' }))).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'cwd_denied' } });
    expect(h.spawnRun).not.toHaveBeenCalled();
  });

  it('fs_read: given an allow, should read the CONFINED path through the fs runner and answer a signed fs_read_result', async () => {
    const h = harness();
    const result = await h.dispatcher.handle(signedGrant({ type: 'grant_fs_read', paths: [`${ROOT}/file`] }));
    expect(h.fsRunner.read).toHaveBeenCalledWith(expect.objectContaining({ op: 'fs_read', paths: [`${ROOT}/file`] }));
    expect(result).toMatchObject({ kind: 'reply', frame: { type: 'fs_read_result', found: true, contentB64: 'aGk=' } });
    expect(verified((result as { frame: Frame }).frame)).toMatchObject({ ok: true });
  });

  it('fs_write: given an allow, should hand the runner the confined paths AND the signed file contents in order, and answer fs_write_result', async () => {
    const h = harness();
    const result = await h.dispatcher.handle(signedGrant({ type: 'grant_fs_write', files: [{ path: `${ROOT}/file`, contentB64: 'aGk=', mode: 0o600 }] }));
    expect(h.fsRunner.write).toHaveBeenCalledWith(expect.objectContaining({ paths: [`${ROOT}/file`] }), [{ contentB64: 'aGk=', mode: 0o600 }]);
    expect(result).toMatchObject({ kind: 'reply', frame: { type: 'fs_write_result', ok: true } });
  });

  it('fs_read: given the runner reports unsupported (multi path), should deny `unsupported_multi_path_read`', async () => {
    const h = harness();
    (h.fsRunner.read as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ kind: 'unsupported', reason: 'multi_path_read' });
    expect(await h.dispatcher.handle(signedGrant({ type: 'grant_fs_read', paths: [`${ROOT}/file`, `${ROOT}/file`] }))).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'unsupported_multi_path_read' } });
  });

  it('given the runner throws (refused env), should deny `runner_refused` rather than crash', async () => {
    const h = harness();
    h.spawnRun.mockRejectedValueOnce(new Error('exec-runner: refusing'));
    const result = await h.dispatcher.handle(execFrame());
    expect(result).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'runner_refused' } });
    expect(h.audits[0]?.verdict).toMatch(/^deny:runner_refused/);
  });

  it('ping → signed-free pong carrying the daemon clock', async () => {
    const h = harness();
    expect(await h.dispatcher.handle({ type: 'ping', ts: 1 })).toEqual({ kind: 'reply', frame: { type: 'pong', ts: NOW } });
  });

  it('pty_input / pty_resize / pty_kill (M2) are dropped and audited, never executed', async () => {
    const h = harness();
    expect(await h.dispatcher.handle({ type: 'pty_input', sessionId: 's', seq: 0, dataB64: '' })).toEqual({ kind: 'dropped', reason: 'unsupported_frame' });
    expect(h.audits[0]?.verdict).toBe('dropped:unsupported_frame');
  });

  describe('ask mode', () => {
    function askHarness(answer: boolean | (() => boolean), overrides: Partial<DispatcherDeps> = {}) {
      const ask: AskPrompter & { calls: number } = { calls: 0, ask: async () => { ask.calls += 1; return typeof answer === 'function' ? answer() : answer; } };
      return { ...harness({ policy: () => ASK_POLICY, ask, ...overrides }), ask };
    }

    it('R4: given an op not pre-approved, should prompt; a declined prompt denies `declined`, audits `ask:declined`, and nothing runs', async () => {
      const h = askHarness(false);
      expect(await h.dispatcher.handle(execFrame())).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'declined' } });
      expect(h.ask.calls).toBe(1);
      expect(h.audits[0]?.verdict).toBe('ask:declined');
      expect(h.spawnRun).not.toHaveBeenCalled();
    });

    it('R4: given an approved prompt, should run the SAME normalized request and audit allow', async () => {
      const h = askHarness(true);
      expect(await h.dispatcher.handle(execFrame())).toMatchObject({ kind: 'reply', frame: { type: 'exec_result', exitCode: 0 } });
      expect(h.spawnRun).toHaveBeenCalledTimes(1);
      expect(h.audits[0]?.verdict).toBe('allow');
    });

    it('added-1: verifyGrant is called EXACTLY once per grant even when the owner approves — the held Grant is reused, never re-verified', async () => {
      const gates = { verifyGrant: vi.fn(verifyGrant), decideExecution: vi.fn(decideExecution) };
      const h = askHarness(true, { gates });
      await h.dispatcher.handle(execFrame());
      expect(gates.verifyGrant).toHaveBeenCalledTimes(1);
      expect(gates.decideExecution).toHaveBeenCalledTimes(2);
      const second = gates.decideExecution.mock.calls[1]![0];
      expect(second.localApproval).toEqual({ grantId: 'grant_1', approvedAt: NOW, request: gates.decideExecution.mock.results[0]!.value.request });
      expect(second.grant).toBe(gates.decideExecution.mock.calls[0]![0].grant);
    });

    it('added-2: given the owner approves after grant.exp, should deny `approval_expired` (audited, answered as typed grant_denied) — approvedAt comes from the daemon clock', async () => {
      let now = NOW;
      const h = askHarness(() => { now = NOW + 31_000; return true; }, { now: () => now });
      expect(await h.dispatcher.handle(execFrame())).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'approval_expired' } });
      expect(h.audits[0]?.verdict).toBe('deny:approval_expired');
      expect(h.spawnRun).not.toHaveBeenCalled();
    });

    it('added-5: given the filesystem drifts between ask and approval (a root-internal link retargeted), should deny `approval_mismatch` and execute nothing', async () => {
      const probe = fakeProbe();
      const h = askHarness(() => { probe.existing[ROOT] = `${ROOT}-elsewhere`; probe.existing[`${ROOT}-elsewhere`] = `${ROOT}-elsewhere`; return true; }, { probe });
      expect(await h.dispatcher.handle(execFrame())).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'approval_mismatch' } });
      expect(h.audits[0]?.verdict).toBe('deny:approval_mismatch');
      expect(h.spawnRun).not.toHaveBeenCalled();
    });

    it('added-5: the normalized request handed to the prompt is frozen — it cannot be mutated while the owner reads it', async () => {
      let seen: NormalizedRequest | null = null;
      const ask: AskPrompter = { ask: async (input) => { seen = input.request; return false; } };
      const h = harness({ policy: () => ASK_POLICY, ask });
      await h.dispatcher.handle(execFrame());
      expect(Object.isFrozen(seen)).toBe(true);
      expect(Object.isFrozen((seen as unknown as NormalizedRequest).env)).toBe(true);
    });

    it('given an ask verdict with NO prompter available (headless), should deny `ask_unavailable` rather than run or hang', async () => {
      const h = harness({ policy: () => ASK_POLICY, ask: null });
      expect(await h.dispatcher.handle(execFrame())).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'ask_unavailable' } });
    });
  });

  describe('revoke (invariant 8)', () => {
    const revokeFrame = (issuedAt: number, keyId = serverKeyId): Frame => ({ type: 'revoke', issuedAt, sig: serverSign(encodeRevokeForSigning({ envId: ENV_ID, enrollmentId: ENROLLMENT_ID, keyId, issuedAt })), reason: 'deleted' });

    it('given a revoke signed under the pinned server key for THIS enrollment, should report revoke_verified and audit `revoked`', async () => {
      const h = harness();
      expect(await h.dispatcher.handle(revokeFrame(NOW))).toEqual({ kind: 'revoke_verified' });
      expect(h.audits[0]?.verdict).toBe('revoked');
    });

    it('given a revoke bound to a different keyId, or with a bad signature, should DROP it (audited) and stay connected', async () => {
      const h = harness();
      expect(await h.dispatcher.handle(revokeFrame(NOW, 'other-key'))).toEqual({ kind: 'dropped', reason: 'revoke_bad_signature' });
      expect(await h.dispatcher.handle({ type: 'revoke', issuedAt: NOW, sig: 'AAAA' })).toEqual({ kind: 'dropped', reason: 'revoke_bad_signature' });
      expect(h.audits.map((a) => a.verdict)).toEqual(['dropped:revoke_bad_signature', 'dropped:revoke_bad_signature']);
    });
  });
});
