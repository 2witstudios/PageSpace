import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { encodeFrame, decodeFrame, type Frame } from '@pagespace/lib/env-bridge/frame-codec';
import { encodeRevokeForSigning, verifyHello } from '@pagespace/lib/env-bridge/machine-signatures';
import { decodeBase64 } from '@pagespace/lib/env-bridge/grant';
import { createEnvConnectHandler, PID_HEARTBEAT_MS, pidFilePath, type EnvConnectHandlerDeps, type PidRecord } from '../env/connect.js';
import { bridgeSocketUrl } from '../../env-bridge/secure-host.js';
import { generateMachineKeypair, signWithMachineKey } from '../../env-bridge/keypair.js';
import { ed25519Verify } from '../../env-bridge/crypto.js';
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
  const signals: Array<(signal: string) => void> = [];
  const exit = vi.fn<(code: number) => void>();
  const execRunner: ExecRunner & { killed: number } = { killed: 0, run: async () => ({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), truncated: false, timedOut: false }), killAll() { this.killed += 1; }, liveCount: () => 0 };
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
    openPolicy: () => {
      if (policyStat === null || policy === null) return null;
      return { uid: policyStat.uid, mode: policyStat.mode, content: policy };
    },
    appendAuditLine: async (_path, line) => void auditLines.push(line),
    pidFile: { write: async (path, record) => void pidWrites.push({ path, record }), remove: async (path) => void pidRemoves.push(path) },
    probe: { realpath: (path) => (path === '/home/me/proj' ? path : null), isSymlink: () => false },
    createExecRunner: () => execRunner,
    createFsRunner: () => ({ read: async () => ({ kind: 'read', found: false }), write: async () => ({ kind: 'write', ok: true }) }),
    createSocket: (url, headers) => { const s = new FakeSocket(url, headers); sockets.push(s); return s; },
    confirm: async () => false,
    onSignal: (handler) => void signals.push(handler),
    exit,
    ...rest,
  };
  return { deps, store, sockets, pidWrites, pidRemoves, auditLines, signals, exit, execRunner, handler: createEnvConnectHandler(deps), socket: () => sockets[sockets.length - 1]! };
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

  it('R5: given policy mode "ask" without a TTY, should refuse to start with a clear message', async () => {
    const h = harness({ policy: JSON.stringify({ mode: 'ask', principals: ['u1'], ops: [], roots: ['/home/me/proj'], envAllowlist: [] }) });
    const c = ctx(false);
    expect(await h.handler(c.ctx, intent(['env', 'connect', 'enr_1']))).toBe(EXIT_RUNTIME_ERROR);
    expect(c.err.text()).toMatch(/"ask" needs an interactive terminal/);
    expect(h.sockets).toHaveLength(0);
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
