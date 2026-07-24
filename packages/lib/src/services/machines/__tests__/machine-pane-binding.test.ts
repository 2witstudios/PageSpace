import { describe, it, expect } from 'vitest';
import {
  deriveMachinePaneBinding,
  resolveMachineNodeTarget,
  type DeriveMachinePaneBindingDeps,
  type MachineNodeHandle,
} from '../machine-pane-binding';
import type { MachineAgentTerminalRecord } from '../agent-terminals-store';
import { SANDBOX_ROOT } from '../../sandbox/sandbox-paths';
import { BRANCH_REPO_PATH } from '../machine-branches';
import { PROJECT_REPO_PATH } from '../machine-project-promotion';

const NOW = new Date('2026-07-20T12:00:00.000Z');
const MACHINE_ID = 'machine-1';
const CONVERSATION_ID = 'agent-terminal-1';
const PROJECT_NAME = 'my-repo';
const PROJECT_PATH = '/workspace/projects/my-repo';
const BRANCH_ID = 'branch-1';
const BRANCH_SANDBOX_ID = 'sprite-branch-1';
const SIBLING_PROJECT_NAME = 'other-repo';
const SIBLING_PROJECT_PATH = '/workspace/projects/other-repo';
const SIBLING_BRANCH_ID = 'branch-2';
const SIBLING_BRANCH_SANDBOX_ID = 'sprite-branch-2';

function makeRow(overrides: Partial<MachineAgentTerminalRecord> = {}): MachineAgentTerminalRecord {
  return {
    id: CONVERSATION_ID,
    ownerId: 'user-1',
    machineId: MACHINE_ID,
    scope: 'machine',
    projectName: null,
    machineBranchId: null,
    name: 'pagespace-agent',
    agentType: 'pagespace',
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

function makeTerminalStore(row: MachineAgentTerminalRecord | null): DeriveMachinePaneBindingDeps['terminalStore'] {
  return { findById: async (id) => (id === CONVERSATION_ID ? row : null) };
}

type ProjectRow = { name: string; path: string; id?: string; sandboxId?: string | null; spriteTornDownAt?: Date | null };
type BranchRow = {
  id: string;
  projectName: string;
  branchName: string;
  sandboxId: string;
  spriteTornDownAt: Date | null;
};

function makeProjectLookup(rows: ProjectRow[] = []): DeriveMachinePaneBindingDeps['projectLookup'] {
  return {
    findByName: async (machineId, name) =>
      machineId === MACHINE_ID ? (rows.find((r) => r.name === name) ?? null) : null,
    list: async (machineId) => (machineId === MACHINE_ID ? rows : []),
  };
}

function makeBranchLookup(rows: BranchRow[] = []): DeriveMachinePaneBindingDeps['branchLookup'] {
  return {
    findById: async (id) => rows.find((r) => r.id === id) ?? null,
    list: async (machineId, projectName) =>
      machineId === MACHINE_ID ? rows.filter((r) => r.projectName === projectName) : [],
    listAll: async (machineId) => (machineId === MACHINE_ID ? rows : []),
  };
}

/** The two-project / one-branch-each fixture every cascade test below derives from. */
const PROJECT_ROWS: ProjectRow[] = [
  { name: PROJECT_NAME, path: PROJECT_PATH },
  { name: SIBLING_PROJECT_NAME, path: SIBLING_PROJECT_PATH },
];
const BRANCH_ROWS: BranchRow[] = [
  {
    id: BRANCH_ID,
    projectName: PROJECT_NAME,
    branchName: 'feature',
    sandboxId: BRANCH_SANDBOX_ID,
    spriteTornDownAt: null,
  },
  {
    id: SIBLING_BRANCH_ID,
    projectName: SIBLING_PROJECT_NAME,
    branchName: 'sibling-feature',
    sandboxId: SIBLING_BRANCH_SANDBOX_ID,
    spriteTornDownAt: null,
  },
];

const MACHINE_HANDLE: MachineNodeHandle = { kind: 'machine', machineId: MACHINE_ID, cwd: SANDBOX_ROOT };
const PROJECT_HANDLE: MachineNodeHandle = {
  kind: 'project',
  machineId: MACHINE_ID,
  project: PROJECT_NAME,
  cwd: PROJECT_PATH,
};
const SIBLING_PROJECT_HANDLE: MachineNodeHandle = {
  kind: 'project',
  machineId: MACHINE_ID,
  project: SIBLING_PROJECT_NAME,
  cwd: SIBLING_PROJECT_PATH,
};
const BRANCH_HANDLE: MachineNodeHandle = {
  kind: 'branch',
  machineId: MACHINE_ID,
  project: PROJECT_NAME,
  branch: 'feature',
  cwd: BRANCH_REPO_PATH,
  branchSandbox: { machineBranchId: BRANCH_ID, sandboxId: BRANCH_SANDBOX_ID },
};
const SIBLING_BRANCH_HANDLE: MachineNodeHandle = {
  kind: 'branch',
  machineId: MACHINE_ID,
  project: SIBLING_PROJECT_NAME,
  branch: 'sibling-feature',
  cwd: BRANCH_REPO_PATH,
  branchSandbox: { machineBranchId: SIBLING_BRANCH_ID, sandboxId: SIBLING_BRANCH_SANDBOX_ID },
};

function makeCascadeDeps(row: MachineAgentTerminalRecord): DeriveMachinePaneBindingDeps {
  return makeDeps({
    terminalStore: makeTerminalStore(row),
    projectLookup: makeProjectLookup(PROJECT_ROWS),
    branchLookup: makeBranchLookup(BRANCH_ROWS),
  });
}

async function deriveOk(deps: DeriveMachinePaneBindingDeps) {
  const result = await deriveMachinePaneBinding({ chatId: MACHINE_ID, conversationId: CONVERSATION_ID }, deps);
  if (!result || !result.ok) throw new Error(`expected an ok binding, got ${JSON.stringify(result)}`);
  return result.binding;
}

function makeDeps(overrides: Partial<DeriveMachinePaneBindingDeps> = {}): DeriveMachinePaneBindingDeps {
  return {
    terminalStore: makeTerminalStore(null),
    projectLookup: makeProjectLookup(),
    branchLookup: makeBranchLookup(),
    ...overrides,
  };
}

describe('deriveMachinePaneBinding', () => {
  it('given no row, should return null', async () => {
    const deps = makeDeps({ terminalStore: makeTerminalStore(null) });
    const result = await deriveMachinePaneBinding({ chatId: MACHINE_ID, conversationId: CONVERSATION_ID }, deps);
    expect(result).toBeNull();
  });

  it('given a non-pagespace (pty-surface) row, should return null', async () => {
    const row = makeRow({ agentType: 'shell' });
    const deps = makeDeps({ terminalStore: makeTerminalStore(row) });
    const result = await deriveMachinePaneBinding({ chatId: MACHINE_ID, conversationId: CONVERSATION_ID }, deps);
    expect(result).toBeNull();
  });

  it('given a row with an unrecognized/retired agentType (e.g. pagespace-cli), should return null', async () => {
    const row = makeRow({ agentType: 'pagespace-cli' });
    const deps = makeDeps({ terminalStore: makeTerminalStore(row) });
    const result = await deriveMachinePaneBinding({ chatId: MACHINE_ID, conversationId: CONVERSATION_ID }, deps);
    expect(result).toBeNull();
  });

  it('given row.machineId !== chatId, should fail closed with binding_page_mismatch', async () => {
    const row = makeRow({ machineId: 'a-different-machine' });
    const deps = makeDeps({ terminalStore: makeTerminalStore(row) });
    const result = await deriveMachinePaneBinding({ chatId: MACHINE_ID, conversationId: CONVERSATION_ID }, deps);
    expect(result).toEqual({ ok: false, reason: 'binding_page_mismatch' });
  });

  it('given machine scope, should read ALL branches in ONE query — never one per project', async () => {
    // deriveMachinePaneBinding runs on the hot path of every bound chat turn;
    // 1 + N per-project branch reads is a per-turn tax that grows with the tree.
    const listCalls: string[] = [];
    const lookup = makeBranchLookup(BRANCH_ROWS);
    const row = makeRow({ scope: 'machine', projectName: null, machineBranchId: null });
    const binding = await deriveOk(
      makeDeps({
        terminalStore: makeTerminalStore(row),
        projectLookup: makeProjectLookup(PROJECT_ROWS),
        branchLookup: {
          ...lookup,
          list: async (machineId, projectName) => {
            listCalls.push(projectName);
            return lookup.list(machineId, projectName);
          },
        },
      }),
    );

    expect(listCalls).toEqual([]);
    // Same closure as before: every project, each followed by its live branches.
    expect(binding.handles.filter((h) => h.kind === 'branch').length).toBeGreaterThan(0);
  });

  it('given machine scope, should bind self to SANDBOX_ROOT', async () => {
    const row = makeRow({ scope: 'machine', projectName: null, machineBranchId: null });
    const binding = await deriveOk(makeDeps({ terminalStore: makeTerminalStore(row) }));
    expect(binding.self).toEqual(MACHINE_HANDLE);
  });

  it('given project scope with a known project, should bind self to the project path', async () => {
    const row = makeRow({ scope: 'project', projectName: PROJECT_NAME, machineBranchId: null });
    const binding = await deriveOk(
      makeDeps({
        terminalStore: makeTerminalStore(row),
        projectLookup: makeProjectLookup([{ name: PROJECT_NAME, path: PROJECT_PATH }]),
      }),
    );
    expect(binding.self).toEqual(PROJECT_HANDLE);
  });

  it('given project scope with a missing project, should fail closed with project_not_found', async () => {
    const row = makeRow({ scope: 'project', projectName: PROJECT_NAME, machineBranchId: null });
    const deps = makeDeps({ terminalStore: makeTerminalStore(row), projectLookup: makeProjectLookup([]) });
    const result = await deriveMachinePaneBinding({ chatId: MACHINE_ID, conversationId: CONVERSATION_ID }, deps);
    expect(result).toEqual({ ok: false, reason: 'project_not_found' });
  });

  it('given branch scope with a live branch, should bind self to BRANCH_REPO_PATH with the branchSandbox', async () => {
    const row = makeRow({ scope: 'branch', projectName: PROJECT_NAME, machineBranchId: BRANCH_ID });
    const binding = await deriveOk(
      makeDeps({ terminalStore: makeTerminalStore(row), branchLookup: makeBranchLookup(BRANCH_ROWS) }),
    );
    expect(binding.self).toEqual(BRANCH_HANDLE);
  });

  it('given branch scope with a missing branch row, should fail closed with branch_not_found', async () => {
    const row = makeRow({ scope: 'branch', projectName: PROJECT_NAME, machineBranchId: BRANCH_ID });
    const deps = makeDeps({ terminalStore: makeTerminalStore(row), branchLookup: makeBranchLookup([]) });
    const result = await deriveMachinePaneBinding({ chatId: MACHINE_ID, conversationId: CONVERSATION_ID }, deps);
    expect(result).toEqual({ ok: false, reason: 'branch_not_found' });
  });

  it('given branch scope with a destroyed branch (spriteTornDownAt set), should fail closed with branch_not_found', async () => {
    const row = makeRow({ scope: 'branch', projectName: PROJECT_NAME, machineBranchId: BRANCH_ID });
    const deps = makeDeps({
      terminalStore: makeTerminalStore(row),
      branchLookup: makeBranchLookup([{ ...BRANCH_ROWS[0], spriteTornDownAt: NOW }]),
    });
    const result = await deriveMachinePaneBinding({ chatId: MACHINE_ID, conversationId: CONVERSATION_ID }, deps);
    expect(result).toEqual({ ok: false, reason: 'branch_not_found' });
  });
});

/**
 * The cascade: a node's binding carries the DOWNWARD CLOSURE of the machine
 * tree beneath it. This handle set is the single authorization fact every
 * later phase consumes (`ToolExecutionContext.machineBinding`) — sibling
 * isolation is not a check, it is a consequence of never deriving the sibling
 * in the first place.
 */
describe('deriveMachinePaneBinding — handle-set derivation (cascade)', () => {
  it('given a machine-root binding, should derive self + all projects + all branches', async () => {
    const row = makeRow({ scope: 'machine', projectName: null, machineBranchId: null });
    const binding = await deriveOk(makeCascadeDeps(row));
    expect(binding.handles).toEqual([
      MACHINE_HANDLE,
      PROJECT_HANDLE,
      BRANCH_HANDLE,
      SIBLING_PROJECT_HANDLE,
      SIBLING_BRANCH_HANDLE,
    ]);
  });

  it('given a project binding, should derive self + its own branches only', async () => {
    const row = makeRow({ scope: 'project', projectName: PROJECT_NAME, machineBranchId: null });
    const binding = await deriveOk(makeCascadeDeps(row));
    expect(binding.handles).toEqual([PROJECT_HANDLE, BRANCH_HANDLE]);
  });

  it('given a branch binding, should derive self alone', async () => {
    const row = makeRow({ scope: 'branch', projectName: PROJECT_NAME, machineBranchId: BRANCH_ID });
    const binding = await deriveOk(makeCascadeDeps(row));
    expect(binding.handles).toEqual([BRANCH_HANDLE]);
  });

  it('given a sibling project, should never appear in a project binding\'s downward closure', async () => {
    const row = makeRow({ scope: 'project', projectName: PROJECT_NAME, machineBranchId: null });
    const binding = await deriveOk(makeCascadeDeps(row));
    expect(binding.handles.some((h) => h.project === SIBLING_PROJECT_NAME)).toBe(false);
  });

  it('given a sibling branch of the same project, should never appear in a branch binding\'s downward closure', async () => {
    const row = makeRow({ scope: 'branch', projectName: PROJECT_NAME, machineBranchId: BRANCH_ID });
    const deps = makeDeps({
      terminalStore: makeTerminalStore(row),
      projectLookup: makeProjectLookup(PROJECT_ROWS),
      branchLookup: makeBranchLookup([
        ...BRANCH_ROWS,
        {
          id: 'branch-3',
          projectName: PROJECT_NAME,
          branchName: 'cousin',
          sandboxId: 'sprite-branch-3',
          spriteTornDownAt: null,
        },
      ]),
    });
    const binding = await deriveOk(deps);
    expect(binding.handles).toEqual([BRANCH_HANDLE]);
  });

  it('given an unpromoted project handle, should resolve to the machine Sprite + cwd = project.path', async () => {
    const row = makeRow({ scope: 'machine', projectName: null, machineBranchId: null });
    const binding = await deriveOk(makeCascadeDeps(row));
    const project = binding.handles.find((h) => h.kind === 'project' && h.project === PROJECT_NAME);
    expect(project).toEqual({ kind: 'project', machineId: MACHINE_ID, project: PROJECT_NAME, cwd: PROJECT_PATH });
    expect(project?.branchSandbox).toBeUndefined();
  });

  it('given a PROMOTED project, should resolve to ITS OWN Sprite at /workspace/repo', async () => {
    const row = makeRow({ scope: 'machine', projectName: null, machineBranchId: null });
    const deps = makeDeps({
      terminalStore: makeTerminalStore(row),
      projectLookup: makeProjectLookup([
        { name: PROJECT_NAME, path: PROJECT_PATH, id: 'proj-1', sandboxId: 'sprite-project-1', spriteTornDownAt: null },
      ]),
      branchLookup: makeBranchLookup([]),
    });
    const binding = await deriveOk(deps);
    const project = binding.handles.find((h) => h.kind === 'project');
    expect(project).toEqual({
      kind: 'project',
      machineId: MACHINE_ID,
      project: PROJECT_NAME,
      cwd: PROJECT_REPO_PATH,
      projectSandbox: { machineProjectId: 'proj-1', sandboxId: 'sprite-project-1' },
    });
    // Its own-Sprite descriptor is the PROJECT one — never smuggled through
    // `branchSandbox`, whose row id addresses a different table entirely.
    expect(project?.branchSandbox).toBeUndefined();
  });

  it('given a promoted project whose Sprite was TORN DOWN, should fall back to the machine checkout', async () => {
    const row = makeRow({ scope: 'machine', projectName: null, machineBranchId: null });
    const deps = makeDeps({
      terminalStore: makeTerminalStore(row),
      projectLookup: makeProjectLookup([
        { name: PROJECT_NAME, path: PROJECT_PATH, id: 'proj-1', sandboxId: 'sprite-project-1', spriteTornDownAt: NOW },
      ]),
      branchLookup: makeBranchLookup([]),
    });
    const binding = await deriveOk(deps);
    const project = binding.handles.find((h) => h.kind === 'project');
    expect(project).toEqual({ kind: 'project', machineId: MACHINE_ID, project: PROJECT_NAME, cwd: PROJECT_PATH });
  });

  it('given a torn-down branch Sprite, should omit that branch from a machine-root closure (fail closed, as today)', async () => {
    const row = makeRow({ scope: 'machine', projectName: null, machineBranchId: null });
    const deps = makeDeps({
      terminalStore: makeTerminalStore(row),
      projectLookup: makeProjectLookup(PROJECT_ROWS),
      branchLookup: makeBranchLookup([{ ...BRANCH_ROWS[0], spriteTornDownAt: NOW }, BRANCH_ROWS[1]]),
    });
    const binding = await deriveOk(deps);
    expect(binding.handles.some((h) => h.branch === 'feature')).toBe(false);
    expect(binding.handles).toContainEqual(SIBLING_BRANCH_HANDLE);
  });

  it('given every handle in a derived set, should carry the owning machine page id (the billing/payer key)', async () => {
    const row = makeRow({ scope: 'machine', projectName: null, machineBranchId: null });
    const binding = await deriveOk(makeCascadeDeps(row));
    expect(binding.handles.every((h) => h.machineId === MACHINE_ID)).toBe(true);
  });

  it('given any binding, should list self first in its handle set', async () => {
    const row = makeRow({ scope: 'project', projectName: PROJECT_NAME, machineBranchId: null });
    const binding = await deriveOk(makeCascadeDeps(row));
    expect(binding.handles[0]).toEqual(binding.self);
  });
});

/**
 * Target resolution is a pure LOOKUP over the derived set — it makes no policy
 * decision of its own. "Out of set" is simply "not derived", which is exactly
 * what makes the derivation the single policy site.
 */
describe('resolveMachineNodeTarget', () => {
  const SET = {
    self: MACHINE_HANDLE,
    handles: [MACHINE_HANDLE, PROJECT_HANDLE, BRANCH_HANDLE, SIBLING_PROJECT_HANDLE, SIBLING_BRANCH_HANDLE],
  };

  it('given no target, should resolve to self', () => {
    expect(resolveMachineNodeTarget(SET, undefined)).toEqual({ ok: true, handle: MACHINE_HANDLE });
  });

  it('given an empty target object, should resolve to self', () => {
    expect(resolveMachineNodeTarget(SET, {})).toEqual({ ok: true, handle: MACHINE_HANDLE });
  });

  it('given a project in the set, should resolve to that project handle', () => {
    expect(resolveMachineNodeTarget(SET, { project: PROJECT_NAME })).toEqual({ ok: true, handle: PROJECT_HANDLE });
  });

  it('given a project + branch in the set, should resolve to that branch handle', () => {
    expect(resolveMachineNodeTarget(SET, { project: PROJECT_NAME, branch: 'feature' })).toEqual({
      ok: true,
      handle: BRANCH_HANDLE,
    });
  });

  it('given a branch alone with a unique name, should resolve without a project', () => {
    expect(resolveMachineNodeTarget(SET, { branch: 'sibling-feature' })).toEqual({
      ok: true,
      handle: SIBLING_BRANCH_HANDLE,
    });
  });

  it('given a branch name that exists under two projects, should refuse as ambiguous', () => {
    const clash: MachineNodeHandle = { ...SIBLING_BRANCH_HANDLE, branch: 'feature' };
    const result = resolveMachineNodeTarget({ self: MACHINE_HANDLE, handles: [...SET.handles, clash] }, {
      branch: 'feature',
    });
    expect(result).toEqual({ ok: false, reason: 'ambiguous_target' });
  });

  it('given a branch alone from a project-scoped self, should resolve within self\'s own project', () => {
    const projectSet = { self: PROJECT_HANDLE, handles: [PROJECT_HANDLE, BRANCH_HANDLE] };
    expect(resolveMachineNodeTarget(projectSet, { branch: 'feature' })).toEqual({ ok: true, handle: BRANCH_HANDLE });
  });

  it('given a project outside the set, should refuse as out of set', () => {
    const projectSet = { self: PROJECT_HANDLE, handles: [PROJECT_HANDLE, BRANCH_HANDLE] };
    expect(resolveMachineNodeTarget(projectSet, { project: SIBLING_PROJECT_NAME })).toEqual({
      ok: false,
      reason: 'target_not_in_set',
    });
  });

  it('given a sibling branch outside the set, should refuse as out of set', () => {
    const branchSet = { self: BRANCH_HANDLE, handles: [BRANCH_HANDLE] };
    expect(resolveMachineNodeTarget(branchSet, { project: SIBLING_PROJECT_NAME, branch: 'sibling-feature' })).toEqual({
      ok: false,
      reason: 'target_not_in_set',
    });
  });

  // Field bug: a model reasoning in ordinary git terms asks for a project's
  // own default branch (commonly "main") as if it were an addressable branch
  // node — but a branch handle only ever exists for an EXPLICITLY created
  // worktree. Denying the whole target here reads as "you have no access to
  // this project at all", when the project itself was right there in scope.
  it('given a project in the set + a branch name that has no branch handle, should fall back to the project handle', () => {
    const projectSet = { self: PROJECT_HANDLE, handles: [PROJECT_HANDLE] };
    expect(resolveMachineNodeTarget(projectSet, { project: PROJECT_NAME, branch: 'main' })).toEqual({
      ok: true,
      handle: PROJECT_HANDLE,
    });
  });

  it('given a project OUTSIDE the set + an unresolved branch name, should still refuse as out of set', () => {
    const branchSet = { self: BRANCH_HANDLE, handles: [BRANCH_HANDLE] };
    expect(resolveMachineNodeTarget(branchSet, { project: SIBLING_PROJECT_NAME, branch: 'main' })).toEqual({
      ok: false,
      reason: 'target_not_in_set',
    });
  });

  it('given a project in the set with a REAL branch handle + a different unresolved branch name, should still fall back to the project handle', () => {
    const projectSet = { self: PROJECT_HANDLE, handles: [PROJECT_HANDLE, BRANCH_HANDLE] };
    expect(resolveMachineNodeTarget(projectSet, { project: PROJECT_NAME, branch: 'main' })).toEqual({
      ok: true,
      handle: PROJECT_HANDLE,
    });
  });

  it('given a BRANCH-scoped self (no project handle in its own set) + an unresolved bare branch name, should refuse rather than fall back', () => {
    // A branch pane's derived set is [self] only (deriveMachinePaneBinding) — its
    // own enclosing project is never itself a handle here, so there is nothing
    // for the fallback to find even though `project` defaults to self.project.
    const branchOnlySet = { self: BRANCH_HANDLE, handles: [BRANCH_HANDLE] };
    expect(resolveMachineNodeTarget(branchOnlySet, { branch: 'main' })).toEqual({
      ok: false,
      reason: 'target_not_in_set',
    });
  });
});
