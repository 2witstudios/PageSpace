import { describe, it, expect } from 'vitest';
import {
  planSpawnAgentTerminal,
  spawnAgentTerminal,
  resolveAgentTerminal,
  resolveAgentTerminalRow,
  resolveAgentTerminalById,
  killAgentTerminal,
  killAgentTerminalById,
  listAgentTerminals,
  deriveAgentTerminalScope,
  findStrandedLiveSessions,
  type AgentTerminalsDeps,
  type AgentTerminalBranchLookup,
  type AgentTerminalProjectLookup,
  type AgentTerminalMachineSandbox,
} from '../agent-terminals';
import type { MachineAgentTerminalStore, MachineAgentTerminalRecord, AgentTerminalScopeKey } from '../agent-terminals-store';
import { type MachineHost, type MachineHandle } from '../../sandbox/machine-host';
import { SANDBOX_ROOT } from '../../sandbox/sandbox-paths';
import { BRANCH_REPO_PATH } from '../machine-branches';
import { PROJECT_REPO_PATH } from '../machine-project-promotion';

const NOW = new Date('2026-07-06T12:00:00.000Z');
const TERMINAL_ID = 'terminal-1';
const PROJECT_NAME = 'my-repo';
const BRANCH_NAME = 'feature-x';
const BRANCH_ID = 'branch-1';
const BRANCH_SANDBOX_ID = 'sprite-branch-1';
const MACHINE_SANDBOX_ID = 'sprite-machine-1';
const PROJECT_PATH = '/workspace/projects/my-repo';

const actor = { userId: 'user-1' };

function makeBranchLookup(rows: Record<string, { id: string; sandboxId: string }> = {}): AgentTerminalBranchLookup {
  const byId = new Map<string, { sandboxId: string }>();
  for (const row of Object.values(rows)) byId.set(row.id, { sandboxId: row.sandboxId });
  return {
    findByName: async (machineId, projectName, branchName) =>
      rows[`${machineId}\0${projectName}\0${branchName}`] ?? null,
    findById: async (id) => byId.get(id) ?? null,
  };
}

const defaultBranchLookup = makeBranchLookup({
  [`${TERMINAL_ID}\0${PROJECT_NAME}\0${BRANCH_NAME}`]: { id: BRANCH_ID, sandboxId: BRANCH_SANDBOX_ID },
});

function makeProjectLookup(
  rows: Record<string, { path: string; sandboxId?: string | null; spriteTornDownAt?: Date | null }> = {},
): AgentTerminalProjectLookup {
  return {
    findByName: async (machineId, name) => rows[`${machineId}\0${name}`] ?? null,
  };
}

const defaultProjectLookup = makeProjectLookup({
  [`${TERMINAL_ID}\0${PROJECT_NAME}`]: { path: PROJECT_PATH },
});

function makeMachineSandbox(over: Partial<AgentTerminalMachineSandbox> = {}): AgentTerminalMachineSandbox {
  return {
    acquire: async () => ({ ok: true, sandboxId: MACHINE_SANDBOX_ID }),
    ...over,
  };
}

function scopeKeyOf(row: MachineAgentTerminalRecord): AgentTerminalScopeKey {
  return { machineId: row.machineId, projectName: row.projectName, machineBranchId: row.machineBranchId };
}

function sameScope(a: AgentTerminalScopeKey, b: AgentTerminalScopeKey): boolean {
  return a.machineId === b.machineId && a.projectName === b.projectName && a.machineBranchId === b.machineBranchId;
}

function makeStore(seed: MachineAgentTerminalRecord[] = []) {
  const rows = new Map<string, MachineAgentTerminalRecord>();
  const key = (scope: AgentTerminalScopeKey, name: string) =>
    `${scope.machineId}\0${scope.projectName ?? ''}\0${scope.machineBranchId ?? ''}\0${name}`;
  for (const row of seed) rows.set(key(scopeKeyOf(row), row.name), row);
  let counter = 0;
  const store: MachineAgentTerminalStore = {
    list: async (scope) => [...rows.values()].filter((r) => sameScope(scopeKeyOf(r), scope)),
    findByName: async (scope, name) => rows.get(key(scope, name)) ?? null,
    findById: async (id) => [...rows.values()].find((r) => r.id === id) ?? null,
    create: async (input) => {
      const k = key({ machineId: input.machineId, projectName: input.projectName, machineBranchId: input.machineBranchId }, input.name);
      if (rows.has(k)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }
      counter += 1;
      const row: MachineAgentTerminalRecord = {
        id: `agent-terminal-${counter}`,
        ownerId: input.ownerId,
        machineId: input.machineId,
        scope: input.scope,
        projectName: input.projectName,
        machineBranchId: input.machineBranchId,
        name: input.name,
        agentType: input.agentType,
        command: input.command,
        streamSessionId: null,
        coldTail: null,
        coldTailAt: null,
        coldTailHasOutput: false,
        createdAt: input.now,
        updatedAt: input.now,
      };
      rows.set(k, row);
      return row;
    },
    updateStreamSessionId: async ({ id, streamSessionId, now }) => {
      for (const [k, row] of rows) {
        if (row.id === id) {
          rows.set(k, { ...row, streamSessionId, updatedAt: now });
          return;
        }
      }
    },
    recordColdTail: async ({ id, tail, hasOutput, endedAt, now }) => {
      for (const [k, row] of rows) {
        if (row.id === id) {
          rows.set(k, { ...row, coldTail: tail, coldTailAt: endedAt, coldTailHasOutput: hasOutput, updatedAt: now });
          return;
        }
      }
    },
    remove: async (scope, name) => {
      rows.delete(key(scope, name));
    },
  };
  return { store, rows };
}

function makeHost(over: Partial<MachineHost> = {}): MachineHost {
  return {
    provision: async () => {
      throw new Error('not used in these tests');
    },
    attach: async () => null,
    kill: async () => {},
    ...over,
  };
}

function makeHandle(over: Partial<MachineHandle> = {}): MachineHandle {
  return {
    machineId: BRANCH_SANDBOX_ID,
    spriteInstanceId: null,
    exec: async () => ({ success: true, exitCode: 0, stdout: '', stderr: '' }),
    writeFiles: async () => {},
    readFile: async () => null,
    createCheckpoint: async () => {},
    stream: async () => ({
      write: () => {},
      resize: () => {},
      onData: () => {},
      onExit: () => {},
      onError: () => {},
      kill: () => {},
    }),
    listStreams: async () => [],
    killSession: async () => {},
    ...over,
  };
}

function makeDeps(overrides: Partial<AgentTerminalsDeps> = {}): AgentTerminalsDeps {
  return {
    branchStore: defaultBranchLookup,
    projectStore: defaultProjectLookup,
    machineSandbox: makeMachineSandbox(),
    store: makeStore().store,
    host: makeHost(),
    now: () => NOW,
    ...overrides,
  };
}

/** A pre-existing DB row stuck with the retired 'pagespace-cli' agentType — simulates a machine
 * that spawned one before it was removed from AGENT_LAUNCH_SPECS, bypassing planSpawnAgentTerminal's
 * validation (which now rejects it) since this is seeded directly into the store. */
function makeLegacyRow(overrides: Partial<MachineAgentTerminalRecord> = {}): MachineAgentTerminalRecord {
  return {
    id: 'agent-terminal-legacy',
    ownerId: actor.userId,
    machineId: TERMINAL_ID,
    scope: 'machine',
    projectName: null,
    machineBranchId: null,
    name: 'legacy-cli',
    agentType: 'pagespace-cli',
    command: null,
    streamSessionId: null,
    coldTail: null,
    coldTailAt: null,
    coldTailHasOutput: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('deriveAgentTerminalScope', () => {
  it('given machineBranchId set, should classify branch (regardless of projectName)', () => {
    expect(deriveAgentTerminalScope({ projectName: PROJECT_NAME, machineBranchId: BRANCH_ID })).toBe('branch');
  });

  it('given only projectName set, should classify project', () => {
    expect(deriveAgentTerminalScope({ projectName: PROJECT_NAME, machineBranchId: null })).toBe('project');
  });

  it('given neither set, should classify machine', () => {
    expect(deriveAgentTerminalScope({ projectName: null, machineBranchId: null })).toBe('machine');
  });
});

describe('planSpawnAgentTerminal', () => {
  it('given a valid name and known agent type, should allow it', () => {
    expect(planSpawnAgentTerminal({ name: 'reviewer', agentType: 'shell' })).toEqual({ ok: true });
  });

  it('given an invalid name, should reject it', () => {
    expect(planSpawnAgentTerminal({ name: '../etc', agentType: 'shell' })).toEqual({
      ok: false,
      reason: 'invalid_name',
    });
  });

  it('given an unknown agent type, should reject it', () => {
    expect(planSpawnAgentTerminal({ name: 'reviewer', agentType: 'gemini' })).toEqual({
      ok: false,
      reason: 'invalid_agent_type',
    });
  });

  it('given the retired pagespace-cli agent type, should reject a FRESH spawn as invalid_agent_type', () => {
    expect(planSpawnAgentTerminal({ name: 'reviewer', agentType: 'pagespace-cli' })).toEqual({
      ok: false,
      reason: 'invalid_agent_type',
    });
  });

  it('given an empty command override, should reject it', () => {
    expect(planSpawnAgentTerminal({ name: 'reviewer', agentType: 'shell', command: '   ' })).toEqual({
      ok: false,
      reason: 'invalid_command',
    });
  });

  it('given a valid command override, should allow it', () => {
    expect(planSpawnAgentTerminal({ name: 'reviewer', agentType: 'shell', command: 'htop' })).toEqual({ ok: true });
  });
});

describe('spawnAgentTerminal — branch scope', () => {
  it('given a branch that does not exist, should deny', async () => {
    const deps = makeDeps({ branchStore: makeBranchLookup() });
    const result = await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: BRANCH_NAME,
      name: 'cli',
      agentType: 'shell',
      actor,
      deps,
    });
    expect(result).toEqual({ ok: false, reason: 'branch_not_found' });
  });

  it('given branchName without projectName, should reject as an invalid target', async () => {
    const deps = makeDeps();
    const result = await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      branchName: BRANCH_NAME,
      name: 'cli',
      agentType: 'shell',
      actor,
      deps,
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_target' });
  });

  it('given a fresh name, should reserve a shell agent terminal keyed to the branch with scope="branch"', async () => {
    const { store, rows } = makeStore();
    const deps = makeDeps({ store });
    const result = await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: BRANCH_NAME,
      name: 'cli',
      agentType: 'shell',
      actor,
      deps,
    });
    expect(result).toMatchObject({ ok: true, agentType: 'shell', resumed: false });
    const row = [...rows.values()][0];
    expect(row).toMatchObject({ scope: 'branch', machineBranchId: BRANCH_ID, projectName: PROJECT_NAME, agentType: 'shell', command: null });
  });

  it('given a command override, should persist it on the row', async () => {
    const { store, rows } = makeStore();
    const deps = makeDeps({ store });
    await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: BRANCH_NAME,
      name: 'top',
      agentType: 'shell',
      command: 'htop',
      actor,
      deps,
    });
    const row = [...rows.values()][0];
    expect(row.command).toBe('htop');
  });

  it('given a second, differently-named spawn in the SAME branch, should let a shell terminal coexist with a pagespace one', async () => {
    const { store, rows } = makeStore();
    const deps = makeDeps({ store });

    await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: BRANCH_NAME,
      name: 'cli',
      agentType: 'pagespace',
      actor,
      deps,
    });
    const shellResult = await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: BRANCH_NAME,
      name: 'reviewer',
      agentType: 'shell',
      actor,
      deps,
    });

    expect(shellResult).toMatchObject({ ok: true, agentType: 'shell', resumed: false });
    expect(rows.size).toBe(2);
    expect([...rows.values()].map((r) => r.agentType).sort()).toEqual(['pagespace', 'shell']);
  });

  it('given a repeat spawn of the same (name, agentType), should resume idempotently rather than duplicate', async () => {
    const { store } = makeStore();
    const deps = makeDeps({ store });

    const first = await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: BRANCH_NAME,
      name: 'cli',
      agentType: 'shell',
      actor,
      deps,
    });
    const second = await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: BRANCH_NAME,
      name: 'cli',
      agentType: 'shell',
      actor,
      deps,
    });

    expect(first.ok && second.ok && first.id === second.id).toBe(true);
    expect(second).toMatchObject({ resumed: true });
  });

  it('given the same name reused under a DIFFERENT agent type, should reject as name_in_use', async () => {
    const { store } = makeStore();
    const deps = makeDeps({ store });

    await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: BRANCH_NAME,
      name: 'agent',
      agentType: 'shell',
      actor,
      deps,
    });
    const conflicting = await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: BRANCH_NAME,
      name: 'agent',
      agentType: 'pagespace',
      actor,
      deps,
    });

    expect(conflicting).toEqual({ ok: false, reason: 'name_in_use' });
  });
});

describe('spawnAgentTerminal — project scope', () => {
  it('given a project that does not exist, should deny', async () => {
    const deps = makeDeps({ projectStore: makeProjectLookup() });
    const result = await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      name: 'cli',
      agentType: 'shell',
      actor,
      deps,
    });
    expect(result).toEqual({ ok: false, reason: 'project_not_found' });
  });

  it('given no projectStore wired, should report scope_unsupported rather than provisioning anything', async () => {
    const deps = makeDeps({ projectStore: undefined });
    const result = await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      name: 'cli',
      agentType: 'shell',
      actor,
      deps,
    });
    expect(result).toEqual({ ok: false, reason: 'scope_unsupported' });
  });

  it('given a valid project, should reserve an agent terminal keyed to the project (scope="project", no machineBranchId)', async () => {
    const { store, rows } = makeStore();
    const deps = makeDeps({ store });
    const result = await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      name: 'cli',
      agentType: 'shell',
      actor,
      deps,
    });
    expect(result).toMatchObject({ ok: true, agentType: 'shell', resumed: false });
    const row = [...rows.values()][0];
    expect(row).toMatchObject({ scope: 'project', projectName: PROJECT_NAME, machineBranchId: null });
  });
});

describe('spawnAgentTerminal — machine scope', () => {
  it('given neither projectName nor branchName, should reserve an agent terminal with ZERO projects on the machine Sprite (scope="machine")', async () => {
    const { store, rows } = makeStore();
    const deps = makeDeps({ store, projectStore: makeProjectLookup() });
    const result = await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      name: 'cli',
      agentType: 'shell',
      actor,
      deps,
    });
    expect(result).toMatchObject({ ok: true, agentType: 'shell', resumed: false });
    const row = [...rows.values()][0];
    expect(row).toMatchObject({ scope: 'machine', machineId: TERMINAL_ID, projectName: null, machineBranchId: null });
  });

  it('given a bare shell agentType, should reserve it (the plain shell IS a machine-scope agent terminal, not a separate concept)', async () => {
    const { store, rows } = makeStore();
    const deps = makeDeps({ store, projectStore: makeProjectLookup() });
    const result = await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      name: 'shell',
      agentType: 'shell',
      actor,
      deps,
    });
    expect(result).toMatchObject({ ok: true, agentType: 'shell' });
    expect([...rows.values()][0]).toMatchObject({ scope: 'machine', agentType: 'shell' });
  });

  it('should not require projectStore/machineSandbox at spawn time (spawn never touches the Sprite)', async () => {
    const { store } = makeStore();
    const deps = makeDeps({ store, projectStore: undefined, machineSandbox: undefined });
    const result = await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      name: 'cli',
      agentType: 'shell',
      actor,
      deps,
    });
    expect(result).toMatchObject({ ok: true, resumed: false });
  });
});

describe('spawnAgentTerminal — pagespace (chat-surface) has NO spawn-side type restriction', () => {
  it('given a fresh pagespace spawn at branch scope, should reserve it exactly like a pty type', async () => {
    const { store, rows } = makeStore();
    const deps = makeDeps({ store });
    const result = await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: BRANCH_NAME,
      name: 'agent',
      agentType: 'pagespace',
      actor,
      deps,
    });
    expect(result).toMatchObject({ ok: true, agentType: 'pagespace', resumed: false });
    expect([...rows.values()][0]).toMatchObject({ scope: 'branch', machineBranchId: BRANCH_ID, agentType: 'pagespace' });
  });

  it('given a fresh pagespace spawn at project scope, should reserve it exactly like a pty type', async () => {
    const { store, rows } = makeStore();
    const deps = makeDeps({ store });
    const result = await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      name: 'agent',
      agentType: 'pagespace',
      actor,
      deps,
    });
    expect(result).toMatchObject({ ok: true, agentType: 'pagespace', resumed: false });
    expect([...rows.values()][0]).toMatchObject({ scope: 'project', projectName: PROJECT_NAME, machineBranchId: null, agentType: 'pagespace' });
  });

  it('given a fresh pagespace spawn at machine scope, should reserve it exactly like a pty type', async () => {
    const { store, rows } = makeStore();
    const deps = makeDeps({ store, projectStore: makeProjectLookup() });
    const result = await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      name: 'agent',
      agentType: 'pagespace',
      actor,
      deps,
    });
    expect(result).toMatchObject({ ok: true, agentType: 'pagespace', resumed: false });
    expect([...rows.values()][0]).toMatchObject({ scope: 'machine', projectName: null, machineBranchId: null, agentType: 'pagespace' });
  });

  it('given a repeat pagespace spawn of the same name, should resume idempotently rather than duplicate', async () => {
    const { store } = makeStore();
    const deps = makeDeps({ store, projectStore: makeProjectLookup() });
    const first = await spawnAgentTerminal({ machineId: TERMINAL_ID, name: 'agent', agentType: 'pagespace', actor, deps });
    const second = await spawnAgentTerminal({ machineId: TERMINAL_ID, name: 'agent', agentType: 'pagespace', actor, deps });
    expect(first.ok && second.ok && first.id === second.id).toBe(true);
    expect(second).toMatchObject({ resumed: true });
  });

  it('given the same name reused under a DIFFERENT agent type (shell then pagespace), should reject as name_in_use', async () => {
    const { store } = makeStore();
    const deps = makeDeps({ store, projectStore: makeProjectLookup() });
    await spawnAgentTerminal({ machineId: TERMINAL_ID, name: 'agent', agentType: 'shell', actor, deps });
    const conflicting = await spawnAgentTerminal({ machineId: TERMINAL_ID, name: 'agent', agentType: 'pagespace', actor, deps });
    expect(conflicting).toEqual({ ok: false, reason: 'name_in_use' });
  });
});

describe('resolveAgentTerminalRow', () => {
  // The whole point of this resolver: it answers "does this target still exist?"
  // with DB reads alone. Passing `machineSandbox: undefined` throughout is the
  // proof — the function cannot wake, resume or reconnect a Sprite because it is
  // never handed one. That is what lets the 60s re-auth tick and the reattach
  // fast path run it without paying for a Sprite wake.
  it('given a machine-scoped terminal, should resolve the row WITHOUT any machineSandbox', async () => {
    const { store } = makeStore();
    const deps = makeDeps({ store, machineSandbox: undefined });
    await spawnAgentTerminal({ machineId: TERMINAL_ID, name: 'cli', agentType: 'shell', actor, deps });

    const result = await resolveAgentTerminalRow({ machineId: TERMINAL_ID, name: 'cli', deps });

    expect(result).toEqual({ ok: true, agentTerminalId: expect.any(String), agentType: 'shell' });
  });

  it('given a project-scoped terminal whose project row is GONE, should deny project_not_found without a Sprite', async () => {
    const deps = makeDeps({ projectStore: makeProjectLookup(), machineSandbox: undefined });

    const result = await resolveAgentTerminalRow({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, name: 'cli', deps });

    expect(result).toEqual({ ok: false, reason: 'project_not_found' });
  });

  it('given an EXISTING row whose agentType is the retired pagespace-cli, should deny not_found rather than crash', async () => {
    const { store } = makeStore([makeLegacyRow()]);
    const deps = makeDeps({ store, machineSandbox: undefined });

    const result = await resolveAgentTerminalRow({ machineId: TERMINAL_ID, name: 'legacy-cli', deps });

    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('given a branch-scoped terminal whose branch row is GONE, should deny branch_not_found without a Sprite', async () => {
    const deps = makeDeps({ branchStore: makeBranchLookup(), machineSandbox: undefined });

    const result = await resolveAgentTerminalRow({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: BRANCH_NAME,
      name: 'cli',
      deps,
    });

    expect(result).toEqual({ ok: false, reason: 'branch_not_found' });
  });

  it('given a name that was never spawned, should deny not_found without a Sprite', async () => {
    const deps = makeDeps({ machineSandbox: undefined });

    const result = await resolveAgentTerminalRow({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: BRANCH_NAME,
      name: 'ghost',
      deps,
    });

    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('given a branch name with no project, should reject the target as invalid without a Sprite', async () => {
    const deps = makeDeps({ machineSandbox: undefined });

    const result = await resolveAgentTerminalRow({ machineId: TERMINAL_ID, branchName: BRANCH_NAME, name: 'cli', deps });

    expect(result).toEqual({ ok: false, reason: 'invalid_target' });
  });

  it('given a pagespace (chat-surface) row, should deny not_a_pty_agent WITHOUT any machineSandbox', async () => {
    const { store } = makeStore();
    const deps = makeDeps({ store, projectStore: makeProjectLookup(), machineSandbox: undefined });
    await spawnAgentTerminal({ machineId: TERMINAL_ID, name: 'agent', agentType: 'pagespace', actor, deps });

    const result = await resolveAgentTerminalRow({ machineId: TERMINAL_ID, name: 'agent', deps });

    expect(result).toEqual({ ok: false, reason: 'not_a_pty_agent' });
  });
});

/**
 * Lazy promotion's TRIGGER: the first project-scoped spawn. `spawnAgentTerminal`
 * is where a project-scoped session is born, so it is where an unpromoted
 * project must become its own Sprite — inline, before the row is reserved, the
 * same way `spawnBranch` provisions+clones inside the spawn request rather than
 * deferring it to first connect.
 */
describe('spawnAgentTerminal — lazy project promotion trigger', () => {
  /** A project lookup whose row can be PROMOTED mid-test, exactly as promoteProject's CAS would. */
  function makePromotableProject() {
    const row: { path: string; sandboxId: string | null; spriteTornDownAt: Date | null } = {
      path: PROJECT_PATH,
      sandboxId: null,
      spriteTornDownAt: null,
    };
    const lookup: AgentTerminalProjectLookup = {
      findByName: async (machineId, name) => (machineId === TERMINAL_ID && name === PROJECT_NAME ? row : null),
    };
    return { row, lookup };
  }

  function spyPromotion(impl?: () => Promise<{ ok: true } | { ok: false; reason: string; detail?: string }>) {
    const calls: Array<{ machineId: string; projectName: string }> = [];
    return {
      calls,
      promotion: {
        promote: async (input: { machineId: string; projectName: string }) => {
          calls.push(input);
          return impl ? impl() : ({ ok: true } as const);
        },
      },
    };
  }

  it('given a project whose Sprite was TORN DOWN (machine trash → restore), a project-scoped spawn should RE-promote it', async () => {
    // The recovery path the handle set depends on: a torn-down row keeps its
    // node addressable (machine-checkout fallback in machine-pane-binding), and
    // the next project-scoped spawn re-promotes — fresh Sprite, fresh clone,
    // teardown marks cleared by the store's promote CAS.
    const { row, lookup } = makePromotableProject();
    row.sandboxId = 'sprite-old-gen';
    row.spriteTornDownAt = new Date('2026-01-01');
    const { store } = makeStore();
    const promotion = spyPromotion(async () => {
      row.sandboxId = 'sprite-new-gen';
      row.spriteTornDownAt = null;
      return { ok: true };
    });
    const deps = makeDeps({ store, projectStore: lookup, projectPromotion: promotion.promotion });

    const spawned = await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      name: 'cli',
      agentType: 'shell',
      actor,
      deps,
    });

    expect(spawned).toMatchObject({ ok: true });
    expect(promotion.calls).toEqual([{ machineId: TERMINAL_ID, projectName: PROJECT_NAME }]);

    const resolved = await resolveAgentTerminal({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, name: 'cli', deps });
    expect(resolved).toMatchObject({ ok: true, sandboxId: 'sprite-new-gen', cwd: PROJECT_REPO_PATH });
  });

  it('given a project-scoped spawn on an UNPROMOTED project, should promote it first and then resolve onto the project Sprite', async () => {
    const { row, lookup } = makePromotableProject();
    const { store } = makeStore();
    const promotion = spyPromotion(async () => {
      // What the real promoteProject's CAS writes.
      row.sandboxId = 'sprite-project-1';
      return { ok: true };
    });
    const acquireCalls: string[] = [];
    const deps = makeDeps({
      store,
      projectStore: lookup,
      projectPromotion: promotion.promotion,
      machineSandbox: makeMachineSandbox({
        acquire: async (machineId) => {
          acquireCalls.push(machineId);
          return { ok: true, sandboxId: MACHINE_SANDBOX_ID };
        },
      }),
    });

    const spawned = await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      name: 'cli',
      agentType: 'shell',
      actor,
      deps,
    });

    expect(spawned).toEqual({ ok: true, id: 'agent-terminal-1', agentType: 'shell', resumed: false });
    expect(promotion.calls).toEqual([{ machineId: TERMINAL_ID, projectName: PROJECT_NAME }]);
    expect(row.sandboxId).toBe('sprite-project-1');

    // ...and the session that spawn just reserved now resolves onto the
    // project's OWN Sprite, never machine Sprite + checkout cwd.
    const resolved = await resolveAgentTerminal({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, name: 'cli', deps });
    expect(resolved).toMatchObject({
      ok: true,
      sandboxId: 'sprite-project-1',
      cwd: PROJECT_REPO_PATH,
      ownSprite: true,
    });
    expect(acquireCalls).toEqual([]);
  });

  it('given a DIRTY checkout, should fail the spawn with the actionable refusal — never a silent machine-Sprite fallback', async () => {
    const { row, lookup } = makePromotableProject();
    const { store } = makeStore();
    const promotion = spyPromotion(async () => ({
      ok: false,
      reason: 'dirty_checkout',
      detail: 'The checkout at /workspace/projects/my-repo has uncommitted changes',
    }));
    const deps = makeDeps({ store, projectStore: lookup, projectPromotion: promotion.promotion });

    const spawned = await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      name: 'cli',
      agentType: 'shell',
      actor,
      deps,
    });

    expect(spawned).toEqual({
      ok: false,
      reason: 'promotion_failed',
      detail: 'The checkout at /workspace/projects/my-repo has uncommitted changes',
    });
    // No row was reserved, and the project stayed put — a refused promotion must
    // not leave a session pointing at a checkout we were about to reclaim.
    expect(await deps.store.findByName({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, machineBranchId: null }, 'cli')).toBeNull();
    expect(row.sandboxId).toBeNull();
  });

  it('given an ALREADY-promoted project, should not re-promote', async () => {
    const { row, lookup } = makePromotableProject();
    row.sandboxId = 'sprite-project-1';
    const { store } = makeStore();
    const promotion = spyPromotion();
    const deps = makeDeps({ store, projectStore: lookup, projectPromotion: promotion.promotion });

    await spawnAgentTerminal({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, name: 'cli', agentType: 'shell', actor, deps });

    expect(promotion.calls).toEqual([]);
  });

  it('given a MACHINE-scope or BRANCH-scope spawn, should never promote anything', async () => {
    const { lookup } = makePromotableProject();
    const promotion = spyPromotion();

    await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      name: 'cli',
      agentType: 'shell',
      actor,
      deps: makeDeps({ store: makeStore().store, projectStore: lookup, projectPromotion: promotion.promotion }),
    });
    await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: BRANCH_NAME,
      name: 'cli',
      agentType: 'shell',
      actor,
      deps: makeDeps({ store: makeStore().store, projectStore: lookup, projectPromotion: promotion.promotion }),
    });

    // A branch has its OWN Sprite regardless of whether its project was ever
    // promoted, and machine scope IS the machine Sprite.
    expect(promotion.calls).toEqual([]);
  });

  it('given NO promotion dep wired, should spawn exactly as before (the dep is optional)', async () => {
    const { lookup } = makePromotableProject();
    const spawned = await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      name: 'cli',
      agentType: 'shell',
      actor,
      deps: makeDeps({ store: makeStore().store, projectStore: lookup }),
    });
    expect(spawned).toMatchObject({ ok: true, resumed: false });
  });
});

describe('resolveAgentTerminal', () => {
  it('given an unknown branch, should deny', async () => {
    const deps = makeDeps({ branchStore: makeBranchLookup() });
    const result = await resolveAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: BRANCH_NAME,
      name: 'cli',
      deps,
    });
    expect(result).toEqual({ ok: false, reason: 'branch_not_found' });
  });

  it('given a name that was never spawned, should return not_found', async () => {
    const deps = makeDeps();
    const result = await resolveAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: BRANCH_NAME,
      name: 'ghost',
      deps,
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('given an EXISTING row whose agentType is the retired pagespace-cli, should deny not_found rather than crash or hand it to resolveAgentLaunchSpec', async () => {
    const { store } = makeStore([makeLegacyRow()]);
    const deps = makeDeps({ store });

    const result = await resolveAgentTerminal({ machineId: TERMINAL_ID, name: 'legacy-cli', deps });

    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('given a branch-scoped agent terminal, should resolve the isolated branch Sprite and its repo cwd', async () => {
    const { store } = makeStore();
    const deps = makeDeps({ store });
    await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: BRANCH_NAME,
      name: 'cli',
      agentType: 'shell',
      actor,
      deps,
    });

    const result = await resolveAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: BRANCH_NAME,
      name: 'cli',
      deps,
    });

    expect(result).toEqual({
      ok: true,
      agentTerminalId: 'agent-terminal-1',
      sandboxId: BRANCH_SANDBOX_ID,
      cwd: BRANCH_REPO_PATH,
      // A branch always has its OWN Sprite — the credential-refresh gate keys on this.
      ownSprite: true,
      agentType: 'shell',
      command: null,
      streamSessionId: null,
    });
  });

  it('given a project-scoped agent terminal, should resolve the SAME machine Sprite with cwd=project.path', async () => {
    const { store } = makeStore();
    const acquireCalls: string[] = [];
    const deps = makeDeps({
      store,
      machineSandbox: makeMachineSandbox({
        acquire: async (machineId) => {
          acquireCalls.push(machineId);
          return { ok: true, sandboxId: MACHINE_SANDBOX_ID };
        },
      }),
    });
    await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      name: 'cli',
      agentType: 'shell',
      actor,
      deps,
    });

    const result = await resolveAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      name: 'cli',
      deps,
    });

    expect(result).toEqual({
      ok: true,
      agentTerminalId: 'agent-terminal-1',
      sandboxId: MACHINE_SANDBOX_ID,
      cwd: PROJECT_PATH,
      // Unpromoted project / machine root: the machine's own shared Sprite.
      ownSprite: false,
      agentType: 'shell',
      command: null,
      streamSessionId: null,
    });
    expect(acquireCalls).toEqual([TERMINAL_ID]);
  });

  it('given a machine-scoped agent terminal spawned with ZERO projects, should resolve the machine Sprite with cwd=SANDBOX_ROOT', async () => {
    const { store } = makeStore();
    const deps = makeDeps({ store, projectStore: makeProjectLookup() });
    await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      name: 'cli',
      agentType: 'shell',
      actor,
      deps,
    });

    const result = await resolveAgentTerminal({
      machineId: TERMINAL_ID,
      name: 'cli',
      deps,
    });

    expect(result).toEqual({
      ok: true,
      agentTerminalId: 'agent-terminal-1',
      sandboxId: MACHINE_SANDBOX_ID,
      cwd: SANDBOX_ROOT,
      // Unpromoted project / machine root: the machine's own shared Sprite.
      ownSprite: false,
      agentType: 'shell',
      command: null,
      streamSessionId: null,
    });
  });

  it('given a PROMOTED project, should resolve ITS OWN Sprite at /workspace/repo and never acquire the machine', async () => {
    const { store } = makeStore();
    const acquireCalls: string[] = [];
    const deps = makeDeps({
      store,
      projectStore: makeProjectLookup({
        [`${TERMINAL_ID}\0${PROJECT_NAME}`]: { path: PROJECT_PATH, sandboxId: 'sprite-project-1', spriteTornDownAt: null },
      }),
      machineSandbox: makeMachineSandbox({
        acquire: async (machineId) => {
          acquireCalls.push(machineId);
          return { ok: true, sandboxId: MACHINE_SANDBOX_ID };
        },
      }),
    });
    await spawnAgentTerminal({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, name: 'cli', agentType: 'shell', actor, deps });

    const result = await resolveAgentTerminal({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, name: 'cli', deps });

    expect(result).toEqual({
      ok: true,
      agentTerminalId: 'agent-terminal-1',
      sandboxId: 'sprite-project-1',
      cwd: PROJECT_REPO_PATH,
      // Its own Sprite — so the realtime bridge's credential refresh fires for it.
      ownSprite: true,
      agentType: 'shell',
      command: null,
      streamSessionId: null,
    });
    // Promoted-first: the machine's Sprite is never woken for a project that no
    // longer lives on it.
    expect(acquireCalls).toEqual([]);
  });

  it('given a promoted project whose Sprite was TORN DOWN, should fall back to the machine checkout', async () => {
    const { store } = makeStore();
    const deps = makeDeps({
      store,
      projectStore: makeProjectLookup({
        [`${TERMINAL_ID}\0${PROJECT_NAME}`]: { path: PROJECT_PATH, sandboxId: 'sprite-project-1', spriteTornDownAt: NOW },
      }),
    });
    await spawnAgentTerminal({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, name: 'cli', agentType: 'shell', actor, deps });

    const result = await resolveAgentTerminal({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, name: 'cli', deps });

    expect(result).toMatchObject({ ok: true, sandboxId: MACHINE_SANDBOX_ID, cwd: PROJECT_PATH, ownSprite: false });
  });

  it('given the machine Sprite fails to acquire, should deny as machine_unavailable', async () => {
    const { store } = makeStore();
    const deps = makeDeps({ store, projectStore: makeProjectLookup() });
    await spawnAgentTerminal({ machineId: TERMINAL_ID, name: 'cli', agentType: 'shell', actor, deps });

    const failingDeps = { ...deps, machineSandbox: makeMachineSandbox({ acquire: async () => ({ ok: false, reason: 'provision_failed' }) }) };
    const result = await resolveAgentTerminal({ machineId: TERMINAL_ID, name: 'cli', deps: failingDeps });

    expect(result).toEqual({ ok: false, reason: 'machine_unavailable' });
  });

  it('given a pagespace (chat-surface) row at machine scope, should deny not_a_pty_agent WITHOUT acquiring the machine Sprite', async () => {
    const { store } = makeStore();
    const acquireCalls: string[] = [];
    const deps = makeDeps({
      store,
      projectStore: makeProjectLookup(),
      machineSandbox: makeMachineSandbox({
        acquire: async (machineId) => {
          acquireCalls.push(machineId);
          return { ok: true, sandboxId: MACHINE_SANDBOX_ID };
        },
      }),
    });
    await spawnAgentTerminal({ machineId: TERMINAL_ID, name: 'agent', agentType: 'pagespace', actor, deps });

    const result = await resolveAgentTerminal({ machineId: TERMINAL_ID, name: 'agent', deps });

    expect(result).toEqual({ ok: false, reason: 'not_a_pty_agent' });
    expect(acquireCalls).toEqual([]);
  });

  it('given a pagespace (chat-surface) row at branch scope, should deny not_a_pty_agent', async () => {
    const { store } = makeStore();
    const deps = makeDeps({ store });
    await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: BRANCH_NAME,
      name: 'agent',
      agentType: 'pagespace',
      actor,
      deps,
    });

    const result = await resolveAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: BRANCH_NAME,
      name: 'agent',
      deps,
    });

    expect(result).toEqual({ ok: false, reason: 'not_a_pty_agent' });
  });
});

describe('resolveAgentTerminalById — level-agnostic (PurePoint Attach{agent_id} parity)', () => {
  it('given an unknown id, should return not_found', async () => {
    const deps = makeDeps();
    const result = await resolveAgentTerminalById({ agentTerminalId: 'ghost', deps });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('given a branch-scoped row id, should resolve its isolated branch Sprite WITHOUT any project/branch name lookup', async () => {
    const { store } = makeStore();
    const findByNameCalls: string[] = [];
    const deps = makeDeps({
      store,
      branchStore: {
        ...defaultBranchLookup,
        findByName: async (...args) => {
          findByNameCalls.push(args.join(':'));
          return defaultBranchLookup.findByName(...args);
        },
      },
    });
    const spawned = await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: BRANCH_NAME,
      name: 'cli',
      agentType: 'shell',
      actor,
      deps,
    });
    expect(spawned.ok).toBe(true);
    findByNameCalls.length = 0; // clear the spawn-time lookup; only care about resolve-time calls below

    const result = await resolveAgentTerminalById({ agentTerminalId: spawned.ok ? spawned.id : '', deps });

    expect(result).toEqual({
      ok: true,
      agentTerminalId: 'agent-terminal-1',
      sandboxId: BRANCH_SANDBOX_ID,
      cwd: BRANCH_REPO_PATH,
      // A branch always has its OWN Sprite — the credential-refresh gate keys on this.
      ownSprite: true,
      agentType: 'shell',
      command: null,
      streamSessionId: null,
    });
    expect(findByNameCalls).toEqual([]); // level-agnostic: resolved purely by id, no name-based branch lookup
  });

  it('given a project-scoped row id, should resolve the SAME machine Sprite with cwd=project.path', async () => {
    const { store } = makeStore();
    const deps = makeDeps({ store });
    const spawned = await spawnAgentTerminal({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, name: 'cli', agentType: 'shell', actor, deps });

    const result = await resolveAgentTerminalById({ agentTerminalId: spawned.ok ? spawned.id : '', deps });

    expect(result).toEqual({
      ok: true,
      agentTerminalId: 'agent-terminal-1',
      sandboxId: MACHINE_SANDBOX_ID,
      cwd: PROJECT_PATH,
      // Unpromoted project / machine root: the machine's own shared Sprite.
      ownSprite: false,
      agentType: 'shell',
      command: null,
      streamSessionId: null,
    });
  });

  it('given a machine-scoped row id, should resolve the machine Sprite with cwd=SANDBOX_ROOT', async () => {
    const { store } = makeStore();
    const deps = makeDeps({ store, projectStore: makeProjectLookup() });
    const spawned = await spawnAgentTerminal({ machineId: TERMINAL_ID, name: 'cli', agentType: 'shell', actor, deps });

    const result = await resolveAgentTerminalById({ agentTerminalId: spawned.ok ? spawned.id : '', deps });

    expect(result).toEqual({
      ok: true,
      agentTerminalId: 'agent-terminal-1',
      sandboxId: MACHINE_SANDBOX_ID,
      cwd: SANDBOX_ROOT,
      // Unpromoted project / machine root: the machine's own shared Sprite.
      ownSprite: false,
      agentType: 'shell',
      command: null,
      streamSessionId: null,
    });
  });

  it('given a row whose branch has vanished, should deny as branch_not_found', async () => {
    const { store } = makeStore();
    const deps = makeDeps({ store });
    const spawned = await spawnAgentTerminal({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: BRANCH_NAME, name: 'cli', agentType: 'shell', actor, deps });

    const goneDeps = { ...deps, branchStore: makeBranchLookup() };
    const result = await resolveAgentTerminalById({ agentTerminalId: spawned.ok ? spawned.id : '', deps: goneDeps });

    expect(result).toEqual({ ok: false, reason: 'branch_not_found' });
  });

  it('given a pagespace (chat-surface) row id, should deny not_a_pty_agent WITHOUT acquiring the machine Sprite', async () => {
    const { store } = makeStore();
    const acquireCalls: string[] = [];
    const deps = makeDeps({
      store,
      projectStore: makeProjectLookup(),
      machineSandbox: makeMachineSandbox({
        acquire: async (machineId) => {
          acquireCalls.push(machineId);
          return { ok: true, sandboxId: MACHINE_SANDBOX_ID };
        },
      }),
    });
    const spawned = await spawnAgentTerminal({ machineId: TERMINAL_ID, name: 'agent', agentType: 'pagespace', actor, deps });

    const result = await resolveAgentTerminalById({ agentTerminalId: spawned.ok ? spawned.id : '', deps });

    expect(result).toEqual({ ok: false, reason: 'not_a_pty_agent' });
    expect(acquireCalls).toEqual([]);
  });
});

describe('listAgentTerminals', () => {
  it('given two agent terminals spawned in one branch, should list both without leaking the project/machine-scoped ones', async () => {
    const { store } = makeStore();
    const deps = makeDeps({ store });
    await spawnAgentTerminal({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: BRANCH_NAME, name: 'cli', agentType: 'shell', actor, deps });
    await spawnAgentTerminal({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: BRANCH_NAME, name: 'reviewer', agentType: 'shell', actor, deps });
    await spawnAgentTerminal({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, name: 'project-cli', agentType: 'shell', actor, deps });
    await spawnAgentTerminal({ machineId: TERMINAL_ID, name: 'machine-cli', agentType: 'shell', actor, deps });

    const result = await listAgentTerminals({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: BRANCH_NAME, deps });

    expect(result.ok).toBe(true);
    expect(result.ok && result.terminals.map((t) => t.name).sort()).toEqual(['cli', 'reviewer']);
  });

  it('given a machine scope with zero spawned terminals, should list empty rather than surfacing project/branch ones', async () => {
    const { store } = makeStore();
    const deps = makeDeps({ store });
    await spawnAgentTerminal({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: BRANCH_NAME, name: 'cli', agentType: 'shell', actor, deps });

    const result = await listAgentTerminals({ machineId: TERMINAL_ID, deps });

    expect(result).toEqual({ ok: true, terminals: [] });
  });

  it('given a legacy row whose agentType is the retired pagespace-cli, should STILL list it — dropping it would strand it with no way to clean it up', async () => {
    const { store } = makeStore([makeLegacyRow()]);
    const deps = makeDeps({ store });
    await spawnAgentTerminal({ machineId: TERMINAL_ID, name: 'cli', agentType: 'shell', actor, deps });

    const result = await listAgentTerminals({ machineId: TERMINAL_ID, deps });

    expect(result.ok).toBe(true);
    expect(result.ok && result.terminals.map((t) => t.name).sort()).toEqual(['cli', 'legacy-cli']);
  });
});

describe('killAgentTerminal', () => {
  it('given a name that was never spawned, should return not_found', async () => {
    const deps = makeDeps();
    const result = await killAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: BRANCH_NAME,
      name: 'ghost',
      deps,
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('given a branch-scoped agent terminal whose PTY was never opened (no streamSessionId), should drop the row without touching the Sprite', async () => {
    const { store, rows } = makeStore();
    const attachCalls: string[] = [];
    const deps = makeDeps({
      store,
      host: makeHost({ attach: async ({ machineId }) => { attachCalls.push(machineId); return makeHandle(); } }),
    });
    await spawnAgentTerminal({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: BRANCH_NAME, name: 'cli', agentType: 'shell', actor, deps });

    const result = await killAgentTerminal({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: BRANCH_NAME, name: 'cli', deps });

    expect(result).toEqual({ ok: true });
    expect(attachCalls).toEqual([]);
    expect(rows.size).toBe(0);
  });

  it('given a PROJECT-scoped agent terminal whose PTY was never opened (no streamSessionId), should drop the row WITHOUT acquiring the machine Sprite', async () => {
    const { store, rows } = makeStore();
    const acquireCalls: string[] = [];
    const deps = makeDeps({
      store,
      machineSandbox: makeMachineSandbox({
        acquire: async (machineId) => {
          acquireCalls.push(machineId);
          return { ok: true, sandboxId: MACHINE_SANDBOX_ID };
        },
      }),
    });
    await spawnAgentTerminal({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, name: 'cli', agentType: 'shell', actor, deps });

    const result = await killAgentTerminal({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, name: 'cli', deps });

    expect(result).toEqual({ ok: true });
    expect(acquireCalls).toEqual([]);
    expect(rows.size).toBe(0);
  });

  it('given a MACHINE-scoped agent terminal whose PTY was never opened (no streamSessionId), should drop the row WITHOUT acquiring the machine Sprite', async () => {
    const { store, rows } = makeStore();
    const acquireCalls: string[] = [];
    const deps = makeDeps({
      store,
      projectStore: makeProjectLookup(),
      machineSandbox: makeMachineSandbox({
        acquire: async (machineId) => {
          acquireCalls.push(machineId);
          return { ok: true, sandboxId: MACHINE_SANDBOX_ID };
        },
      }),
    });
    await spawnAgentTerminal({ machineId: TERMINAL_ID, name: 'cli', agentType: 'shell', actor, deps });

    const result = await killAgentTerminal({ machineId: TERMINAL_ID, name: 'cli', deps });

    expect(result).toEqual({ ok: true });
    expect(acquireCalls).toEqual([]);
    expect(rows.size).toBe(0);
  });

  it('given a pagespace (chat-surface) agent terminal (never has a streamSessionId), should drop the row WITHOUT touching the Sprite at all', async () => {
    const { store, rows } = makeStore();
    const acquireCalls: string[] = [];
    const attachCalls: string[] = [];
    const deps = makeDeps({
      store,
      projectStore: makeProjectLookup(),
      machineSandbox: makeMachineSandbox({
        acquire: async (machineId) => {
          acquireCalls.push(machineId);
          return { ok: true, sandboxId: MACHINE_SANDBOX_ID };
        },
      }),
      host: makeHost({ attach: async ({ machineId }) => { attachCalls.push(machineId); return makeHandle(); } }),
    });
    await spawnAgentTerminal({ machineId: TERMINAL_ID, name: 'agent', agentType: 'pagespace', actor, deps });

    const result = await killAgentTerminal({ machineId: TERMINAL_ID, name: 'agent', deps });

    expect(result).toEqual({ ok: true });
    expect(acquireCalls).toEqual([]);
    expect(attachCalls).toEqual([]);
    expect(rows.size).toBe(0);
  });

  it('given a branch-scoped agent terminal whose PTY IS running, should attach the ISOLATED branch Sprite, kill that specific session by id via the REST endpoint, and drop the row', async () => {
    const { store, rows } = makeStore([
      {
        id: 'agent-terminal-1',
        ownerId: 'user-1',
        machineId: TERMINAL_ID,
        scope: 'branch',
        projectName: PROJECT_NAME,
        machineBranchId: BRANCH_ID,
        name: 'cli',
        agentType: 'shell',
        command: null,
        streamSessionId: 'sess-abc',
        coldTail: null,
        coldTailAt: null,
        coldTailHasOutput: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const killed: string[] = [];
    let attachedMachineId: string | undefined;
    const deps = makeDeps({
      store,
      host: makeHost({
        attach: async ({ machineId }) => {
          attachedMachineId = machineId;
          return machineId === BRANCH_SANDBOX_ID
            ? makeHandle({ killSession: async (sessionId) => { killed.push(sessionId); } })
            : null;
        },
      }),
    });

    const result = await killAgentTerminal({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: BRANCH_NAME, name: 'cli', deps });

    expect(result).toEqual({ ok: true });
    expect(attachedMachineId).toBe(BRANCH_SANDBOX_ID);
    expect(killed).toEqual(['sess-abc']);
    expect(rows.size).toBe(0);
  });

  it('given a project-scoped agent terminal whose PTY IS running, should attach the SAME machine Sprite, kill that session by id, and drop the row', async () => {
    const { store, rows } = makeStore([
      {
        id: 'agent-terminal-1',
        ownerId: 'user-1',
        machineId: TERMINAL_ID,
        scope: 'project',
        projectName: PROJECT_NAME,
        machineBranchId: null,
        name: 'cli',
        agentType: 'shell',
        command: null,
        streamSessionId: 'sess-proj',
        coldTail: null,
        coldTailAt: null,
        coldTailHasOutput: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    let attachedMachineId: string | undefined;
    const killed: string[] = [];
    const deps = makeDeps({
      store,
      host: makeHost({
        attach: async ({ machineId }) => {
          attachedMachineId = machineId;
          return makeHandle({ machineId, killSession: async (sessionId) => { killed.push(sessionId); } });
        },
      }),
    });

    const result = await killAgentTerminal({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, name: 'cli', deps });

    expect(result).toEqual({ ok: true });
    expect(attachedMachineId).toBe(MACHINE_SANDBOX_ID);
    expect(killed).toEqual(['sess-proj']);
    expect(rows.size).toBe(0);
  });

  it('given a machine-scoped agent terminal whose PTY IS running, should attach the machine Sprite, kill that session by id, and drop the row', async () => {
    const { store, rows } = makeStore([
      {
        id: 'agent-terminal-1',
        ownerId: 'user-1',
        machineId: TERMINAL_ID,
        scope: 'machine',
        projectName: null,
        machineBranchId: null,
        name: 'cli',
        agentType: 'shell',
        command: null,
        streamSessionId: 'sess-machine',
        coldTail: null,
        coldTailAt: null,
        coldTailHasOutput: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    let attachedMachineId: string | undefined;
    const killed: string[] = [];
    const deps = makeDeps({
      store,
      projectStore: makeProjectLookup(),
      host: makeHost({
        attach: async ({ machineId }) => {
          attachedMachineId = machineId;
          return makeHandle({ machineId, killSession: async (sessionId) => { killed.push(sessionId); } });
        },
      }),
    });

    const result = await killAgentTerminal({ machineId: TERMINAL_ID, name: 'cli', deps });

    expect(result).toEqual({ ok: true });
    expect(attachedMachineId).toBe(MACHINE_SANDBOX_ID);
    expect(killed).toEqual(['sess-machine']);
    expect(rows.size).toBe(0);
  });

  it('given the branch Sprite has vanished, should still drop the row (nothing left to orphan)', async () => {
    const { store, rows } = makeStore([
      {
        id: 'agent-terminal-1',
        ownerId: 'user-1',
        machineId: TERMINAL_ID,
        scope: 'branch',
        projectName: PROJECT_NAME,
        machineBranchId: BRANCH_ID,
        name: 'cli',
        agentType: 'shell',
        command: null,
        streamSessionId: 'sess-abc',
        coldTail: null,
        coldTailAt: null,
        coldTailHasOutput: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const deps = makeDeps({ store, host: makeHost({ attach: async () => null }) });

    const result = await killAgentTerminal({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: BRANCH_NAME, name: 'cli', deps });

    expect(result).toEqual({ ok: true });
    expect(rows.size).toBe(0);
  });

  // sprites 2-3: the REST kill-by-id endpoint (`MachineHandle.killSession`) is
  // idempotent against a session the Sprite no longer recognizes — it resolves
  // rather than rejecting (see sprites.ts's `killSpriteSession`) — so a dangling
  // streamSessionId (the exec session died with a Sprite pause, or was already
  // killed) drops the row cleanly with no separate listing/corroboration step.
  it('given a dangling streamSessionId the Sprite no longer recognizes, should still drop the row — killSession is idempotent', async () => {
    const { store, rows } = makeStore([
      {
        id: 'agent-terminal-1',
        ownerId: 'user-1',
        machineId: TERMINAL_ID,
        scope: 'branch',
        projectName: PROJECT_NAME,
        machineBranchId: BRANCH_ID,
        name: 'cli',
        agentType: 'shell',
        command: null,
        streamSessionId: 'sess-dangling',
        coldTail: null,
        coldTailAt: null,
        coldTailHasOutput: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const deps = makeDeps({
      store,
      host: makeHost({
        attach: async () => makeHandle({ killSession: async () => {} }), // already-gone session: resolves, does not throw
      }),
    });

    const result = await killAgentTerminal({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: BRANCH_NAME, name: 'cli', deps });

    expect(result).toEqual({ ok: true });
    expect(rows.size).toBe(0);
  });

  it('given the session-kill call fails (control-plane outage, auth), should KEEP the row rather than orphan a possibly-live PTY', async () => {
    const { store, rows } = makeStore([
      {
        id: 'agent-terminal-1',
        ownerId: 'user-1',
        machineId: TERMINAL_ID,
        scope: 'branch',
        projectName: PROJECT_NAME,
        machineBranchId: BRANCH_ID,
        name: 'cli',
        agentType: 'shell',
        command: null,
        streamSessionId: 'sess-abc',
        coldTail: null,
        coldTailAt: null,
        coldTailHasOutput: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const deps = makeDeps({
      store,
      host: makeHost({
        attach: async () =>
          makeHandle({
            killSession: async () => {
              throw Object.assign(new Error('sprite control plane unavailable'), { status: 500 });
            },
          }),
      }),
    });

    const result = await killAgentTerminal({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: BRANCH_NAME, name: 'cli', deps });

    // Dropping the row here would leave a possibly still-running, billable agent
    // process with nothing pointing at it. A failed kill is not a licence to delete.
    expect(result).toEqual({ ok: false, reason: 'error' });
    expect(rows.size).toBe(1);
  });

  it('given the Sprite attach itself throws, should keep the row so a retry can find it again', async () => {
    const { store, rows } = makeStore([
      {
        id: 'agent-terminal-1',
        ownerId: 'user-1',
        machineId: TERMINAL_ID,
        scope: 'branch',
        projectName: PROJECT_NAME,
        machineBranchId: BRANCH_ID,
        name: 'cli',
        agentType: 'shell',
        command: null,
        streamSessionId: 'sess-abc',
        coldTail: null,
        coldTailAt: null,
        coldTailHasOutput: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const deps = makeDeps({
      store,
      host: makeHost({
        attach: async () => {
          throw new Error('sprite api down');
        },
      }),
    });

    const result = await killAgentTerminal({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: BRANCH_NAME, name: 'cli', deps });

    expect(result).toEqual({ ok: false, reason: 'error' });
    expect(rows.size).toBe(1);
  });
});

describe('store.recordColdTail (issue #2205)', () => {
  it('given a row with no prior cold tail, should write the tail, endedAt, and hasOutput', async () => {
    const { store, rows } = makeStore();
    const spawned = await spawnAgentTerminal({ machineId: TERMINAL_ID, name: 'cli', agentType: 'shell', actor, deps: makeDeps({ store }) });
    const id = spawned.ok ? spawned.id : '';
    const endedAt = new Date('2026-01-02T00:00:00Z');

    await store.recordColdTail({ id, tail: 'last output', hasOutput: true, endedAt, now: endedAt });

    const row = [...rows.values()].find((r) => r.id === id);
    expect(row).toMatchObject({ coldTail: 'last output', coldTailAt: endedAt, coldTailHasOutput: true });
  });

  it('given a row that already has a cold tail, should OVERWRITE it in place rather than appending — the tail belongs to the LAST dead incarnation only', async () => {
    const { store, rows } = makeStore();
    const spawned = await spawnAgentTerminal({ machineId: TERMINAL_ID, name: 'cli', agentType: 'shell', actor, deps: makeDeps({ store }) });
    const id = spawned.ok ? spawned.id : '';
    await store.recordColdTail({ id, tail: 'old incarnation', hasOutput: true, endedAt: new Date('2026-01-01'), now: new Date('2026-01-01') });

    const endedAt = new Date('2026-01-03T00:00:00Z');
    await store.recordColdTail({ id, tail: 'new incarnation', hasOutput: false, endedAt, now: endedAt });

    const row = [...rows.values()].find((r) => r.id === id);
    expect(row).toMatchObject({ coldTail: 'new incarnation', coldTailAt: endedAt, coldTailHasOutput: false });
  });
});

describe('killAgentTerminalById — level-agnostic (PurePoint Attach{agent_id} parity)', () => {
  it('given an unknown id, should return not_found', async () => {
    const deps = makeDeps();
    const result = await killAgentTerminalById({ agentTerminalId: 'ghost', deps });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('given a branch-scoped row id whose PTY IS running, should kill it purely by id (no project/branch name needed)', async () => {
    const { store, rows } = makeStore();
    const deps = makeDeps({ store });
    const spawned = await spawnAgentTerminal({ machineId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: BRANCH_NAME, name: 'cli', agentType: 'shell', actor, deps });
    const id = spawned.ok ? spawned.id : '';
    await store.updateStreamSessionId({ id, streamSessionId: 'sess-abc', now: NOW });

    const killed: string[] = [];
    const killDeps = {
      ...deps,
      host: makeHost({
        attach: async ({ machineId }) =>
          machineId === BRANCH_SANDBOX_ID
            ? makeHandle({ killSession: async (sessionId) => { killed.push(sessionId); } })
            : null,
      }),
    };

    const result = await killAgentTerminalById({ agentTerminalId: id, deps: killDeps });

    expect(result).toEqual({ ok: true });
    expect(killed).toEqual(['sess-abc']);
    expect(rows.size).toBe(0);
  });

  it('given a machine-scoped row id whose PTY was never opened (no streamSessionId), should drop the row WITHOUT acquiring the machine Sprite', async () => {
    const { store, rows } = makeStore();
    const acquireCalls: string[] = [];
    const deps = makeDeps({
      store,
      projectStore: makeProjectLookup(),
      machineSandbox: makeMachineSandbox({
        acquire: async (machineId) => {
          acquireCalls.push(machineId);
          return { ok: true, sandboxId: MACHINE_SANDBOX_ID };
        },
      }),
    });
    const spawned = await spawnAgentTerminal({ machineId: TERMINAL_ID, name: 'cli', agentType: 'shell', actor, deps });

    const result = await killAgentTerminalById({ agentTerminalId: spawned.ok ? spawned.id : '', deps });

    expect(result).toEqual({ ok: true });
    expect(acquireCalls).toEqual([]);
    expect(rows.size).toBe(0);
  });

  it('given a pagespace (chat-surface) row id (never has a streamSessionId), should drop the row WITHOUT touching the Sprite at all', async () => {
    const { store, rows } = makeStore();
    const acquireCalls: string[] = [];
    const attachCalls: string[] = [];
    const deps = makeDeps({
      store,
      projectStore: makeProjectLookup(),
      machineSandbox: makeMachineSandbox({
        acquire: async (machineId) => {
          acquireCalls.push(machineId);
          return { ok: true, sandboxId: MACHINE_SANDBOX_ID };
        },
      }),
      host: makeHost({ attach: async ({ machineId }) => { attachCalls.push(machineId); return makeHandle(); } }),
    });
    const spawned = await spawnAgentTerminal({ machineId: TERMINAL_ID, name: 'agent', agentType: 'pagespace', actor, deps });

    const result = await killAgentTerminalById({ agentTerminalId: spawned.ok ? spawned.id : '', deps });

    expect(result).toEqual({ ok: true });
    expect(acquireCalls).toEqual([]);
    expect(attachCalls).toEqual([]);
    expect(rows.size).toBe(0);
  });
});

/**
 * Issue #2204 follow-up, F10. Promotion deletes the root checkout and points
 * every project row at the new Sprite — but a PTY's process lives in the old
 * Sprite and cannot follow, so a pre-existing live session would be left
 * running somewhere no reconnect can reach.
 */
describe('findStrandedLiveSessions', () => {
  it('given rows whose PTYs are in the Sprite listing, should name them', () => {
    expect(
      findStrandedLiveSessions(
        [
          { name: 'build', streamSessionId: 'stream-1' },
          { name: 'notes', streamSessionId: null },
          { name: 'watch', streamSessionId: 'stream-2' },
        ],
        new Set(['stream-1', 'stream-2']),
      ),
    ).toEqual(['build', 'watch']);
  });

  it('given a row whose PTY has EXITED, should not treat the historical id as live', () => {
    // streamSessionId is never cleared, so this is the case that would
    // otherwise block every later project-scoped spawn permanently.
    expect(
      findStrandedLiveSessions([{ name: 'build', streamSessionId: 'stream-old' }], new Set(['stream-other'])),
    ).toEqual([]);
  });

  it('given an empty Sprite listing, should find nothing live', () => {
    expect(findStrandedLiveSessions([{ name: 'build', streamSessionId: 'stream-1' }], new Set())).toEqual([]);
  });

  it('given only reserved-but-never-launched rows, should find nothing to strand', () => {
    expect(findStrandedLiveSessions([{ name: 'cli', streamSessionId: null }], new Set(['x']))).toEqual([]);
  });

  it('given no rows at all, should find nothing', () => {
    expect(findStrandedLiveSessions([], new Set(['x']))).toEqual([]);
  });
});

describe('spawnAgentTerminal — live sessions block promotion (F10)', () => {
  function promotableProject() {
    const row: { path: string; sandboxId: string | null; spriteTornDownAt: Date | null } = {
      path: PROJECT_PATH,
      sandboxId: null,
      spriteTornDownAt: null,
    };
    const lookup: AgentTerminalProjectLookup = {
      findByName: async (machineId, name) => (machineId === TERMINAL_ID && name === PROJECT_NAME ? row : null),
    };
    return { row, lookup };
  }

  it('given an unpromoted project with a LIVE PTY, should refuse and promote nothing', async () => {
    const { lookup } = promotableProject();
    const { store } = makeStore();
    // A session reserved and launched BEFORE this rollout, on the machine's own Sprite.
    const existing = await store.create({
      ownerId: actor.userId,
      machineId: TERMINAL_ID,
      scope: 'project',
      projectName: PROJECT_NAME,
      machineBranchId: null,
      name: 'build',
      agentType: 'shell',
      command: null,
      now: new Date('2026-01-01'),
    });
    await store.updateStreamSessionId({ id: existing.id, streamSessionId: 'stream-1', now: new Date('2026-01-01') });

    const promotionCalls: unknown[] = [];
    const deps = makeDeps({
      store,
      projectStore: lookup,
      liveSessions: { list: async () => ['stream-1'] },
      projectPromotion: {
        promote: async (input) => {
          promotionCalls.push(input);
          return { ok: true };
        },
      },
    });

    const spawned = await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      name: 'cli',
      agentType: 'shell',
      actor,
      deps,
    });

    expect(spawned).toMatchObject({ ok: false, reason: 'live_sessions_block_promotion' });
    expect(spawned.ok === false && spawned.detail).toContain('build');
    expect(promotionCalls).toEqual([]);
  });

  it('given an unpromoted project whose rows never launched a PTY, should promote as before', async () => {
    const { row, lookup } = promotableProject();
    const { store } = makeStore();
    await store.create({
      ownerId: actor.userId,
      machineId: TERMINAL_ID,
      scope: 'project',
      projectName: PROJECT_NAME,
      machineBranchId: null,
      name: 'notes',
      agentType: 'claude',
      command: null,
      now: new Date('2026-01-01'),
    });

    const deps = makeDeps({
      store,
      projectStore: lookup,
      // Never consulted: no row here ever launched a PTY.
      liveSessions: { list: async () => { throw new Error('probe must not be paid for'); } },
      projectPromotion: {
        promote: async () => {
          row.sandboxId = 'sprite-project-1';
          return { ok: true };
        },
      },
    });

    const spawned = await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      name: 'cli',
      agentType: 'shell',
      actor,
      deps,
    });

    expect(spawned).toMatchObject({ ok: true });
    expect(row.sandboxId).toBe('sprite-project-1');
  });
});

/**
 * Codex P2 on PR #2209: `streamSessionId` records a session that existed at
 * some point and is never cleared, so the promotion gate must ask the Sprite
 * what is running rather than trust the column.
 */
describe('spawnAgentTerminal — promotion gate consults real PTY liveness', () => {
  async function projectWithLaunchedRow(streamSessionId: string) {
    const row: { path: string; sandboxId: string | null; spriteTornDownAt: Date | null } = {
      path: PROJECT_PATH,
      sandboxId: null,
      spriteTornDownAt: null,
    };
    const lookup: AgentTerminalProjectLookup = {
      findByName: async (machineId, name) => (machineId === TERMINAL_ID && name === PROJECT_NAME ? row : null),
    };
    const { store } = makeStore();
    const existing = await store.create({
      ownerId: actor.userId,
      machineId: TERMINAL_ID,
      scope: 'project',
      projectName: PROJECT_NAME,
      machineBranchId: null,
      name: 'build',
      agentType: 'shell',
      command: null,
      now: new Date('2026-01-01'),
    });
    await store.updateStreamSessionId({ id: existing.id, streamSessionId, now: new Date('2026-01-01') });
    return { row, lookup, store };
  }

  it('given a row whose PTY has EXITED, should promote rather than block forever', async () => {
    const { row, lookup, store } = await projectWithLaunchedRow('stream-dead');
    const deps = makeDeps({
      store,
      projectStore: lookup,
      // The Sprite is running something else entirely — our session is gone.
      liveSessions: { list: async () => ['stream-unrelated'] },
      projectPromotion: {
        promote: async () => {
          row.sandboxId = 'sprite-project-1';
          return { ok: true };
        },
      },
    });

    const spawned = await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      name: 'cli',
      agentType: 'shell',
      actor,
      deps,
    });

    expect(spawned).toMatchObject({ ok: true });
    expect(row.sandboxId).toBe('sprite-project-1');
  });

  it('given a Sprite that cannot be probed, should refuse rather than risk stranding a live process', async () => {
    const { lookup, store } = await projectWithLaunchedRow('stream-1');
    const promotionCalls: unknown[] = [];
    const deps = makeDeps({
      store,
      projectStore: lookup,
      liveSessions: { list: async () => null },
      projectPromotion: {
        promote: async (input) => {
          promotionCalls.push(input);
          return { ok: true };
        },
      },
    });

    const spawned = await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      name: 'cli',
      agentType: 'shell',
      actor,
      deps,
    });

    expect(spawned).toMatchObject({ ok: false, reason: 'live_sessions_block_promotion' });
    expect(spawned.ok === false && spawned.detail).toContain('Could not verify');
    expect(promotionCalls).toEqual([]);
  });

  it('given NO liveness probe wired at all, should also refuse — an unverifiable answer is not a negative one', async () => {
    const { lookup, store } = await projectWithLaunchedRow('stream-1');
    const deps = makeDeps({
      store,
      projectStore: lookup,
      projectPromotion: { promote: async () => ({ ok: true }) },
    });

    const spawned = await spawnAgentTerminal({
      machineId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      name: 'cli',
      agentType: 'shell',
      actor,
      deps,
    });

    expect(spawned).toMatchObject({ ok: false, reason: 'live_sessions_block_promotion' });
  });
});
