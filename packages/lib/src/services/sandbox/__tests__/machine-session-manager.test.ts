import { describe, it, expect } from 'vitest';
import {
  deriveMachineSessionKey,
  planMachineLifecycle,
  acquireMachineSession,
  type MachineSessionStore,
  type MachineSessionRecord,
  type SandboxClient,
} from '../machine-session-manager';
import { resolveSandboxNetworkOptions } from '../network-options';
import { assert } from './riteway';

const SECRET = 'x'.repeat(32);
const NOW = new Date('2026-06-01T12:00:00.000Z');

// Default passing full-egress gate (the gate is required; these tests exercise
// non-gate paths). Containment-gate behaviour has its own suite.
const passGate = async (): Promise<{ ok: true }> => ({ ok: true });

const namespacing = { tenantId: 't1', driveId: 'd1', pageId: 'p1' };
const actor = { userId: 'u1', ...namespacing };

function keyFor() {
  return deriveMachineSessionKey({ ...namespacing, secret: SECRET });
}

function makeStore(seed?: MachineSessionRecord) {
  const rows = new Map<string, MachineSessionRecord>();
  if (seed) rows.set(seed.sessionKey, seed);
  const calls = { save: 0, touch: 0, remove: 0 };
  const store: MachineSessionStore = {
    findBySessionKey: async (sessionKey) => rows.get(sessionKey) ?? null,
    save: async (input) => {
      calls.save += 1;
      rows.set(input.sessionKey, {
        sessionKey: input.sessionKey,
        pageId: input.pageId,
        userId: input.userId,
        sandboxId: input.sandboxId,
        spriteInstanceId: input.spriteInstanceId,
        lastActiveAt: input.now,
        egressPolicyToken: input.egressPolicyToken,
      });
    },
    touch: async ({ sessionKey, now, egressPolicyToken }) => {
      calls.touch += 1;
      const row = rows.get(sessionKey);
      if (row) {
        rows.set(sessionKey, {
          ...row,
          lastActiveAt: now,
          egressPolicyToken: egressPolicyToken ?? row.egressPolicyToken,
        });
      }
    },
    remove: async (sessionKey) => {
      calls.remove += 1;
      rows.delete(sessionKey);
    },
    removeIfSandbox: async ({ sessionKey, sandboxId }) => {
      // Mirrors the real store: a row whose sandboxId changed under us now points
      // at a LIVE replacement Sprite — deleting it would orphan that VM.
      const row = rows.get(sessionKey);
      if (!row || row.sandboxId !== sandboxId) return false;
      rows.delete(sessionKey);
      return true;
    },
  };
  return { store, rows, calls };
}

function makeClient(overrides: Partial<SandboxClient> = {}) {
  const calls = {
    getOrCreate: [] as Array<{
      name: string;
      options: import('../sandbox-options').SandboxCreateOptions;
      appliedEgressToken?: string | null;
    }>,
    get: [] as string[],
    stop: [] as string[],
  };
  const client: SandboxClient = {
    getOrCreate: async ({ name, options, appliedEgressToken }) => {
      calls.getOrCreate.push({ name, options, appliedEgressToken });
      // The driver confirms the lockdown and reports the token it proved.
      return { sandboxId: 'sbx-new', egressPolicyToken: TOKEN };
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

function seedRecord(over: Partial<MachineSessionRecord> = {}): MachineSessionRecord {
  return {
    sessionKey: keyFor(),
    pageId: 'p1',
    userId: 'u1',
    sandboxId: 'sbx-existing',
    spriteInstanceId: 'inst-existing',
    lastActiveAt: new Date('2026-06-01T11:59:00.000Z'),
    egressPolicyToken: null,
    ...over,
  };
}

/** A lockdown token as the driver would return it: (sprite instance id, policy hash). */
const TOKEN = 'sprite-abc:policy-hash-1';

describe('deriveMachineSessionKey', () => {
  it('given the same inputs, returns the same key every time', () => {
    const a = deriveMachineSessionKey({ ...namespacing, secret: SECRET });
    const b = deriveMachineSessionKey({ ...namespacing, secret: SECRET });
    expect(a).toBe(b);
  });

  it('given different pageIds (same tenantId+driveId), returns different keys', () => {
    const a = deriveMachineSessionKey({ ...namespacing, pageId: 'p1', secret: SECRET });
    const b = deriveMachineSessionKey({ ...namespacing, pageId: 'p2', secret: SECRET });
    expect(a).not.toBe(b);
  });

  it('given an empty string secret, throws', () => {
    expect(() => deriveMachineSessionKey({ ...namespacing, secret: '' })).toThrow(
      'deriveMachineSessionKey requires a non-empty secret',
    );
  });
});

describe('planMachineLifecycle', () => {
  it('given canRun=false and no session, returns { action: deny }', () => {
    const result = planMachineLifecycle({ canRun: false, now: NOW });
    expect(result).toEqual({ action: 'deny' });
  });

  it('given canRun=false and an existing session, returns { action: deny } (re-authz enforced)', () => {
    const result = planMachineLifecycle({
      canRun: false,
      existingSession: { sandboxId: 'sbx-x', lastActiveAt: NOW },
      now: NOW,
    });
    expect(result).toEqual({ action: 'deny' });
  });

  it('given canRun=true and no session, returns { action: create }', () => {
    const result = planMachineLifecycle({ canRun: true, now: NOW });
    expect(result).toEqual({ action: 'create' });
  });

  it('given canRun=true and a fresh session, returns { action: resume, sandboxId }', () => {
    const result = planMachineLifecycle({
      canRun: true,
      existingSession: { sandboxId: 'sbx-warm', lastActiveAt: new Date(NOW.getTime() - 1000) },
      now: NOW,
    });
    expect(result).toEqual({ action: 'resume', sandboxId: 'sbx-warm' });
  });

  it('given canRun=true and an idle session (lastActiveAt older than idleTimeoutMs), returns { action: noop } (never teardown — Sprites hibernates)', () => {
    const result = planMachineLifecycle({
      canRun: true,
      existingSession: { sandboxId: 'sbx-idle', lastActiveAt: new Date(NOW.getTime() - 20 * 60 * 1000) },
      now: NOW,
    });
    expect(result).toEqual({ action: 'noop' });
  });

  it('given intent=end and an existing session, returns { action: teardown, reason: session_end }', () => {
    const result = planMachineLifecycle({
      canRun: true,
      existingSession: { sandboxId: 'sbx-end', lastActiveAt: NOW },
      now: NOW,
      intent: 'end',
    });
    expect(result).toEqual({ action: 'teardown', sandboxId: 'sbx-end', reason: 'session_end' });
  });

  it('given intent=end and no session, returns { action: noop }', () => {
    const result = planMachineLifecycle({ canRun: true, now: NOW, intent: 'end' });
    expect(result).toEqual({ action: 'noop' });
  });

  it('given an idle session at exactly the idleTimeoutMs boundary, returns { action: noop } (>= is idle)', () => {
    const result = planMachineLifecycle({
      canRun: true,
      existingSession: { sandboxId: 'sbx-idle', lastActiveAt: new Date(NOW.getTime() - 15 * 60 * 1000) },
      now: NOW,
    });
    expect(result).toEqual({ action: 'noop' });
  });

  it('given a custom idleTimeoutMs and a session idle past it, returns { action: noop }', () => {
    const result = planMachineLifecycle({
      canRun: true,
      existingSession: { sandboxId: 'sbx-idle', lastActiveAt: new Date(NOW.getTime() - 5 * 60 * 1000) },
      now: NOW,
      idleTimeoutMs: 60 * 1000,
    });
    expect(result).toEqual({ action: 'noop' });
  });
});

describe('acquireMachineSession', () => {
  it('given empty pageId, returns { ok: false, reason: error }', async () => {
    const { store } = makeStore();
    const { client } = makeClient();
    const result = await acquireMachineSession({
      ...actor,
      canRun: true,
      pageId: '',
      deps: { store, client, now: () => NOW, secret: SECRET, checkFullEgressEnablement: passGate },
    });
    expect(result).toEqual({ ok: false, reason: 'error' });
  });

  it('given empty secret, returns { ok: false, reason: error }', async () => {
    const { store } = makeStore();
    const { client } = makeClient();
    const result = await acquireMachineSession({
      ...actor,
      canRun: true,
      deps: { store, client, now: () => NOW, secret: '', checkFullEgressEnablement: passGate },
    });
    expect(result).toEqual({ ok: false, reason: 'error' });
  });

  it('given no existing session, calls client.getOrCreate and store.save; returns { ok: true, resumed: false }', async () => {
    const { store, calls: storeCalls } = makeStore();
    const { client, calls } = makeClient();
    const result = await acquireMachineSession({
      ...actor,
      canRun: true,
      deps: { store, client, now: () => NOW, secret: SECRET, checkFullEgressEnablement: passGate },
    });
    expect(result).toMatchObject({ ok: true, sandboxId: 'sbx-new', resumed: false });
    if (result.ok) expect(result.sessionKey).toBe(keyFor());
    expect(calls.getOrCreate).toMatchObject([{ name: keyFor() }]);
    expect(storeCalls.save).toBe(1);
  });

  it('given fresh existing session, reconnects via getOrCreate (reapplies egress policy) and returns resumed: true', async () => {
    const { store, calls: storeCalls } = makeStore(seedRecord());
    const { client, calls } = makeClient();
    const result = await acquireMachineSession({
      ...actor,
      canRun: true,
      deps: { store, client, now: () => NOW, secret: SECRET, checkFullEgressEnablement: passGate },
    });
    expect(result).toMatchObject({ ok: true, sandboxId: 'sbx-new', resumed: true });
    if (result.ok) expect(result.sessionKey).toBe(keyFor());
    // getOrCreate is used for reconnects (reapplies policy); get is never called.
    expect(calls.getOrCreate).toMatchObject([{ name: keyFor() }]);
    expect(calls.get).toEqual([]);
    expect(storeCalls.touch).toBe(1);
  });

  it('given existing session with a gone VM, getOrCreate transparently re-provisions under the same key', async () => {
    // In real Sprites: getOrCreate(name) finds the sprite by name; if 404, creates fresh.
    // The sandboxId is always name.slice(0,63), so the store record stays valid.
    const { store, calls: storeCalls } = makeStore(seedRecord());
    const { client, calls } = makeClient();
    const result = await acquireMachineSession({
      ...actor,
      canRun: true,
      deps: { store, client, now: () => NOW, secret: SECRET, checkFullEgressEnablement: passGate },
    });
    // getOrCreate handles the VM-gone case transparently — no explicit remove + re-provision.
    expect(result).toMatchObject({ ok: true, sandboxId: 'sbx-new', resumed: true });
    expect(calls.getOrCreate).toMatchObject([{ name: keyFor() }]);
    expect(storeCalls.remove).toBe(0);
    expect(storeCalls.touch).toBe(1);
  });

  it('given store.save throws after getOrCreate, calls client.stop and returns { ok: false, reason: provision_failed }', async () => {
    const failingStore = makeStore();
    failingStore.store.save = async () => {
      throw new Error('db down');
    };
    const { client, calls } = makeClient();
    const result = await acquireMachineSession({
      ...actor,
      canRun: true,
      deps: { store: failingStore.store, client, now: () => NOW, secret: SECRET, checkFullEgressEnablement: passGate },
    });
    expect(result).toMatchObject({ ok: false, reason: 'provision_failed' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.cause).toBeInstanceOf(Error);
    expect(calls.stop).toEqual(['sbx-new']);
  });

  it('given canRun=false, returns { ok: false, reason: deny } without calling client', async () => {
    const { store } = makeStore(seedRecord());
    const { client, calls } = makeClient();
    const result = await acquireMachineSession({
      ...actor,
      canRun: false,
      deps: { store, client, now: () => NOW, secret: SECRET, checkFullEgressEnablement: passGate },
    });
    expect(result).toMatchObject({ ok: false, reason: 'deny' });
    expect(calls.get).toEqual([]);
    expect(calls.getOrCreate).toEqual([]);
    expect(calls.stop).toEqual([]);
  });

  it('given an idle (hibernated) session, reconnects via getOrCreate (wakes and reapplies policy, never destroys)', async () => {
    // 20 min idle would have tripped the old 15-min destroy timer. With Sprites
    // hibernation + persistent:true, acquire reconnects via getOrCreate which
    // wakes the VM and reapplies the open egress policy in one call.
    const stale = seedRecord({ lastActiveAt: new Date(NOW.getTime() - 20 * 60 * 1000) });
    const { store, calls: storeCalls } = makeStore(stale);
    const { client, calls } = makeClient();
    const result = await acquireMachineSession({
      ...actor,
      canRun: true,
      deps: { store, client, now: () => NOW, secret: SECRET, checkFullEgressEnablement: passGate },
    });
    expect(result).toMatchObject({ ok: true, sandboxId: 'sbx-new', resumed: true });
    expect(calls.getOrCreate).toMatchObject([{ name: keyFor() }]);
    expect(calls.get).toEqual([]);
    expect(calls.stop).toEqual([]);
    expect(storeCalls.touch).toBe(1);
  });

  it('provisions fresh terminal with egressMode: open (not the tight agent allowlist)', async () => {
    const { store } = makeStore();
    const { client, calls } = makeClient();
    const result = await acquireMachineSession({
      ...actor,
      canRun: true,
      deps: { store, client, now: () => NOW, secret: SECRET, checkFullEgressEnablement: passGate },
    });
    expect(result).toMatchObject({ ok: true, sandboxId: 'sbx-new', resumed: false });
    expect(calls.getOrCreate).toHaveLength(1);
    expect(calls.getOrCreate[0].options).toMatchObject({ egressMode: 'open' });
    // The tight SANDBOX_EGRESS_ALLOWLIST must NOT appear on the terminal path.
    expect(calls.getOrCreate[0].options).not.toHaveProperty('egressAllowlist');
    // Sourced from the shared resolver (one network posture for agent + terminal).
    expect(calls.getOrCreate[0].options).toEqual(resolveSandboxNetworkOptions({ surface: 'machine' }));
  });

  it('reconnects also use egressMode: open via getOrCreate (applies policy on every hand-back, not just fresh provisions)', async () => {
    // This covers the migration path: a session created before the egress change
    // still gets the open policy applied on the next reconnect.
    const { store } = makeStore(seedRecord());
    const { client, calls } = makeClient();
    const result = await acquireMachineSession({
      ...actor,
      canRun: true,
      deps: { store, client, now: () => NOW, secret: SECRET, checkFullEgressEnablement: passGate },
    });
    expect(result).toMatchObject({ ok: true, sandboxId: 'sbx-new', resumed: true });
    expect(calls.getOrCreate).toHaveLength(1);
    expect(calls.getOrCreate[0].options).toMatchObject({ egressMode: 'open' });
    expect(calls.get).toEqual([]);
  });

  it('given an idle session whose VM has vanished, getOrCreate transparently recreates it under the same name', async () => {
    // In production: sandboxId = key.slice(0,63), so the store record stays valid
    // after re-creation. The reconnect returns resumed: true because the session
    // record exists (the planner returns noop for persistent sessions, not create).
    const stale = seedRecord({ lastActiveAt: new Date(NOW.getTime() - 20 * 60 * 1000) });
    const { store, calls: storeCalls } = makeStore(stale);
    const { client, calls } = makeClient();
    const result = await acquireMachineSession({
      ...actor,
      canRun: true,
      deps: { store, client, now: () => NOW, secret: SECRET, checkFullEgressEnablement: passGate },
    });
    expect(result).toMatchObject({ ok: true, sandboxId: 'sbx-new', resumed: true });
    expect(calls.getOrCreate).toMatchObject([{ name: keyFor() }]);
    expect(storeCalls.remove).toBe(0);
    expect(storeCalls.touch).toBe(1);
  });
});

describe('acquireMachineSession — egress policy record', () => {
  const acquire = (store: MachineSessionStore, client: SandboxClient) =>
    acquireMachineSession({
      ...actor,
      canRun: true,
      deps: { store, client, now: () => NOW, secret: SECRET, checkFullEgressEnablement: passGate },
    });

  it('records the lockdown token the driver confirmed when provisioning fresh', async () => {
    const { store, rows } = makeStore();
    const { client } = makeClient();
    await acquire(store, client);
    assert({
      given: 'a fresh provision',
      should: 'persist the token the driver proved for THIS VM (not the policy we asked for)',
      actual: rows.get(keyFor())?.egressPolicyToken,
      expected: TOKEN,
    });
  });

  it('records nothing when the driver could not prove the lockdown', async () => {
    const { store, rows } = makeStore();
    // No token: the platform reported no Sprite identity, so the lockdown is
    // unprovable and must not be recorded as proven.
    const { client } = makeClient({ getOrCreate: async () => ({ sandboxId: 'sbx-new' }) });
    await acquire(store, client);
    assert({
      given: 'a driver that returns no lockdown token',
      should: 'record null, so the next hand-back re-applies (fail closed)',
      actual: rows.get(keyFor())?.egressPolicyToken,
      expected: null,
    });
  });

  it('links the session only after the driver confirms the lockdown', async () => {
    const { store, calls: storeCalls } = makeStore();
    const { client } = makeClient({
      getOrCreate: async () => {
        throw new Error('policy api down');
      },
    });
    const result = await acquire(store, client);
    assert({
      given: 'a fresh provision whose lockdown fails',
      should: 'refuse the hand-back and write NO session row (never link an unlocked sandbox)',
      actual: { ok: result.ok, saves: storeCalls.save },
      expected: { ok: false, saves: 0 },
    });
  });

  it('hands the recorded token to the driver on reconnect', async () => {
    const { store } = makeStore(seedRecord({ egressPolicyToken: TOKEN }));
    const { client, calls } = makeClient();
    await acquire(store, client);
    assert({
      given: 'a reconnect to a session whose lockdown is already recorded',
      should: 'pass that token to getOrCreate so a proven policy is not re-applied',
      actual: calls.getOrCreate.map((c) => c.appliedEgressToken),
      expected: [TOKEN],
    });
  });

  it('reports no recorded token for a legacy session', async () => {
    const { store } = makeStore(seedRecord({ egressPolicyToken: null }));
    const { client, calls } = makeClient();
    await acquire(store, client);
    assert({
      given: 'a reconnect to a session that predates the record',
      should: 'pass a null token so the driver fails closed and re-applies',
      actual: calls.getOrCreate.map((c) => c.appliedEgressToken),
      expected: [null],
    });
  });

  it('records the new token when the lockdown moved (new VM, or changed policy)', async () => {
    const { store, rows, calls: storeCalls } = makeStore(seedRecord({ egressPolicyToken: 'sprite-DEAD:policy-hash-1' }));
    const { client } = makeClient();
    await acquire(store, client);
    assert({
      given: 'a reconnect whose recorded token names a replaced VM',
      should: 'record the token the driver just confirmed, so the NEXT hand-back can skip the push',
      actual: { token: rows.get(keyFor())?.egressPolicyToken, touches: storeCalls.touch },
      expected: { token: TOKEN, touches: 1 },
    });
  });
});

describe('acquireMachineSession — full-egress containment gate', () => {
  it('refuses with containment_unverified when the gate denies, never provisioning', async () => {
    const { store } = makeStore();
    const { client, calls } = makeClient();
    const result = await acquireMachineSession({
      ...actor,
      canRun: true,
      deps: {
        store,
        client,
        now: () => NOW,
        secret: SECRET,
        checkFullEgressEnablement: async () => ({ ok: false, reason: 'containment_unverified' }),
      },
    });
    expect(result).toEqual({ ok: false, reason: 'containment_unverified' });
    expect(calls.getOrCreate).toEqual([]);
  });

  it('provisions when the containment gate passes', async () => {
    const { store } = makeStore();
    const { client, calls } = makeClient();
    const result = await acquireMachineSession({
      ...actor,
      canRun: true,
      deps: {
        store,
        client,
        now: () => NOW,
        secret: SECRET,
        checkFullEgressEnablement: async () => ({ ok: true }),
      },
    });
    expect(result).toMatchObject({ ok: true, resumed: false });
    expect(calls.getOrCreate).toHaveLength(1);
  });

  it('on RECONNECT (resume) of an existing session, must STILL gate — getOrCreate can recreate a destroyed VM with open egress', async () => {
    // The reconnect path uses getOrCreate (which re-provisions a vanished VM), so it
    // must be gated too, or a warm/hibernating terminal could mint a fresh
    // open-egress VM after SANDBOX_CONTAINMENT_VERIFIED is turned off.
    const { store } = makeStore(seedRecord());
    const { client, calls } = makeClient();
    const result = await acquireMachineSession({
      ...actor,
      canRun: true,
      deps: {
        store,
        client,
        now: () => NOW,
        secret: SECRET,
        checkFullEgressEnablement: async () => ({ ok: false, reason: 'containment_unverified' }),
      },
    });
    expect(result).toEqual({ ok: false, reason: 'containment_unverified' });
    expect(calls.getOrCreate).toEqual([]);
  });
});
