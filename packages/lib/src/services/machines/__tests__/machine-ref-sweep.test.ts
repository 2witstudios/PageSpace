import { describe, it, expect, vi } from 'vitest';
import {
  collectReferencedMachineIds,
  planMachineRefRewrite,
  sweepMachineRefs,
  type MachineRefHolder,
  type SweepMachineRefsDeps,
} from '../machine-ref-sweep';

const DEAD = 'machine-gone';
const LIVE = 'machine-live';

function agent(overrides: Partial<MachineRefHolder & { pageId: string }> = {}) {
  return {
    pageId: 'agent-1',
    entries: [{ kind: 'existing', machineId: DEAD }] as unknown[],
    machineAccess: true,
    ...overrides,
  };
}

function global_(overrides: Partial<MachineRefHolder & { userId: string }> = {}) {
  return {
    userId: 'user-1',
    entries: [{ kind: 'existing', machineId: DEAD }] as unknown[],
    machineAccess: true,
    ...overrides,
  };
}

type Agent = ReturnType<typeof agent>;
type Global = ReturnType<typeof global_>;

function makeDeps(
  overrides: Partial<SweepMachineRefsDeps<Agent, Global>> = {},
): SweepMachineRefsDeps<Agent, Global> {
  return {
    listAgentConfigs: vi.fn().mockResolvedValue([agent()]),
    listGlobalConfigs: vi.fn().mockResolvedValue([global_()]),
    // Only LIVE still has a page row; DEAD was hard-deleted.
    findExistingPageIds: vi.fn().mockImplementation(async (ids: readonly string[]) =>
      ids.filter((id) => id !== DEAD),
    ),
    writeAgentConfig: vi.fn().mockResolvedValue(true),
    writeGlobalConfig: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe('collectReferencedMachineIds', () => {
  it('collects every existing-ref machineId across holders, de-duplicated', () => {
    const ids = collectReferencedMachineIds([
      { entries: [{ kind: 'existing', machineId: 'a' }, { kind: 'own' }], machineAccess: true },
      { entries: [{ kind: 'existing', machineId: 'a' }, { kind: 'existing', machineId: 'b' }], machineAccess: false },
    ]);
    expect([...ids].sort()).toEqual(['a', 'b']);
  });

  it('ignores malformed entries and non-array blobs', () => {
    const ids = collectReferencedMachineIds([
      { entries: [null, 42, { kind: 'existing' }, { kind: 'existing', machineId: '' }, 'nope'], machineAccess: true },
    ]);
    expect(ids.size).toBe(0);
  });
});

describe('planMachineRefRewrite', () => {
  it('drops refs to dead machines', () => {
    const plan = planMachineRefRewrite({
      entries: [{ kind: 'existing', machineId: DEAD }, { kind: 'existing', machineId: LIVE }],
      machineAccess: true,
      deadMachineIds: new Set([DEAD]),
    });
    expect(plan).toEqual({
      changed: true,
      machines: [{ kind: 'existing', machineId: LIVE }],
      machineAccess: true,
    });
  });

  it('reports no change when every ref is still live', () => {
    const entries = [{ kind: 'existing', machineId: LIVE }];
    const plan = planMachineRefRewrite({ entries, machineAccess: true, deadMachineIds: new Set([DEAD]) });
    expect(plan.changed).toBe(false);
  });

  it('preserves an own-machine ref', () => {
    const plan = planMachineRefRewrite({
      entries: [{ kind: 'own' }, { kind: 'existing', machineId: DEAD }],
      machineAccess: true,
      deadMachineIds: new Set([DEAD]),
    });
    expect(plan.machines).toEqual([{ kind: 'own' }]);
    expect(plan.machineAccess).toBe(true);
  });

  it('preserves malformed entries byte-for-byte', () => {
    const junk = { kind: 'existing' };
    const plan = planMachineRefRewrite({
      entries: [junk, null, { kind: 'existing', machineId: DEAD }],
      machineAccess: true,
      deadMachineIds: new Set([DEAD]),
    });
    expect(plan.changed).toBe(true);
    expect(plan.machines).toEqual([junk, null]);
    expect(plan.machines[0]).toBe(junk);
  });

  it('turns machineAccess off when the rewrite empties the list', () => {
    const plan = planMachineRefRewrite({
      entries: [{ kind: 'existing', machineId: DEAD }],
      machineAccess: true,
      deadMachineIds: new Set([DEAD]),
    });
    expect(plan).toEqual({ changed: true, machines: [], machineAccess: false });
  });

  it('leaves an already-off machineAccess off when the rewrite empties the list', () => {
    const plan = planMachineRefRewrite({
      entries: [{ kind: 'existing', machineId: DEAD }],
      machineAccess: false,
      deadMachineIds: new Set([DEAD]),
    });
    expect(plan).toEqual({ changed: true, machines: [], machineAccess: false });
  });

  it('does not touch machineAccess for a config that was already empty', () => {
    const plan = planMachineRefRewrite({ entries: [], machineAccess: true, deadMachineIds: new Set([DEAD]) });
    expect(plan).toEqual({ changed: false, machines: [], machineAccess: true });
  });

  it('treats a non-array blob as empty', () => {
    const plan = planMachineRefRewrite({
      entries: undefined,
      machineAccess: true,
      deadMachineIds: new Set([DEAD]),
    });
    expect(plan).toEqual({ changed: false, machines: [], machineAccess: true });
  });
});

describe('sweepMachineRefs', () => {
  it('rewrites both blobs when a referenced machine has no page row', async () => {
    const deps = makeDeps();
    const result = await sweepMachineRefs(deps);

    expect(result).toEqual({
      deadMachineIds: [DEAD],
      agentsUpdated: 1,
      globalConfigsUpdated: 1,
      failures: 0,
    });
    expect(deps.writeAgentConfig).toHaveBeenCalledWith({
      config: agent(),
      machines: [],
      machineAccess: false,
      deadMachineIds: new Set([DEAD]),
    });
    expect(deps.writeGlobalConfig).toHaveBeenCalledWith({
      config: global_(),
      machines: [],
      machineAccess: false,
      deadMachineIds: new Set([DEAD]),
    });
  });

  it('treats a trashed-but-existing machine page as alive and writes nothing', async () => {
    // A trash is reversible: the page row still exists, so its refs must survive.
    const deps = makeDeps({ findExistingPageIds: vi.fn().mockImplementation(async (ids: readonly string[]) => ids) });
    const result = await sweepMachineRefs(deps);

    expect(result).toEqual({ deadMachineIds: [], agentsUpdated: 0, globalConfigsUpdated: 0, failures: 0 });
    expect(deps.writeAgentConfig).not.toHaveBeenCalled();
    expect(deps.writeGlobalConfig).not.toHaveBeenCalled();
  });

  it('never queries page liveness when nothing references a machine', async () => {
    const deps = makeDeps({
      listAgentConfigs: vi.fn().mockResolvedValue([]),
      listGlobalConfigs: vi.fn().mockResolvedValue([global_({ entries: [{ kind: 'own' }] })]),
    });
    const result = await sweepMachineRefs(deps);

    expect(result.deadMachineIds).toEqual([]);
    expect(deps.findExistingPageIds).not.toHaveBeenCalled();
  });

  it('skips configs the rewrite would not change', async () => {
    const deps = makeDeps({
      listAgentConfigs: vi
        .fn()
        .mockResolvedValue([agent(), agent({ pageId: 'agent-2', entries: [{ kind: 'existing', machineId: LIVE }] })]),
    });
    const result = await sweepMachineRefs(deps);

    expect(result.agentsUpdated).toBe(1);
    expect(deps.writeAgentConfig).toHaveBeenCalledTimes(1);
  });

  it('skips a global config the rewrite would not change', async () => {
    const deps = makeDeps({
      listGlobalConfigs: vi
        .fn()
        .mockResolvedValue([global_({ entries: [{ kind: 'existing', machineId: LIVE }] }), global_({ userId: 'user-2' })]),
    });
    const result = await sweepMachineRefs(deps);

    expect(result.globalConfigsUpdated).toBe(1);
    expect(deps.writeGlobalConfig).toHaveBeenCalledTimes(1);
  });

  it('does not count a write that reported it wrote nothing', async () => {
    // A lost compare-and-swap, or a row someone else already repaired.
    const deps = makeDeps({
      writeAgentConfig: vi.fn().mockResolvedValue(false),
      writeGlobalConfig: vi.fn().mockResolvedValue(false),
    });
    const result = await sweepMachineRefs(deps);

    expect(result).toEqual({
      deadMachineIds: [DEAD],
      agentsUpdated: 0,
      globalConfigsUpdated: 0,
      failures: 0,
    });
  });

  it('keeps sweeping when one write fails, and reports it', async () => {
    const writeAgentConfig = vi
      .fn()
      .mockRejectedValueOnce(new Error('revision moved'))
      .mockResolvedValue(true);
    const deps = makeDeps({
      listAgentConfigs: vi.fn().mockResolvedValue([agent(), agent({ pageId: 'agent-2' })]),
      writeAgentConfig,
    });
    const result = await sweepMachineRefs(deps);

    expect(writeAgentConfig).toHaveBeenCalledTimes(2);
    expect(result.agentsUpdated).toBe(1);
    expect(result.failures).toBe(1);
    // A failed agent write must not skip the global blob.
    expect(deps.writeGlobalConfig).toHaveBeenCalledTimes(1);
    expect(result.globalConfigsUpdated).toBe(1);
  });

  it('reports a failing global-config write without losing the agent counts', async () => {
    const deps = makeDeps({ writeGlobalConfig: vi.fn().mockRejectedValue(new Error('locked')) });
    const result = await sweepMachineRefs(deps);

    expect(result).toEqual({
      deadMachineIds: [DEAD],
      agentsUpdated: 1,
      globalConfigsUpdated: 0,
      failures: 1,
    });
  });

  it('narrows the listing to the candidate machine ids when given', async () => {
    const deps = makeDeps({ candidateMachineIds: [DEAD] });
    await sweepMachineRefs(deps);

    expect(deps.listAgentConfigs).toHaveBeenCalledWith([DEAD]);
    expect(deps.listGlobalConfigs).toHaveBeenCalledWith([DEAD]);
  });

  it('does nothing at all when the candidate list is empty', async () => {
    const deps = makeDeps({ candidateMachineIds: [] });
    const result = await sweepMachineRefs(deps);

    expect(result).toEqual({ deadMachineIds: [], agentsUpdated: 0, globalConfigsUpdated: 0, failures: 0 });
    expect(deps.listAgentConfigs).not.toHaveBeenCalled();
    expect(deps.listGlobalConfigs).not.toHaveBeenCalled();
    expect(deps.findExistingPageIds).not.toHaveBeenCalled();
  });

  it('only considers candidate machines dead, even if another ref is also dangling', async () => {
    // A scoped sweep proves nothing about machines outside its candidate set —
    // asserting one is dead would let an unrelated concurrent create be scrubbed.
    const other = 'machine-other';
    const deps = makeDeps({
      candidateMachineIds: [DEAD],
      listAgentConfigs: vi
        .fn()
        .mockResolvedValue([
          agent({ entries: [{ kind: 'existing', machineId: DEAD }, { kind: 'existing', machineId: other }] }),
        ]),
      listGlobalConfigs: vi.fn().mockResolvedValue([]),
      findExistingPageIds: vi.fn().mockResolvedValue([]),
    });
    const result = await sweepMachineRefs(deps);

    expect(deps.findExistingPageIds).toHaveBeenCalledWith([DEAD]);
    expect(result.deadMachineIds).toEqual([DEAD]);
    expect(deps.writeAgentConfig).toHaveBeenCalledWith({
      config: expect.anything(),
      machines: [{ kind: 'existing', machineId: other }],
      machineAccess: true,
      deadMachineIds: new Set([DEAD]),
    });
  });
});
