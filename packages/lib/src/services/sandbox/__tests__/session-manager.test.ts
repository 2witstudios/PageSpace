import { describe, it, expect } from 'vitest';
import {
  acquireConversationSandbox,
  teardownConversationSandbox,
  type SandboxClient,
} from '../session-manager';
import type { SandboxSessionStore, SandboxSessionRecord } from '../session-store';
import { deriveSessionKey } from '../session-key';

const SECRET = 'x'.repeat(32);
const NOW = new Date('2026-06-01T12:00:00.000Z');

const namespacing = { tenantId: 't1', driveId: 'd1', conversationId: 'c1' };
const actor = { userId: 'u1', ...namespacing };

function keyFor() {
  return deriveSessionKey({ ...namespacing, secret: SECRET });
}

// In-memory store with call tracking, so tests assert what the orchestrator did
// without touching a database.
function makeStore(seed?: SandboxSessionRecord) {
  const rows = new Map<string, SandboxSessionRecord>();
  if (seed) rows.set(seed.sessionKey, seed);
  const calls = { save: 0, touch: 0, remove: 0 };
  const store: SandboxSessionStore = {
    findBySessionKey: async (sessionKey) => rows.get(sessionKey) ?? null,
    save: async (input) => {
      calls.save += 1;
      rows.set(input.sessionKey, {
        sessionKey: input.sessionKey,
        conversationId: input.conversationId,
        driveId: input.driveId ?? null,
        tenantId: input.tenantId ?? null,
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

function seedRecord(over: Partial<SandboxSessionRecord> = {}): SandboxSessionRecord {
  return {
    sessionKey: keyFor(),
    conversationId: 'c1',
    driveId: 'd1',
    tenantId: 't1',
    userId: 'u1',
    sandboxId: 'sbx-existing',
    lastActiveAt: new Date('2026-06-01T11:59:00.000Z'),
    ...over,
  };
}

describe('acquireConversationSandbox', () => {
  it('given an authorized actor with no session, should create, name by the session key, and persist the link', async () => {
    const { store, calls: storeCalls } = makeStore();
    const { client, calls } = makeClient();
    const result = await acquireConversationSandbox({
      ...actor,
      deps: { store, client, authorize: async () => ({ ok: true }), now: () => NOW, secret: SECRET },
    });
    expect(result).toEqual({ ok: true, sandboxId: 'sbx-new', resumed: false });
    expect(calls.getOrCreate).toEqual([{ name: keyFor() }]);
    expect(storeCalls.save).toBe(1);
  });

  it('given an authorized actor with a fresh session, should resume by reconnecting, not create', async () => {
    const { store, calls: storeCalls } = makeStore(seedRecord());
    const { client, calls } = makeClient();
    const result = await acquireConversationSandbox({
      ...actor,
      deps: { store, client, authorize: async () => ({ ok: true }), now: () => NOW, secret: SECRET },
    });
    expect(result).toEqual({ ok: true, sandboxId: 'sbx-existing', resumed: true });
    expect(calls.get).toEqual(['sbx-existing']);
    expect(calls.getOrCreate).toEqual([]);
    expect(storeCalls.touch).toBe(1);
  });

  it('given an UNAUTHORIZED actor with an existing warm session, should deny and never reconnect (resume re-authz)', async () => {
    const { store, calls: storeCalls } = makeStore(seedRecord());
    const { client, calls } = makeClient();
    const result = await acquireConversationSandbox({
      ...actor,
      deps: {
        store,
        client,
        authorize: async () => ({ ok: false, reason: 'insufficient_role' }),
        now: () => NOW,
        secret: SECRET,
      },
    });
    expect(result).toEqual({ ok: false, reason: 'insufficient_role' });
    // The warm sandbox is never handed back, reconnected, or torn down.
    expect(calls.get).toEqual([]);
    expect(calls.getOrCreate).toEqual([]);
    expect(calls.stop).toEqual([]);
    expect(storeCalls.touch).toBe(0);
    expect(storeCalls.remove).toBe(0);
  });

  it('given an authorized actor whose session is idle-expired, should tear down the stale VM then create fresh', async () => {
    const stale = seedRecord({ lastActiveAt: new Date('2026-06-01T11:00:00.000Z') });
    const { store, calls: storeCalls } = makeStore(stale);
    const { client, calls } = makeClient();
    const result = await acquireConversationSandbox({
      ...actor,
      idleTimeoutMs: 5 * 60 * 1000,
      deps: { store, client, authorize: async () => ({ ok: true }), now: () => NOW, secret: SECRET },
    });
    expect(result).toEqual({ ok: true, sandboxId: 'sbx-new', resumed: false });
    expect(calls.stop).toEqual(['sbx-existing']);
    expect(calls.getOrCreate).toEqual([{ name: keyFor() }]);
    expect(storeCalls.remove).toBe(1);
    expect(storeCalls.save).toBe(1);
  });

  it('given a stored session whose VM has vanished on resume, should drop the stale link and create fresh', async () => {
    const { store, calls: storeCalls } = makeStore(seedRecord());
    const { client, calls } = makeClient({ get: async () => null });
    const result = await acquireConversationSandbox({
      ...actor,
      deps: { store, client, authorize: async () => ({ ok: true }), now: () => NOW, secret: SECRET },
    });
    expect(result).toEqual({ ok: true, sandboxId: 'sbx-new', resumed: false });
    expect(storeCalls.remove).toBe(1);
    expect(calls.getOrCreate).toEqual([{ name: keyFor() }]);
  });

  it('given provisioning that throws, should report failure without persisting a link', async () => {
    const { store, calls: storeCalls } = makeStore();
    const { client } = makeClient({
      getOrCreate: async () => {
        throw new Error('platform down');
      },
    });
    const result = await acquireConversationSandbox({
      ...actor,
      deps: { store, client, authorize: async () => ({ ok: true }), now: () => NOW, secret: SECRET },
    });
    expect(result).toEqual({ ok: false, reason: 'provision_failed' });
    expect(storeCalls.save).toBe(0);
  });

  it('given the link persist failing after create, should tear down the new VM to avoid an orphan', async () => {
    const failingStore = makeStore();
    failingStore.store.save = async () => {
      throw new Error('db down');
    };
    const { client, calls } = makeClient();
    const result = await acquireConversationSandbox({
      ...actor,
      deps: {
        store: failingStore.store,
        client,
        authorize: async () => ({ ok: true }),
        now: () => NOW,
        secret: SECRET,
      },
    });
    expect(result).toEqual({ ok: false, reason: 'provision_failed' });
    expect(calls.stop).toEqual(['sbx-new']);
  });

  it('given the store lookup throwing (DB down), should fail closed and never provision', async () => {
    const { store } = makeStore();
    store.findBySessionKey = async () => {
      throw new Error('db down');
    };
    const { client, calls } = makeClient();
    const result = await acquireConversationSandbox({
      ...actor,
      deps: { store, client, authorize: async () => ({ ok: true }), now: () => NOW, secret: SECRET },
    });
    expect(result).toEqual({ ok: false, reason: 'error' });
    expect(calls.getOrCreate).toEqual([]);
    expect(calls.get).toEqual([]);
  });

  it('given a fresh session whose lastActive touch fails, should still resume (touch is best-effort)', async () => {
    const { store } = makeStore(seedRecord());
    store.touch = async () => {
      throw new Error('write failed');
    };
    const { client } = makeClient();
    const result = await acquireConversationSandbox({
      ...actor,
      deps: { store, client, authorize: async () => ({ ok: true }), now: () => NOW, secret: SECRET },
    });
    expect(result).toEqual({ ok: true, sandboxId: 'sbx-existing', resumed: true });
  });

  it('given an empty session secret, should deny without provisioning (fail closed)', async () => {
    const { store } = makeStore();
    const { client, calls } = makeClient();
    const result = await acquireConversationSandbox({
      ...actor,
      deps: { store, client, authorize: async () => ({ ok: true }), now: () => NOW, secret: '' },
    });
    expect(result.ok).toBe(false);
    expect(calls.getOrCreate).toEqual([]);
  });
});

describe('teardownConversationSandbox', () => {
  it('given an existing session, should stop the VM and remove the link', async () => {
    const { store, calls: storeCalls } = makeStore(seedRecord());
    const { client, calls } = makeClient();
    const result = await teardownConversationSandbox({
      ...namespacing,
      reason: 'session_end',
      deps: { store, client, secret: SECRET },
    });
    expect(result).toEqual({ torn: true });
    expect(calls.stop).toEqual(['sbx-existing']);
    expect(storeCalls.remove).toBe(1);
  });

  it('given no existing session, should be a no-op and not call the client', async () => {
    const { store } = makeStore();
    const { client, calls } = makeClient();
    const result = await teardownConversationSandbox({
      ...namespacing,
      reason: 'idle',
      deps: { store, client, secret: SECRET },
    });
    expect(result).toEqual({ torn: false });
    expect(calls.stop).toEqual([]);
  });

  it('given the store lookup throwing (DB down), should not throw and report not torn', async () => {
    const { store } = makeStore(seedRecord());
    store.findBySessionKey = async () => {
      throw new Error('db down');
    };
    const { client, calls } = makeClient();
    const result = await teardownConversationSandbox({
      ...namespacing,
      reason: 'crash',
      deps: { store, client, secret: SECRET },
    });
    expect(result).toEqual({ torn: false });
    expect(calls.stop).toEqual([]);
  });

  it('given the link removal throwing after a successful stop, should not throw and still report torn', async () => {
    const { store } = makeStore(seedRecord());
    store.remove = async () => {
      throw new Error('db down');
    };
    const { client, calls } = makeClient();
    const result = await teardownConversationSandbox({
      ...namespacing,
      reason: 'failure',
      deps: { store, client, secret: SECRET },
    });
    expect(result).toEqual({ torn: true });
    expect(calls.stop).toEqual(['sbx-existing']);
  });

  it('given an unconfirmed VM stop, should KEEP the link and report not torn (no orphan), without throwing', async () => {
    const { store, calls: storeCalls } = makeStore(seedRecord());
    const { client } = makeClient({
      stop: async () => {
        throw new Error('stop failed');
      },
    });
    const result = await teardownConversationSandbox({
      ...namespacing,
      reason: 'crash',
      deps: { store, client, secret: SECRET },
    });
    // The VM may still be alive — deleting the link would orphan it. Keep the
    // link so a retry or the idle reaper can reclaim it.
    expect(result).toEqual({ torn: false });
    expect(storeCalls.remove).toBe(0);
  });
});
