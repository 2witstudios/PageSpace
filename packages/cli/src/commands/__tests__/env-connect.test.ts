import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { encodeFrame, decodeFrame, type Frame } from '@pagespace/lib/env-bridge/frame-codec';
import { encodeRevokeForSigning, verifyHello } from '@pagespace/lib/env-bridge/machine-signatures';
import { canonicalizeArgs, decodeBase64, encodeGrant, type Grant } from '@pagespace/lib/env-bridge/grant';
import { grantRequestForFrame, type GrantFrame } from '@pagespace/lib/env-bridge/grant-args';
import { createEnvConnectHandler, PID_HEARTBEAT_MS, pidFilePath, type EnvConnectHandlerDeps, type PidRecord } from '../env/connect.js';
import { bridgeSocketUrl } from '../../env-bridge/secure-host.js';
import { generateMachineKeypair, signWithMachineKey } from '../../env-bridge/keypair.js';
import { ed25519Verify, envBridgeHash } from '../../env-bridge/crypto.js';
import type { BridgeSocket } from '../../env-bridge/ws-client.js';
import type { ExecRunner } from '../../env-bridge/exec-runner.js';
import { machineProfileName, type HostCredential, type MachineHostCredential } from '../../credentials/serialize.js';
import type { CredentialStore } from '../../credentials/store.js';
import type { HandlerContext } from '../../handler-context.js';
import { parseArgv } from '../../argv/parse.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../../exit-codes.js';

const HOST = 'https://pagespace.test';
const NOW = Date.parse('2026-09-06T10:00:00.000Z');
const HOME = '/home/me';
const UID = 501;

const serverPair = generateKeyPairSync('ed25519');
const serverPublicKeyB64 = serverPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const serverKeyId = createHash('sha256').update(decodeBase64(serverPublicKeyB64)!).digest('hex').slice(0, 16);
const machine = generateMachineKeypair();

const CREDENTIAL: MachineHostCredential = { kind: 'machine', privateKey: machine.privateKey, enrollmentId: 'enr_1', envId: 'env_1', serverPublicKey: serverPublicKeyB64, serverKeyId, scopes: [], createdAt: '2026-09-05T09:00:00.000Z' };
const POLICY = JSON.stringify({ mode: 'allowlist', principals: ['u1'], ops: ['exec'], roots: ['/home/me/proj'], envAllowlist: [] });

class FakeSocket extends EventEmitter implements BridgeSocket {
  readonly sent: string[] = [];
  readyState = 0;
  closed: { code?: number; reason?: string } | null = null;
  constructor(readonly url: string, readonly headers: Record<string, string>) {
    super();
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  terminate() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.emit('open');
  }
  receive(frame: Frame) {
    this.emit('message', encodeFrame(frame));
  }
}

function sink() {
  const lines: string[] = [];
  return { lines, write: (chunk: string) => void lines.push(chunk), text: () => lines.join('') };
}

function fakeStore(initial: HostCredential | null = CREDENTIAL): CredentialStore & { entries: Map<string, HostCredential> } {
  const entries = new Map<string, HostCredential>();
  if (initial) entries.set(`${HOST} ${machineProfileName('enr_1')}`, initial);
  const key = (host: string, profile = 'default') => `${host} ${profile}`;
  return {
    entries,
    get: async (host, profile) => entries.get(key(host, profile)) ?? null,
    set: async (host, credential, profile) => void entries.set(key(host, profile), credential),
    delete: async (host, profile) => void entries.delete(key(host, profile)),
    list: async () => [],
  };
}

function ctx(isTTY: boolean) {
  const out = sink();
  const err = sink();
  return { ctx: { stdout: out, stderr: err, env: { PAGESPACE_API_URL: HOST }, isTTY } as unknown as HandlerContext, out, err };
}

/** What `run.ts` hands a handler: the parsed intent with the two-segment route path stripped from `args`. */
function intent(argv: string[]) {
  const parsed = parseArgv(argv);
  if (parsed.kind !== 'command') throw new Error(parsed.message);
  return { ...parsed, args: parsed.args.slice(2) };
}

/** Scripted token round trip: GET challenge, POST redeem — for as many connects as needed. */
function tokenFetch() {
  let n = 0;
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/api/env-bridge/token') && (!init || init.method === undefined)) {
      return new Response(JSON.stringify({ nonce: 'nonce', expiresAt: new Date(NOW + 60_000).toISOString() }), { status: 200 });
    }
    if (u.includes('/api/env-bridge/token') && init?.method === 'POST') {
      n += 1;
      return new Response(JSON.stringify({ token: `tok_${n}`, expiresInMs: 600_000, envId: 'env_1' }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  return fetch as unknown as typeof globalThis.fetch;
}

function harness(overrides: Partial<EnvConnectHandlerDeps> & { policy?: string | null; policyStat?: { uid: number; mode: number } | null } = {}) {
  const { policy = POLICY, policyStat = { uid: UID, mode: 0o100600 }, ...rest } = overrides;
  const sockets: FakeSocket[] = [];
  const pidWrites: Array<{ path: string; record: PidRecord }> = [];
  const pidRemoves: string[] = [];
  const auditLines: string[] = [];
  const approvalWrites: Array<{ path: string; content: string }> = [];
  const signals: Array<(signal: string) => void> = [];
  const exit = vi.fn<(code: number) => void>();
  const execRunner: ExecRunner & { killed: number } = { killed: 0, run: async () => ({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false, timedOut: false }), killAll() { this.killed += 1; return 0; }, liveCount: () => 0 };
  const store = fakeStore();
  const deps: EnvConnectHandlerDeps = {
    createCredentialStore: () => store,
    fetch: tokenFetch(),
    sign: signWithMachineKey,
    now: () => NOW,
    homedir: HOME,
    uid: UID,
    pid: 4242,
    argv0: 'pagespace',
    platform: 'darwin',
    openPolicy: (path) => {
      if (path.endsWith('env-approvals.json')) return null;
      if (policyStat === null || policy === null) return null;
      return { uid: policyStat.uid, mode: policyStat.mode, content: policy };
    },
    appendAuditLine: async (_path, line) => void auditLines.push(line),
    pidFile: { write: async (path, record) => void pidWrites.push({ path, record }), remove: async (path) => void pidRemoves.push(path) },
    probe: { realpath: (path) => (path === '/home/me/proj' ? path : null), isSymlink: () => false },
    statMode: () => null,
    createExecRunner: () => execRunner,
    createFsRunner: () => ({ read: async () => ({ kind: 'read', found: false }), write: async () => ({ kind: 'write', ok: true }) }),
    createSocket: (url, headers) => { const s = new FakeSocket(url, headers); sockets.push(s); return s; },
    confirm: async () => false,
    writeApprovals: async (path, content) => void approvalWrites.push({ path, content }),
    approvalId: () => 'ap_test',
    challengeId: () => 'ch_test',
    onSignal: (handler) => void signals.push(handler),
    daemonEpoch: 'ep_test',
    exit,
    ...rest,
  };
  return { deps, store, sockets, pidWrites, pidRemoves, auditLines, approvalWrites, signals, exit, execRunner, handler: createEnvConnectHandler(deps), socket: () => sockets[sockets.length - 1]! };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('pagespace env connect <enrollmentId>', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('given no enrollmentId, should exit 2 with usage', async () => {
    const h = harness();
    const c = ctx(true);
    expect(await h.handler(c.ctx, intent(['env', 'connect']))).toBe(EXIT_USAGE_ERROR);
    expect(c.err.text()).toMatch(/Usage/);
  });

  it('given no (or a pending) machine credential, should exit 1 pointing at env enroll and never connect', async () => {
    const h = harness({ createCredentialStore: () => fakeStore({ ...CREDENTIAL, serverKeyId: 'pending' }) });
    const c = ctx(true);
    expect(await h.handler(c.ctx, intent(['env', 'connect', 'enr_1']))).toBe(EXIT_RUNTIME_ERROR);
    expect(c.err.text()).toMatch(/env enroll/);
    expect(h.sockets).toHaveLength(0);
  });

  it('F: on win32 the daemon refuses to start with a clear message (no process groups, no O_NOFOLLOW) and never connects', async () => {
    const h = harness({ platform: 'win32' });
    const c = ctx(true);
    expect(await h.handler(c.ctx, intent(['env', 'connect', 'enr_1']))).toBe(EXIT_RUNTIME_ERROR);
    expect(c.err.text()).toMatch(/Windows is not supported/);
    expect(h.sockets).toHaveLength(0);
  });

  it('B (CWE-319): a plaintext non-loopback host is refused before any credential or socket work', async () => {
    const h = harness();
    const c = ctx(true);
    expect(await h.handler(c.ctx, intent(['env', 'connect', 'enr_1', '--host', 'http://pagespace.ai']))).toBe(EXIT_RUNTIME_ERROR);
    expect(c.err.text()).toMatch(/https/);
    expect(h.sockets).toHaveLength(0);
  });

  it('R5 (GA wave 2): given policy mode "ask" without a TTY, should START and say asks will wait for a click in the chat; a non-pre-approved grant is answered ask_pending:<id> with the frozen request, nothing runs', async () => {
    const h = harness({ policy: JSON.stringify({ mode: 'ask', principals: ['u1'], ops: [], roots: ['/home/me/proj'], envAllowlist: [] }) });
    const c = ctx(false);
    expect(await h.handler(c.ctx, intent(['env', 'connect', 'enr_1']))).toBe(EXIT_SUCCESS);
    expect(c.err.text()).toMatch(/wait for your click in the PageSpace chat/);
    await flush();
    h.socket().open();
    await flush();
    h.socket().receive({ type: 'ping', ts: 1 });
    await flush();
    const unsigned = { type: 'grant_exec' as const, cmd: '/usr/bin/true', args: [], cwd: '/home/me/proj', env: {} };
    const request = grantRequestForFrame({ ...unsigned, grant: {}, sig: '' } as GrantFrame);
    const grant: Grant = { grantId: 'g_chat', envId: 'env_1', principal: { userId: 'u1', sessionId: 's', conversationId: 'c' }, op: 'exec', argsHash: envBridgeHash(canonicalizeArgs(request.args)), iat: NOW - 1000, exp: NOW + 30_000, nonce: 'n_chat' };
    h.socket().receive({ ...unsigned, grant: { ...grant, principal: { ...grant.principal } }, sig: Buffer.from(nodeSign(null, encodeGrant(grant), serverPair.privateKey)).toString('base64') } as unknown as Frame);
    await flush();
    const replies = h.socket().sent.map((raw) => decodeFrame(raw, { maxFrameBytes: 1 << 20 })).filter((d) => d.ok && d.frame.type === 'grant_denied');
    expect(replies).toHaveLength(1);
    expect((replies[0] as { frame: Extract<Frame, { type: 'grant_denied' }> }).frame).toMatchObject({ grantId: 'g_chat', reason: 'ask_pending:ch_test', pending: { challengeId: 'ch_test', expiresAt: NOW + 30_000, request: { cmd: '/usr/bin/true', cwd: '/home/me/proj' } } });
  });

  it('Codex P1 wiring: a mode-less fs_write over an ALREADY executable file reaches the chat as an ask — the existing-mode probe is actually threaded from connect to the decision', async () => {
    const target = '/home/me/proj/bin/tool';
    const h = harness({
      policy: JSON.stringify({ mode: 'allowlist', principals: ['u1'], ops: ['fs_read', 'fs_write'], roots: ['/home/me/proj'], envAllowlist: [] }),
      probe: { realpath: (path: string) => (path === '/home/me/proj' || path === '/home/me/proj/bin' || path === target ? path : null), isSymlink: () => false },
      statMode: (path: string) => (path === target ? 0o755 : null),
    });
    const c = ctx(false);
    expect(await h.handler(c.ctx, intent(['env', 'connect', 'enr_1']))).toBe(EXIT_SUCCESS);
    await flush();
    h.socket().open();
    await flush();
    h.socket().receive({ type: 'ping', ts: 1 });
    await flush();
    const unsigned = { type: 'grant_fs_write' as const, files: [{ path: target, contentB64: Buffer.from('#!/bin/sh\nid').toString('base64') }] };
    const request = grantRequestForFrame({ ...unsigned, grant: {}, sig: '' } as GrantFrame);
    const grant: Grant = { grantId: 'g_write', envId: 'env_1', principal: { userId: 'u1', sessionId: 's', conversationId: 'c' }, op: 'fs_write', argsHash: envBridgeHash(canonicalizeArgs(request.args)), iat: NOW - 1000, exp: NOW + 30_000, nonce: 'n_write' };
    h.socket().receive({ ...unsigned, grant: { ...grant, principal: { ...grant.principal } }, sig: Buffer.from(nodeSign(null, encodeGrant(grant), serverPair.privateKey)).toString('base64') } as unknown as Frame);
    await flush();
    const sent = h.socket().sent.map((raw) => decodeFrame(raw, { maxFrameBytes: 1 << 20 }));
    const denied = sent.filter((d) => d.ok && d.frame.type === 'grant_denied');
    expect(denied, JSON.stringify(sent)).toHaveLength(1);
    expect((denied[0] as { frame: Extract<Frame, { type: 'grant_denied' }> }).frame).toMatchObject({
      grantId: 'g_write',
      reason: 'ask_pending:ch_test',
      pending: { files: [{ path: target, mode: null, reason: 'executable_bit' }] },
    });
  });

  it('GA wave 2 · leaf 1: at start the daemon names the approvals file and how many approvals are in force (none ⇒ 0)', async () => {
    const h = harness();
    const c = ctx(false);
    await h.handler(c.ctx, intent(['env', 'connect', 'enr_1']));
    expect(c.err.text()).toMatch(/Approvals \/home\/me\/\.pagespace\/env-approvals\.json: 0 in force/);
  });

  it('GA wave 2 · leaf 1: in ask mode, a durable approval in ~/.pagespace/env-approvals.json runs a covered command from a NEW session with NO terminal prompt; an uncovered one prompts', async () => {
    const ASK = JSON.stringify({ mode: 'ask', principals: ['u1'], ops: [], roots: ['/home/me/proj'], envAllowlist: [] });
    const APPROVALS = JSON.stringify({ version: 1, approvals: [{ approvalId: 'old', envId: 'env_1', userId: 'u1', op: 'exec', subject: 'exec:/usr/bin/true', scope: 'until_revoked', createdAt: 1, expiresAt: null }] });
    const confirm = vi.fn(async () => false);
    const runs: string[] = [];
    const h = harness({
      policy: ASK,
      confirm,
      openPolicy: (path) => ({ uid: UID, mode: 0o100600, content: path.endsWith('env-approvals.json') ? APPROVALS : ASK }),
      createExecRunner: () => ({ run: async (request) => { runs.push(request.cmd ?? ''); return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false, timedOut: false }; }, killAll: () => 0, liveCount: () => 0 }),
    });
    const c = ctx(true);
    await h.handler(c.ctx, intent(['env', 'connect', 'enr_1']));
    expect(c.err.text()).toMatch(/Approvals .*: 1 in force/);
    await flush();
    h.socket().open();
    await flush();
    h.socket().receive({ type: 'ping', ts: 1 }); // the ack
    await flush();
    const grantFor = (cmd: string, n: number) => {
      const unsigned = { type: 'grant_exec' as const, cmd, args: [], cwd: '/home/me/proj', env: {} };
      const request = grantRequestForFrame({ ...unsigned, grant: {}, sig: '' } as GrantFrame);
      const grant: Grant = { grantId: `g${n}`, envId: 'env_1', principal: { userId: 'u1', sessionId: `brand-new-session-${n}`, conversationId: `new-chat-${n}` }, op: 'exec', argsHash: envBridgeHash(canonicalizeArgs(request.args)), iat: NOW - 1000, exp: NOW + 30_000, nonce: `n${n}` };
      return { ...unsigned, grant: { ...grant, principal: { ...grant.principal } }, sig: Buffer.from(nodeSign(null, encodeGrant(grant), serverPair.privateKey)).toString('base64') } as unknown as Frame;
    };
    h.socket().receive(grantFor('/usr/bin/true', 1));
    await flush();
    expect(runs).toEqual(['/usr/bin/true']);
    expect(confirm).not.toHaveBeenCalled();
    h.socket().receive(grantFor('/usr/bin/false', 2));
    await flush();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(runs).toEqual(['/usr/bin/true']);
  });

  it('R1: given NO policy file, should START anyway (deny-all), say why, write the pid file, mint a token and send a signed hello with an empty policy digest', async () => {
    const h = harness({ policy: null });
    const c = ctx(false);
    expect(await h.handler(c.ctx, intent(['env', 'connect', 'enr_1']))).toBe(EXIT_SUCCESS);
    expect(c.err.text()).toMatch(/No policy file/);
    expect(h.pidWrites).toEqual([{ path: pidFilePath(HOME, 'enr_1'), record: { pid: 4242, startedAt: NOW, argv0: 'pagespace' } }]);
    await flush();
    expect(h.socket().url).toBe(bridgeSocketUrl(HOST, 'env_1'));
    expect(h.socket().url).toBe('wss://pagespace.test/api/env-bridge/ws?envId=env_1');
    expect(h.socket().headers).toEqual({ Authorization: 'Bearer tok_1' });
    h.socket().open();
    const hello = decodeFrame(h.socket().sent[0]!, { maxFrameBytes: 1 << 20 });
    expect(hello).toMatchObject({ ok: true, frame: { type: 'hello', envId: 'env_1', capabilities: { shell: true, pty: false, fs: true, checkpoint: false }, policyDigest: '' } });
    expect(verifyHello({ hello: (hello as { frame: Extract<Frame, { type: 'hello' }> }).frame, expectedEnvId: 'env_1', machinePublicKey: decodeBase64(machine.publicKey)!, verify: ed25519Verify })).toEqual({ ok: true });
  });

  it('given a valid policy, should print its summary and advertise its digest in hello', async () => {
    const h = harness();
    const c = ctx(false);
    await h.handler(c.ctx, intent(['env', 'connect', 'enr_1']));
    expect(c.err.text()).toMatch(/mode allowlist, principals u1, ops exec/);
    await flush();
    h.socket().open();
    expect(h.socket().sent[0]).toContain(createHash('sha256').update(POLICY).digest('hex'));
  });

  it('C: the pid record is re-written every PID_HEARTBEAT_MS while the daemon lives, so a stale file is detectable by age', async () => {
    const h = harness();
    await h.handler(ctx(false).ctx, intent(['env', 'connect', 'enr_1']));
    await vi.advanceTimersByTimeAsync(PID_HEARTBEAT_MS * 2);
    expect(h.pidWrites.length).toBeGreaterThanOrEqual(3);
    expect(new Set(h.pidWrites.map((w) => JSON.stringify(w.record))).size).toBe(1);
  });

  it('C: a pid write in flight when disconnect fires completes BEFORE the file is removed, so it cannot recreate a stale pid file', async () => {
    const order: string[] = [];
    let releaseWrite: (() => void) | null = null;
    const h = harness({
      pidFile: {
        write: async () => {
          await new Promise<void>((resolve) => { releaseWrite = resolve; });
          order.push('write');
        },
        remove: async () => { order.push('remove'); },
      },
    });
    const c = ctx(false);
    // Don't await: the first writePid blocks on releaseWrite.
    void h.handler(c.ctx, intent(['env', 'connect', 'enr_1']));
    await flush();
    h.signals[0]!('SIGINT');
    await flush();
    // Shutdown is awaiting the in-flight write; nothing removed yet.
    expect(order).toEqual([]);
    releaseWrite!();
    await flush();
    await flush();
    expect(order).toEqual(['write', 'remove']);
  });

  it('R8: Ctrl-C (SIGINT) closes the socket, kills every child process group, removes the pid file and exits 0', async () => {
    const h = harness();
    const c = ctx(false);
    await h.handler(c.ctx, intent(['env', 'connect', 'enr_1']));
    await flush();
    h.socket().open();
    h.signals[0]!('SIGINT');
    await flush();
    expect(h.socket().closed).toEqual({ code: 1000, reason: 'SIGINT' });
    expect(h.execRunner.killed).toBe(1);
    expect(h.pidRemoves).toEqual([pidFilePath(HOME, 'enr_1')]);
    expect(h.exit).toHaveBeenCalledWith(EXIT_SUCCESS);
  });

  /**
   * STOP reaches the process (GA wave 3, leaf 3 amendment). The REAL exec
   * runner spawns a real `sh -c 'exec sleep 30'` under a real temp root; a
   * server-signed `pause` arrives; the daemon must SIGKILL the process group
   * before it acks. Proof, in order: the pause_result is sent before the
   * exec_result; that exec_result carries exit 137 (128 + SIGKILL) — the
   * sleep did not finish on its own; and `kill -0` on the pid fails once the
   * parent has reaped it. Real timers: a real child process is involved.
   */
  it('GA wave 3 · Stop: a running command is killed by a verified pause — exit 137 from SIGKILL, the pid gone, the signed pause_result sent before the exec_result', async () => {
    vi.useRealTimers();
    const { mkdtempSync, existsSync, readFileSync, realpathSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createNodeExecRunner } = await import('../../env-bridge/exec-runner.js');
    const { encodePauseForSigning } = await import('@pagespace/lib/env-bridge/machine-signatures');
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ps-pause-')));
    const pidFile = join(root, 'child.pid');
    try {
      const h = harness({
        policy: JSON.stringify({ mode: 'allowlist', principals: ['u1'], ops: ['exec'], roots: [root], envAllowlist: [] }),
        probe: { realpath: (path) => (existsSync(path) ? realpathSync(path) : null), isSymlink: () => false },
        createExecRunner: (resolver) => createNodeExecRunner(resolver),
      });
      const c = ctx(false);
      expect(await h.handler(c.ctx, intent(['env', 'connect', 'enr_1']))).toBe(EXIT_SUCCESS);
      await new Promise((r) => setTimeout(r, 10));
      h.socket().open();
      await new Promise((r) => setTimeout(r, 10));
      h.socket().receive({ type: 'ping', ts: 1 });
      await new Promise((r) => setTimeout(r, 10));
      const unsigned = { type: 'grant_exec' as const, cmd: '/bin/sh', args: ['-c', `echo $$ > ${pidFile}; exec sleep 30`], cwd: root, env: {}, timeoutMs: 60_000 };
      const request = grantRequestForFrame({ ...unsigned, grant: {}, sig: '' } as GrantFrame);
      const grant: Grant = { grantId: 'g_sleep', envId: 'env_1', principal: { userId: 'u1', sessionId: 's', conversationId: 'c' }, op: 'exec', argsHash: envBridgeHash(canonicalizeArgs(request.args)), iat: NOW - 1000, exp: NOW + 30_000, nonce: 'n_sleep' };
      h.socket().receive({ ...unsigned, grant: { ...grant, principal: { ...grant.principal } }, sig: Buffer.from(nodeSign(null, encodeGrant(grant), serverPair.privateKey)).toString('base64') } as unknown as Frame);
      const deadline = Date.now() + 5_000;
      while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      expect(() => process.kill(pid, 0)).not.toThrow();

      const pausedAt = NOW + 500;
      h.socket().receive({ type: 'pause', issuedAt: NOW, pausedAt, sig: Buffer.from(nodeSign(null, encodePauseForSigning({ envId: 'env_1', enrollmentId: 'enr_1', keyId: serverKeyId, issuedAt: NOW, pausedAt }), serverPair.privateKey)).toString('base64') });
      const types = () => h.socket().sent.map((raw) => decodeFrame(raw, { maxFrameBytes: 1 << 20 })).filter((d) => d.ok).map((d) => (d as { frame: Frame }).frame);
      const until = Date.now() + 5_000;
      while (!types().some((f) => f.type === 'exec_result') && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
      const frames = types();
      const ack = frames.findIndex((f) => f.type === 'pause_result');
      const result = frames.findIndex((f) => f.type === 'exec_result');
      expect(ack).toBeGreaterThanOrEqual(0);
      expect(result).toBeGreaterThan(ack);
      expect(frames[ack]).toMatchObject({ type: 'pause_result', envId: 'env_1', pausedAt, killed: 1 });
      expect(frames[result]).toMatchObject({ type: 'exec_result', grantId: 'g_sleep', exitCode: 137 });
      // Reaped by the daemon's own close handler: the pid no longer exists.
      expect(() => process.kill(pid, 0)).toThrow();
      expect(h.auditLines.some((line) => line.includes('"verdict":"paused:killed:1"'))).toBe(true);
      // Still connected: Stop pauses grants, not the machine.
      expect(h.socket().closed).toBeNull();
      h.signals[0]!('SIGINT');
    } finally {
      rmSync(root, { recursive: true, force: true });
      vi.useFakeTimers();
    }
  }, 20_000);

  it('Codex P2 #7 (review round 1): the hello carries this process\'s daemonEpoch under the signature, and a RECONNECT sends the same epoch', async () => {
    const h = harness();
    const c = ctx(false);
    expect(await h.handler(c.ctx, intent(['env', 'connect', 'enr_1']))).toBe(EXIT_SUCCESS);
    await flush();
    h.socket().open();
    const first = decodeFrame(h.socket().sent[0]!, { maxFrameBytes: 1 << 20 });
    expect(first).toMatchObject({ ok: true, frame: { type: 'hello', daemonEpoch: 'ep_test' } });
    expect(verifyHello({ hello: (first as { frame: Extract<Frame, { type: 'hello' }> }).frame, expectedEnvId: 'env_1', machinePublicKey: decodeBase64(machine.publicKey)!, verify: ed25519Verify })).toEqual({ ok: true });
    h.socket().emit('close', 1006, Buffer.from(''));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sockets.length).toBeGreaterThan(1);
    h.socket().open();
    const again = decodeFrame(h.socket().sent[0]!, { maxFrameBytes: 1 << 20 });
    expect(again).toMatchObject({ ok: true, frame: { type: 'hello', daemonEpoch: 'ep_test' } });
    h.signals[0]!('SIGINT');
  });

  it('GA wave 3 · leaf 7: given mode allowlist with exec in ops (the harness default), the daemon prints the exec-allowlisted line at start and audits policy_warning:exec_allowlisted once; with exec absent it prints and audits nothing of the kind', async () => {
    const h = harness();
    const c = ctx(false);
    expect(await h.handler(c.ctx, intent(['env', 'connect', 'enr_1']))).toBe(EXIT_SUCCESS);
    await flush();
    expect(c.err.text()).toMatch(/exec is allowlisted: commands run on this machine without a click — remove exec from ops to restore the approval prompt/);
    expect(h.auditLines.filter((line) => line.includes('"verdict":"policy_warning:exec_allowlisted"'))).toHaveLength(1);
    const quiet = harness({ policy: JSON.stringify({ mode: 'allowlist', principals: ['u1'], ops: ['fs_read'], roots: ['/home/me/proj'], envAllowlist: [] }) });
    const q = ctx(false);
    expect(await quiet.handler(q.ctx, intent(['env', 'connect', 'enr_1']))).toBe(EXIT_SUCCESS);
    await flush();
    expect(q.err.text()).not.toMatch(/exec is allowlisted/);
    expect(quiet.auditLines.some((line) => line.includes('policy_warning'))).toBe(false);
  });

  it('A6: given a policy rooted at the home directory, connect prints the root_is_home line AND audits policy_warning:root_is_home — the audit loops over CODES, it does not special-case one', async () => {
    const h = harness({ policy: JSON.stringify({ mode: 'allowlist', principals: ['u1'], ops: ['fs_read', 'exec'], roots: [HOME], envAllowlist: [] }), probe: { realpath: (path: string) => (path === HOME ? path : null), isSymlink: () => false } });
    const c = ctx(false);
    expect(await h.handler(c.ctx, intent(['env', 'connect', 'enr_1']))).toBe(EXIT_SUCCESS);
    await flush();
    expect(c.err.text()).toMatch(/covers your whole home directory/);
    expect(h.auditLines.filter((line) => line.includes('"verdict":"policy_warning:root_is_home"'))).toHaveLength(1);
    // The pre-existing code is still printed and still audited exactly once.
    expect(h.auditLines.filter((line) => line.includes('"verdict":"policy_warning:exec_allowlisted"'))).toHaveLength(1);
  });

  it('R7: a server-signed revoke deletes the machine key from the credential store, stops reconnecting, and exits non-zero with a message', async () => {
    const h = harness();
    const c = ctx(false);
    await h.handler(c.ctx, intent(['env', 'connect', 'enr_1']));
    await flush();
    h.socket().open();
    h.socket().receive({ type: 'ping', ts: 1 });
    await flush();
    const issuedAt = NOW;
    const sig = Buffer.from(nodeSign(null, encodeRevokeForSigning({ envId: 'env_1', enrollmentId: 'enr_1', keyId: serverKeyId, issuedAt }), serverPair.privateKey)).toString('base64');
    h.socket().receive({ type: 'revoke', issuedAt, sig, reason: 'deleted' });
    await flush();
    expect(h.store.entries.has(`${HOST} ${machineProfileName('enr_1')}`)).toBe(false);
    expect(h.exit).toHaveBeenCalledWith(EXIT_RUNTIME_ERROR);
    expect(c.err.text()).toMatch(/REVOKED/);
    expect(h.auditLines.some((line) => JSON.parse(line).verdict === 'revoked')).toBe(true);
    h.socket().emit('close', 1000, Buffer.from('revoked'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sockets).toHaveLength(1);
  });

  it('R7 (negative): a revoke NOT signed by the pinned key changes nothing — key kept, still connected', async () => {
    const h = harness();
    const c = ctx(false);
    await h.handler(c.ctx, intent(['env', 'connect', 'enr_1']));
    await flush();
    h.socket().open();
    h.socket().receive({ type: 'revoke', issuedAt: NOW, sig: Buffer.from('nope').toString('base64') });
    await flush();
    expect(h.store.entries.size).toBe(1);
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.socket().closed).toBeNull();
  });

  it('P1: when the server closes with env_superseded (another daemon took over), should say so, keep the key, remove the pid file and exit 1 — never reconnect', async () => {
    const h = harness();
    const c = ctx(false);
    await h.handler(c.ctx, intent(['env', 'connect', 'enr_1']));
    await flush();
    h.socket().open();
    h.socket().emit('close', 1000, Buffer.from('env_superseded'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sockets).toHaveLength(1);
    expect(c.err.text()).toMatch(/another daemon took over this environment/i);
    expect(h.store.entries.size).toBe(1);
    expect(h.pidRemoves).toEqual([pidFilePath(HOME, 'enr_1')]);
    expect(h.exit).toHaveBeenCalledWith(EXIT_RUNTIME_ERROR);
  });

  it('R9: after the server drops the socket, reconnects with a FRESH token and re-sends hello', async () => {
    const h = harness();
    const c = ctx(false);
    await h.handler(c.ctx, intent(['env', 'connect', 'enr_1']));
    await flush();
    h.socket().open();
    h.socket().emit('close', 1006, Buffer.from(''));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sockets).toHaveLength(2);
    expect(h.socket().headers).toEqual({ Authorization: 'Bearer tok_2' });
    h.socket().open();
    expect(h.socket().sent[0]).toContain('"type":"hello"');
  });
});
