import { describe, it, expect } from 'vitest';
import {
  deriveTerminalSessionKey,
  planTerminalLifecycle,
  acquireTerminalSandbox,
  type TerminalSessionStore,
  type TerminalSessionRecord,
} from '../terminal-session-manager';
import type { SandboxClient } from '../session-manager';

const SECRET = 'x'.repeat(32);
const NOW = new Date('2026-06-01T12:00:00.000Z');

const namespacing = { tenantId: 't1', driveId: 'd1', pageId: 'p1' };
const actor = { userId: 'u1', ...namespacing };

function keyFor() {
  return deriveTerminalSessionKey({ ...namespacing, secret: SECRET });
}

function makeStore(seed?: TerminalSessionRecord) {
  const rows = new Map<string, TerminalSessionRecord>();
  if (seed) rows.set(seed.sessionKey, seed);
  const calls = { save: 0, touch: 0, remove: 0 };
  const store: TerminalSessionStore = {
    findBySessionKey: async (sessionKey) => rows.get(sessionKey) ?? null,
    save: async (input) => {
      calls.save += 1;
      rows.set(input.sessionKey, {
        sessionKey: input.sessionKey,
        pageId: input.pageId,
        userId: input.userId,
        sandboxId: input.sandboxId,
        lastActiveAt: input.now,
      });
    },
    touch: async ({ sessionKey, now }) => {
      calls.touch += 1;
      const row = rows.get(sessionKey);
      if (row) rows.set(sessionKey, { ...row, lastActiveAt: now });
    },
    remove: async (sessionKey) => {
      calls.remove += 1;
      rows.delete(sessionKey);
    },
  };
  return { store, rows, calls };
}

function makeClient(overrides: Partial<SandboxClient> = {}) {
  const calls = {
    getOrCreate: [] as Array<{ name: string }>,
    get: [] as string[],
    stop: [] as string[],
  };
  const client: SandboxClient = {
    getOrCreate: async ({ name }) => {
      calls.getOrCreate.push({ name });
      return { sandboxId: 'sbx-new' };
    },
    get: async ({ sandboxId }) => {
      calls.get.push(sandboxId);
      return { sandboxId };
    },
    stop: async ({ sandboxId }) => {
      calls.stop.push(sandboxId);
    },
    ...overrides,
  };
  return { client, calls };
}

function seedRecord(over: Partial<TerminalSessionRecord> = {}): TerminalSessionRecord {
  return {
    sessionKey: keyFor(),
    pageId: 'p1',
    userId: 'u1',
    sandboxId: 'sbx-existing',
    lastActiveAt: new Date('2026-06-01T11:59:00.000Z'),
    ...over,
  };
}

describe('deriveTerminalSessionKey', () => {
  it('given the same inputs, returns the same key every time', () => {
    const a = deriveTerminalSessionKey({ ...namespacing, secret: SECRET });
    const b = deriveTerminalSessionKey({ ...namespacing, secret: SECRET });
    expect(a).toBe(b);
  });

  it('given different pageIds (same tenantId+driveId), returns different keys', () => {
    const a = deriveTerminalSessionKey({ ...namespacing, pageId: 'p1', secret: SECRET });
    const b = deriveTerminalSessionKey({ ...namespacing, pageId: 'p2', secret: SECRET });
    expect(a).not.toBe(b);
  });

  it('given an empty string secret, throws', () => {
    expect(() => deriveTerminalSessionKey({ ...namespacing, secret: '' })).toThrow(
      'deriveTerminalSessionKey requires a non-empty secret',
    );
  });
});

describe('planTerminalLifecycle', () => {
  it('given canRun=false and no session, returns { action: deny }', () => {
    const result = planTerminalLifecycle({ canRun: false, now: NOW });
    expect(result).toEqual({ action: 'deny' });
  });

  it('given canRun=false and an existing session, returns { action: deny } (re-authz enforced)', () => {
    const result = planTerminalLifecycle({
      canRun: false,
      existingSession: { sandboxId: 'sbx-x', lastActiveAt: NOW },
      now: NOW,
    });
    expect(result).toEqual({ action: 'deny' });
  });

  it('given canRun=true and no session, returns { action: create }', () => {
    const result = planTerminalLifecycle({ canRun: true, now: NOW });
    expect(result).toEqual({ action: 'create' });
  });

  it('given canRun=true and a fresh session, returns { action: resume, sandboxId }', () => {
    const result = planTerminalLifecycle({
      canRun: true,
      existingSession: { sandboxId: 'sbx-warm', lastActiveAt: new Date(NOW.getTime() - 1000) },
      now: NOW,
    });
    expect(result).toEqual({ action: 'resume', sandboxId: 'sbx-warm' });
  });

  it('given canRun=true and an idle session (lastActiveAt older than idleTimeoutMs), returns { action: teardown, reason: idle }', () => {
    const result = planTerminalLifecycle({
      canRun: true,
      existingSession: { sandboxId: 'sbx-idle', lastActiveAt: new Date(NOW.getTime() - 20 * 60 * 1000) },
      now: NOW,
    });
    expect(result).toEqual({ action: 'teardown', sandboxId: 'sbx-idle', reason: 'idle' });
  });

  it('given intent=end and an existing session, returns { action: teardown, reason: session_end }', () => {
    const result = planTerminalLifecycle({
      canRun: true,
      existingSession: { sandboxId: 'sbx-end', lastActiveAt: NOW },
      now: NOW,
      intent: 'end',
    });
    expect(result).toEqual({ action: 'teardown', sandboxId: 'sbx-end', reason: 'session_end' });
  });

  it('given intent=end and no session, returns { action: noop }', () => {
    const result = planTerminalLifecycle({ canRun: true, now: NOW, intent: 'end' });
    expect(result).toEqual({ action: 'noop' });
  });
});

describe('acquireTerminalSandbox', () => {
  it('given empty pageId, returns { ok: false, reason: error }', async () => {
    const { store } = makeStore();
    const { client } = makeClient();
    const result = await acquireTerminalSandbox({
      ...actor,
      canRun: true,
      pageId: '',
      deps: { store, client, now: () => NOW, secret: SECRET },
    });
    expect(result).toEqual({ ok: false, reason: 'error' });
  });

  it('given empty secret, returns { ok: false, reason: error }', async () => {
    const { store } = makeStore();
    const { client } = makeClient();
    const result = await acquireTerminalSandbox({
      ...actor,
      canRun: true,
      deps: { store, client, now: () => NOW, secret: '' },
    });
    expect(result).toEqual({ ok: false, reason: 'error' });
  });

  it('given no existing session, calls client.getOrCreate and store.save; returns { ok: true, resumed: false }', async () => {
    const { store, calls: storeCalls } = makeStore();
    const { client, calls } = makeClient();
    const result = await acquireTerminalSandbox({
      ...actor,
      canRun: true,
      deps: { store, client, now: () => NOW, secret: SECRET },
    });
    expect(result).toEqual({ ok: true, sandboxId: 'sbx-new', resumed: false });
    expect(calls.getOrCreate).toEqual([{ name: keyFor() }]);
    expect(storeCalls.save).toBe(1);
  });

  it('given fresh existing session and client.get returns a handle, returns { ok: true, resumed: true } without calling getOrCreate', async () => {
    const { store, calls: storeCalls } = makeStore(seedRecord());
    const { client, calls } = makeClient();
    const result = await acquireTerminalSandbox({
      ...actor,
      canRun: true,
      deps: { store, client, now: () => NOW, secret: SECRET },
    });
    expect(result).toEqual({ ok: true, sandboxId: 'sbx-existing', resumed: true });
    expect(calls.get).toEqual(['sbx-existing']);
    expect(calls.getOrCreate).toEqual([]);
    expect(storeCalls.touch).toBe(1);
  });

  it('given existing session but client.get returns null (VM gone), provisions fresh (calls getOrCreate)', async () => {
    const { store, calls: storeCalls } = makeStore(seedRecord());
    const { client, calls } = makeClient({ get: async () => null });
    const result = await acquireTerminalSandbox({
      ...actor,
      canRun: true,
      deps: { store, client, now: () => NOW, secret: SECRET },
    });
    expect(result).toEqual({ ok: true, sandboxId: 'sbx-new', resumed: false });
    expect(storeCalls.remove).toBe(1);
    expect(calls.getOrCreate).toEqual([{ name: keyFor() }]);
  });

  it('given store.save throws after getOrCreate, calls client.stop and returns { ok: false, reason: provision_failed }', async () => {
    const failingStore = makeStore();
    failingStore.store.save = async () => {
      throw new Error('db down');
    };
    const { client, calls } = makeClient();
    const result = await acquireTerminalSandbox({
      ...actor,
      canRun: true,
      deps: { store: failingStore.store, client, now: () => NOW, secret: SECRET },
    });
    expect(result).toEqual({ ok: false, reason: 'provision_failed' });
    expect(calls.stop).toEqual(['sbx-new']);
  });

  it('given canRun=false, returns { ok: false, reason: deny } without calling client', async () => {
    const { store } = makeStore(seedRecord());
    const { client, calls } = makeClient();
    const result = await acquireTerminalSandbox({
      ...actor,
      canRun: false,
      deps: { store, client, now: () => NOW, secret: SECRET },
    });
    expect(result).toEqual({ ok: false, reason: 'deny' });
    expect(calls.get).toEqual([]);
    expect(calls.getOrCreate).toEqual([]);
    expect(calls.stop).toEqual([]);
  });

  it('given teardown plan and safeStop fails, keeps the session link and returns { ok: false, reason: error }', async () => {
    // lastActiveAt 20 min ago triggers idle teardown (default timeout = 15 min)
    const stale = seedRecord({ lastActiveAt: new Date(NOW.getTime() - 20 * 60 * 1000) });
    const { store, calls: storeCalls } = makeStore(stale);
    const { client } = makeClient({
      stop: async () => {
        throw new Error('stop failed');
      },
    });
    const result = await acquireTerminalSandbox({
      ...actor,
      canRun: true,
      deps: { store, client, now: () => NOW, secret: SECRET },
    });
    expect(result).toEqual({ ok: false, reason: 'error' });
    expect(storeCalls.remove).toBe(0);
  });
});
