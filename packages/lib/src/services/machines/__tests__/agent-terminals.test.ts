import { describe, it, expect } from 'vitest';
import {
  planSpawnAgentTerminal,
  spawnAgentTerminal,
  resolveAgentTerminal,
  killAgentTerminal,
  listAgentTerminals,
  type AgentTerminalsDeps,
  type AgentTerminalBranchLookup,
} from '../agent-terminals';
import type { MachineAgentTerminalStore, MachineAgentTerminalRecord } from '../agent-terminals-store';
import type { MachineHost, MachineHandle } from '../../sandbox/machine-host';

const NOW = new Date('2026-07-06T12:00:00.000Z');
const TERMINAL_ID = 'terminal-1';
const PROJECT_NAME = 'my-repo';
const BRANCH_NAME = 'feature-x';
const BRANCH_ID = 'branch-1';
const SANDBOX_ID = 'sprite-branch-1';

const actor = { userId: 'user-1' };

function makeBranchLookup(rows: Record<string, { id: string; sandboxId: string }> = {}): AgentTerminalBranchLookup {
  return {
    findByName: async (terminalId, projectName, branchName) =>
      rows[`${terminalId}\0${projectName}\0${branchName}`] ?? null,
  };
}

const defaultBranchLookup = makeBranchLookup({
  [`${TERMINAL_ID}\0${PROJECT_NAME}\0${BRANCH_NAME}`]: { id: BRANCH_ID, sandboxId: SANDBOX_ID },
});

function makeStore(seed: MachineAgentTerminalRecord[] = []) {
  const rows = new Map<string, MachineAgentTerminalRecord>();
  const key = (machineBranchId: string, name: string) => `${machineBranchId}\0${name}`;
  for (const row of seed) rows.set(key(row.machineBranchId, row.name), row);
  let counter = 0;
  const store: MachineAgentTerminalStore = {
    list: async (machineBranchId) => [...rows.values()].filter((r) => r.machineBranchId === machineBranchId),
    findByName: async (machineBranchId, name) => rows.get(key(machineBranchId, name)) ?? null,
    create: async (input) => {
      const k = key(input.machineBranchId, input.name);
      if (rows.has(k)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }
      counter += 1;
      const row: MachineAgentTerminalRecord = {
        id: `agent-terminal-${counter}`,
        ownerId: input.ownerId,
        machineBranchId: input.machineBranchId,
        name: input.name,
        agentType: input.agentType,
        streamSessionId: null,
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
    remove: async (machineBranchId, name) => {
      rows.delete(key(machineBranchId, name));
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
    machineId: SANDBOX_ID,
    exec: async () => ({ success: true, exitCode: 0, stdout: '', stderr: '' }),
    writeFiles: async () => {},
    readFile: async () => null,
    stream: async () => ({
      write: () => {},
      resize: () => {},
      onData: () => {},
      onExit: () => {},
      onError: () => {},
      kill: () => {},
    }),
    listStreams: async () => [],
    ...over,
  };
}

function makeDeps(overrides: Partial<AgentTerminalsDeps> = {}): AgentTerminalsDeps {
  return {
    branchStore: defaultBranchLookup,
    store: makeStore().store,
    host: makeHost(),
    now: () => NOW,
    ...overrides,
  };
}

describe('planSpawnAgentTerminal', () => {
  it('given a valid name and known agent type, should allow it', () => {
    expect(planSpawnAgentTerminal({ name: 'reviewer', agentType: 'claude' })).toEqual({ ok: true });
  });

  it('given an invalid name, should reject it', () => {
    expect(planSpawnAgentTerminal({ name: '../etc', agentType: 'claude' })).toEqual({
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
});

describe('spawnAgentTerminal', () => {
  it('given a branch that does not exist, should deny', async () => {
    const deps = makeDeps({ branchStore: makeBranchLookup() });
    const result = await spawnAgentTerminal({
      terminalId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: BRANCH_NAME,
      name: 'cli',
      agentType: 'pagespace-cli',
      actor,
      deps,
    });
    expect(result).toEqual({ ok: false, reason: 'branch_not_found' });
  });

  it('given a fresh name, should reserve a pagespace-cli agent terminal', async () => {
    const { store, rows } = makeStore();
    const deps = makeDeps({ store });
    const result = await spawnAgentTerminal({
      terminalId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: BRANCH_NAME,
      name: 'cli',
      agentType: 'pagespace-cli',
      actor,
      deps,
    });
    expect(result).toMatchObject({ ok: true, agentType: 'pagespace-cli', resumed: false });
    expect(rows.get(`${BRANCH_ID}\0cli`)?.agentType).toBe('pagespace-cli');
  });

  it('given a second, differently-named spawn in the SAME branch, should let a claude terminal coexist with the pagespace-cli one', async () => {
    const { store, rows } = makeStore();
    const deps = makeDeps({ store });

    await spawnAgentTerminal({
      terminalId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: BRANCH_NAME,
      name: 'cli',
      agentType: 'pagespace-cli',
      actor,
      deps,
    });
    const claudeResult = await spawnAgentTerminal({
      terminalId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: BRANCH_NAME,
      name: 'reviewer',
      agentType: 'claude',
      actor,
      deps,
    });

    expect(claudeResult).toMatchObject({ ok: true, agentType: 'claude', resumed: false });
    expect(rows.size).toBe(2);
    expect([...rows.values()].map((r) => r.agentType).sort()).toEqual(['claude', 'pagespace-cli']);
  });

  it('given a repeat spawn of the same (name, agentType), should resume idempotently rather than duplicate', async () => {
    const { store } = makeStore();
    const deps = makeDeps({ store });

    const first = await spawnAgentTerminal({
      terminalId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: BRANCH_NAME,
      name: 'cli',
      agentType: 'pagespace-cli',
      actor,
      deps,
    });
    const second = await spawnAgentTerminal({
      terminalId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: BRANCH_NAME,
      name: 'cli',
      agentType: 'pagespace-cli',
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
      terminalId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: BRANCH_NAME,
      name: 'agent',
      agentType: 'claude',
      actor,
      deps,
    });
    const conflicting = await spawnAgentTerminal({
      terminalId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: BRANCH_NAME,
      name: 'agent',
      agentType: 'codex',
      actor,
      deps,
    });

    expect(conflicting).toEqual({ ok: false, reason: 'name_in_use' });
  });
});

describe('resolveAgentTerminal', () => {
  it('given an unknown branch, should deny', async () => {
    const deps = makeDeps({ branchStore: makeBranchLookup() });
    const result = await resolveAgentTerminal({
      terminalId: TERMINAL_ID,
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
      terminalId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: BRANCH_NAME,
      name: 'ghost',
      deps,
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('given a spawned agent terminal, should resolve its Sprite, launch spec, and known session id', async () => {
    const { store } = makeStore();
    const deps = makeDeps({ store });
    await spawnAgentTerminal({
      terminalId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: BRANCH_NAME,
      name: 'cli',
      agentType: 'pagespace-cli',
      actor,
      deps,
    });

    const result = await resolveAgentTerminal({
      terminalId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: BRANCH_NAME,
      name: 'cli',
      deps,
    });

    expect(result).toEqual({
      ok: true,
      agentTerminalId: 'agent-terminal-1',
      sandboxId: SANDBOX_ID,
      agentType: 'pagespace-cli',
      streamSessionId: null,
    });
  });
});

describe('listAgentTerminals', () => {
  it('given two agent terminals spawned in one branch, should list both', async () => {
    const { store } = makeStore();
    const deps = makeDeps({ store });
    await spawnAgentTerminal({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: BRANCH_NAME, name: 'cli', agentType: 'pagespace-cli', actor, deps });
    await spawnAgentTerminal({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: BRANCH_NAME, name: 'reviewer', agentType: 'claude', actor, deps });

    const result = await listAgentTerminals({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: BRANCH_NAME, deps });

    expect(result.ok).toBe(true);
    expect(result.ok && result.terminals.map((t) => t.name).sort()).toEqual(['cli', 'reviewer']);
  });
});

describe('killAgentTerminal', () => {
  it('given a name that was never spawned, should return not_found', async () => {
    const deps = makeDeps();
    const result = await killAgentTerminal({
      terminalId: TERMINAL_ID,
      projectName: PROJECT_NAME,
      branchName: BRANCH_NAME,
      name: 'ghost',
      deps,
    });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('given an agent terminal whose PTY was never opened (no streamSessionId), should drop the row without touching the Sprite', async () => {
    const { store, rows } = makeStore();
    const attachCalls: string[] = [];
    const deps = makeDeps({
      store,
      host: makeHost({ attach: async ({ machineId }) => { attachCalls.push(machineId); return makeHandle(); } }),
    });
    await spawnAgentTerminal({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: BRANCH_NAME, name: 'cli', agentType: 'pagespace-cli', actor, deps });

    const result = await killAgentTerminal({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: BRANCH_NAME, name: 'cli', deps });

    expect(result).toEqual({ ok: true });
    expect(attachCalls).toEqual([]);
    expect(rows.size).toBe(0);
  });

  it('given an agent terminal whose PTY IS running, should attach the branch Sprite, kill that specific session, and drop the row', async () => {
    const { store, rows } = makeStore([
      {
        id: 'agent-terminal-1',
        ownerId: 'user-1',
        machineBranchId: BRANCH_ID,
        name: 'cli',
        agentType: 'pagespace-cli',
        streamSessionId: 'sess-abc',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const killed: string[] = [];
    let attachedSessionId: string | undefined;
    const deps = makeDeps({
      store,
      host: makeHost({
        attach: async ({ machineId }) =>
          machineId === SANDBOX_ID
            ? makeHandle({
                stream: async ({ sessionId }) => {
                  attachedSessionId = sessionId;
                  return {
                    write: () => {},
                    resize: () => {},
                    onData: () => {},
                    onExit: () => {},
                    onError: () => {},
                    kill: (signal) => killed.push(signal ?? 'SIGTERM'),
                  };
                },
              })
            : null,
      }),
    });

    const result = await killAgentTerminal({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: BRANCH_NAME, name: 'cli', deps });

    expect(result).toEqual({ ok: true });
    expect(attachedSessionId).toBe('sess-abc');
    expect(killed).toEqual(['SIGKILL']);
    expect(rows.size).toBe(0);
  });

  it('given the branch Sprite has vanished, should still drop the row (nothing left to orphan)', async () => {
    const { store, rows } = makeStore([
      {
        id: 'agent-terminal-1',
        ownerId: 'user-1',
        machineBranchId: BRANCH_ID,
        name: 'cli',
        agentType: 'pagespace-cli',
        streamSessionId: 'sess-abc',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const deps = makeDeps({ store, host: makeHost({ attach: async () => null }) });

    const result = await killAgentTerminal({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: BRANCH_NAME, name: 'cli', deps });

    expect(result).toEqual({ ok: true });
    expect(rows.size).toBe(0);
  });

  it('given the Sprite kill throws, should keep the row so a retry can find it again', async () => {
    const { store, rows } = makeStore([
      {
        id: 'agent-terminal-1',
        ownerId: 'user-1',
        machineBranchId: BRANCH_ID,
        name: 'cli',
        agentType: 'pagespace-cli',
        streamSessionId: 'sess-abc',
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

    const result = await killAgentTerminal({ terminalId: TERMINAL_ID, projectName: PROJECT_NAME, branchName: BRANCH_NAME, name: 'cli', deps });

    expect(result).toEqual({ ok: false, reason: 'error' });
    expect(rows.size).toBe(1);
  });
});
