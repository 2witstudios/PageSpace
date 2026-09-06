import { describe, it, expect, vi } from 'vitest';
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

function fakeHandle(): SandboxHandle {
  return {
    sandboxId: 'sbx',
    spriteInstanceId: 'inst',
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

function deps(over: Partial<DetectionRegistryDeps> = {}) {
  const factory = fakeSocketFactory();
  const logs: string[] = [];
  const waits: number[] = [];
  const upserts: unknown[] = [];
  const d: DetectionRegistryDeps = {
    featureEnabled: () => true,
    resolveHolderSandboxId: async (holder) => (holder.id === 'gone-holder' ? null : `sbx-${holder.id}`),
    attach: async () => fakeHandle(),
    store: { findByHolder: async () => null, upsert: async (intent) => { upserts.push(intent); } },
    createSocket: factory.createSocket,
    spritesToken: () => 'tok',
    spritesApiBaseUrl: () => 'https://api.sprites.dev',
    log: { info: (m) => logs.push(`info:${m}`), warn: (m, c) => logs.push(`warn:${m}:${JSON.stringify(c)}`), error: (m) => logs.push(`error:${m}`) },
    now: () => new Date('2026-09-06T12:00:00Z'),
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
    h.sockets[0].emit('message', { data: JSON.stringify({ type: 'port_opened', port: 5173, pid: 3 }) });
    await new Promise((r) => setTimeout(r, 10));
    expect(h.upserts).toHaveLength(1);
    expect(h.upserts[0]).toMatchObject({ holder: HOLDER, targetPort: 5173, spriteInstanceId: 'inst' });
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
});
