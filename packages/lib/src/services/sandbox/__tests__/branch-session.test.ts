import { describe, it, expect } from 'vitest';
import { acquireBranchSandbox, type AcquireBranchSandboxDeps } from '../branch-session';
import type { MachineRuntimeGuardrailDecision } from '../quota';

const NOW = new Date('2026-07-20T12:00:00.000Z');
const MACHINE_ID = 'machine-1';
const BRANCH_ID = 'branch-1';
const BRANCH_SANDBOX_ID = 'sprite-branch-1';

function makeFindBranch(
  rows: Record<string, { sandboxId: string; spriteTornDownAt: Date | null }> = {
    [BRANCH_ID]: { sandboxId: BRANCH_SANDBOX_ID, spriteTornDownAt: null },
  },
): AcquireBranchSandboxDeps['findBranch'] {
  return async (id) => rows[id] ?? null;
}

function makeDeps(over: Partial<AcquireBranchSandboxDeps> = {}): AcquireBranchSandboxDeps {
  return {
    authorize: async () => ({ ok: true }),
    now: () => NOW,
    checkMachineRuntimeGuardrail: (): MachineRuntimeGuardrailDecision => ({ allowed: true }),
    recordMachineActivity: () => {},
    findBranch: makeFindBranch(),
    ...over,
  };
}

const base = { driveId: 'd1', userId: 'u1', machineId: MACHINE_ID, machineBranchId: BRANCH_ID };

describe('acquireBranchSandbox', () => {
  it('given an authorize denial, should propagate the denial reason without checking the branch', async () => {
    const seenFindBranch: string[] = [];
    const result = await acquireBranchSandbox({
      ...base,
      deps: makeDeps({
        authorize: async () => ({ ok: false, reason: 'insufficient_role' }),
        findBranch: async (id) => {
          seenFindBranch.push(id);
          return null;
        },
      }),
    });
    expect(result).toEqual({ ok: false, reason: 'insufficient_role' });
    expect(seenFindBranch).toEqual([]);
  });

  it('given a guardrail denial, should return machine_runtime_exceeded without checking the branch', async () => {
    const seenFindBranch: string[] = [];
    const result = await acquireBranchSandbox({
      ...base,
      deps: makeDeps({
        checkMachineRuntimeGuardrail: () => ({ allowed: false, reason: 'machine_runtime_exceeded' }),
        findBranch: async (id) => {
          seenFindBranch.push(id);
          return null;
        },
      }),
    });
    expect(result).toEqual({ ok: false, reason: 'machine_runtime_exceeded' });
    expect(seenFindBranch).toEqual([]);
  });

  it('given a guardrail denial for an UNAUTHORIZED actor, should surface the authz denial first', async () => {
    const result = await acquireBranchSandbox({
      ...base,
      deps: makeDeps({
        authorize: async () => ({ ok: false, reason: 'insufficient_role' }),
        checkMachineRuntimeGuardrail: () => ({ allowed: false, reason: 'machine_runtime_exceeded' }),
      }),
    });
    expect(result).toEqual({ ok: false, reason: 'insufficient_role' });
  });

  it('given the happy path, should return the branch row\'s sandboxId with no provision call and record activity keyed to the machine page', async () => {
    const seenGuardrail: Array<{ machineKey: string; now: number }> = [];
    const seenRecord: Array<{ machineKey: string; now: number }> = [];
    const result = await acquireBranchSandbox({
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
    expect(result).toEqual({ ok: true, sandboxId: BRANCH_SANDBOX_ID, pageId: MACHINE_ID });
    // Keyed by the MACHINE page id, not the branch id — mirrors acquireMachineSandbox.
    expect(seenGuardrail).toEqual([{ machineKey: MACHINE_ID, now: NOW.getTime() }]);
    expect(seenRecord).toEqual([{ machineKey: MACHINE_ID, now: NOW.getTime() }]);
  });

  it('given a destroyed branch (spriteTornDownAt set), should fail closed and never record activity', async () => {
    const seenRecord: unknown[] = [];
    const result = await acquireBranchSandbox({
      ...base,
      deps: makeDeps({
        findBranch: makeFindBranch({ [BRANCH_ID]: { sandboxId: BRANCH_SANDBOX_ID, spriteTornDownAt: NOW } }),
        recordMachineActivity: (input) => seenRecord.push(input),
      }),
    });
    expect(result).toEqual({ ok: false, reason: 'branch_not_found' });
    expect(seenRecord).toEqual([]);
  });

  it('given a missing branch row, should fail closed and never record activity', async () => {
    const seenRecord: unknown[] = [];
    const result = await acquireBranchSandbox({
      ...base,
      deps: makeDeps({
        findBranch: makeFindBranch({}),
        recordMachineActivity: (input) => seenRecord.push(input),
      }),
    });
    expect(result).toEqual({ ok: false, reason: 'branch_not_found' });
    expect(seenRecord).toEqual([]);
  });
});
