import { describe, it, expect } from 'vitest';
import {
  acquireMachineSandbox,
  resolveMachinePageId,
  type AcquireMachineSandboxDeps,
} from '../machine-session';
import type { SandboxClient } from '../machine-session-manager';
import type { MachineSessionStore, MachineSessionRecord } from '../machine-session-manager';
import type { MachineRuntimeGuardrailDecision } from '../quota';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const passGate = async (): Promise<{ ok: true }> => ({ ok: true });

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
        lastActiveAt: input.now,
        egressPolicyHash: input.egressPolicyHash,
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
  const calls = { getOrCreate: [] as string[], get: [] as string[], stop: [] as string[] };
  // getOrCreate is idempotent BY NAME in production (Sprites auto-resumes a
  // live/hibernating Sprite addressed by its name) — the fake must model that,
  // or "resume" would look indistinguishable from "always mints a fresh VM".
  const byName = new Map<string, string>();
  let counter = 0;
  const client: SandboxClient = {
    getOrCreate: async ({ name }) => {
      calls.getOrCreate.push(name);
      let sandboxId = byName.get(name);
      if (!sandboxId) {
        counter += 1;
        sandboxId = `sbx-${counter}`;
        byName.set(name, sandboxId);
      }
      return { sandboxId };
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

function makeDeps(over: Partial<AcquireMachineSandboxDeps> = {}): AcquireMachineSandboxDeps {
  const { store } = makeStore();
  const { client } = makeClient();
  return {
    store,
    client,
    authorize: async () => ({ ok: true }),
    now: () => NOW,
    secret: 'x'.repeat(32),
    checkFullEgressEnablement: passGate,
    checkMachineRuntimeGuardrail: (): MachineRuntimeGuardrailDecision => ({ allowed: true }),
    recordMachineActivity: () => {},
    ...over,
  };
}

describe('resolveMachinePageId', () => {
  it('given an "existing" machine, resolves to its machineId regardless of agentPageId', () => {
    expect(
      resolveMachinePageId({ agentPageId: 'agent-1', activeMachine: { kind: 'existing', machineId: 't1' } }),
    ).toBe('t1');
  });

  it('given an "own" machine, resolves to the agent\'s own page id', () => {
    expect(resolveMachinePageId({ agentPageId: 'agent-1', activeMachine: { kind: 'own' } })).toBe('agent-1');
  });

  it('given no activeMachine (undefined = default), resolves to the agent\'s own page id', () => {
    expect(resolveMachinePageId({ agentPageId: 'agent-1' })).toBe('agent-1');
  });

  it('given an "own" machine with no agentPageId (e.g. global assistant), resolves to undefined', () => {
    expect(resolveMachinePageId({ activeMachine: { kind: 'own' } })).toBeUndefined();
  });
});

describe('acquireMachineSandbox', () => {
  const base = { tenantId: 't1', driveId: 'd1', userId: 'u1', agentPageId: 'agent-1' };

  it('given an "own" machine on first use, should lazily provision a fresh persistent sandbox keyed by the agent\'s own page', async () => {
    const { store, calls: storeCalls } = makeStore();
    const { client, calls } = makeClient();
    const result = await acquireMachineSandbox({
      ...base,
      activeMachine: { kind: 'own' },
      deps: makeDeps({ store, client }),
    });
    expect(result).toEqual({ ok: true, sandboxId: 'sbx-1', resumed: false, pageId: 'agent-1' });
    expect(storeCalls.save).toBe(1);
    expect(calls.getOrCreate).toHaveLength(1);
  });

  it('given a SECOND call for the SAME own machine, should resume the SAME sandboxId (cross-run filesystem persistence)', async () => {
    const { store } = makeStore();
    const { client } = makeClient();
    const deps = makeDeps({ store, client });

    const first = await acquireMachineSandbox({ ...base, activeMachine: { kind: 'own' }, deps });
    const second = await acquireMachineSandbox({ ...base, activeMachine: { kind: 'own' }, deps });

    expect(first.ok).toBe(true);
    expect(second).toEqual({
      ok: true,
      sandboxId: first.ok ? first.sandboxId : undefined,
      resumed: true,
      pageId: 'agent-1',
    });
  });

  it('given an "existing" machine, should key the persistent session by the Terminal page id, not the agent\'s own page', async () => {
    const { store, calls: storeCalls } = makeStore();
    const { client } = makeClient();
    const result = await acquireMachineSandbox({
      ...base,
      activeMachine: { kind: 'existing', machineId: 'terminal-page-1' },
      deps: makeDeps({ store, client }),
    });
    expect(result).toEqual({ ok: true, sandboxId: 'sbx-1', resumed: false, pageId: 'terminal-page-1' });
    expect(storeCalls.save).toBe(1);

    // A DIFFERENT agentPageId sharing the same "existing" terminal reconnects to
    // the SAME persistent session — the machine is addressed by the Terminal
    // page, not by whichever agent is currently driving it.
    const second = await acquireMachineSandbox({
      tenantId: 't1',
      driveId: 'd1',
      userId: 'u1',
      agentPageId: 'a-different-agent',
      activeMachine: { kind: 'existing', machineId: 'terminal-page-1' },
      deps: makeDeps({ store, client }),
    });
    expect(second).toEqual({ ok: true, sandboxId: 'sbx-1', resumed: true, pageId: 'terminal-page-1' });
  });

  it('given no activeMachine set (undefined), should default to the "own" machine', async () => {
    const { store } = makeStore();
    const { client, calls } = makeClient();
    const result = await acquireMachineSandbox({ ...base, deps: makeDeps({ store, client }) });
    expect(result).toEqual({ ok: true, sandboxId: 'sbx-1', resumed: false, pageId: 'agent-1' });
    expect(calls.getOrCreate).toHaveLength(1);
  });

  it('given an "own" machine with no agentPageId (global assistant, no backing page yet), should deny no_machine without provisioning', async () => {
    const { client, calls } = makeClient();
    const result = await acquireMachineSandbox({
      tenantId: 't1',
      driveId: 'd1',
      userId: 'u1',
      activeMachine: { kind: 'own' },
      deps: makeDeps({ client }),
    });
    expect(result).toEqual({ ok: false, reason: 'no_machine' });
    expect(calls.getOrCreate).toEqual([]);
  });

  it('given no driveId, should deny no_machine without provisioning', async () => {
    const { client, calls } = makeClient();
    const result = await acquireMachineSandbox({
      tenantId: 't1',
      userId: 'u1',
      agentPageId: 'agent-1',
      deps: makeDeps({ client }),
    });
    expect(result).toEqual({ ok: false, reason: 'no_machine' });
    expect(calls.getOrCreate).toEqual([]);
  });

  it('given an UNAUTHORIZED actor, should deny with the authorize reason and never provision (re-authz on every call)', async () => {
    const { client, calls } = makeClient();
    const result = await acquireMachineSandbox({
      ...base,
      activeMachine: { kind: 'own' },
      deps: makeDeps({ client, authorize: async () => ({ ok: false, reason: 'insufficient_role' }) }),
    });
    expect(result).toEqual({ ok: false, reason: 'insufficient_role' });
    expect(calls.getOrCreate).toEqual([]);
  });

  it('given the full-egress containment gate refuses, should deny and never provision', async () => {
    const { client, calls } = makeClient();
    const result = await acquireMachineSandbox({
      ...base,
      activeMachine: { kind: 'own' },
      deps: makeDeps({ client, checkFullEgressEnablement: async () => ({ ok: false, reason: 'containment_unverified' }) }),
    });
    expect(result).toEqual({ ok: false, reason: 'containment_unverified' });
    expect(calls.getOrCreate).toEqual([]);
  });

  it('given provisioning that fails, should surface provision_failed', async () => {
    const cause = new Error('platform down');
    const { client } = makeClient({
      getOrCreate: async () => {
        throw cause;
      },
    });
    const result = await acquireMachineSandbox({
      ...base,
      activeMachine: { kind: 'own' },
      deps: makeDeps({ client }),
    });
    expect(result).toEqual({ ok: false, reason: 'provision_failed', cause });
  });

  it('given the machine runtime guardrail refuses, should deny machine_runtime_exceeded and never provision', async () => {
    const { client, calls } = makeClient();
    const result = await acquireMachineSandbox({
      ...base,
      activeMachine: { kind: 'own' },
      deps: makeDeps({
        client,
        checkMachineRuntimeGuardrail: () => ({ allowed: false, reason: 'machine_runtime_exceeded' }),
      }),
    });
    expect(result).toEqual({ ok: false, reason: 'machine_runtime_exceeded' });
    expect(calls.getOrCreate).toEqual([]);
  });

  it('given the runtime guardrail refuses for an UNAUTHORIZED actor, should surface the authz denial first', async () => {
    const { client, calls } = makeClient();
    const result = await acquireMachineSandbox({
      ...base,
      activeMachine: { kind: 'own' },
      deps: makeDeps({
        client,
        authorize: async () => ({ ok: false, reason: 'insufficient_role' }),
        checkMachineRuntimeGuardrail: () => ({ allowed: false, reason: 'machine_runtime_exceeded' }),
      }),
    });
    expect(result).toEqual({ ok: false, reason: 'insufficient_role' });
    expect(calls.getOrCreate).toEqual([]);
  });

  it('given a successful acquisition, should key the guardrail by the resolved machine pageId and record activity after provisioning', async () => {
    const seenCheck: Array<{ machineKey: string; now: number }> = [];
    const seenRecord: Array<{ machineKey: string; now: number }> = [];
    const result = await acquireMachineSandbox({
      ...base,
      activeMachine: { kind: 'existing', machineId: 'terminal-page-1' },
      deps: makeDeps({
        checkMachineRuntimeGuardrail: (input) => {
          seenCheck.push(input);
          return { allowed: true };
        },
        recordMachineActivity: (input) => {
          seenRecord.push(input);
        },
      }),
    });
    expect(result.ok).toBe(true);
    expect(seenCheck).toEqual([{ machineKey: 'terminal-page-1', now: NOW.getTime() }]);
    expect(seenRecord).toEqual([{ machineKey: 'terminal-page-1', now: NOW.getTime() }]);
  });

  it('given the runtime guardrail refuses, should never record activity', async () => {
    const seenRecord: unknown[] = [];
    const result = await acquireMachineSandbox({
      ...base,
      activeMachine: { kind: 'own' },
      deps: makeDeps({
        checkMachineRuntimeGuardrail: () => ({ allowed: false, reason: 'machine_runtime_exceeded' }),
        recordMachineActivity: (input) => seenRecord.push(input),
      }),
    });
    expect(result).toEqual({ ok: false, reason: 'machine_runtime_exceeded' });
    expect(seenRecord).toEqual([]);
  });
});
