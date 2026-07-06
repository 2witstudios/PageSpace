import { describe, it, expect } from 'vitest';
import {
  deriveMachineSessionKey,
  acquireMachineSandbox,
  type MachineSessionStore,
  type MachineSessionRecord,
} from '../machine-session-manager';
import type { SandboxClient } from '../../sandbox/session-manager';
import { resolveSandboxNetworkOptions } from '../../sandbox/network-options';

const SECRET = 'x'.repeat(32);
const NOW = new Date('2026-06-01T12:00:00.000Z');

const passGate = async (): Promise<{ ok: true }> => ({ ok: true });

const namespacing = { tenantId: 't1', machineKey: 'own:u1' };
const actor = { ownerId: 'u1', ...namespacing };

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
        ownerId: input.ownerId,
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
    getOrCreate: [] as Array<{ name: string; options: import('../../sandbox/sandbox-options').SandboxCreateOptions }>,
    get: [] as string[],
    stop: [] as string[],
  };
  const client: SandboxClient = {
    getOrCreate: async ({ name, options }) => {
      calls.getOrCreate.push({ name, options });
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

function seedRecord(over: Partial<MachineSessionRecord> = {}): MachineSessionRecord {
  return {
    sessionKey: keyFor(),
    ownerId: 'u1',
    sandboxId: 'sbx-existing',
    lastActiveAt: new Date('2026-06-01T11:59:00.000Z'),
    ...over,
  };
}

describe('deriveMachineSessionKey', () => {
  it('given the same inputs, returns the same key every time', () => {
    expect(deriveMachineSessionKey({ ...namespacing, secret: SECRET })).toBe(
      deriveMachineSessionKey({ ...namespacing, secret: SECRET }),
    );
  });

  it('given different machineKeys, returns different keys', () => {
    const a = deriveMachineSessionKey({ ...namespacing, machineKey: 'own:u1', secret: SECRET });
    const b = deriveMachineSessionKey({ ...namespacing, machineKey: 'own:u2', secret: SECRET });
    expect(a).not.toBe(b);
  });

  it('given an empty string secret, throws', () => {
    expect(() => deriveMachineSessionKey({ ...namespacing, secret: '' })).toThrow(
      'deriveMachineSessionKey requires a non-empty secret',
    );
  });
});

describe('acquireMachineSandbox', () => {
  it('given empty machineKey, returns { ok: false, reason: error }', async () => {
    const { store } = makeStore();
    const { client } = makeClient();
    const result = await acquireMachineSandbox({
      ...actor,
      machineKey: '',
      canRun: true,
      deps: { store, client, now: () => NOW, secret: SECRET, checkFullEgressEnablement: passGate },
    });
    expect(result).toEqual({ ok: false, reason: 'error' });
  });

  it('given no existing session, calls client.getOrCreate and store.save; returns { ok: true, resumed: false }', async () => {
    const { store, calls: storeCalls } = makeStore();
    const { client, calls } = makeClient();
    const result = await acquireMachineSandbox({
      ...actor,
      canRun: true,
      deps: { store, client, now: () => NOW, secret: SECRET, checkFullEgressEnablement: passGate },
    });
    expect(result).toMatchObject({ ok: true, sandboxId: 'sbx-new', resumed: false });
    if (result.ok) expect(result.sessionKey).toBe(keyFor());
    expect(calls.getOrCreate).toMatchObject([{ name: keyFor() }]);
    expect(storeCalls.save).toBe(1);
  });

  it('given an idle (hibernated) machine session, reconnects via getOrCreate (wakes, never destroys the filesystem)', async () => {
    const stale = seedRecord({ lastActiveAt: new Date(NOW.getTime() - 20 * 60 * 1000) });
    const { store, calls: storeCalls } = makeStore(stale);
    const { client, calls } = makeClient();
    const result = await acquireMachineSandbox({
      ...actor,
      canRun: true,
      deps: { store, client, now: () => NOW, secret: SECRET, checkFullEgressEnablement: passGate },
    });
    expect(result).toMatchObject({ ok: true, sandboxId: 'sbx-new', resumed: true });
    expect(calls.getOrCreate).toMatchObject([{ name: keyFor() }]);
    expect(calls.stop).toEqual([]);
    expect(storeCalls.touch).toBe(1);
  });

  it('given canRun=false, returns { ok: false, reason: deny } without calling the client', async () => {
    const { store } = makeStore(seedRecord());
    const { client, calls } = makeClient();
    const result = await acquireMachineSandbox({
      ...actor,
      canRun: false,
      deps: { store, client, now: () => NOW, secret: SECRET, checkFullEgressEnablement: passGate },
    });
    expect(result).toMatchObject({ ok: false, reason: 'deny' });
    expect(calls.getOrCreate).toEqual([]);
  });

  it('given store.save throws after getOrCreate, calls client.stop and returns { ok: false, reason: provision_failed }', async () => {
    const failingStore = makeStore();
    failingStore.store.save = async () => {
      throw new Error('db down');
    };
    const { client, calls } = makeClient();
    const result = await acquireMachineSandbox({
      ...actor,
      canRun: true,
      deps: { store: failingStore.store, client, now: () => NOW, secret: SECRET, checkFullEgressEnablement: passGate },
    });
    expect(result).toMatchObject({ ok: false, reason: 'provision_failed' });
    expect(calls.stop).toEqual(['sbx-new']);
  });

  it('provisions with egressMode: open, sourced from the shared terminal-surface resolver', async () => {
    const { store } = makeStore();
    const { client, calls } = makeClient();
    const result = await acquireMachineSandbox({
      ...actor,
      canRun: true,
      deps: { store, client, now: () => NOW, secret: SECRET, checkFullEgressEnablement: passGate },
    });
    expect(result).toMatchObject({ ok: true });
    expect(calls.getOrCreate[0].options).toEqual(resolveSandboxNetworkOptions({ surface: 'terminal' }));
  });

  it('refuses with containment_unverified when the full-egress gate denies, never provisioning', async () => {
    const { store } = makeStore();
    const { client, calls } = makeClient();
    const result = await acquireMachineSandbox({
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

  it('two different owners never resolve to the same session (own machines are per-owner)', async () => {
    const { store } = makeStore();
    const { client, calls } = makeClient();
    await acquireMachineSandbox({
      ownerId: 'u1',
      tenantId: 't1',
      machineKey: 'own:u1',
      canRun: true,
      deps: { store, client, now: () => NOW, secret: SECRET, checkFullEgressEnablement: passGate },
    });
    await acquireMachineSandbox({
      ownerId: 'u2',
      tenantId: 't1',
      machineKey: 'own:u2',
      canRun: true,
      deps: { store, client, now: () => NOW, secret: SECRET, checkFullEgressEnablement: passGate },
    });
    expect(calls.getOrCreate).toHaveLength(2);
    expect(calls.getOrCreate[0].name).not.toBe(calls.getOrCreate[1].name);
  });
});
