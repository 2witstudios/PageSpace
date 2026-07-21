import { describe, it, expect } from 'vitest';
import { deriveMachinePaneBinding, type DeriveMachinePaneBindingDeps } from '../machine-pane-binding';
import type { MachineAgentTerminalRecord } from '../agent-terminals-store';
import { SANDBOX_ROOT } from '../../sandbox/sandbox-paths';
import { BRANCH_REPO_PATH } from '../machine-branches';

const NOW = new Date('2026-07-20T12:00:00.000Z');
const MACHINE_ID = 'machine-1';
const CONVERSATION_ID = 'agent-terminal-1';
const PROJECT_NAME = 'my-repo';
const PROJECT_PATH = '/workspace/projects/my-repo';
const BRANCH_ID = 'branch-1';
const BRANCH_SANDBOX_ID = 'sprite-branch-1';

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
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeTerminalStore(row: MachineAgentTerminalRecord | null): DeriveMachinePaneBindingDeps['terminalStore'] {
  return { findById: async (id) => (id === CONVERSATION_ID ? row : null) };
}

function makeProjectLookup(rows: Record<string, { path: string }> = {}): DeriveMachinePaneBindingDeps['projectLookup'] {
  return { findByName: async (machineId, name) => rows[`${machineId}\0${name}`] ?? null };
}

function makeBranchLookup(
  rows: Record<string, { sandboxId: string; spriteTornDownAt: Date | null }> = {},
): DeriveMachinePaneBindingDeps['branchLookup'] {
  return { findById: async (id) => rows[id] ?? null };
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

  it('given machine scope, should bind cwd to SANDBOX_ROOT', async () => {
    const row = makeRow({ scope: 'machine', projectName: null, machineBranchId: null });
    const deps = makeDeps({ terminalStore: makeTerminalStore(row) });
    const result = await deriveMachinePaneBinding({ chatId: MACHINE_ID, conversationId: CONVERSATION_ID }, deps);
    expect(result).toEqual({ ok: true, binding: { cwd: SANDBOX_ROOT } });
  });

  it('given project scope with a known project, should bind cwd to the project path', async () => {
    const row = makeRow({ scope: 'project', projectName: PROJECT_NAME, machineBranchId: null });
    const deps = makeDeps({
      terminalStore: makeTerminalStore(row),
      projectLookup: makeProjectLookup({ [`${MACHINE_ID}\0${PROJECT_NAME}`]: { path: PROJECT_PATH } }),
    });
    const result = await deriveMachinePaneBinding({ chatId: MACHINE_ID, conversationId: CONVERSATION_ID }, deps);
    expect(result).toEqual({ ok: true, binding: { cwd: PROJECT_PATH } });
  });

  it('given project scope with a missing project, should fail closed with project_not_found', async () => {
    const row = makeRow({ scope: 'project', projectName: PROJECT_NAME, machineBranchId: null });
    const deps = makeDeps({ terminalStore: makeTerminalStore(row), projectLookup: makeProjectLookup({}) });
    const result = await deriveMachinePaneBinding({ chatId: MACHINE_ID, conversationId: CONVERSATION_ID }, deps);
    expect(result).toEqual({ ok: false, reason: 'project_not_found' });
  });

  it('given branch scope with a live branch, should bind cwd to BRANCH_REPO_PATH with the branchSandbox', async () => {
    const row = makeRow({ scope: 'branch', projectName: PROJECT_NAME, machineBranchId: BRANCH_ID });
    const deps = makeDeps({
      terminalStore: makeTerminalStore(row),
      branchLookup: makeBranchLookup({ [BRANCH_ID]: { sandboxId: BRANCH_SANDBOX_ID, spriteTornDownAt: null } }),
    });
    const result = await deriveMachinePaneBinding({ chatId: MACHINE_ID, conversationId: CONVERSATION_ID }, deps);
    expect(result).toEqual({
      ok: true,
      binding: { cwd: BRANCH_REPO_PATH, branchSandbox: { machineBranchId: BRANCH_ID, sandboxId: BRANCH_SANDBOX_ID } },
    });
  });

  it('given branch scope with a missing branch row, should fail closed with branch_not_found', async () => {
    const row = makeRow({ scope: 'branch', projectName: PROJECT_NAME, machineBranchId: BRANCH_ID });
    const deps = makeDeps({ terminalStore: makeTerminalStore(row), branchLookup: makeBranchLookup({}) });
    const result = await deriveMachinePaneBinding({ chatId: MACHINE_ID, conversationId: CONVERSATION_ID }, deps);
    expect(result).toEqual({ ok: false, reason: 'branch_not_found' });
  });

  it('given branch scope with a destroyed branch (spriteTornDownAt set), should fail closed with branch_not_found', async () => {
    const row = makeRow({ scope: 'branch', projectName: PROJECT_NAME, machineBranchId: BRANCH_ID });
    const deps = makeDeps({
      terminalStore: makeTerminalStore(row),
      branchLookup: makeBranchLookup({ [BRANCH_ID]: { sandboxId: BRANCH_SANDBOX_ID, spriteTornDownAt: NOW } }),
    });
    const result = await deriveMachinePaneBinding({ chatId: MACHINE_ID, conversationId: CONVERSATION_ID }, deps);
    expect(result).toEqual({ ok: false, reason: 'branch_not_found' });
  });
});
