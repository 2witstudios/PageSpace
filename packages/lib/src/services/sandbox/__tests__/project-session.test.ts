import { describe, it, expect } from 'vitest';
import { acquireProjectSandbox, type AcquireProjectSandboxDeps } from '../project-session';
import type { MachineRuntimeGuardrailDecision } from '../quota';

const NOW = new Date('2026-07-21T12:00:00.000Z');
const MACHINE_ID = 'machine-1';
const PROJECT_ID = 'project-1';
const PROJECT_SANDBOX_ID = 'sprite-project-1';

function makeFindProject(
  rows: Record<string, { sandboxId: string | null; spriteTornDownAt: Date | null }> = {
    [PROJECT_ID]: { sandboxId: PROJECT_SANDBOX_ID, spriteTornDownAt: null },
  },
): AcquireProjectSandboxDeps['findProject'] {
  return async (id) => rows[id] ?? null;
}

function makeDeps(over: Partial<AcquireProjectSandboxDeps> = {}): AcquireProjectSandboxDeps {
  return {
    authorize: async () => ({ ok: true }),
    now: () => NOW,
    checkMachineRuntimeGuardrail: (): MachineRuntimeGuardrailDecision => ({ allowed: true }),
    recordMachineActivity: () => {},
    findProject: makeFindProject(),
    ...over,
  };
}

const base = { driveId: 'd1', userId: 'u1', machineId: MACHINE_ID, machineProjectId: PROJECT_ID };

describe('acquireProjectSandbox', () => {
  it('given a promoted project, should return ITS sandboxId with no provision call and bill activity to the MACHINE page', async () => {
    const seenGuardrail: Array<{ machineKey: string; now: number }> = [];
    const seenRecord: Array<{ machineKey: string; now: number }> = [];
    const result = await acquireProjectSandbox({
      ...base,
      deps: makeDeps({
        checkMachineRuntimeGuardrail: (input) => {
          seenGuardrail.push(input);
          return { allowed: true };
        },
        recordMachineActivity: (input) => {
          seenRecord.push(input);
        },
      }),
    });
    expect(result).toEqual({ ok: true, sandboxId: PROJECT_SANDBOX_ID });
    // Keyed by the OWNING MACHINE page id, not the project row — the runtime
    // budget and payer are the machine's (phase 3's attribution key).
    expect(seenGuardrail).toEqual([{ machineKey: MACHINE_ID, now: NOW.getTime() }]);
    expect(seenRecord).toEqual([{ machineKey: MACHINE_ID, now: NOW.getTime() }]);
  });

  it('given an authorize denial, should propagate it without reading the project row', async () => {
    const seen: string[] = [];
    const result = await acquireProjectSandbox({
      ...base,
      deps: makeDeps({
        authorize: async () => ({ ok: false, reason: 'insufficient_role' }),
        findProject: async (id) => {
          seen.push(id);
          return null;
        },
      }),
    });
    expect(result).toEqual({ ok: false, reason: 'insufficient_role' });
    expect(seen).toEqual([]);
  });

  it('given a guardrail denial, should return machine_runtime_exceeded without reading the project row', async () => {
    const seen: string[] = [];
    const result = await acquireProjectSandbox({
      ...base,
      deps: makeDeps({
        checkMachineRuntimeGuardrail: () => ({ allowed: false, reason: 'machine_runtime_exceeded' }),
        findProject: async (id) => {
          seen.push(id);
          return null;
        },
      }),
    });
    expect(result).toEqual({ ok: false, reason: 'machine_runtime_exceeded' });
    expect(seen).toEqual([]);
  });

  it('given an UNPROMOTED project row, should fail closed rather than lazily provisioning one', async () => {
    const seenRecord: unknown[] = [];
    const result = await acquireProjectSandbox({
      ...base,
      deps: makeDeps({
        findProject: makeFindProject({ [PROJECT_ID]: { sandboxId: null, spriteTornDownAt: null } }),
        recordMachineActivity: (input) => seenRecord.push(input),
      }),
    });
    expect(result).toEqual({ ok: false, reason: 'project_not_found' });
    expect(seenRecord).toEqual([]);
  });

  it('given a project whose Sprite was torn down between derivation and acquire, should fail closed', async () => {
    const result = await acquireProjectSandbox({
      ...base,
      deps: makeDeps({
        findProject: makeFindProject({ [PROJECT_ID]: { sandboxId: PROJECT_SANDBOX_ID, spriteTornDownAt: NOW } }),
      }),
    });
    expect(result).toEqual({ ok: false, reason: 'project_not_found' });
  });

  it('given a missing project row, should fail closed', async () => {
    const result = await acquireProjectSandbox({ ...base, deps: makeDeps({ findProject: makeFindProject({}) }) });
    expect(result).toEqual({ ok: false, reason: 'project_not_found' });
  });
});
