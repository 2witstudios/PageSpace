import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { encodeFrame, type Frame } from '@pagespace/lib/env-bridge/frame-codec';
import { ENV_SUPERSEDED_CLOSE_CODE, ENV_SUPERSEDED_CLOSE_REASON } from '@pagespace/lib/env-bridge/bridge-session';
import type { HelloFrame } from '@pagespace/lib/env-bridge/bridge-session';
import { createBridgeConnection, type BridgeConnectionDeps, type BridgeSocket } from '../ws-client.js';
import type { AuditEntry } from '../audit-log.js';
import type { DispatchResult } from '../dispatcher.js';

const HELLO: HelloFrame = { type: 'hello', envId: 'env_1', capabilities: { shell: true, pty: false, fs: true, checkpoint: false }, policyDigest: 'd', sig: 'AAAA' };
const GRANT: Frame = { type: 'grant_exec', grant: { grantId: 'g1' }, sig: 'AAAA', cmd: 'x' };
const PING: Frame = { type: 'ping', ts: 1 };

class FakeSocket extends EventEmitter implements BridgeSocket {
  readonly sent: string[] = [];
  readyState = 0;
  closed: { code?: number; reason?: string } | null = null;
  terminated = false;
  constructor(readonly url: string, readonly headers: Record<string, string>) {
    super();
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
  terminate() {
    this.terminated = true;
  }
  open() {
    this.readyState = 1;
    this.emit('open');
  }
  receive(frame: Frame | string) {
    this.emit('message', typeof frame === 'string' ? frame : encodeFrame(frame));
  }
  drop(code = 1006, reason = '') {
    this.readyState = 3;
    this.emit('close', code, Buffer.from(reason));
  }
}

function harness(overrides: Partial<BridgeConnectionDeps> = {}) {
  const sockets: FakeSocket[] = [];
  const audits: AuditEntry[] = [];
  const handled: Frame[] = [];
  let tokens = 0;
  const deps: BridgeConnectionDeps = {
    url: 'wss://pagespace.test/api/env-bridge/ws?envId=env_1',
    mintToken: vi.fn(async () => `tok_${++tokens}`),
    hello: () => HELLO,
    dispatcher: { handle: vi.fn(async (frame: Frame): Promise<DispatchResult> => { handled.push(frame); return frame.type === 'ping' ? { kind: 'reply', frame: { type: 'pong', ts: 9 } } : { kind: 'reply', frame: { type: 'grant_denied', grantId: 'g1', reason: 'x', sig: 'AAAA' } }; }) },
    audit: { record: async (entry) => void audits.push(entry) },
    createSocket: (url, headers) => { const s = new FakeSocket(url, headers); sockets.push(s); return s; },
    deleteKey: vi.fn(async () => undefined),
    onRevoked: vi.fn(),
    onSuperseded: vi.fn(),
    log: () => undefined,
    limits: { maxFrameBytes: 1024 * 1024 },
    backoff: { initialMs: 1_000, maxMs: 30_000, expiredRetryMs: 500 },
    idleTimeoutMs: 90_000,
    ...overrides,
  };
  return { deps, sockets, audits, handled, connection: createBridgeConnection(deps), socket: () => sockets[sockets.length - 1]! };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('ws-client — lifted reconnect/backoff/heartbeat; state driven by reduceBridgeSession, effects performed here', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('start: mints a FRESH token, opens the socket with the Bearer header on the env URL, and sends the signed hello as the FIRST frame', async () => {
    const h = harness();
    h.connection.start();
    await flush();
    expect(h.deps.mintToken).toHaveBeenCalledTimes(1);
    expect(h.socket().url).toBe('wss://pagespace.test/api/env-bridge/ws?envId=env_1');
    expect(h.socket().headers).toEqual({ Authorization: 'Bearer tok_1' });
    h.socket().open();
    expect(h.socket().sent).toEqual([encodeFrame(HELLO)]);
    expect(h.connection.status().session).toBe('hello_sent');
  });

  it('R9: a grant arriving BEFORE the hello is acknowledged is rejected by the reducer (audited), never dispatched; the first server ping is the ack and later grants dispatch', async () => {
    const h = harness();
    h.connection.start();
    await flush();
    h.socket().open();
    h.socket().receive(GRANT);
    await flush();
    expect(h.handled).toEqual([]);
    expect(h.audits.at(-1)).toMatchObject({ verdict: 'rejected:not_authorized', op: 'grant_exec' });
    h.socket().receive(PING);
    await flush();
    expect(h.connection.status().session).toBe('authorized');
    expect(h.socket().sent[1]).toBe(encodeFrame({ type: 'pong', ts: 9 }));
    h.socket().receive(GRANT);
    await flush();
    expect(h.handled.map((f) => f.type)).toEqual(['ping', 'grant_exec']);
    expect(h.socket().sent[2]).toContain('grant_denied');
  });

  it('R2: a frame that fails decodeFrame is dropped + audited; the process does not throw and the dispatcher is not called', async () => {
    const h = harness();
    h.connection.start();
    await flush();
    h.socket().open();
    h.socket().receive(PING);
    await flush();
    h.socket().receive('{not json');
    h.socket().receive(JSON.stringify({ type: 'sudo', ok: true }));
    h.socket().receive(JSON.stringify({ type: 'grant_exec', grant: {}, sig: '***', cmd: 'x' }));
    await flush();
    expect(h.audits.filter((a) => a.verdict.startsWith('dropped:')).map((a) => a.verdict)).toEqual(['dropped:malformed', 'dropped:unknown_type', 'dropped:bad_base64']);
    expect(h.handled.map((f) => f.type)).toEqual(['ping']);
  });

  it('R7: a verified revoke deletes the key, closes the socket, reports revoked, and NEVER reconnects', async () => {
    const h = harness({ dispatcher: { handle: async () => ({ kind: 'revoke_verified' }) } });
    h.connection.start();
    await flush();
    h.socket().open();
    h.socket().receive({ type: 'revoke', sig: 'AAAA', issuedAt: 1 });
    await flush();
    expect(h.deps.deleteKey).toHaveBeenCalledTimes(1);
    expect(h.deps.onRevoked).toHaveBeenCalledTimes(1);
    expect(h.socket().closed).toEqual({ code: 1000, reason: 'revoked' });
    expect(h.connection.status().session).toBe('revoked');
    h.socket().drop(1000, 'revoked');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sockets).toHaveLength(1);
    expect(h.deps.mintToken).toHaveBeenCalledTimes(1);
  });

  it('R9: server restart → reconnects with exponential backoff (1s, 2s, 4s…), a FRESH token each time, and re-sends hello', async () => {
    const h = harness();
    h.connection.start();
    await flush();
    h.socket().open();
    h.socket().drop();
    await vi.advanceTimersByTimeAsync(999);
    expect(h.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(2);
    expect(h.socket().headers.Authorization).toBe('Bearer tok_2');
    h.socket().drop();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(h.sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(3);
    h.socket().open();
    expect(h.socket().sent).toEqual([encodeFrame(HELLO)]);
    expect(h.deps.mintToken).toHaveBeenCalledTimes(3);
  });

  it('backoff resets after a successful handshake and is capped at maxMs', async () => {
    const h = harness({ backoff: { initialMs: 1_000, maxMs: 2_000, expiredRetryMs: 500 } });
    h.connection.start();
    await flush();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      h.socket().drop();
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(h.sockets).toHaveLength(5);
    h.socket().open();
    h.socket().receive(PING);
    await flush();
    h.socket().drop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sockets).toHaveLength(6);
  });

  it('a close whose reason says the token expired reconnects immediately (expiredRetryMs) with backoff reset', async () => {
    const h = harness();
    h.connection.start();
    await flush();
    h.socket().drop(1008, 'Invalid or expired token');
    await vi.advanceTimersByTimeAsync(499);
    expect(h.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sockets).toHaveLength(2);
  });

  it('R8: stop() (Ctrl-C / env disconnect) closes the socket cleanly, cancels any pending reconnect, and the later close event schedules nothing', async () => {
    const h = harness();
    h.connection.start();
    await flush();
    h.socket().open();
    h.connection.stop('interrupted');
    expect(h.socket().closed).toEqual({ code: 1000, reason: 'interrupted' });
    h.socket().drop(1000, 'interrupted');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sockets).toHaveLength(1);
    expect(h.connection.status().stopped).toBe(true);
  });

  it('heartbeat watchdog: no server ping within idleTimeoutMs terminates the socket so the backoff reconnect takes over', async () => {
    const h = harness({ idleTimeoutMs: 5_000 });
    h.connection.start();
    await flush();
    h.socket().open();
    h.socket().receive(PING);
    await vi.advanceTimersByTimeAsync(4_000);
    h.socket().receive(PING);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.socket().terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.socket().terminated).toBe(true);
  });

  it('P1: a close with the server\'s env_superseded contract (1000 + reason) is TERMINAL — no reconnect, no backoff, onSuperseded fires, status stopped', async () => {
    const h = harness();
    h.connection.start();
    await flush();
    h.socket().open();
    h.socket().receive(PING);
    await flush();
    h.socket().drop(ENV_SUPERSEDED_CLOSE_CODE, ENV_SUPERSEDED_CLOSE_REASON);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sockets).toHaveLength(1);
    expect(h.deps.mintToken).toHaveBeenCalledTimes(1);
    expect(h.deps.onSuperseded).toHaveBeenCalledTimes(1);
    expect(h.deps.deleteKey).not.toHaveBeenCalled();
    expect(h.connection.status().stopped).toBe(true);
  });

  it('a plain 1000 close with another reason is still a failure to reconnect from (the contract is code AND reason)', async () => {
    const h = harness();
    h.connection.start();
    await flush();
    h.socket().drop(1000, 'going away');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.sockets).toHaveLength(2);
    expect(h.deps.onSuperseded).not.toHaveBeenCalled();
  });

  it('a token mint failure schedules a backoff reconnect instead of crashing', async () => {
    const h = harness({ mintToken: vi.fn(async () => { throw new Error('Challenge refused: rate limited (HTTP 429)'); }) });
    h.connection.start();
    await flush();
    expect(h.sockets).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.deps.mintToken).toHaveBeenCalledTimes(2);
  });

  it('a socket error is logged and does not throw', async () => {
    const lines: string[] = [];
    const h = harness({ log: (line) => void lines.push(line) });
    h.connection.start();
    await flush();
    h.socket().emit('error', new Error('ECONNREFUSED'));
    expect(lines.join('')).toMatch(/ECONNREFUSED/);
  });
});

describe('GA wave 3 — a `paused` dispatch result: the signed ack goes back and the socket STAYS open', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('should send the pause_result frame and neither close nor delete the key', async () => {
    const ack: Frame = { type: 'pause_result', envId: 'env_1', pausedAt: 5, killed: 1, sig: 'AAAA' };
    const h = harness({ dispatcher: { handle: async (frame: Frame) => (frame.type === 'pause' ? { kind: 'paused', pausedAt: 5, killed: 1, dropped: 0, frame: ack } : { kind: 'reply', frame: { type: 'pong', ts: 1 } }) } });
    void h.connection.start();
    await flush();
    h.socket().open();
    h.socket().receive({ type: 'ping', ts: 1 });
    await flush();
    const before = h.socket().sent.length;
    h.socket().receive({ type: 'pause', sig: 'AAAA', issuedAt: 1, pausedAt: 5 });
    await flush();
    expect(h.socket().sent.slice(before).map((raw) => JSON.parse(raw).type)).toEqual(['pause_result']);
    expect(h.socket().closed).toBeNull();
    expect(h.deps.deleteKey).not.toHaveBeenCalled();
  });
});
