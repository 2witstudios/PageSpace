/**
 * Attach-socket tests. A fake socket stands in for the WebSocket everywhere, so
 * nothing here touches the network.
 *
 * The two behaviours worth stating plainly, because both are counter-intuitive
 * and both were measured against the live API:
 * - readiness is `session.updated`, NEVER `session.created` (an attached socket
 *   never sends the latter — the browser's data channel already consumed it);
 * - the attach is authenticated by that call's own `ek_` ephemeral secret, and
 *   an API key produces `404 call_id_not_found`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    realtime: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

import {
  attachToCall,
  RealtimeAttachError,
  REALTIME_ATTACH_URL,
  type AttachSocket,
  type AttachSocketFactory,
} from '../voice/realtime-call-session';

/** A socket whose every event can be driven from a test. */
class FakeSocket implements AttachSocket {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  readonly sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  /** The frames the code under test sent, parsed. */
  sentEvents(): Record<string, unknown>[] {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  open(): void {
    this.onopen?.(undefined);
  }

  receive(event: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  receiveRaw(data: unknown): void {
    this.onmessage?.({ data });
  }
}

type Harness = {
  readonly socket: FakeSocket;
  readonly factory: AttachSocketFactory;
  readonly urls: string[];
  readonly headers: Record<string, string>[];
};

function harness(): Harness {
  const socket = new FakeSocket();
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const factory: AttachSocketFactory = (url, hdrs) => {
    urls.push(url);
    headers.push({ ...hdrs });
    return socket;
  };
  return { socket, factory, urls, headers };
}

const CALL_ID = 'rtc_u0_test';
const SECRET = 'ek_live_secret';

const TOOLS = [
  { type: 'function' as const, name: 'read_page', description: 'Read.', parameters: {} },
];

/** Attach and drive the socket to ready. */
async function attachReady(h: Harness) {
  const promise = attachToCall({
    callId: CALL_ID,
    secret: SECRET,
    userId: 'u1',
    tools: TOOLS,
    socketFactory: h.factory,
  });
  h.socket.open();
  h.socket.receive({ type: 'session.updated', session: {} });
  return promise;
}

describe('attachToCall — credential', () => {
  beforeEach(() => vi.clearAllMocks());

  it('given an API key instead of the ephemeral secret, should fail with a self-explaining named error and open NO socket', async () => {
    const h = harness();
    let opened = false;
    const factory: AttachSocketFactory = (...args) => {
      opened = true;
      return h.factory(...args);
    };

    const error = await attachToCall({
      callId: CALL_ID,
      secret: 'sk-proj-an-api-key',
      userId: 'u1',
      tools: TOOLS,
      socketFactory: factory,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RealtimeAttachError);
    expect((error as RealtimeAttachError).code).toBe('ephemeral_secret_required');
    // The message has to carry the fix, not just the fact.
    expect((error as RealtimeAttachError).message).toContain('ek_');
    expect((error as RealtimeAttachError).message).toContain('call_id_not_found');
    expect(opened).toBe(false);
  });

  it('given the call secret, should authenticate with exactly Bearer <secret> on the call_id URL', async () => {
    const h = harness();
    await attachReady(h);

    expect(h.headers[0]).toEqual({ Authorization: `Bearer ${SECRET}` });
    expect(h.urls[0]).toBe(`${REALTIME_ATTACH_URL}?call_id=${CALL_ID}`);
  });
});

describe('attachToCall — readiness', () => {
  beforeEach(() => vi.clearAllMocks());

  it('given the socket opens, should push session.update carrying the tools', async () => {
    const h = harness();
    await attachReady(h);

    const update = h.socket.sentEvents()[0];
    expect(update.type).toBe('session.update');
    expect((update.session as { tools: unknown[] }).tools).toEqual(TOOLS);
  });

  it('given session.created (never sent by a real attach) instead of session.updated, should NOT resolve', async () => {
    const h = harness();
    const promise = attachToCall({
      callId: CALL_ID,
      secret: SECRET,
      userId: 'u1',
      tools: TOOLS,
      socketFactory: h.factory,
    });

    h.socket.open();
    h.socket.receive({ type: 'session.created', session: {} });

    const settled = await Promise.race([
      promise.then(() => 'resolved'),
      new Promise((r) => setTimeout(() => r('pending'), 10)),
    ]);
    expect(settled).toBe('pending');

    // And it still resolves on the event that actually means ready.
    h.socket.receive({ type: 'session.updated', session: {} });
    await expect(promise).resolves.toMatchObject({ callId: CALL_ID });
  });

  it('given session.updated, should resolve a session carrying its identity', async () => {
    const h = harness();
    const promise = attachToCall({
      callId: CALL_ID,
      secret: SECRET,
      userId: 'u1',
      conversationId: 'conv1',
      tools: TOOLS,
      socketFactory: h.factory,
    });
    h.socket.open();
    h.socket.receive({ type: 'session.updated', session: {} });

    const session = await promise;
    expect(session.callId).toBe(CALL_ID);
    expect(session.userId).toBe('u1');
    expect(session.conversationId).toBe('conv1');
    expect(session.ended).toBe(false);
  });

  it('given session.update is rejected with an error event, should surface the upstream error and not report ready', async () => {
    const h = harness();
    const promise = attachToCall({
      callId: CALL_ID,
      secret: SECRET,
      userId: 'u1',
      tools: TOOLS,
      socketFactory: h.factory,
    });
    h.socket.open();
    h.socket.receive({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'unknown parameter' },
    });

    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RealtimeAttachError);
    expect((error as RealtimeAttachError).code).toBe('session_update_rejected');
    expect((error as RealtimeAttachError).upstream).toEqual({
      type: 'invalid_request_error',
      message: 'unknown parameter',
    });
  });

  it('given the socket closes before ready, should name the ephemeral-secret cause', async () => {
    const h = harness();
    const promise = attachToCall({
      callId: CALL_ID,
      secret: SECRET,
      userId: 'u1',
      tools: TOOLS,
      socketFactory: h.factory,
    });
    h.socket.onclose?.({ code: 1006 });

    const error = await promise.catch((e: unknown) => e);
    expect((error as RealtimeAttachError).code).toBe('socket_closed_before_ready');
    expect((error as RealtimeAttachError).message).toContain('1006');
    expect((error as RealtimeAttachError).message).toContain('ek_');
  });

  it('given the socket errors before ready, should reject with socket_error', async () => {
    const h = harness();
    const promise = attachToCall({
      callId: CALL_ID,
      secret: SECRET,
      userId: 'u1',
      tools: TOOLS,
      socketFactory: h.factory,
    });
    h.socket.onerror?.(new Error('handshake failed'));

    const error = await promise.catch((e: unknown) => e);
    expect((error as RealtimeAttachError).code).toBe('socket_error');
  });

  it('given nothing ever arrives, should time out rather than hang forever', async () => {
    const h = harness();
    const promise = attachToCall({
      callId: CALL_ID,
      secret: SECRET,
      userId: 'u1',
      tools: TOOLS,
      socketFactory: h.factory,
      readyTimeoutMs: 5,
    });
    h.socket.open();

    const error = await promise.catch((e: unknown) => e);
    expect((error as RealtimeAttachError).code).toBe('attach_timeout');
    // The message carries the fact that would otherwise be re-derived.
    expect((error as RealtimeAttachError).message).toContain('session.created');
  });
});

describe('attachToCall — event seam for B3/B4', () => {
  beforeEach(() => vi.clearAllMocks());

  it('given subscribers, should fan every parsed event out to all of them', async () => {
    const h = harness();
    const session = await attachReady(h);

    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    session.subscribe((e) => seenA.push(e));
    session.subscribe((e) => seenB.push(e));

    h.socket.receive({ type: 'response.done', response: { usage: { total_tokens: 7 } } });

    expect(seenA).toEqual([{ type: 'response.done', response: { usage: { total_tokens: 7 } } }]);
    expect(seenB).toEqual(seenA);
  });

  it('given unsubscribe, should stop delivering', async () => {
    const h = harness();
    const session = await attachReady(h);

    const seen: unknown[] = [];
    const off = session.subscribe((e) => seen.push(e));
    h.socket.receive({ type: 'a' });
    off();
    h.socket.receive({ type: 'b' });

    expect(seen).toEqual([{ type: 'a' }]);
  });

  it('given a subscriber that throws, should keep delivering to the others', async () => {
    const h = harness();
    const session = await attachReady(h);

    const seen: unknown[] = [];
    session.subscribe(() => {
      throw new Error('bad subscriber');
    });
    session.subscribe((e) => seen.push(e));

    expect(() => h.socket.receive({ type: 'a' })).not.toThrow();
    expect(seen).toEqual([{ type: 'a' }]);
  });

  it('given a malformed frame, should ignore it instead of throwing into the socket', async () => {
    const h = harness();
    const session = await attachReady(h);

    const seen: unknown[] = [];
    session.subscribe((e) => seen.push(e));

    expect(() => h.socket.receiveRaw('not json at all')).not.toThrow();
    expect(() => h.socket.receiveRaw(new ArrayBuffer(4))).not.toThrow();
    expect(seen).toEqual([]);
  });

  it('given a frame that is valid JSON but not an event, should fan it out without reading a type off it', async () => {
    // `JSON.parse` happily returns a number, a string or null, and a frame whose
    // `type` is not a string is just as unusable. Neither may throw while the
    // readiness check is reading the type off it.
    const h = harness();
    const session = await attachReady(h);

    const seen: unknown[] = [];
    session.subscribe((e) => seen.push(e));

    expect(() => h.socket.receiveRaw('42')).not.toThrow();
    expect(() => h.socket.receiveRaw('null')).not.toThrow();
    expect(() => h.socket.receive({ type: 7 })).not.toThrow();

    expect(seen).toEqual([42, null, { type: 7 }]);
  });

  it('given send, should write the event as JSON — and stay silent once ended', async () => {
    const h = harness();
    const session = await attachReady(h);
    const before = h.socket.sent.length;

    session.send({ type: 'response.create' });
    expect(JSON.parse(h.socket.sent[before])).toEqual({ type: 'response.create' });

    session.end('test');
    session.send({ type: 'response.create' });
    expect(h.socket.sent.length).toBe(before + 1);
  });
});

describe('attachToCall — teardown', () => {
  beforeEach(() => vi.clearAllMocks());

  it('given the socket closes mid-call, should mark it ended and notify onClosed exactly once', async () => {
    const h = harness();
    const onClosed = vi.fn();
    const promise = attachToCall({
      callId: CALL_ID,
      secret: SECRET,
      userId: 'u1',
      tools: TOOLS,
      socketFactory: h.factory,
      onClosed,
    });
    h.socket.open();
    h.socket.receive({ type: 'session.updated', session: {} });
    const session = await promise;

    const closeHandler = h.socket.onclose;
    closeHandler?.({ code: 1000 });

    expect(session.ended).toBe(true);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenCalledWith(CALL_ID);
    expect(h.socket.closed).toBe(true);
  });

  it('given a socket whose close() THROWS, should still finish tearing down', async () => {
    // The point of the close is to stop billing, and a socket that refuses it
    // is a socket that is already closing. Letting that throw would abandon
    // teardown half-done — no deregistration, no onClosed, a live registry
    // entry for a dead call.
    const h = harness();
    const onClosed = vi.fn();
    const promise = attachToCall({
      callId: CALL_ID,
      secret: SECRET,
      userId: 'u1',
      tools: TOOLS,
      socketFactory: h.factory,
      onClosed,
    });
    h.socket.open();
    h.socket.receive({ type: 'session.updated', session: {} });
    const session = await promise;

    h.socket.close = () => {
      throw new Error('already closing');
    };

    expect(() => session.end('test')).not.toThrow();
    expect(session.ended).toBe(true);
    expect(onClosed).toHaveBeenCalledWith(CALL_ID);
  });

  it('given a close with NO code, should still name the credential as the usual cause', async () => {
    // A bare `1006` — or no code at all — is exactly what a wrong credential
    // looks like from here, which is why the message says so rather than
    // reporting the close verbatim.
    const h = harness();
    const promise = attachToCall({
      callId: CALL_ID,
      secret: SECRET,
      userId: 'u1',
      tools: TOOLS,
      socketFactory: h.factory,
    });
    h.socket.open();
    h.socket.onclose?.({});

    await expect(promise).rejects.toMatchObject({ code: 'socket_closed_before_ready' });
    await expect(promise).rejects.toThrow(/code unknown/);
  });

  it('given end() called twice, should tear down once and stay idempotent', async () => {
    const h = harness();
    const onClosed = vi.fn();
    const promise = attachToCall({
      callId: CALL_ID,
      secret: SECRET,
      userId: 'u1',
      tools: TOOLS,
      socketFactory: h.factory,
      onClosed,
    });
    h.socket.open();
    h.socket.receive({ type: 'session.updated', session: {} });
    const session = await promise;

    session.end('first');
    session.end('second');

    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('given teardown, should drop subscribers so a late frame reaches nobody', async () => {
    const h = harness();
    const session = await attachReady(h);
    const seen: unknown[] = [];
    session.subscribe((e) => seen.push(e));

    const deliverLate = h.socket.onmessage;
    session.end('done');
    deliverLate?.({ data: JSON.stringify({ type: 'response.done' }) });

    expect(seen).toEqual([]);
  });

  it('given the hard duration cap elapses, should end the call so it cannot bill silently', async () => {
    const h = harness();
    const onClosed = vi.fn();
    const promise = attachToCall({
      callId: CALL_ID,
      secret: SECRET,
      userId: 'u1',
      tools: TOOLS,
      socketFactory: h.factory,
      onClosed,
      maxDurationMs: 5,
    });
    h.socket.open();
    h.socket.receive({ type: 'session.updated', session: {} });
    const session = await promise;

    await new Promise((r) => setTimeout(r, 20));

    expect(session.ended).toBe(true);
    expect(h.socket.closed).toBe(true);
    expect(onClosed).toHaveBeenCalledWith(CALL_ID);
  });

  it('given a session that reached ready, should clear its timers so the process can exit', async () => {
    const clearTimeoutFn = vi.fn(clearTimeout);
    const h = harness();
    const promise = attachToCall({
      callId: CALL_ID,
      secret: SECRET,
      userId: 'u1',
      tools: TOOLS,
      socketFactory: h.factory,
      clearTimeoutFn: clearTimeoutFn as unknown as typeof clearTimeout,
    });
    h.socket.open();
    h.socket.receive({ type: 'session.updated', session: {} });
    const session = await promise;
    session.end('done');

    // The ready timer is cleared on readiness; the duration timer on teardown.
    expect(clearTimeoutFn).toHaveBeenCalled();
  });
});

describe('attachToCall — concurrent calls', () => {
  beforeEach(() => vi.clearAllMocks());

  it('given two calls attach at once, should keep their sockets and events independent', async () => {
    const a = harness();
    const b = harness();

    const promiseA = attachToCall({
      callId: 'rtc_a',
      secret: 'ek_a',
      userId: 'ua',
      tools: TOOLS,
      socketFactory: a.factory,
    });
    const promiseB = attachToCall({
      callId: 'rtc_b',
      secret: 'ek_b',
      userId: 'ub',
      tools: [],
      socketFactory: b.factory,
    });

    a.socket.open();
    b.socket.open();
    a.socket.receive({ type: 'session.updated', session: {} });
    b.socket.receive({ type: 'session.updated', session: {} });

    const [sessionA, sessionB] = await Promise.all([promiseA, promiseB]);

    expect(a.headers[0]).toEqual({ Authorization: 'Bearer ek_a' });
    expect(b.headers[0]).toEqual({ Authorization: 'Bearer ek_b' });

    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    sessionA.subscribe((e) => seenA.push(e));
    sessionB.subscribe((e) => seenB.push(e));

    a.socket.receive({ type: 'only.for.a' });

    expect(seenA).toEqual([{ type: 'only.for.a' }]);
    expect(seenB).toEqual([]);

    // Ending one must not touch the other.
    sessionA.end('done');
    expect(sessionA.ended).toBe(true);
    expect(sessionB.ended).toBe(false);
    expect(b.socket.closed).toBe(false);
  });
});
