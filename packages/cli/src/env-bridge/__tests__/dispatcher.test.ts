import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { canonicalizeArgs, decodeBase64, encodeGrant, verifyGrant, type ApprovalIntent, type Grant } from '@pagespace/lib/env-bridge/grant';
import { grantRequestForFrame, type GrantFrame } from '@pagespace/lib/env-bridge/grant-args';
import { decideExecution, type NormalizedRequest } from '@pagespace/lib/env-bridge/decide-execution';
import { encodeApprovalRevokeForSigning, encodeRevokeForSigning, verifyMachineResult, type MachineResultFrame } from '@pagespace/lib/env-bridge/machine-signatures';
import { execOutputCeiling, fsReadContentCeiling, type Frame } from '@pagespace/lib/env-bridge/frame-codec';
import type { MachinePolicy } from '@pagespace/lib/env-bridge/policy-types';
import type { PathProbe } from '@pagespace/lib/env-bridge/confine-path';
import { createDispatcher, DAEMON_CAPABILITIES, type DispatcherDeps } from '../dispatcher.js';
import { createDaemonNonceStore } from '../nonce-store.js';
import { createApprovalsStore } from '../approvals-store.js';
import { createChallengeStore } from '../challenge-store.js';
import { generateMachineKeypair, signWithMachineKey } from '../keypair.js';
import { ed25519Verify, envBridgeHash } from '../crypto.js';
import type { AuditEntry } from '../audit-log.js';
import type { ExecRunner } from '../exec-runner.js';
import type { FsRunner } from '../fs-runner.js';
import type { AskInput, AskPrompter } from '../ask.js';

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
    limits: { maxFrameBytes: 1024 * 1024 },
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
    expect(h.fsRunner.read).toHaveBeenCalledWith(expect.objectContaining({ op: 'fs_read', paths: [`${ROOT}/file`] }), expect.objectContaining({ roots: [ROOT] }));
    expect(result).toMatchObject({ kind: 'reply', frame: { type: 'fs_read_result', found: true, contentB64: 'aGk=' } });
    expect(verified((result as { frame: Frame }).frame)).toMatchObject({ ok: true });
  });

  it('fs_write: given an allow, should hand the runner the confined paths AND the signed file contents in order, and answer fs_write_result', async () => {
    const h = harness();
    const result = await h.dispatcher.handle(signedGrant({ type: 'grant_fs_write', files: [{ path: `${ROOT}/file`, contentB64: 'aGk=', mode: 0o600 }] }));
    expect(h.fsRunner.write).toHaveBeenCalledWith(expect.objectContaining({ paths: [`${ROOT}/file`] }), [{ contentB64: 'aGk=', mode: 0o600 }], { roots: [ROOT] });
    expect(result).toMatchObject({ kind: 'reply', frame: { type: 'fs_write_result', ok: true } });
  });

  it('fs_read: given the runner reports unsupported (multi path), should deny `unsupported_multi_path_read`', async () => {
    const h = harness();
    (h.fsRunner.read as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ kind: 'unsupported', reason: 'multi_path_read' });
    expect(await h.dispatcher.handle(signedGrant({ type: 'grant_fs_read', paths: [`${ROOT}/file`, `${ROOT}/file`] }))).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'unsupported_multi_path_read' } });
  });

  it('D: the runner\'s maxBytes is clamped to execOutputCeiling(frame limit) so a completed command\'s signed reply always decodes on the server', async () => {
    const h = harness({ policy: () => ({ ...POLICY, maxBytes: 50 * 1024 * 1024 }), limits: { maxFrameBytes: 64 * 1024 } });
    await h.dispatcher.handle(execFrame({ maxBytes: 50 * 1024 * 1024 }));
    const request = h.spawnRun.mock.calls[0]![0];
    expect(request.maxBytes).toBe(execOutputCeiling({ maxFrameBytes: 64 * 1024 }));
    expect(request.clamped).toBe(true);
  });

  it('D: a policy cap already below the frame ceiling is left alone', async () => {
    const h = harness();
    await h.dispatcher.handle(execFrame());
    expect(h.spawnRun.mock.calls[0]![0].maxBytes).toBe(4096);
  });

  it('P2: given the fs runner reports too_large, should deny `too_large` (the codec has no truncation marker for reads)', async () => {
    const h = harness();
    (h.fsRunner.read as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ kind: 'too_large', size: 5_000_000, maxContentBytes: 786_048 });
    expect(await h.dispatcher.handle(signedGrant({ type: 'grant_fs_read', paths: [`${ROOT}/file`] }))).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'too_large' } });
    expect(h.audits[0]?.verdict).toMatch(/^deny:too_large:5000000>786048$/);
  });

  it('P2: the fs runner receives the policy roots and a content ceiling derived from the frame limit', async () => {
    const h = harness();
    await h.dispatcher.handle(signedGrant({ type: 'grant_fs_read', paths: [`${ROOT}/file`] }));
    expect(h.fsRunner.read).toHaveBeenCalledWith(expect.anything(), { roots: [ROOT], maxContentBytes: fsReadContentCeiling({ maxFrameBytes: 1024 * 1024 }) });
    await h.dispatcher.handle(signedGrant({ type: 'grant_fs_write', files: [{ path: `${ROOT}/file`, contentB64: 'aGk=' }] }));
    expect(h.fsRunner.write).toHaveBeenCalledWith(expect.anything(), expect.anything(), { roots: [ROOT] });
  });

  it('P2: expired nonces are evicted as part of grant processing, so the store stays bounded over a long-running daemon', async () => {
    let now = NOW;
    const h = harness({ now: () => now });
    for (let i = 0; i < 20; i += 1) {
      await h.dispatcher.handle(signedGrant({ type: 'grant_exec', cmd: 'tool' }, { iat: now - 1_000, exp: now + 5_000 }));
      now += 10_000;
    }
    expect(h.deps.nonces.size()).toBeLessThanOrEqual(1);
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
      const ask: AskPrompter & { calls: number; inputs: AskInput[] } = {
        calls: 0,
        inputs: [],
        ask: async (input) => {
          ask.calls += 1;
          ask.inputs.push(input);
          const approved = typeof answer === 'function' ? answer() : answer;
          return approved ? { approved: true, scope: '30d' } : { approved: false };
        },
      };
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
      expect(h.audits[0]?.verdict).toBe('allow:approved:30d');
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
      const ask: AskPrompter = { ask: async (input) => { seen = input.request; return { approved: false }; } };
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

  describe('GA wave 2 · leaf 1 — durable approvals keyed (envId, userId, op, subject), never the session', () => {
    const BIN: Record<string, string> = { tool: '/usr/bin/tool', rm: '/bin/rm' };
    function durableHarness(answer: boolean | (() => boolean), scope: 'once' | 'session' | '30d' | 'until_revoked' = '30d', overrides: Partial<DispatcherDeps> = {}) {
      const fs = { content: null as string | null };
      const writes: string[] = [];
      const approvals = createApprovalsStore({
        path: '/home/me/.pagespace/env-approvals.json',
        uid: 501,
        open: () => (fs.content === null ? null : { uid: 501, mode: 0o100600, content: fs.content }),
        write: async (_p, content) => {
          writes.push(content);
          fs.content = content;
        },
        now: () => NOW,
      });
      const ask: AskPrompter & { calls: number } = {
        calls: 0,
        ask: async () => {
          ask.calls += 1;
          const approved = typeof answer === 'function' ? answer() : answer;
          return approved ? { approved: true, scope } : { approved: false };
        },
      };
      const ids = { approvalId: () => 'ap_1' };
      return { ...harness({ policy: () => ASK_POLICY, ask, approvals, resolveArgv0: (name) => BIN[name] ?? null, ids, ...overrides }), ask, approvals, fs, writes };
    }
    const fromSession = (session: string, extra: Partial<Extract<GrantFrame, { type: 'grant_exec' }>> = {}) =>
      signedGrant({ type: 'grant_exec', cmd: 'tool', args: ['a'], cwd: ROOT, env: { CI: '1' }, ...extra }, { principal: { ...PRINCIPAL, sessionId: session, conversationId: `conv_${session}` } });

    it('given an approval of `tool a` (30d), a later `tool b` from a NEW session and conversation runs with NO prompt, audited allow:approval:<id>', async () => {
      const h = durableHarness(true);
      expect(await h.dispatcher.handle(fromSession('s1'))).toMatchObject({ kind: 'reply', frame: { type: 'exec_result' } });
      expect(h.ask.calls).toBe(1);
      expect(h.writes).toHaveLength(1);
      expect(JSON.parse(h.writes[0]!)).toEqual({ version: 1, approvals: [{ approvalId: 'ap_1', envId: ENV_ID, userId: 'u1', op: 'exec', subject: 'exec:/usr/bin/tool', scope: '30d', createdAt: NOW, expiresAt: NOW + 30 * 24 * 3600 * 1000 }] });
      expect(await h.dispatcher.handle(fromSession('s2', { args: ['b'] }))).toMatchObject({ kind: 'reply', frame: { type: 'exec_result' } });
      expect(h.ask.calls).toBe(1);
      expect(h.audits[1]?.verdict).toBe('allow:approval:ap_1');
      expect(h.spawnRun).toHaveBeenCalledTimes(2);
    });

    it('given an approval of `tool`, a later `rm` prompts again (subject differs) and a declined prompt runs nothing', async () => {
      const h = durableHarness(() => h.ask.calls === 1);
      await h.dispatcher.handle(fromSession('s1'));
      expect(await h.dispatcher.handle(fromSession('s1', { cmd: 'rm', args: ['-rf', 'x'] }))).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'declined' } });
      expect(h.ask.calls).toBe(2);
      expect(h.spawnRun).toHaveBeenCalledTimes(1);
    });

    it('given the prompt is answered with scope once, nothing is remembered: the same command from the same session prompts again', async () => {
      const h = durableHarness(true, 'once');
      await h.dispatcher.handle(fromSession('s1'));
      await h.dispatcher.handle(fromSession('s1'));
      expect(h.ask.calls).toBe(2);
      expect(h.writes).toHaveLength(0);
      expect(h.approvals.entries()).toEqual([]);
    });

    it('given scope session, the approval is remembered in this process only — nothing written', async () => {
      const h = durableHarness(true, 'session');
      await h.dispatcher.handle(fromSession('s1'));
      await h.dispatcher.handle(fromSession('s2'));
      expect(h.ask.calls).toBe(1);
      expect(h.writes).toHaveLength(0);
    });

    it('given a request whose programs cannot be pinned down (`sh -c` with substitution), the prompt says so (subjects null) and NOTHING is remembered even on approval', async () => {
      const h = durableHarness(true);
      const frame = () => fromSession('s1', { cmd: 'sh', args: ['-c', 'tool $(rm -rf x)'] });
      // `sh` resolves, so the request is well formed; its subjects are still null.
      const withSh = { ...h, dispatcher: createDispatcher({ ...h.deps, resolveArgv0: (name) => ({ ...BIN, sh: '/bin/sh' })[name] ?? null }) };
      await withSh.dispatcher.handle(frame());
      await withSh.dispatcher.handle(frame());
      expect(h.ask.calls).toBe(2);
      expect(h.writes).toHaveLength(0);
    });

    it('given a durable approval in the FILE from an earlier daemon run, a fresh daemon runs the covered command with no prompt (a new chat does not re-prompt)', async () => {
      const h = durableHarness(false);
      h.fs.content = JSON.stringify({ version: 1, approvals: [{ approvalId: 'old', envId: ENV_ID, userId: 'u1', op: 'exec', subject: 'exec:/usr/bin/tool', scope: 'until_revoked', createdAt: 1, expiresAt: null }] });
      expect(await h.dispatcher.handle(fromSession('s9'))).toMatchObject({ kind: 'reply', frame: { type: 'exec_result' } });
      expect(h.ask.calls).toBe(0);
    });

    it('given an approval for ANOTHER user or another env in the file, should still prompt (all four key parts)', async () => {
      const h = durableHarness(false);
      h.fs.content = JSON.stringify({ version: 1, approvals: [
        { approvalId: 'o1', envId: ENV_ID, userId: 'u2', op: 'exec', subject: 'exec:/usr/bin/tool', scope: 'until_revoked', createdAt: 1, expiresAt: null },
        { approvalId: 'o2', envId: 'env_other', userId: 'u1', op: 'exec', subject: 'exec:/usr/bin/tool', scope: 'until_revoked', createdAt: 1, expiresAt: null },
      ] });
      expect(await h.dispatcher.handle(fromSession('s9'))).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'declined' } });
      expect(h.ask.calls).toBe(1);
    });

    it('given a file the daemon does not trust (writable by others), no approval in it counts', async () => {
      const h = durableHarness(false, '30d', {});
      const store = createApprovalsStore({ path: '/p', uid: 501, open: () => ({ uid: 501, mode: 0o100666, content: JSON.stringify({ version: 1, approvals: [{ approvalId: 'old', envId: ENV_ID, userId: 'u1', op: 'exec', subject: 'exec:/usr/bin/tool', scope: 'until_revoked', createdAt: 1, expiresAt: null }] }) }), write: async () => undefined, now: () => NOW });
      const d = createDispatcher({ ...h.deps, approvals: store });
      expect(await d.handle(fromSession('s9'))).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'declined' } });
    });

    it('an approval is written ONLY after the byte-compare allowed the request: a drift between prompt and answer (approval_mismatch) remembers nothing', async () => {
      const probe = fakeProbe();
      const h = durableHarness(() => { probe.existing[ROOT] = `${ROOT}-elsewhere`; probe.existing[`${ROOT}-elsewhere`] = `${ROOT}-elsewhere`; return true; }, '30d', { probe });
      expect(await h.dispatcher.handle(fromSession('s1'))).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'approval_mismatch' } });
      expect(h.writes).toHaveLength(0);
      expect(h.approvals.entries()).toEqual([]);
    });

    it('a policy that PRE-APPROVES the op never consults approvals and audits plain allow', async () => {
      const h = durableHarness(false, '30d', { policy: () => POLICY });
      expect(await h.dispatcher.handle(fromSession('s1'))).toMatchObject({ kind: 'reply', frame: { type: 'exec_result' } });
      expect(h.audits[0]?.verdict).toBe('allow');
    });
  });

  describe('GA wave 2 · leaf 4 — the challenge store: an ask with no terminal freezes the request and answers ask_pending:<id>', () => {
    const BIN: Record<string, string> = { tool: '/usr/bin/tool', rm: '/bin/rm' };
    function chatHarness(overrides: Partial<DispatcherDeps> = {}) {
      let n = 0;
      const challenges = createChallengeStore({ newId: () => `ch_${++n}` });
      return { ...harness({ policy: () => ASK_POLICY, ask: null, challenges, resolveArgv0: (name) => BIN[name] ?? null, ...overrides }), challenges };
    }

    it('given an ask verdict and no prompter, should freeze the NORMALISED request under a challenge whose TTL is the grant exp, answer a SIGNED grant_denied ask_pending:<id> carrying it verbatim, audit ask:pending:<id>, and run nothing', async () => {
      const h = chatHarness();
      const frame = execFrame({ env: { CI: '1', LD_PRELOAD: '/evil.so' }, timeoutMs: 999_999 });
      const result = await h.dispatcher.handle(frame);
      expect(result).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', grantId: 'grant_1', reason: 'ask_pending:ch_1' } });
      const denied = (result as { frame: Extract<Frame, { type: 'grant_denied' }> }).frame;
      expect(denied.pending).toEqual({ challengeId: 'ch_1', expiresAt: NOW + 30_000, request: { op: 'exec', cmd: 'tool', args: ['a'], cwd: ROOT, paths: [], env: { CI: '1' }, timeoutMs: 10_000, maxBytes: 4096, clamped: true } });
      expect(verified(denied)).toMatchObject({ ok: true });
      expect(h.audits[0]).toMatchObject({ grantId: 'grant_1', verdict: 'ask:pending:ch_1', argsHash: expect.any(String) });
      expect(h.spawnRun).not.toHaveBeenCalled();
      expect(h.challenges.size()).toBe(1);
      expect(h.challenges.peek('ch_1', NOW)).toMatchObject({ request: denied.pending!.request, subjects: ['exec:/usr/bin/tool'], exp: NOW + 30_000 });
    });

    it('given a second ask for the same subject while one is pending, should answer the SAME id and not grow the store', async () => {
      const h = chatHarness();
      await h.dispatcher.handle(execFrame());
      expect(await h.dispatcher.handle(execFrame({ args: ['b'] }))).toMatchObject({ kind: 'reply', frame: { reason: 'ask_pending:ch_1' } });
      expect(h.challenges.size()).toBe(1);
      expect(await h.dispatcher.handle(execFrame({ cmd: 'rm' }))).toMatchObject({ kind: 'reply', frame: { reason: 'ask_pending:ch_2' } });
      expect(h.challenges.size()).toBe(2);
    });

    it('given a prompter AND preferChat, should go to the chat and never prompt the terminal', async () => {
      const ask: AskPrompter & { calls: number } = { calls: 0, ask: async () => { ask.calls += 1; return { approved: true, scope: '30d' }; } };
      const h = chatHarness({ ask, preferChat: true });
      expect(await h.dispatcher.handle(execFrame())).toMatchObject({ kind: 'reply', frame: { reason: 'ask_pending:ch_1' } });
      expect(ask.calls).toBe(0);
    });

    it('given a prompter and no preference, should prompt the terminal and not touch the store', async () => {
      const ask: AskPrompter = { ask: async () => ({ approved: false }) };
      const h = chatHarness({ ask });
      expect(await h.dispatcher.handle(execFrame())).toMatchObject({ kind: 'reply', frame: { reason: 'declined' } });
      expect(h.challenges.size()).toBe(0);
    });

    it('given the store is full, should deny ask_unavailable (audited as such) rather than evict a pending question', async () => {
      const challenges = createChallengeStore({ newId: () => 'ch_x', max: 1 });
      const h = chatHarness({ challenges });
      await h.dispatcher.handle(execFrame());
      expect(await h.dispatcher.handle(execFrame({ cmd: 'rm' }))).toMatchObject({ kind: 'reply', frame: { reason: 'ask_unavailable' } });
      expect(h.audits[1]?.verdict).toBe('deny:ask_unavailable:challenges_full');
    });

    it('given a durable approval covering the subject, should run without freezing anything', async () => {
      const approvals = createApprovalsStore({ path: '/p', uid: 501, open: () => ({ uid: 501, mode: 0o100600, content: JSON.stringify({ version: 1, approvals: [{ approvalId: 'old', envId: ENV_ID, userId: 'u1', op: 'exec', subject: 'exec:/usr/bin/tool', scope: 'until_revoked', createdAt: 1, expiresAt: null }] }) }), write: async () => undefined, now: () => NOW });
      const h = chatHarness({ approvals });
      expect(await h.dispatcher.handle(execFrame())).toMatchObject({ kind: 'reply', frame: { type: 'exec_result' } });
      expect(h.challenges.size()).toBe(0);
    });

    it('given no prompter and no challenge store, should deny ask_unavailable (unchanged)', async () => {
      const h = harness({ policy: () => ASK_POLICY, ask: null });
      expect(await h.dispatcher.handle(execFrame())).toMatchObject({ kind: 'reply', frame: { reason: 'ask_unavailable' } });
    });
  });

  describe('GA wave 2 · leaf 7 — the click: the daemon byte-compares the re-issued request against the one it froze; only a match writes the approval and runs', () => {
    const BIN: Record<string, string> = { tool: '/usr/bin/tool', rm: '/bin/rm' };
    const INTENT: ApprovalIntent = { challengeId: 'ch_1', scope: '30d', expiresAt: NOW + 30_000 };
    function clickHarness(overrides: Partial<DispatcherDeps> = {}) {
      let n = 0;
      const challenges = createChallengeStore({ newId: () => `ch_${++n}` });
      const fs = { content: null as string | null };
      const writes: string[] = [];
      const approvals = createApprovalsStore({ path: '/p', uid: 501, open: () => (fs.content === null ? null : { uid: 501, mode: 0o100600, content: fs.content }), write: async (_p, c) => { writes.push(c); fs.content = c; }, now: () => NOW });
      return { ...harness({ policy: () => ASK_POLICY, ask: null, challenges, approvals, resolveArgv0: (name) => BIN[name] ?? null, ...overrides }), challenges, writes };
    }
    /** The click: the SAME unsigned frame, a fresh grant, plus the server-signed intent. */
    const click = (extra: Partial<Extract<GrantFrame, { type: 'grant_exec' }>> = {}, intent: Partial<ApprovalIntent> = {}, principal = PRINCIPAL, grantOverrides: Partial<Grant> = {}) =>
      signedGrant({ type: 'grant_exec', cmd: 'tool', args: ['a'], cwd: ROOT, env: { CI: '1' }, ...extra }, { approvalIntent: { ...INTENT, ...intent }, principal: { ...principal, sessionId: 'later', conversationId: 'later' }, ...grantOverrides });

    it('given a click whose re-issued request is BYTE-IDENTICAL to the frozen one, should run it, audit allow:click:<id>:<scope>, remember the approval under the challenge id, and spend the challenge', async () => {
      const h = clickHarness();
      expect(await h.dispatcher.handle(execFrame())).toMatchObject({ kind: 'reply', frame: { reason: 'ask_pending:ch_1' } });
      const result = await h.dispatcher.handle(click());
      expect(result).toMatchObject({ kind: 'reply', frame: { type: 'exec_result', exitCode: 0 } });
      expect(h.spawnRun).toHaveBeenCalledTimes(1);
      expect(h.spawnRun.mock.calls[0]![0]).toMatchObject({ cmd: 'tool', args: ['a'], cwd: ROOT, env: { CI: '1' } });
      expect(h.audits[1]).toMatchObject({ grantId: 'grant_2', verdict: 'allow:click:ch_1:30d' });
      expect(JSON.parse(h.writes[0]!)).toMatchObject({ approvals: [expect.objectContaining({ approvalId: 'ch_1', subject: 'exec:/usr/bin/tool', scope: '30d', userId: 'u1' })] });
      expect(h.challenges.size()).toBe(0);
      // And a third request for the same program from a new chat is now covered: no challenge, no click.
      expect(await h.dispatcher.handle(execFrame({ args: ['zzz'] }))).toMatchObject({ kind: 'reply', frame: { type: 'exec_result' } });
    });

    it('EXIT CRITERION: a chat click cannot introduce a request the machine did not frame — a click over DIFFERENT bytes is approval_mismatch, executes nothing, remembers nothing, is audited', async () => {
      const h = clickHarness();
      await h.dispatcher.handle(execFrame());
      for (const different of [click({ cmd: 'rm', args: ['-rf', 'x'] }), click({ args: ['b'] }), click({ env: { CI: '2' } }), click({ cwd: `${ROOT}/file` })]) {
        expect(await h.dispatcher.handle(different)).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'approval_mismatch' } });
      }
      expect(h.spawnRun).not.toHaveBeenCalled();
      expect(h.writes).toHaveLength(0);
      expect(h.audits.slice(1).every((a) => a.verdict.startsWith('deny:approval_mismatch'))).toBe(true);
      // The genuine question is still pending: a matching click can still answer it.
      expect(h.challenges.size()).toBe(1);
      expect(await h.dispatcher.handle(click())).toMatchObject({ kind: 'reply', frame: { type: 'exec_result' } });
    });

    it('given a click for a challenge the daemon never froze (a guessed id, or an approval the SERVER "recorded"), should deny approval_unknown and run nothing', async () => {
      const h = clickHarness();
      expect(await h.dispatcher.handle(click({}, { challengeId: 'ch_never' }))).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'approval_unknown' } });
      expect(h.audits[0]?.verdict).toBe('deny:approval_unknown:ch_never');
      expect(h.spawnRun).not.toHaveBeenCalled();
      expect(h.writes).toHaveLength(0);
    });

    it('given a click after the intent expiry or after the challenge TTL, should deny approval_expired', async () => {
      const h = clickHarness();
      await h.dispatcher.handle(execFrame());
      expect(await h.dispatcher.handle(click({}, { expiresAt: NOW - 1 }))).toMatchObject({ kind: 'reply', frame: { reason: 'approval_expired' } });
      let now = NOW;
      const late = clickHarness({ now: () => now });
      await late.dispatcher.handle(execFrame());
      now = NOW + 31_000; // past the frozen grant's exp: the challenge is evicted (the click's own grant is fresh)
      expect(await late.dispatcher.handle(click({}, { expiresAt: NOW + 60_000 }, PRINCIPAL, { iat: now - 1000, exp: now + 30_000 }))).toMatchObject({ kind: 'reply', frame: { reason: 'approval_unknown' } });
      expect(h.spawnRun).not.toHaveBeenCalled();
      expect(late.spawnRun).not.toHaveBeenCalled();
    });

    it('given a click carrying ANOTHER user\'s principal for a challenge frozen for u1, should deny approval_mismatch', async () => {
      const h = clickHarness({ policy: () => ({ ...ASK_POLICY, principals: ['u1', 'u2'] }) });
      await h.dispatcher.handle(execFrame());
      expect(await h.dispatcher.handle(click({}, {}, { ...PRINCIPAL, userId: 'u2' }))).toMatchObject({ kind: 'reply', frame: { reason: 'approval_mismatch' } });
      expect(h.spawnRun).not.toHaveBeenCalled();
    });

    it('given scope once, should run and remember nothing; given until_revoked, should remember with no expiry', async () => {
      const once = clickHarness();
      await once.dispatcher.handle(execFrame());
      expect(await once.dispatcher.handle(click({}, { scope: 'once' }))).toMatchObject({ kind: 'reply', frame: { type: 'exec_result' } });
      expect(once.writes).toHaveLength(0);
      const forever = clickHarness();
      await forever.dispatcher.handle(execFrame());
      await forever.dispatcher.handle(click({}, { scope: 'until_revoked' }));
      expect(JSON.parse(forever.writes[0]!)).toMatchObject({ approvals: [expect.objectContaining({ approvalId: 'ch_1', scope: 'until_revoked', expiresAt: null })] });
    });

    it('a click is only ever a fresh grant: the intent rides the signature (a forged one is bad_signature) and its nonce is spent like any other', async () => {
      const h = clickHarness();
      await h.dispatcher.handle(execFrame());
      const forged = click();
      const tampered = { ...forged, grant: { ...forged.grant, approvalIntent: { ...INTENT, scope: 'until_revoked' } } } as GrantFrame;
      expect(await h.dispatcher.handle(tampered)).toMatchObject({ kind: 'reply', frame: { reason: 'bad_signature' } });
      const genuine = click();
      await h.dispatcher.handle(genuine);
      expect(await h.dispatcher.handle(genuine)).toMatchObject({ kind: 'reply', frame: { reason: 'replayed' } });
      expect(h.spawnRun).toHaveBeenCalledTimes(1);
    });
  });

  describe('GA wave 2 · leaf 8 — the server revokes ONE approval over the signed revoke frame; the machine file stays authoritative for ALLOW', () => {
    const approvalRevoke = (approvalId: string, issuedAt = NOW, keyId = serverKeyId): Frame => ({ type: 'revoke', approvalId, issuedAt, sig: serverSign(encodeApprovalRevokeForSigning({ envId: ENV_ID, enrollmentId: ENROLLMENT_ID, keyId, issuedAt, approvalId })), reason: 'owner' });
    function revokeHarness() {
      const fs = { content: JSON.stringify({ version: 1, approvals: [
        { approvalId: 'ch_1', envId: ENV_ID, userId: 'u1', op: 'exec', subject: 'exec:/usr/bin/tool', scope: 'until_revoked', createdAt: 1, expiresAt: null },
        { approvalId: 'ch_1', envId: ENV_ID, userId: 'u1', op: 'exec', subject: 'builtin:cd', scope: 'until_revoked', createdAt: 1, expiresAt: null },
        { approvalId: 'ch_2', envId: ENV_ID, userId: 'u1', op: 'exec', subject: 'exec:/bin/rm', scope: 'until_revoked', createdAt: 1, expiresAt: null },
      ] }) as string | null };
      const approvals = createApprovalsStore({ path: '/p', uid: 501, open: () => (fs.content === null ? null : { uid: 501, mode: 0o100600, content: fs.content }), write: async (_p, c) => { fs.content = c; }, now: () => NOW });
      return { ...harness({ policy: () => ASK_POLICY, ask: null, approvals, resolveArgv0: (name) => ({ tool: '/usr/bin/tool', rm: '/bin/rm' })[name] ?? null }), approvals, fs };
    }

    it('given a signed approval revoke, should delete exactly that approval\'s rows, audit approval_revoked:<id>:<n>, and report approval_revoked — NOT revoke_verified: the key and the enrollment stand', async () => {
      const h = revokeHarness();
      expect(await h.dispatcher.handle(approvalRevoke('ch_1'))).toEqual({ kind: 'approval_revoked', approvalId: 'ch_1', removed: 2 });
      expect(h.approvals.entries().map((a) => a.approvalId)).toEqual(['ch_2']);
      expect(h.audits[0]?.verdict).toBe('approval_revoked:ch_1:2');
      // The revoked program now asks again; the untouched one still runs.
      expect(await h.dispatcher.handle(execFrame())).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'ask_unavailable' } });
      expect(await h.dispatcher.handle(execFrame({ cmd: 'rm' }))).toMatchObject({ kind: 'reply', frame: { type: 'exec_result' } });
    });

    it('given an approval revoke for an id the machine does not hold, should report 0 removed and change nothing', async () => {
      const h = revokeHarness();
      expect(await h.dispatcher.handle(approvalRevoke('ch_nope'))).toEqual({ kind: 'approval_revoked', approvalId: 'ch_nope', removed: 0 });
      expect(h.approvals.entries()).toHaveLength(3);
    });

    it('given an approval revoke NOT signed by the pinned key, or signed for another id, should drop it and delete nothing', async () => {
      const h = revokeHarness();
      const forged = { ...approvalRevoke('ch_1'), approvalId: 'ch_2' } as Frame;
      expect(await h.dispatcher.handle(forged)).toEqual({ kind: 'dropped', reason: 'revoke_bad_signature' });
      expect(await h.dispatcher.handle(approvalRevoke('ch_1', NOW, 'other-key'))).toEqual({ kind: 'dropped', reason: 'revoke_bad_signature' });
      expect(h.approvals.entries()).toHaveLength(3);
      expect(h.audits.map((a) => a.verdict)).toEqual(['dropped:approval_revoke_bad_signature', 'dropped:approval_revoke_bad_signature']);
    });

    it('given a signed approval revoke with the id STRIPPED, should drop it — it can never become an enrollment revoke (no deleteKey)', async () => {
      const h = revokeHarness();
      const { approvalId: _dropped, ...stripped } = approvalRevoke('ch_1') as Extract<Frame, { type: 'revoke' }>;
      expect(await h.dispatcher.handle(stripped as Frame)).toEqual({ kind: 'dropped', reason: 'revoke_bad_signature' });
    });

    it('THE ASYMMETRY: nothing the server sends can ADD an approval — a revoke frame, a grant, a click for a challenge the machine never froze: the store only grows after the machine\'s own byte-compared approval', async () => {
      const h = revokeHarness();
      await h.dispatcher.handle(approvalRevoke('ch_1')); // tool is no longer covered
      const before = h.approvals.entries().length;
      await h.dispatcher.handle(approvalRevoke('ch_9'));
      await h.dispatcher.handle(execFrame({ cmd: 'rm' }));
      expect(await h.dispatcher.handle(signedGrant({ type: 'grant_exec', cmd: 'tool', cwd: ROOT }, { approvalIntent: { challengeId: 'server_recorded', scope: 'until_revoked', expiresAt: NOW + 30_000 } }))).toMatchObject({ kind: 'reply', frame: { reason: 'approval_unknown' } });
      expect(h.approvals.entries().length).toBe(before);
      expect(h.spawnRun).toHaveBeenCalledTimes(1); // only rm (covered by ch_2)
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
