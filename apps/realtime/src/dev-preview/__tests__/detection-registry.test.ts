import { describe, it, expect, vi } from 'vitest';
// WITHOUT THIS IMPORT the `assert({ given, should, actual, expected })` calls
// below silently resolve to vitest's global chai `assert`, which asserts
// TRUTHINESS of its first argument — and an object literal is always truthy.
// Eight of them passed unconditionally, one whole test asserted nothing at
// all, and it typechecked and went green the entire time.
import { assert } from '../../terminal/__tests__/riteway';
import type { SandboxHandle } from '@pagespace/lib/services/sandbox/sandbox-host';
import type { PortsWatchSocketLike } from '@pagespace/lib/services/sandbox/preview/ports-watch';
import { createDetectionRegistry, nodeWebSocketFactory, type DetectionRegistryDeps } from '../detection-registry';

type Listener = (event: never) => void;

function fakeSocketFactory() {
  const sockets: Array<{ url: string; headers: Record<string, string>; emit: (type: string, event?: unknown) => void; closes: number }> = [];
  const createSocket = (url: string, headers: Record<string, string>): PortsWatchSocketLike => {
    const listeners = new Map<string, Listener[]>();
    const entry = {
      url,
      headers,
      closes: 0,
      emit: (type: string, event?: unknown) => { for (const l of listeners.get(type) ?? []) l(event as never); },
    };
    sockets.push(entry);
    return {
      addEventListener(type: string, listener: Listener) { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
      close() { entry.closes += 1; },
    };
  };
  return { sockets, createSocket };
}

function fakeHandle(spriteInstanceId = 'inst'): SandboxHandle {
  return {
    sandboxId: 'sbx',
    spriteInstanceId,
    exec: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
    writeFiles: async () => {},
    readFile: async () => null,
    stream: async () => { throw new Error('unused'); },
    listStreams: async () => [],
    killSession: async () => {},
    createCheckpoint: async () => {},
    services: { create: async () => {}, list: async () => [], get: async () => null, start: async () => {}, stop: async () => {}, remove: async () => {} },
    urlInfo: async () => ({ url: null, auth: 'unknown' }),
    setUrlAuth: async () => {},
    powerState: async () => 'running',
  };
}

const clock = { now: new Date('2026-09-06T12:00:00Z') };

function deps(over: Partial<DetectionRegistryDeps> = {}) {
  const factory = fakeSocketFactory();
  const logs: string[] = [];
  const waits: number[] = [];
  const upserts: unknown[] = [];
  const d: DetectionRegistryDeps = {
    featureEnabled: () => true,
    resolveHolderSandboxId: async (holder) => (holder.id === 'gone-holder' ? null : `sbx-${holder.id}`),
    attach: async () => fakeHandle(),
    store: { findByHolder: async () => null, upsert: async (intent) => { upserts.push(intent); return true; }, setStoppedByUser: async () => null },
    createSocket: factory.createSocket,
    spritesToken: () => 'tok',
    spritesApiBaseUrl: () => 'https://api.sprites.dev',
    log: { info: (m) => logs.push(`info:${m}`), warn: (m, c) => logs.push(`warn:${m}:${JSON.stringify(c)}`), error: (m) => logs.push(`error:${m}`) },
    now: () => clock.now,
    wait: async (ms) => { waits.push(ms); },
    ...over,
  };
  return { deps: d, sockets: factory.sockets, logs, waits, upserts };
}

const HOLDER = { kind: 'env', id: 'env1' } as const;

describe('createDetectionRegistry', () => {
  it('does nothing while the feature is dark', async () => {
    const h = deps({ featureEnabled: () => false });
    const registry = createDetectionRegistry(h.deps);
    await registry.ensure({ holder: HOLDER });
    expect(h.sockets).toHaveLength(0);
    expect(registry.watching()).toEqual([]);
  });

  it('opens ONE watch per sprite, at the ports/watch endpoint with the bearer token, and is idempotent', async () => {
    const h = deps();
    const registry = createDetectionRegistry(h.deps);
    await Promise.all([registry.ensure({ holder: HOLDER }), registry.ensure({ holder: HOLDER })]);
    await registry.ensure({ holder: HOLDER });
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0].url).toBe('wss://api.sprites.dev/v1/sprites/sbx-env1/ports/watch');
    expect(h.sockets[0].headers).toEqual({ Authorization: 'Bearer tok' });
    expect(registry.watching()).toEqual(['sbx-env1']);
  });

  it('feeds frames to the detector, which plans through the core and writes the row', async () => {
    const h = deps();
    const registry = createDetectionRegistry(h.deps);
    await registry.ensure({ holder: HOLDER });
    h.sockets[0].emit('open');
    // The platform sends a `port_list` on connect, always. The core will not
    // plan a relay start from an accumulated set until it has, because before
    // that the set says nothing about who holds port 8080.
    h.sockets[0].emit('message', { data: JSON.stringify({ type: 'port_list', ports: [] }) });
    h.sockets[0].emit('message', { data: JSON.stringify({ type: 'port_opened', port: 5173, pid: 3 }) });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.upserts).toHaveLength(1);
    expect(h.upserts[0]).toMatchObject({ holder: HOLDER, targetPort: 5173, spriteInstanceId: 'inst' });
  });

  it('listeners(): null before any watch AND until the connection\'s port_list has APPLIED (the detector owns that); the accumulated snapshot after it; null again once the watcher is gone or the feature is dark', async () => {
    const h = deps();
    const registry = createDetectionRegistry(h.deps);
    expect((await registry.read({ holder: HOLDER })).listeners).toBeNull();
    await registry.ensure({ holder: HOLDER });
    // Watching, socket open, but no `port_list` yet: the detector's empty
    // array is NOT a known-empty snapshot — it is nothing yet. Unknown.
    h.sockets[0].emit('open');
    expect((await registry.read({ holder: HOLDER })).listeners).toBeNull();
    h.sockets[0].emit('message', { data: JSON.stringify({ type: 'port_opened', port: 3000, pid: 1 }) });
    await new Promise((r) => setTimeout(r, 10));
    expect((await registry.read({ holder: HOLDER })).listeners).toBeNull();
    h.sockets[0].emit('message', { data: JSON.stringify({ type: 'port_list', ports: [{ port: 5173, pid: 3 }, { port: 8080, pid: 9 }] }) });
    // (Arrived-but-not-applied is the detector's own contract, tested there.)
    h.sockets[0].emit('message', { data: JSON.stringify({ type: 'port_closed', port: 8080 }) });
    await new Promise((r) => setTimeout(r, 10));
    expect((await registry.read({ holder: HOLDER })).listeners).toEqual([{ port: 5173, pid: 3 }]);
    // A holder whose row has no live sprite is never answered from someone else's watcher.
    expect((await registry.read({ holder: { kind: 'env', id: 'gone-holder' } })).listeners).toBeNull();
    registry.stopAll();
    expect((await registry.read({ holder: HOLDER })).listeners).toBeNull();
    const dark = createDetectionRegistry(deps({ featureEnabled: () => false }).deps);
    expect((await dark.read({ holder: HOLDER })).listeners).toBeNull();
  });

  it('listeners(): a DROPPED connection answers null through the reconnect backoff (the old array is stale), and is known again only after the new connection delivers its port_list', async () => {
    const h = deps({ maxReconnects: 3 });
    const registry = createDetectionRegistry(h.deps);
    await registry.ensure({ holder: HOLDER });
    h.sockets[0].emit('open');
    h.sockets[0].emit('message', { data: JSON.stringify({ type: 'port_list', ports: [{ port: 5173, pid: 3 }] }) });
    await new Promise((r) => setTimeout(r, 10));
    expect((await registry.read({ holder: HOLDER })).listeners).toEqual([{ port: 5173, pid: 3 }]);
    // Drop: reconnect is pending (the waits fake resolves at once, so a second socket exists) — still unknown until IT snapshots.
    h.sockets[0].emit('close', { code: 1006 });
    await new Promise((r) => setImmediate(r));
    expect(registry.watching()).toEqual(['sbx-env1']);
    expect((await registry.read({ holder: HOLDER })).listeners).toBeNull();
    h.sockets[1].emit('open');
    expect((await registry.read({ holder: HOLDER })).listeners).toBeNull();
    h.sockets[1].emit('message', { data: JSON.stringify({ type: 'port_list', ports: [{ port: 8080, pid: 42 }] }) });
    await new Promise((r) => setTimeout(r, 10));
    expect((await registry.read({ holder: HOLDER })).listeners).toEqual([{ port: 8080, pid: 42 }]);
  });

  it('listeners(): a port_list whose socket dropped before the detector applied it never marks the NEXT connection fresh', async () => {
    const h = deps({ maxReconnects: 3 });
    const registry = createDetectionRegistry(h.deps);
    await registry.ensure({ holder: HOLDER });
    h.sockets[0].emit('open');
    // Arrives on connection 1, then connection 1 drops before the chain has applied it.
    h.sockets[0].emit('message', { data: JSON.stringify({ type: 'port_list', ports: [{ port: 5173, pid: 3 }] }) });
    h.sockets[0].emit('close', { code: 1006 });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.sockets).toHaveLength(2);
    h.sockets[1].emit('open');
    expect((await registry.read({ holder: HOLDER })).listeners).toBeNull();
  });

  it('a failing start leaves no entry behind (a malformed API base URL throws before the channel opens)', async () => {
    const h = deps({ spritesApiBaseUrl: () => 'not a url' });
    const registry = createDetectionRegistry(h.deps);
    await registry.ensure({ holder: HOLDER });
    expect(registry.watching()).toEqual([]);
    expect((await registry.read({ holder: HOLDER })).listeners).toBeNull();
    expect(h.logs.some((l) => l.startsWith('error:dev-preview: watcher failed to start'))).toBe(true);
  });

  it('listeners(): a watcher dropped past its reconnect budget answers null, not a stale snapshot', async () => {
    const h = deps({ maxReconnects: 0 });
    const registry = createDetectionRegistry(h.deps);
    await registry.ensure({ holder: HOLDER });
    h.sockets[0].emit('open');
    h.sockets[0].emit('message', { data: JSON.stringify({ type: 'port_list', ports: [{ port: 5173, pid: 3 }] }) });
    await new Promise((r) => setTimeout(r, 10));
    expect((await registry.read({ holder: HOLDER })).listeners).toEqual([{ port: 5173, pid: 3 }]);
    h.sockets[0].emit('close', { code: 1006 });
    await new Promise((r) => setImmediate(r));
    expect(registry.watching()).toEqual([]);
    expect((await registry.read({ holder: HOLDER })).listeners).toBeNull();
  });

  it('watches nothing for a holder whose row has no live sprite — the caller never names the sprite', async () => {
    const h = deps();
    const registry = createDetectionRegistry(h.deps);
    await registry.ensure({ holder: { kind: 'env', id: 'gone-holder' } });
    expect(h.sockets).toHaveLength(0);
    expect(registry.watching()).toEqual([]);
  });

  it('drops a sprite the platform no longer has, without opening a socket', async () => {
    const h = deps({ attach: async () => null });
    const registry = createDetectionRegistry(h.deps);
    await registry.ensure({ holder: HOLDER });
    expect(h.sockets).toHaveLength(0);
    expect(registry.watching()).toEqual([]);
    expect(h.logs.some((l) => l.startsWith('warn:dev-preview: sprite not attachable'))).toBe(true);
  });

  it('reconnects with backoff after a drop, resets the budget once a connection opened, and stops after the budget', async () => {
    const h = deps({ maxReconnects: 2 });
    const registry = createDetectionRegistry(h.deps);
    await registry.ensure({ holder: HOLDER });
    // First socket connects then drops: budget reset, reconnect after 1s.
    h.sockets[0].emit('open');
    h.sockets[0].emit('close', { code: 1006 });
    await new Promise((r) => setImmediate(r));
    expect(h.waits).toEqual([1000]);
    expect(h.sockets).toHaveLength(2);
    // The second never opens: one more try after 2s; the third never opens
    // either, and the budget (2) is spent — give up, no fourth socket.
    h.sockets[1].emit('close', { code: 1002 });
    await new Promise((r) => setImmediate(r));
    h.sockets[2].emit('close', { code: 1002 });
    await new Promise((r) => setImmediate(r));
    expect(h.waits).toEqual([1000, 2000]);
    expect(h.sockets).toHaveLength(3);
    expect(registry.watching()).toEqual([]);
    expect(h.logs.some((l) => l.startsWith('warn:dev-preview: watch channel gone'))).toBe(true);
    // A later ensure starts fresh.
    await registry.ensure({ holder: HOLDER });
    expect(h.sockets).toHaveLength(4);
  });

  it('never opens a channel without a token (fail closed), and stops at once', async () => {
    const h = deps({ spritesToken: () => '' });
    const registry = createDetectionRegistry(h.deps);
    await registry.ensure({ holder: HOLDER });
    await new Promise((r) => setImmediate(r));
    expect(h.sockets).toHaveLength(0);
    expect(registry.watching()).toEqual([]);
    expect(h.waits).toEqual([]);
  });

  it('stopAll closes every socket and forgets every sprite; a close after stop does not reconnect', async () => {
    const h = deps();
    const registry = createDetectionRegistry(h.deps);
    await registry.ensure({ holder: HOLDER });
    await registry.ensure({ holder: { kind: 'workspace', id: 'w' } });
    registry.stopAll();
    expect(h.sockets.map((s) => s.closes)).toEqual([1, 1]);
    expect(registry.watching()).toEqual([]);
    h.sockets[0].emit('close', { code: 1000 });
    await new Promise((r) => setImmediate(r));
    expect(h.sockets).toHaveLength(2);
  });

  it('a throwing attach is logged (Error or not) and the slot released', async () => {
    for (const thrown of [new Error('boom'), 'string boom']) {
      const h = deps({ attach: async () => { throw thrown; } });
      const registry = createDetectionRegistry(h.deps);
      await registry.ensure({ holder: HOLDER });
      expect(registry.watching()).toEqual([]);
      expect(h.logs.some((l) => l.startsWith('error:dev-preview: watcher failed to start'))).toBe(true);
    }
  });

  it('uses a real timer when no wait seam is given', async () => {
    vi.useFakeTimers();
    try {
      const h = deps({ wait: undefined, maxReconnects: 1 });
      const registry = createDetectionRegistry(h.deps);
      await registry.ensure({ holder: HOLDER });
      h.sockets[0].emit('close', { code: 1006 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.sockets).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('nodeWebSocketFactory hands the runtime WebSocket the url and the headers option', () => {
    const seen: unknown[] = [];
    class FakeWebSocket { constructor(url: string, options: unknown) { seen.push(url, options); } addEventListener() {} close() {} }
    vi.stubGlobal('WebSocket', FakeWebSocket);
    try {
      nodeWebSocketFactory('wss://x/ports/watch', { Authorization: 'Bearer t' });
      expect(seen).toEqual(['wss://x/ports/watch', { headers: { Authorization: 'Bearer t' } }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a stopAll that lands while attach is pending opens no channel', async () => {
    let releaseAttach: (h: SandboxHandle) => void = () => {};
    const h = deps({ attach: () => new Promise<SandboxHandle>((resolve) => { releaseAttach = resolve; }) });
    const registry = createDetectionRegistry(h.deps);
    const pending = registry.ensure({ holder: HOLDER });
    await new Promise((r) => setImmediate(r));
    expect(registry.watching()).toEqual(['sbx-env1']);
    registry.stopAll();
    releaseAttach(fakeHandle());
    await pending;
    expect(h.sockets).toHaveLength(0);
    expect(registry.watching()).toEqual([]);
  });

  it('RECOVERY AFTER A RESTART: a fresh registry that was never told to `ensure` still starts watching when a status read arrives', async () => {
    // This is the process-restart case. Watchers live only in memory, so a
    // restart loses every one of them, and nothing else would ever start them
    // again — a dev server begun afterwards was previously never detected.
    const h = deps();
    const registry = createDetectionRegistry(h.deps);
    const first = await registry.read({ holder: HOLDER });
    assert({ given: 'a read against a registry with no watchers', should: 'report arming and say nothing about ports', actual: first, expected: { detection: 'arming', listeners: null } });
    await new Promise((r) => setTimeout(r, 5));
    expect(h.sockets).toHaveLength(1);

    h.sockets[0].emit('open');
    h.sockets[0].emit('message', { data: JSON.stringify({ type: 'port_list', ports: [{ port: 5173, pid: 3 }] }) });
    await new Promise((r) => setTimeout(r, 10));
    assert({ given: 'the re-armed watcher once it has snapshotted', should: 'report watching, with the ports', actual: await registry.read({ holder: HOLDER }), expected: { detection: 'watching', listeners: [{ port: 5173, pid: 3 }] } });
  });

  it('an exhausted reconnect budget is no longer the end of detection — the next read re-arms it', async () => {
    const h = deps({ maxReconnects: 0 });
    const registry = createDetectionRegistry(h.deps);
    await registry.ensure({ holder: HOLDER });
    h.sockets[0].emit('open');
    h.sockets[0].emit('close', { code: 1006 });
    await new Promise((r) => setImmediate(r));
    expect(registry.watching()).toEqual([]);

    // Past the cool-down (the drop counts as an arm), a read starts over.
    clock.now = new Date(clock.now.getTime() + 60_000);
    assert({ given: 'a read after the budget was spent', should: 'arm again', actual: await registry.read({ holder: HOLDER }), expected: { detection: 'arming', listeners: null } });
    await new Promise((r) => setTimeout(r, 5));
    expect(h.sockets).toHaveLength(2);
  });

  it('the re-arm is THROTTLED, so a sick sprite is not re-attacked on every render — but an explicit ensure is never throttled', async () => {
    const h = deps({ attach: async () => null });
    const registry = createDetectionRegistry(h.deps);
    for (let i = 0; i < 5; i += 1) await registry.read({ holder: HOLDER });
    await new Promise((r) => setTimeout(r, 5));
    assert({ given: 'five reads inside the cool-down for an unattachable sprite', should: 'have tried exactly once', actual: h.logs.filter((l) => l.startsWith('warn:dev-preview: sprite not attachable')).length, expected: 1 });

    clock.now = new Date(clock.now.getTime() + 60_000);
    await registry.read({ holder: HOLDER });
    await new Promise((r) => setTimeout(r, 5));
    assert({ given: 'a read past the cool-down', should: 'try again', actual: h.logs.filter((l) => l.startsWith('warn:dev-preview: sprite not attachable')).length, expected: 2 });

    // An explicit trigger means something just happened — it never waits.
    await registry.ensure({ holder: HOLDER });
    await new Promise((r) => setTimeout(r, 5));
    assert({ given: 'an ensure inside the cool-down', should: 'try immediately', actual: h.logs.filter((l) => l.startsWith('warn:dev-preview: sprite not attachable')).length, expected: 3 });
  });

  it('a holder with no live sprite, and a dark feature, report unavailable and arm nothing', async () => {
    const h = deps();
    const registry = createDetectionRegistry(h.deps);
    assert({ given: 'a holder whose row has no sprite', should: 'be unavailable', actual: await registry.read({ holder: { kind: 'env', id: 'gone-holder' } }), expected: { detection: 'unavailable', listeners: null } });
    const dark = deps({ featureEnabled: () => false });
    assert({ given: 'a dark deployment', should: 'be unavailable without even resolving the row', actual: await createDetectionRegistry(dark.deps).read({ holder: HOLDER }), expected: { detection: 'unavailable', listeners: null } });
    expect(h.sockets).toHaveLength(0);
    expect(dark.sockets).toHaveLength(0);
  });

  it('a sprite REBUILT under the same name is re-watched, and only an explicit trigger pays to notice', async () => {
    // A name is reused across re-creates. A watcher armed against the old VM
    // still answers `watchers.has`, and its detector holds a dead instance id —
    // so it would write rows naming a VM that no longer exists while its
    // service calls land on the new one: every render `stale`, the proxy 409,
    // and no recovery short of a process restart.
    let instance = 'inst-old';
    const h = deps({ attach: async () => fakeHandle(instance) });
    const registry = createDetectionRegistry(h.deps);
    await registry.ensure({ holder: HOLDER });
    expect(h.sockets).toHaveLength(1);

    // Same VM: an explicit trigger checks and leaves the watcher alone.
    await registry.ensure({ holder: HOLDER });
    expect(h.sockets).toHaveLength(1);

    // Rebuilt: the explicit trigger notices and re-watches.
    instance = 'inst-new';
    await registry.ensure({ holder: HOLDER });
    expect(h.sockets).toHaveLength(2);
    expect(h.logs.some((l) => l.includes('sprite replaced under the same name'))).toBe(true);

    // The READ path does not pay for the check — it runs on every render, and
    // an attach per render is exactly what the throttle exists to prevent.
    instance = 'inst-newer';
    await registry.read({ holder: HOLDER });
    expect(h.sockets).toHaveLength(2);
  });

  it('two explicit triggers racing a rebuild leave exactly ONE watcher, never an orphan', async () => {
    // The interleaving is SCRIPTED, because the orphan only appears in one
    // order: the second trigger's comparison must resolve AFTER the first has
    // already installed its replacement. Then closing the stale entry by KEY
    // deletes the live replacement — socket open, detector still writing rows,
    // nothing able to reach it — and a second watcher starts beside it.
    let instance = 'inst-old';
    const pending: Array<() => void> = [];
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const h = deps({
      attach: async () => {
        await new Promise<void>((resolve) => pending.push(resolve));
        return fakeHandle(instance);
      },
    });
    const registry = createDetectionRegistry(h.deps);

    const initial = registry.ensure({ holder: HOLDER });
    await flush();
    pending.shift()?.();                     // the first arm's own attach
    await initial;
    expect(h.sockets).toHaveLength(1);

    instance = 'inst-new';
    const t1 = registry.ensure({ holder: HOLDER });
    await flush();                            // t1's comparison attach is queued
    const t2 = registry.ensure({ holder: HOLDER });
    await flush();                            // t2's comparison attach is queued behind it

    pending.shift()?.();                      // t1 compares: mismatch, closes, reserves, attaches again
    await flush();
    const t1Start = pending.pop();            // t1's re-arm attach, queued last
    t1Start?.();
    await t1;
    expect(h.sockets).toHaveLength(2);         // t1's replacement is LIVE

    pending.shift()?.();                      // only now does t2 compare, against a map that moved on
    await t2;
    await flush();
    while (pending.length > 0) pending.shift()?.();
    await flush();

    // Still exactly one replacement. Without the identity guard t2 tears down
    // t1's live watcher and opens a third socket.
    expect(h.sockets).toHaveLength(2);
  });

  it('a failed re-arm leaves the sprite armable by the next explicit trigger', async () => {
    // The property, not the race. When a re-arm's own attach fails the slot is
    // left EMPTY, and the next explicit trigger must arm rather than stand
    // down — for an unattended session nothing else would.
    //
    // NOT COVERED: the concurrent interleaving where a second trigger captured
    // the stale entry BEFORE the slot emptied, and so re-reads `undefined`
    // rather than a stale entry. That is the case the empty-vs-occupied
    // distinction in `armIfMissing` exists for; every attempt to script it
    // deterministically here produced a test that either passed with the fix
    // removed or hung, and a test that cannot fail is worth nothing. The
    // distinction is argued in the code instead.
    let instance = 'inst-old';
    let attaches = 0;
    // 1 = the first arm's own start; 2 = the rebuild comparison; 3 = the
    // re-arm's start, which is the one that fails.
    const h = deps({
      attach: async () => {
        attaches += 1;
        return attaches === 3 ? null : fakeHandle(instance);
      },
    });
    const registry = createDetectionRegistry(h.deps);
    await registry.ensure({ holder: HOLDER });
    expect(h.sockets).toHaveLength(1);

    instance = 'inst-new';
    await registry.ensure({ holder: HOLDER });
    expect(h.sockets).toHaveLength(1);
    expect(h.logs.some((l) => l.includes('not attachable'))).toBe(true);

    await registry.ensure({ holder: HOLDER });
    expect(h.sockets).toHaveLength(2);
  });

  it('a channel that stays up is NOT retired, however many times it is recycled', async () => {
    // The lifetime ceiling exists for a flap. Counting clean recycles too
    // would retire a healthy long-lived watcher, and an unattended session —
    // nobody rendering status, so nothing to re-arm it — would lose detection
    // for the life of the sprite, which is the case detection exists for.
    const h = deps({ maxTotalReconnects: 2 });
    const registry = createDetectionRegistry(h.deps);
    await registry.ensure({ holder: HOLDER });
    for (let i = 0; i < 5 && h.sockets.length > 0; i += 1) {
      const socket = h.sockets[h.sockets.length - 1];
      socket.emit('open');
      clock.now = new Date(clock.now.getTime() + 5 * 60 * 1000);
      socket.emit('close', { code: 1006 });
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(h.logs.some((l) => l.includes('watch channel gone'))).toBe(false);
  });

  it('a SLOW HANDSHAKE is not uptime — the ceiling still retires a channel that never stays up', async () => {
    // `attemptStartedAt` is taken from the socket's own `open` event, not from
    // when the attempt began. Measuring from the attempt would let a handshake
    // that takes longer than the health window count as a healthy connection,
    // clearing the very budget that exists to retire a channel like this.
    const h = deps({ maxTotalReconnects: 2 });
    const registry = createDetectionRegistry(h.deps);
    await registry.ensure({ holder: HOLDER });
    for (let i = 0; i < 5 && h.sockets.length > 0; i += 1) {
      const socket = h.sockets[h.sockets.length - 1];
      // Two minutes of HANDSHAKE, then it opens and dies at once.
      clock.now = new Date(clock.now.getTime() + 2 * 60 * 1000);
      socket.emit('open');
      socket.emit('close', { code: 1006 });
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(h.logs.some((l) => l.includes('watch channel gone'))).toBe(true);
  });

  it('drops a channel that flaps forever, because a status read re-arms it within a poll', async () => {
    // `attempts` resets on any connection that OPENS, so a socket that opens
    // and dies immediately would reconnect for ever — which is not what the
    // budget claims to do.
    const h = deps({ maxTotalReconnects: 3 });
    const registry = createDetectionRegistry(h.deps);
    await registry.ensure({ holder: HOLDER });
    for (let i = 0; i < 6 && h.sockets.length > 0; i += 1) {
      const socket = h.sockets[h.sockets.length - 1];
      socket.emit('open');
      socket.emit('close', { code: 1006 });
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(h.logs.some((l) => l.includes('watch channel gone'))).toBe(true);
  });
});
