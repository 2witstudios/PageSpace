import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, createPrivateKey, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { canonicalizeArgs, decodeBase64, encodeGrant, verifyGrant, type ApprovalIntent, type Grant } from '@pagespace/lib/env-bridge/grant';
import { grantRequestForFrame, type GrantFrame } from '@pagespace/lib/env-bridge/grant-args';
import { decideExecution, type NormalizedRequest } from '@pagespace/lib/env-bridge/decide-execution';
import { encodePauseForSigning, encodeApprovalRevokeForSigning, encodeRevokeForSigning, verifyMachineResult, type MachineResultFrame } from '@pagespace/lib/env-bridge/machine-signatures';
import { execOutputCeiling, fsReadContentCeiling, type Frame } from '@pagespace/lib/env-bridge/frame-codec';
import type { MachinePolicy } from '@pagespace/lib/env-bridge/policy-types';
import type { PathProbe } from '@pagespace/lib/env-bridge/confine-path';
import { createDispatcher, DAEMON_CAPABILITIES, type DispatcherDeps } from '../dispatcher.js';
import { createDaemonNonceStore } from '../nonce-store.js';
import { createApprovalsStore, type ApprovalsStore } from '../approvals-store.js';
import { createChallengeStore, type ChallengeStore } from '../challenge-store.js';
import { generateMachineKeypair, signWithMachineKey } from '../keypair.js';
import { ed25519Verify, envBridgeHash, envBridgeSha256, es256Verify } from '../crypto.js';
import { deriveOwnerApprovalChallenge, pendingRequestForWire, type OwnerApprovalRequest, type PinnedOwnerApproval } from '../lib-core.js';
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

// ---------------------------------------------------------------------------
// The OWNER's authenticator (hardening B). A real P-256 credential, so the
// assertion rows are signed and verified for real rather than simulated —
// only the pinning and the two primitives are handed to the dispatcher.
// ---------------------------------------------------------------------------
const RP_ID = 'pagespace.test';
const ORIGIN = 'https://pagespace.test';
const b64url = (bytes: Uint8Array | Buffer): string => Buffer.from(bytes).toString('base64url');

function makeOwnerCredential(credentialId: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const cose = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from([0x22, 0x58, 0x20]),
    Buffer.from(jwk.y, 'base64url'),
  ]);
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
  return {
    credentialId: b64url(Buffer.from(credentialId)),
    publicKeyCose: b64url(cose),
    sign: (message: Uint8Array) => new Uint8Array(nodeSign('sha256', message, createPrivateKey(pem))),
  };
}

const OWNER_CREDENTIAL = makeOwnerCredential('owner-key');
const IMPOSTOR_CREDENTIAL = makeOwnerCredential('impostor-key');
const PINNED_OWNER: PinnedOwnerApproval = { rpId: RP_ID, origin: ORIGIN, credentials: [{ credentialId: OWNER_CREDENTIAL.credentialId, publicKeyCose: OWNER_CREDENTIAL.publicKeyCose }] };
const OWNER_APPROVAL_GATE = { pinned: PINNED_OWNER, sha256: envBridgeSha256, verifyEs256: es256Verify };

interface AssertionOverrides {
  readonly type?: string;
  readonly challenge?: string;
  readonly origin?: string;
  readonly rpId?: string;
  readonly flags?: number;
  readonly credential?: typeof OWNER_CREDENTIAL;
}

/**
 * A WebAuthn assertion over the challenge DERIVED from the request the machine
 * froze — the only thing that can make a chat approval run.
 */
function ownerAssertion(envId: string, challengeId: string, request: OwnerApprovalRequest, over: AssertionOverrides = {}) {
  const credential = over.credential ?? OWNER_CREDENTIAL;
  const challenge = over.challenge ?? deriveOwnerApprovalChallenge({ envId, challengeId, request }, envBridgeSha256);
  const clientDataJSON = Buffer.from(JSON.stringify({ type: over.type ?? 'webauthn.get', challenge, origin: over.origin ?? ORIGIN, crossOrigin: false }));
  const authenticatorData = Buffer.concat([createHash('sha256').update(over.rpId ?? RP_ID).digest(), Buffer.from([over.flags ?? 0x05]), Buffer.alloc(4)]);
  const signed = Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()]);
  return {
    credentialId: credential.credentialId,
    authenticatorData: b64url(authenticatorData),
    clientDataJSON: b64url(clientDataJSON),
    signature: b64url(credential.sign(signed)),
  };
}

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
  const execRunner: ExecRunner = { run: spawnRun, killAll: () => 0, liveCount: () => 0 };
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
    // The owner's pinned credentials (hardening B). A daemon WITHOUT this
    // refuses every chat approval; the tests that assert that pass
    // `ownerApproval: undefined` explicitly.
    ownerApproval: OWNER_APPROVAL_GATE,
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

  describe('A5: the machine\'s audit line names the resolved paths', () => {
    it('given an allowed fs_write, should audit the CONFINED path it wrote', async () => {
      const h = harness();
      await h.dispatcher.handle(signedGrant({ type: 'grant_fs_write', files: [{ path: `${ROOT}/file`, contentB64: 'aGk=', mode: 0o600 }] }));
      expect(h.audits.at(-1)).toMatchObject({ op: 'fs_write', verdict: 'allow', paths: [`${ROOT}/file`] });
    });

    it('given an allowed fs_read, should audit the resolved path it read', async () => {
      const h = harness();
      await h.dispatcher.handle(signedGrant({ type: 'grant_fs_read', paths: [`${ROOT}/file`] }));
      expect(h.audits.at(-1)).toMatchObject({ op: 'fs_read', verdict: 'allow', paths: [`${ROOT}/file`] });
    });

    it('given a path that RESOLVES elsewhere (a symlink inside the root), should audit the CONFINED path, not the one the server named', async () => {
      const probe = fakeProbe({ [ROOT]: ROOT, [`${ROOT}/link`]: `${ROOT}/real.txt` });
      const h = harness({ probe });
      await h.dispatcher.handle(signedGrant({ type: 'grant_fs_read', paths: [`${ROOT}/link`] }));
      expect(h.audits.at(-1)).toMatchObject({ verdict: 'allow', paths: [`${ROOT}/real.txt`] });
    });

    it('given a REFUSED fs op, should still name the path — a refusal that says nothing about WHAT was refused is not a record', async () => {
      const h = harness();
      await h.dispatcher.handle(signedGrant({ type: 'grant_fs_read', paths: ['/etc/passwd'] }));
      expect(h.audits.at(-1)).toMatchObject({ verdict: 'deny:path_denied', paths: ['/etc/passwd'] });
    });

    it('given an exec, should not gain a paths field it has no use for', async () => {
      const h = harness();
      await h.dispatcher.handle(execFrame());
      expect(h.audits.at(-1)?.paths ?? null).toBeNull();
    });
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
      /**
       * The owner's assertion for a question this machine is actually
       * holding — bound to the request IT froze, which is what the daemon
       * re-derives. `undefined` when nothing is pending under that id.
       */
      const proof = (challengeId = 'ch_1', over: AssertionOverrides = {}) => {
        const frozen = challenges.peek(challengeId, NOW);
        return frozen === undefined ? undefined : ownerAssertion(ENV_ID, challengeId, pendingRequestForWire(frozen.request), over);
      };
      return { ...harness({ policy: () => ASK_POLICY, ask: null, challenges, approvals, resolveArgv0: (name) => BIN[name] ?? null, ...overrides }), challenges, writes, proof };
    }
    /**
     * The click: the SAME unsigned frame, a fresh grant, the server-signed
     * intent — and the owner's assertion, without which the daemon runs
     * nothing (hardening B). Callers pass `h.proof()`.
     */
    const click = (
      extra: Partial<Extract<GrantFrame, { type: 'grant_exec' }>> = {},
      intent: Partial<ApprovalIntent> = {},
      principal = PRINCIPAL,
      grantOverrides: Partial<Grant> = {},
      assertion?: ApprovalIntent['assertion'],
    ) =>
      signedGrant({ type: 'grant_exec', cmd: 'tool', args: ['a'], cwd: ROOT, env: { CI: '1' }, ...extra }, { approvalIntent: { ...INTENT, ...(assertion !== undefined && { assertion }), ...intent }, principal: { ...principal, sessionId: 'later', conversationId: 'later' }, ...grantOverrides });

    it('given a click whose re-issued request is BYTE-IDENTICAL to the frozen one, should run it, audit allow:click:<id>:<scope>, remember the approval under the challenge id, and spend the challenge', async () => {
      const h = clickHarness();
      expect(await h.dispatcher.handle(execFrame())).toMatchObject({ kind: 'reply', frame: { reason: 'ask_pending:ch_1' } });
      const result = await h.dispatcher.handle(click({}, {}, PRINCIPAL, {}, h.proof()));
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
      // Each carries the owner's GENUINE assertion for the pending question — the realistic attack, and the one only the byte-compare catches.
      const proof = h.proof();
      for (const different of [click({ cmd: 'rm', args: ['-rf', 'x'] }, {}, PRINCIPAL, {}, proof), click({ args: ['b'] }, {}, PRINCIPAL, {}, proof), click({ env: { CI: '2' } }, {}, PRINCIPAL, {}, proof), click({ cwd: `${ROOT}/file` }, {}, PRINCIPAL, {}, proof)]) {
        expect(await h.dispatcher.handle(different)).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'approval_mismatch' } });
      }
      expect(h.spawnRun).not.toHaveBeenCalled();
      expect(h.writes).toHaveLength(0);
      expect(h.audits.slice(1).every((a) => a.verdict.startsWith('deny:approval_mismatch'))).toBe(true);
      // The genuine question is still pending: a matching click can still answer it.
      expect(h.challenges.size()).toBe(1);
      expect(await h.dispatcher.handle(click({}, {}, PRINCIPAL, {}, h.proof()))).toMatchObject({ kind: 'reply', frame: { type: 'exec_result' } });
    });

    it('COMPROMISED SERVER: a server-signed grant carrying an approvalIntent whose challengeId this daemon has NEVER frozen (the server manufacturing a "covered" request out of thin air) ⇒ approval_mismatch, nothing executes, NOTHING is remembered', async () => {
      const h = clickHarness();
      // Nothing pending on the machine at all; the server presents a valid signature, a valid intent, a policy-allowed op.
      expect(h.challenges.size()).toBe(0);
      expect(await h.dispatcher.handle(click({}, { challengeId: 'ch_never' }))).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'approval_mismatch' } });
      expect(h.audits[0]?.verdict).toBe('deny:approval_mismatch:unknown_challenge:ch_never');
      expect(h.spawnRun).not.toHaveBeenCalled();
      expect(h.writes).toHaveLength(0);
      expect(h.deps.approvals!.entries()).toEqual([]);
      // And it stays that way on a retry with a different scope or id: the file is authoritative for allow.
      expect(await h.dispatcher.handle(click({}, { challengeId: 'ch_never_2', scope: 'until_revoked' }))).toMatchObject({ kind: 'reply', frame: { reason: 'approval_mismatch' } });
      expect(h.deps.approvals!.entries()).toEqual([]);
    });

    it('given a click after the intent expiry or after the challenge TTL, should deny approval_expired', async () => {
      const h = clickHarness();
      await h.dispatcher.handle(execFrame());
      expect(await h.dispatcher.handle(click({}, { expiresAt: NOW - 1 }))).toMatchObject({ kind: 'reply', frame: { reason: 'approval_expired' } });
      let now = NOW;
      const late = clickHarness({ now: () => now });
      await late.dispatcher.handle(execFrame());
      now = NOW + 31_000; // past the frozen grant's exp: the challenge is evicted (the click's own grant is fresh)
      expect(await late.dispatcher.handle(click({}, { expiresAt: NOW + 60_000 }, PRINCIPAL, { iat: now - 1000, exp: now + 30_000 }))).toMatchObject({ kind: 'reply', frame: { reason: 'approval_mismatch' } });
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
      expect(await once.dispatcher.handle(click({}, { scope: 'once' }, PRINCIPAL, {}, once.proof()))).toMatchObject({ kind: 'reply', frame: { type: 'exec_result' } });
      expect(once.writes).toHaveLength(0);
      const forever = clickHarness();
      await forever.dispatcher.handle(execFrame());
      await forever.dispatcher.handle(click({}, { scope: 'until_revoked' }, PRINCIPAL, {}, forever.proof()));
      expect(JSON.parse(forever.writes[0]!)).toMatchObject({ approvals: [expect.objectContaining({ approvalId: 'ch_1', scope: 'until_revoked', expiresAt: null })] });
    });

    /**
     * HARDENING B, LEAF B4 — the machine verifies the OWNER'S CLICK itself.
     *
     * Everything the older rows above check is satisfiable by whoever holds
     * the signing key AND stands where the server stands: the daemon hands
     * the challenge id and the frozen request back in its own `ask_pending`
     * reply, so a second grant carrying `approvalIntent { challengeId }`
     * byte-matches BY CONSTRUCTION. These rows are what closes that.
     */
    describe('hardening B — the daemon verifies the assertion, not the server\'s word', () => {
      const pend = async (h: ReturnType<typeof clickHarness>) => {
        expect(await h.dispatcher.handle(execFrame())).toMatchObject({ kind: 'reply', frame: { reason: 'ask_pending:ch_1' } });
      };
      const refusal = async (h: ReturnType<typeof clickHarness>, assertion: ApprovalIntent['assertion'], reason: string) => {
        const result = await h.dispatcher.handle(click({}, {}, PRINCIPAL, {}, assertion));
        expect(result).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'approval_unproven' } });
        // Audited with the precise cause, and NOTHING ran or was remembered.
        expect(h.audits.at(-1)?.verdict).toBe(`deny:approval_unproven:${reason}:ch_1`);
        expect(h.spawnRun).not.toHaveBeenCalled();
        expect(h.writes).toHaveLength(0);
        // The genuine question survives unspent: the owner can still answer it properly.
        expect(h.challenges.peek('ch_1', NOW)).toBeDefined();
      };

      it('THE FORGERY: a well-formed click with NO assertion at all is approval_unproven — a server holding the signing key can no longer make this machine run anything', async () => {
        const h = clickHarness();
        await pend(h);
        await refusal(h, undefined, 'malformed');
      });

      it('EXIT CRITERION: an assertion the owner genuinely made for a DIFFERENT frozen request is refused — the challenge is derived from the request THIS machine froze', async () => {
        const h = clickHarness();
        await pend(h);
        // A second, different question, answered honestly by the owner…
        expect(await h.dispatcher.handle(execFrame({ cmd: 'rm', args: ['-rf', 'x'] }))).toMatchObject({ kind: 'reply', frame: { reason: 'ask_pending:ch_2' } });
        const otherProof = h.proof('ch_2');
        // …replayed onto the FIRST question, whose re-issued bytes match it exactly, so the byte-compare cannot catch this.
        await refusal(h, otherProof, 'challenge_mismatch');
      });

      it('an assertion bound to another ENVIRONMENT is refused — it never travels between machines', async () => {
        const h = clickHarness();
        await pend(h);
        const frozen = h.challenges.peek('ch_1', NOW)!;
        await refusal(h, ownerAssertion('env_somewhere_else', 'ch_1', pendingRequestForWire(frozen.request)), 'challenge_mismatch');
      });

      it.each<[string, AssertionOverrides, string]>([
        ['a registration ceremony replayed as an approval', { type: 'webauthn.create' }, 'wrong_type'],
        ['an origin that is not the one pinned at enrolment', { origin: 'https://evil.example' }, 'origin_mismatch'],
        ['an rpId that is not the one pinned at enrolment', { rpId: 'evil.example' }, 'rp_mismatch'],
        ['the user-present flag unset (a silent authenticator is not a click)', { flags: 0x04 }, 'user_not_present'],
        ['a credential outside the pinned set', { credential: IMPOSTOR_CREDENTIAL }, 'unknown_credential'],
      ])('refuses %s', async (_label, over, reason) => {
        const h = clickHarness();
        await pend(h);
        await refusal(h, h.proof('ch_1', over), reason);
      });

      it('refuses a signature made by a key that is not the pinned one, even under the pinned credential id', async () => {
        const h = clickHarness();
        await pend(h);
        const frozen = h.challenges.peek('ch_1', NOW)!;
        const impostor = ownerAssertion(ENV_ID, 'ch_1', pendingRequestForWire(frozen.request), { credential: IMPOSTOR_CREDENTIAL });
        await refusal(h, { ...impostor, credentialId: OWNER_CREDENTIAL.credentialId }, 'bad_signature');
      });

      it.each<[string, unknown]>([
        ['truncated authenticator data', { credentialId: OWNER_CREDENTIAL.credentialId, authenticatorData: 'AAAA', clientDataJSON: 'e30', signature: 'AAAA' }],
        ['client data that is not JSON', { credentialId: OWNER_CREDENTIAL.credentialId, authenticatorData: 'A'.repeat(52), clientDataJSON: 'bm90IGpzb24', signature: 'AAAA' }],
        ['hostile non-base64url bytes', { credentialId: OWNER_CREDENTIAL.credentialId, authenticatorData: '!!!!', clientDataJSON: '!!!!', signature: '!!!!' }],
      ])('refuses a MALFORMED assertion (%s) rather than throwing', async (_label, assertion) => {
        const h = clickHarness();
        await pend(h);
        await refusal(h, assertion as ApprovalIntent['assertion'], 'malformed');
      });

      it('B5: with a pinned set, the machine USES it and never falls back to an unproven intent — a click on a challenge frozen earlier is still refused if the credentials are gone', async () => {
        // Frozen while the gate was in place…
        const h = clickHarness();
        await pend(h);
        const proof = h.proof();
        // …and answered by a daemon that can no longer verify anybody: refused, not waved through.
        const blind = { ...h, dispatcher: createDispatcher({ ...h.deps, ownerApproval: undefined }) };
        expect(await blind.dispatcher.handle(click({}, {}, PRINCIPAL, {}, proof))).toMatchObject({ kind: 'reply', frame: { reason: 'approval_unproven' } });
        expect(blind.audits.at(-1)?.verdict).toBe('deny:approval_unproven:no_pinned_credential:ch_1');
        expect(h.spawnRun).not.toHaveBeenCalled();
        // An EMPTY pinned set is the same answer: an owner with no passkey has not been vouched for.
        const empty = { ...h, dispatcher: createDispatcher({ ...h.deps, ownerApproval: { ...OWNER_APPROVAL_GATE, pinned: { ...PINNED_OWNER, credentials: [] } } }) };
        expect(await empty.dispatcher.handle(click({}, {}, PRINCIPAL, {}, proof, ))).toMatchObject({ kind: 'reply', frame: { reason: 'approval_unproven' } });
      });

      it('B5: with NO pinned credential and no terminal, the chat path is refused BEFORE anything is frozen — the machine does not even ask a question it could not verify the answer to', async () => {
        const h = clickHarness({ ownerApproval: undefined });
        expect(await h.dispatcher.handle(execFrame())).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'ask_unavailable' } });
        expect(h.audits.at(-1)?.verdict).toBe('deny:ask_unavailable:no_owner_credential');
        expect(h.challenges.size()).toBe(0);
        expect(h.spawnRun).not.toHaveBeenCalled();
        // Same for a pinned-but-empty set.
        const empty = clickHarness({ ownerApproval: { ...OWNER_APPROVAL_GATE, pinned: { ...PINNED_OWNER, credentials: [] } } });
        expect(await empty.dispatcher.handle(execFrame())).toMatchObject({ kind: 'reply', frame: { reason: 'ask_unavailable' } });
        expect(empty.challenges.size()).toBe(0);
      });

      it('B5: with NO pinned credential but a TERMINAL attached, the ask goes to the TERMINAL even when the chat is preferred — the prompt was never exposed to this forgery', async () => {
        const asked: AskInput[] = [];
        const ask: AskPrompter = { ask: async (input) => { asked.push(input); return { approved: true, scope: 'once' as const }; } };
        const h = clickHarness({ ownerApproval: undefined, ask, preferChat: true });
        expect(await h.dispatcher.handle(execFrame())).toMatchObject({ kind: 'reply', frame: { type: 'exec_result', exitCode: 0 } });
        expect(asked).toHaveLength(1);
        expect(h.challenges.size()).toBe(0);
        // With credentials pinned, the same daemon prefers the chat again.
        const proven = clickHarness({ ask, preferChat: true });
        expect(await proven.dispatcher.handle(execFrame())).toMatchObject({ kind: 'reply', frame: { reason: 'ask_pending:ch_1' } });
      });

      it('the proof is checked BEFORE the byte-compare, so an unproven click reads as unproven rather than as a mismatch', async () => {
        const h = clickHarness();
        await pend(h);
        // Different bytes AND no assertion: the assertion is what is reported.
        const result = await h.dispatcher.handle(click({ cmd: 'rm', args: ['-rf', 'x'] }));
        expect(result).toMatchObject({ kind: 'reply', frame: { reason: 'approval_unproven' } });
      });

      it('a click carrying a VALID assertion still runs, and remembers, exactly as before — the check adds a condition, it does not change the happy path', async () => {
        const h = clickHarness();
        await pend(h);
        expect(await h.dispatcher.handle(click({}, {}, PRINCIPAL, {}, h.proof()))).toMatchObject({ kind: 'reply', frame: { type: 'exec_result', exitCode: 0 } });
        expect(h.audits.at(-1)).toMatchObject({ verdict: 'allow:click:ch_1:30d' });
      });
    });

    it('a click is only ever a fresh grant: the intent rides the signature (a forged one is bad_signature) and its nonce is spent like any other', async () => {
      const h = clickHarness();
      await h.dispatcher.handle(execFrame());
      const forged = click({}, {}, PRINCIPAL, {}, h.proof());
      const tampered = { ...forged, grant: { ...forged.grant, approvalIntent: { ...INTENT, scope: 'until_revoked' } } } as GrantFrame;
      expect(await h.dispatcher.handle(tampered)).toMatchObject({ kind: 'reply', frame: { reason: 'bad_signature' } });
      const genuine = click({}, {}, PRINCIPAL, {}, h.proof());
      await h.dispatcher.handle(genuine);
      expect(await h.dispatcher.handle(genuine)).toMatchObject({ kind: 'reply', frame: { reason: 'replayed' } });
      expect(h.spawnRun).toHaveBeenCalledTimes(1);
    });
  });

  describe('GA wave 3 · Stop — a verified `pause` kills what is running, drops every pending challenge, acks signed, and stays connected', () => {
    const PAUSED_AT = NOW + 500;
    const pauseFrame = (over: { pausedAt?: number; issuedAt?: number; keyId?: string; sig?: string } = {}): Frame => {
      const issuedAt = over.issuedAt ?? NOW;
      const pausedAt = over.pausedAt ?? PAUSED_AT;
      return { type: 'pause', issuedAt, pausedAt, sig: over.sig ?? serverSign(encodePauseForSigning({ envId: ENV_ID, enrollmentId: ENROLLMENT_ID, keyId: over.keyId ?? serverKeyId, issuedAt, pausedAt })) };
    };
    function pauseHarness() {
      let n = 0;
      const challenges = createChallengeStore({ newId: () => `ch_${++n}` });
      const killAll = vi.fn(() => 2);
      const approvals = createApprovalsStore({ path: '/p', uid: 501, open: () => null, write: async () => undefined, now: () => NOW });
      const h = harness({ policy: () => ASK_POLICY, ask: null, challenges, approvals, resolveArgv0: (name) => ({ tool: '/usr/bin/tool' })[name] ?? null });
      h.deps.execRunner.killAll = killAll;
      return { ...h, dispatcher: createDispatcher(h.deps), challenges, killAll };
    }

    it('given a pause signed by the pinned server key, should killAll, clear the challenges, audit paused:killed:<n>, and answer a machine-signed pause_result bound to the pause — NOT revoke_verified', async () => {
      const h = pauseHarness();
      expect(await h.dispatcher.handle(execFrame())).toMatchObject({ kind: 'reply', frame: { reason: 'ask_pending:ch_1' } });
      expect(h.challenges.size()).toBe(1);
      const result = await h.dispatcher.handle(pauseFrame());
      expect(result).toMatchObject({ kind: 'paused', pausedAt: PAUSED_AT, killed: 2, dropped: 1, frame: { type: 'pause_result', envId: ENV_ID, pausedAt: PAUSED_AT, killed: 2 } });
      expect(h.killAll).toHaveBeenCalledTimes(1);
      expect(h.challenges.size()).toBe(0);
      expect(h.audits.at(-1)).toMatchObject({ grantId: null, op: 'pause', verdict: 'paused:killed:2' });
      const ack = (result as { frame: Frame }).frame;
      expect(verified(ack)).toMatchObject({ ok: true });
      expect(verified({ ...ack, killed: 0 } as Frame)).toEqual({ ok: false, reason: 'bad_signature' });
    });

    it('after a pause, a click naming a challenge frozen BEFORE it runs nothing — refused paused if its grant predates the pause, approval_mismatch if it is newer (the store was cleared); a fresh request after Resume is framed anew (no frame needed to resume)', async () => {
      const h = pauseHarness();
      await h.dispatcher.handle(execFrame());
      await h.dispatcher.handle(pauseFrame());
      const intent = { challengeId: 'ch_1', scope: '30d' as const, expiresAt: NOW + 30_000 };
      const principal = { ...PRINCIPAL, sessionId: 'later', conversationId: 'later' };
      const staleClick = signedGrant({ type: 'grant_exec', cmd: 'tool', args: ['a'], cwd: ROOT, env: { CI: '1' } }, { approvalIntent: intent, principal });
      expect(await h.dispatcher.handle(staleClick)).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'paused' } });
      const newerClick = signedGrant({ type: 'grant_exec', cmd: 'tool', args: ['a'], cwd: ROOT, env: { CI: '1' } }, { approvalIntent: intent, principal, iat: PAUSED_AT + 1, exp: PAUSED_AT + 30_000, nonce: 'n_click2', grantId: 'grant_click2' });
      expect(await h.dispatcher.handle(newerClick)).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'approval_mismatch' } });
      expect(h.spawnRun).not.toHaveBeenCalled();
      // Resume is the server signing again: a request newer than the pause is a NEW question, under a new id.
      expect(await h.dispatcher.handle(execFrame({ args: ['zzz'] }) && signedGrant({ type: 'grant_exec', cmd: 'tool', args: ['zzz'], cwd: ROOT, env: { CI: '1' } }, { iat: PAUSED_AT + 2, exp: PAUSED_AT + 30_000, nonce: 'n_fresh', grantId: 'grant_fresh' }))).toMatchObject({ kind: 'reply', frame: { reason: 'ask_pending:ch_2' } });
    });

    describe('Codex P1 #3 (review round 1) — the daemon LATCHES paused: a handler that resumes after an await never spawns, and only a newer verified grant clears it', () => {
      function latchHarness(over: { policy?: MachinePolicy; approvals?: ApprovalsStore; challenges?: ChallengeStore; ask?: AskPrompter | null } = {}) {
        const killAll = vi.fn(() => 0);
        const h = harness({ policy: () => over.policy ?? ASK_POLICY, ask: over.ask ?? null, approvals: over.approvals, challenges: over.challenges, resolveArgv0: (name) => ({ tool: '/usr/bin/tool' })[name] ?? null });
        h.deps.execRunner.killAll = killAll;
        return { ...h, dispatcher: createDispatcher(h.deps), killAll };
      }
      const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

      it('given a pause lands while a handler awaits the TERMINAL prompt, the approval that arrives afterwards runs NOTHING (deny:paused, audited)', async () => {
        const answer = deferred<{ approved: boolean; scope: 'once' }>();
        const h = latchHarness({ ask: { ask: () => answer.promise } });
        const pending = h.dispatcher.handle(execFrame());
        await Promise.resolve();
        expect(await h.dispatcher.handle(pauseFrame())).toMatchObject({ kind: 'paused' });
        answer.resolve({ approved: true, scope: 'once' });
        expect(await pending).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'paused' } });
        expect(h.spawnRun).not.toHaveBeenCalled();
        expect(h.audits.some((a) => a.verdict === 'deny:paused' && a.grantId === 'grant_1')).toBe(true);
      });

      it('given a pause lands while the CLICK path awaits the approval write, the frozen request runs NOTHING', async () => {
        let n = 0;
        const challenges = createChallengeStore({ newId: () => `ch_${++n}` });
        const write = deferred<void>();
        const approvals = createApprovalsStore({ path: '/p', uid: 501, open: () => null, write: () => write.promise, now: () => NOW });
        const h = latchHarness({ approvals, challenges });
        expect(await h.dispatcher.handle(execFrame())).toMatchObject({ kind: 'reply', frame: { reason: 'ask_pending:ch_1' } });
        const frozen = challenges.peek('ch_1', NOW)!;
        const click = signedGrant(
          { type: 'grant_exec', cmd: 'tool', args: ['a'], cwd: ROOT, env: { CI: '1' } },
          { approvalIntent: { challengeId: 'ch_1', scope: '30d', expiresAt: NOW + 30_000, assertion: ownerAssertion(ENV_ID, 'ch_1', pendingRequestForWire(frozen.request)) }, principal: { ...PRINCIPAL, sessionId: 'later', conversationId: 'later' } },
        );
        const pending = h.dispatcher.handle(click);
        await Promise.resolve();
        await Promise.resolve();
        expect(await h.dispatcher.handle(pauseFrame())).toMatchObject({ kind: 'paused' });
        write.resolve();
        expect(await pending).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'paused' } });
        expect(h.spawnRun).not.toHaveBeenCalled();
      });

      it('after a pause, an OLDER grant (issuedAt <= pausedAt) is refused paused before anything else; a NEWER verified grant runs — the server signs only when not paused, so that grant IS the resume', async () => {
        const h = latchHarness({ policy: POLICY });
        await h.dispatcher.handle(pauseFrame());
        expect(await h.dispatcher.handle(execFrame())).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'paused' } });
        expect(h.spawnRun).not.toHaveBeenCalled();
        const newer = signedGrant({ type: 'grant_exec', cmd: 'tool', args: ['a'], cwd: ROOT, env: { CI: '1' } }, { iat: PAUSED_AT + 1, exp: PAUSED_AT + 30_000, nonce: 'n_newer', grantId: 'grant_newer' });
        expect(await h.dispatcher.handle(newer)).toMatchObject({ kind: 'reply', frame: { type: 'exec_result', grantId: 'grant_newer' } });
        expect(h.spawnRun).toHaveBeenCalledTimes(1);
        // Cleared: another grant newer than the pause runs too; one older than it still does not.
        expect(await h.dispatcher.handle(signedGrant({ type: 'grant_exec', cmd: 'tool', args: ['b'], cwd: ROOT, env: { CI: '1' } }, { iat: PAUSED_AT + 2, exp: PAUSED_AT + 30_000, nonce: 'n_newer2', grantId: 'grant_newer2' }))).toMatchObject({ kind: 'reply', frame: { type: 'exec_result' } });
        expect(await h.dispatcher.handle(execFrame({ args: ['c'] }))).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'paused' } });
      });
    });

    it.each([
      ['a rogue key', () => pauseFrame({ keyId: 'other-key' })],
      ['an edited pausedAt', () => ({ ...pauseFrame(), pausedAt: PAUSED_AT + 1 })],
      ['a revoke signature riding a pause frame', () => ({ type: 'revoke' as const, issuedAt: NOW, sig: (pauseFrame() as Extract<Frame, { type: 'pause' }>).sig })],
    ])('given %s, should drop it, kill NOTHING, clear NOTHING, and audit the drop', async (_label, make) => {
      const h = pauseHarness();
      await h.dispatcher.handle(execFrame());
      const frame = make() as Frame;
      const result = await h.dispatcher.handle(frame);
      expect(result.kind).toBe('dropped');
      expect(h.killAll).not.toHaveBeenCalled();
      expect(h.challenges.size()).toBe(1);
      expect(h.audits.at(-1)?.verdict).toMatch(/^dropped:(pause|revoke)_bad_signature$/);
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
      const result = await h.dispatcher.handle(approvalRevoke('ch_1'));
      expect(result).toMatchObject({ kind: 'approval_revoked', approvalId: 'ch_1', removed: 2, frame: { type: 'approval_revoke_result', approvalId: 'ch_1', removed: 2 } });
      // Codex P2 on #2583: the ack is machine-signed over {approvalId, removed} — the server may only claim what this machine did.
      const ack = (result as { frame: Frame }).frame;
      expect(verified(ack)).toMatchObject({ ok: true });
      expect(verified({ ...ack, removed: 3 } as Frame)).toEqual({ ok: false, reason: 'bad_signature' });
      expect(h.approvals.entries().map((a) => a.approvalId)).toEqual(['ch_2']);
      expect(h.audits[0]?.verdict).toBe('approval_revoked:ch_1:2');
      // The revoked program now asks again; the untouched one still runs.
      expect(await h.dispatcher.handle(execFrame())).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'ask_unavailable' } });
      expect(await h.dispatcher.handle(execFrame({ cmd: 'rm' }))).toMatchObject({ kind: 'reply', frame: { type: 'exec_result' } });
    });

    it('given an approval revoke for an id the machine does not hold, should report 0 removed and change nothing', async () => {
      const h = revokeHarness();
      expect(await h.dispatcher.handle(approvalRevoke('ch_nope'))).toMatchObject({ kind: 'approval_revoked', approvalId: 'ch_nope', removed: 0, frame: { type: 'approval_revoke_result', removed: 0 } });
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
      expect(await h.dispatcher.handle(signedGrant({ type: 'grant_exec', cmd: 'tool', cwd: ROOT }, { approvalIntent: { challengeId: 'server_recorded', scope: 'until_revoked', expiresAt: NOW + 30_000 } }))).toMatchObject({ kind: 'reply', frame: { reason: 'approval_mismatch' } });
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

  describe('A7: a pending WRITE carries what the card must say', () => {
    const hookProbe = () => fakeProbe({ [ROOT]: ROOT, [`${ROOT}/.git/hooks/pre-commit`]: `${ROOT}/.git/hooks/pre-commit`, [`${ROOT}/file`]: `${ROOT}/file` });
    const chat = (overrides: Partial<DispatcherDeps> = {}) => harness({ probe: hookProbe(), challenges: createChallengeStore({ newId: () => 'ch_1' }), ask: null, ...overrides });
    const HOOK = Buffer.from('#!/bin/sh\nid').toString('base64');

    it('given a sensitive write reaching the chat, should carry every path with its mode, its byte count and the machine\'s OWN reason — and never the content', async () => {
      const h = chat();
      const result = await h.dispatcher.handle(signedGrant({ type: 'grant_fs_write', files: [{ path: `${ROOT}/.git/hooks/pre-commit`, contentB64: HOOK, mode: 0o755 }] }));
      expect(result).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'ask_pending:ch_1' } });
      const frame = (result as { frame: Frame }).frame as Extract<Frame, { type: 'grant_denied' }>;
      expect(frame.pending?.request.writeModes).toEqual([0o755]);
      expect(frame.pending?.files).toEqual([{ path: `${ROOT}/.git/hooks/pre-commit`, mode: 0o755, bytes: Buffer.from(HOOK, 'base64').length, reason: 'vcs_metadata' }]);
      expect(h.fsRunner.write).not.toHaveBeenCalled();
      expect(JSON.stringify(frame)).not.toContain(HOOK);
    });

    it('given a mixed write, should carry the ordinary file too, with a null reason — the card shows every path and marks which ones are sensitive', async () => {
      const h = chat({ policy: () => ASK_POLICY });
      const result = await h.dispatcher.handle(signedGrant({ type: 'grant_fs_write', files: [{ path: `${ROOT}/file`, contentB64: HOOK, mode: 0o600 }, { path: `${ROOT}/.git/hooks/pre-commit`, contentB64: 'aGk=', mode: 0o755 }] }));
      const frame = (result as { frame: Frame }).frame as Extract<Frame, { type: 'grant_denied' }>;
      expect(frame.pending?.files).toEqual([
        { path: `${ROOT}/file`, mode: 0o600, bytes: 12, reason: null },
        { path: `${ROOT}/.git/hooks/pre-commit`, mode: 0o755, bytes: 2, reason: 'vcs_metadata' },
      ]);
    });

    it('given an exec reaching the chat, should carry no files and no modes at all', async () => {
      const h = chat({ policy: () => ASK_POLICY });
      const result = await h.dispatcher.handle(execFrame());
      const frame = (result as { frame: Frame }).frame as Extract<Frame, { type: 'grant_denied' }>;
      expect(frame.pending?.files).toBeUndefined();
      expect(frame.pending?.request.writeModes).toBeUndefined();
    });

    it('Codex P1: given a mode-less overwrite of an ALREADY executable file, should freeze it for the click and write NOTHING — the runner would not have chmodded, so the file stays a command', async () => {
      const h = chat({ statMode: (path: string) => (path === `${ROOT}/file` ? 0o755 : null) });
      const result = await h.dispatcher.handle(signedGrant({ type: 'grant_fs_write', files: [{ path: `${ROOT}/file`, contentB64: HOOK }] }));
      expect(result).toMatchObject({ kind: 'reply', frame: { type: 'grant_denied', reason: 'ask_pending:ch_1' } });
      const frame = (result as { frame: Frame }).frame as Extract<Frame, { type: 'grant_denied' }>;
      expect(frame.pending?.files).toEqual([{ path: `${ROOT}/file`, mode: null, bytes: 12, reason: 'executable_bit' }]);
      expect(h.fsRunner.write).not.toHaveBeenCalled();
    });

    it('Codex P1: given the same write over a NON-executable file, should still run headless — no Tier A regression', async () => {
      const h = chat({ policy: () => POLICY, statMode: () => 0o644 });
      const result = await h.dispatcher.handle(signedGrant({ type: 'grant_fs_write', files: [{ path: `${ROOT}/file`, contentB64: HOOK }] }));
      expect(result).toMatchObject({ kind: 'reply', frame: { type: 'fs_write_result', ok: true } });
      expect(h.fsRunner.write).toHaveBeenCalledTimes(1);
    });

    it('given the owner CLICKS the sensitive write, should run it — escalation is a question, and the answer is honoured', async () => {
      const approvals = createApprovalsStore({ path: '/p', uid: 501, open: () => null, write: async () => undefined, now: () => NOW });
      const h = chat({ approvals });
      const file = { path: `${ROOT}/.git/hooks/pre-commit`, contentB64: 'aGk=', mode: 0o755 };
      await h.dispatcher.handle(signedGrant({ type: 'grant_fs_write', files: [file] }));
      expect(h.fsRunner.write).not.toHaveBeenCalled();
      const clicked = await h.dispatcher.handle(signedGrant({ type: 'grant_fs_write', files: [file] }, { approvalIntent: { challengeId: 'ch_1', scope: 'once', expiresAt: NOW + 30_000 }, principal: { ...PRINCIPAL, sessionId: 'later' } }));
      expect(clicked).toMatchObject({ kind: 'reply', frame: { type: 'fs_write_result', ok: true } });
      expect(h.fsRunner.write).toHaveBeenCalledTimes(1);
    });
  });

});
