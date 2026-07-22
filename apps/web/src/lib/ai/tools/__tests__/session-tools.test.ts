import { describe, it } from 'vitest';
import { assert } from './riteway';

import {
  createSessionTools,
  readSessionState,
  type SessionRow,
  type SessionToolsDeps,
} from '../session-tools';
import type { SessionView, SessionViewWrite } from '../session-layout';
import type { ToolExecutionContext } from '../../core/types';
import type {
  MachineNodeHandle,
  MachineNodeHandleSet,
} from '@pagespace/lib/services/machines/machine-pane-binding';

const NOW = new Date('2026-07-22T12:00:00Z');

function machineHandle(machineId = 'm1'): MachineNodeHandle {
  return { kind: 'machine', machineId, cwd: '/home/pagespace' };
}
function projectHandle(project: string, machineId = 'm1'): MachineNodeHandle {
  return { kind: 'project', machineId, project, cwd: `/home/pagespace/${project}` };
}
function branchHandle(project: string, branch: string, machineId = 'm1'): MachineNodeHandle {
  return {
    kind: 'branch',
    machineId,
    project,
    branch,
    cwd: '/repo',
    branchSandbox: { machineBranchId: `br-${branch}`, sandboxId: `sbx-${branch}` },
  };
}

/** A machine-root binding over one project with one branch — the shape `deriveMachinePaneBinding` returns. */
function rootBinding(): MachineNodeHandleSet {
  const self = machineHandle();
  return { self, handles: [self, projectHandle('repo'), branchHandle('repo', 'feature')] };
}

interface Recorded {
  spawned: { node: MachineNodeHandle; name: string; agentType: string }[];
  writes: { machineId: string; writes: SessionViewWrite[] }[];
}

function deps(
  overrides: Partial<SessionToolsDeps> = {},
): { deps: SessionToolsDeps; recorded: Recorded } {
  const recorded: Recorded = { spawned: [], writes: [] };
  let ids = 0;
  const base: SessionToolsDeps = {
    listSessions: async () => [],
    findSession: async () => null,
    spawnSession: async ({ node, name, agentType }) => {
      recorded.spawned.push({ node, name, agentType });
      return { ok: true, id: `row-${name}`, resumed: false };
    },
    killSession: async () => ({ ok: true }),
    listViews: async () => [],
    applyViewWrites: async (machineId, writes) => {
      recorded.writes.push({ machineId, writes });
    },
    newId: () => `id${++ids}`,
    now: () => NOW,
  };
  return { deps: { ...base, ...overrides }, recorded };
}

function context(binding: MachineNodeHandleSet | undefined): ToolExecutionContext {
  return { userId: 'u1', conversationId: 'c1', machineBinding: binding };
}

function exec(tool: { execute?: unknown }, args: unknown, ctx: ToolExecutionContext) {
  const fn = tool.execute as (a: unknown, o: unknown) => Promise<unknown>;
  return fn(args, { experimental_context: ctx });
}

function agentRow(name: string, overrides: Partial<SessionRow> = {}): SessionRow {
  return { name, agentType: 'pagespace', streamSessionId: null, updatedAt: NOW, ...overrides };
}
function shellRow(name: string, overrides: Partial<SessionRow> = {}): SessionRow {
  return { name, agentType: 'shell', streamSessionId: null, updatedAt: NOW, ...overrides };
}

describe('readSessionState', () => {
  it('given a shell session whose PTY has never been started, should report reserved', () => {
    assert({
      given: 'a pty-surface row with no stream session',
      should: 'report reserved',
      actual: readSessionState(shellRow('sh'), NOW),
      expected: 'reserved',
    });
  });

  it('given a shell session with a live stream session id, should report activity, not reserved', () => {
    assert({
      given: 'a pty-surface row whose PTY has been started',
      should: 'report active',
      actual: readSessionState(shellRow('sh', { streamSessionId: 'sess-1' }), NOW),
      expected: 'active',
    });
  });

  it('given an agent session untouched for an hour, should report idle', () => {
    assert({
      given: 'a chat-surface row last touched an hour ago',
      should: 'report idle',
      actual: readSessionState(agentRow('a', { updatedAt: new Date(NOW.getTime() - 3_600_000) }), NOW),
      expected: 'idle',
    });
  });

  it('given an agent session with no stream session id, should never report reserved', () => {
    assert({
      given: 'a chat-surface row (which never has a PTY stream)',
      should: 'report active rather than reserved',
      actual: readSessionState(agentRow('a'), NOW),
      expected: 'active',
    });
  });
});

describe('list_sessions', () => {
  it('given a machine-root binding, should return every node in the set including empty ones', async () => {
    const views: SessionView[] = [
      { id: 'w1', name: 'pagespace-a1', projectName: 'repo', branchName: null, columns: [] },
    ];
    const sessions: Record<string, SessionRow[]> = {
      'repo/': [agentRow('pagespace-a1')],
    };
    const { deps: d } = deps({
      listViews: async () => views,
      listSessions: async (node) => sessions[`${node.project ?? ''}/${node.branch ?? ''}`] ?? [],
    });
    const tools = createSessionTools(d);

    const result = await exec(tools.list_sessions, {}, context(rootBinding()));

    assert({
      given: 'a machine-root binding over one project with one branch',
      should: 'list all three nodes, with the project\'s view and session attached',
      actual: result,
      expected: {
        success: true,
        nodes: [
          { node: 'machine', self: true, cwd: '/home/pagespace', views: [], sessions: [] },
          {
            node: 'project "repo"',
            self: false,
            cwd: '/home/pagespace/repo',
            views: [{ id: 'w1', name: 'pagespace-a1' }],
            sessions: [{ name: 'pagespace-a1', type: 'agent', agentType: 'pagespace', state: 'active' }],
          },
          {
            node: 'project "repo" / branch "feature"',
            self: false,
            cwd: '/repo',
            views: [],
            sessions: [],
          },
        ],
      },
    });
  });

  it('given a target, should list only that node', async () => {
    const { deps: d } = deps();
    const tools = createSessionTools(d);

    const result = (await exec(tools.list_sessions, { target: { project: 'repo' } }, context(rootBinding()))) as {
      nodes: { node: string }[];
    };

    assert({
      given: 'a target naming one project',
      should: 'list only that node',
      actual: result.nodes.map((n) => n.node),
      expected: ['project "repo"'],
    });
  });

  it('given a target outside the handle set, should deny without reading any state', async () => {
    const { deps: d } = deps({
      listSessions: async () => {
        throw new Error('must not read sessions for an unaddressable node');
      },
    });
    const tools = createSessionTools(d);

    const result = (await exec(
      tools.list_sessions,
      { target: { project: 'other' } },
      context(rootBinding()),
    )) as { success: boolean };

    assert({
      given: 'a target naming a project outside the derived set',
      should: 'deny',
      actual: result.success,
      expected: false,
    });
  });

  it('given an unbound conversation, should refuse', async () => {
    const { deps: d } = deps();
    const tools = createSessionTools(d);

    const result = (await exec(tools.list_sessions, {}, context(undefined))) as { success: boolean };

    assert({
      given: 'a conversation with no machine binding',
      should: 'refuse',
      actual: result.success,
      expected: false,
    });
  });
});

describe('add_session', () => {
  it('given type agent with the default placement, should spawn at the bound node and create its born-bound view', async () => {
    const { deps: d, recorded } = deps();
    const tools = createSessionTools(d);

    const result = await exec(tools.add_session, { type: 'agent', name: 'worker' }, context(rootBinding()));

    assert({
      given: 'an agent session added with no placement',
      should: 'spawn at the bound node and materialize one born-bound view',
      actual: {
        spawned: recorded.spawned,
        writes: recorded.writes,
        result,
      },
      expected: {
        spawned: [{ node: machineHandle(), name: 'worker', agentType: 'pagespace' }],
        writes: [
          {
            machineId: 'm1',
            writes: [
              {
                kind: 'create',
                id: 'sessionworker',
                name: 'worker',
                scope: {},
                columns: [{ id: 'id1', panes: [{ id: 'id1', scope: { name: 'worker', kind: 'chat' } }] }],
              },
            ],
          },
        ],
        result: {
          success: true,
          name: 'worker',
          type: 'agent',
          resumed: false,
          state: 'active',
          node: 'machine',
          view: { id: 'sessionworker', name: 'worker' },
        },
      },
    });
  });

  it('given type shell, should reserve the row and report the reserved state', async () => {
    const { deps: d } = deps();
    const tools = createSessionTools(d);

    const result = (await exec(
      tools.add_session,
      { type: 'shell', name: 'sh1', target: { project: 'repo', branch: 'feature' } },
      context(rootBinding()),
    )) as { state: string; type: string };

    assert({
      given: 'a shell session (whose PTY starts on first viewer connect)',
      should: 'report the reserved state',
      actual: { state: result.state, type: result.type },
      expected: { state: 'reserved', type: 'shell' },
    });
  });

  it('given the add_session description, should state that a shell PTY starts on first viewer connect', () => {
    const { deps: d } = deps();
    const tools = createSessionTools(d);

    assert({
      given: 'the add_session tool description',
      should: 'state the reserved-until-first-viewer behaviour',
      actual: /reserved/.test((tools.add_session as { description?: string }).description ?? ''),
      expected: true,
    });
  });

  it('given a splitInto placement, should update that view instead of creating one', async () => {
    const view: SessionView = {
      id: 'w1',
      name: 'Workspace 1',
      projectName: null,
      branchName: null,
      columns: [{ id: 'c1', panes: [{ id: 'p1', scope: { name: 'other' } }] }],
    };
    const { deps: d, recorded } = deps({ listViews: async () => [view] });
    const tools = createSessionTools(d);

    await exec(
      tools.add_session,
      { type: 'agent', name: 'worker', placement: { splitInto: 'w1', direction: 'down' } },
      context(rootBinding()),
    );

    assert({
      given: 'a split-into placement',
      should: 'plan one update to the named view',
      actual: recorded.writes[0]?.writes.map((write) => ({ kind: write.kind, id: write.id })),
      expected: [{ kind: 'update', id: 'w1' }],
    });
  });

  it('given a target outside the handle set, should deny without spawning', async () => {
    const { deps: d, recorded } = deps();
    const tools = createSessionTools(d);

    const result = (await exec(
      tools.add_session,
      { type: 'agent', name: 'worker', target: { project: 'sibling' } },
      context(rootBinding()),
    )) as { success: boolean };

    assert({
      given: 'a target outside the derived handle set',
      should: 'deny and spawn nothing',
      actual: { success: result.success, spawned: recorded.spawned.length },
      expected: { success: false, spawned: 0 },
    });
  });

  it('given a prompt, should refuse until the agent dispatch engine lands', async () => {
    const { deps: d, recorded } = deps();
    const tools = createSessionTools(d);

    const result = (await exec(
      tools.add_session,
      { type: 'agent', name: 'worker', prompt: 'go fix the build' },
      context(rootBinding()),
    )) as { success: boolean };

    assert({
      given: 'a starting prompt',
      should: 'refuse and spawn nothing',
      actual: { success: result.success, spawned: recorded.spawned.length },
      expected: { success: false, spawned: 0 },
    });
  });

  it('given no name, should mint one from the session type', async () => {
    const { deps: d, recorded } = deps();
    const tools = createSessionTools(d);

    await exec(tools.add_session, { type: 'shell' }, context(rootBinding()));

    assert({
      given: 'an add_session with no name',
      should: 'mint an agent-type-prefixed name',
      actual: recorded.spawned[0]?.name.startsWith('shell-'),
      expected: true,
    });
  });

  it('given a spawn denial, should report it and write no layout', async () => {
    const { deps: d, recorded } = deps({
      spawnSession: async () => ({ ok: false, reason: 'name_in_use' }),
    });
    const tools = createSessionTools(d);

    const result = (await exec(tools.add_session, { type: 'agent', name: 'worker' }, context(rootBinding()))) as {
      success: boolean;
    };

    assert({
      given: 'a spawn the runtime refuses',
      should: 'report the failure and materialize nothing',
      actual: { success: result.success, writes: recorded.writes.length },
      expected: { success: false, writes: 0 },
    });
  });
});

describe('move_session', () => {
  const boundView: SessionView = {
    id: 'w1',
    name: 'worker',
    projectName: null,
    branchName: null,
    columns: [{ id: 'c1', panes: [{ id: 'p1', scope: { name: 'worker', kind: 'chat' } }] }],
  };
  const otherView: SessionView = {
    id: 'w2',
    name: 'Workspace 1',
    projectName: null,
    branchName: null,
    columns: [{ id: 'c2', panes: [{ id: 'p2', scope: { name: 'other' } }] }],
  };

  it('given a re-home into another view at the same node, should close the old manifestation and place the new one', async () => {
    const { deps: d, recorded } = deps({
      listViews: async () => [boundView, otherView],
      findSession: async () => agentRow('worker'),
    });
    const tools = createSessionTools(d);

    const result = (await exec(
      tools.move_session,
      { name: 'worker', placement: { splitInto: 'w2', direction: 'down' } },
      context(rootBinding()),
    )) as { success: boolean; view?: { id: string } };

    assert({
      given: 'a session moved into another view at its own node',
      should: 'remove the emptied source view and update the destination',
      actual: {
        success: result.success,
        view: result.view?.id,
        writes: recorded.writes[0]?.writes.map((write) => ({ kind: write.kind, id: write.id })),
      },
      expected: {
        success: true,
        view: 'w2',
        writes: [
          { kind: 'remove', id: 'w1' },
          { kind: 'update', id: 'w2' },
        ],
      },
    });
  });

  it('given a move into a view at another node, should refuse and write nothing', async () => {
    const projectView: SessionView = {
      id: 'w3',
      name: 'Workspace 2',
      projectName: 'repo',
      branchName: null,
      columns: [{ id: 'c3', panes: [{ id: 'p3', scope: null }] }],
    };
    const { deps: d, recorded } = deps({
      listViews: async () => [boundView, projectView],
      findSession: async () => agentRow('worker'),
    });
    const tools = createSessionTools(d);

    const result = (await exec(
      tools.move_session,
      { name: 'worker', placement: { splitInto: 'w3', direction: 'down' } },
      context(rootBinding()),
    )) as { success: boolean };

    assert({
      given: 'a machine-scoped session moved into a project-scoped view',
      should: 'refuse — a move never changes a session\'s sandbox',
      actual: { success: result.success, writes: recorded.writes.length },
      expected: { success: false, writes: 0 },
    });
  });

  it('given a session that does not exist at the target node, should refuse', async () => {
    const { deps: d, recorded } = deps({ listViews: async () => [otherView] });
    const tools = createSessionTools(d);

    const result = (await exec(
      tools.move_session,
      { name: 'ghost', placement: 'new-view' },
      context(rootBinding()),
    )) as { success: boolean };

    assert({
      given: 'a name no session at this node carries',
      should: 'refuse and write nothing',
      actual: { success: result.success, writes: recorded.writes.length },
      expected: { success: false, writes: 0 },
    });
  });

  it('given a target outside the handle set, should deny before reading anything', async () => {
    const { deps: d, recorded } = deps({
      findSession: async () => {
        throw new Error('must not read a session at an unaddressable node');
      },
    });
    const tools = createSessionTools(d);

    const result = (await exec(
      tools.move_session,
      { name: 'worker', target: { project: 'sibling' }, placement: 'new-view' },
      context(rootBinding()),
    )) as { success: boolean };

    assert({
      given: 'a target outside the derived handle set',
      should: 'deny',
      actual: { success: result.success, writes: recorded.writes.length },
      expected: { success: false, writes: 0 },
    });
  });
});

describe('kill_session', () => {
  const view: SessionView = {
    id: 'w1',
    name: 'worker',
    projectName: null,
    branchName: null,
    columns: [{ id: 'c1', panes: [{ id: 'p1', scope: { name: 'worker', kind: 'chat' } }] }],
  };

  it('given a session in the handle set, should kill it and close its manifestations', async () => {
    const killed: string[] = [];
    const { deps: d, recorded } = deps({
      listViews: async () => [view],
      findSession: async () => agentRow('worker'),
      killSession: async ({ name }) => {
        killed.push(name);
        return { ok: true };
      },
    });
    const tools = createSessionTools(d);

    const result = (await exec(tools.kill_session, { name: 'worker' }, context(rootBinding()))) as {
      success: boolean;
    };

    assert({
      given: 'a session at the bound node',
      should: 'kill the session and remove the view it was the only pane of',
      actual: {
        success: result.success,
        killed,
        writes: recorded.writes[0]?.writes,
      },
      expected: {
        success: true,
        killed: ['worker'],
        writes: [{ kind: 'remove', id: 'w1' }],
      },
    });
  });

  it('given a target outside the handle set, should deny via the one policy site and kill nothing', async () => {
    const { deps: d, recorded } = deps({
      killSession: async () => {
        throw new Error('must not kill outside the derived handle set');
      },
      findSession: async () => {
        throw new Error('must not read a session at an unaddressable node');
      },
    });
    const tools = createSessionTools(d);

    const result = (await exec(
      tools.kill_session,
      { name: 'worker', target: { project: 'sibling' } },
      context(rootBinding()),
    )) as { success: boolean };

    assert({
      given: 'a kill aimed at a node the derived set never contained',
      should: 'deny and touch nothing',
      actual: { success: result.success, writes: recorded.writes.length },
      expected: { success: false, writes: 0 },
    });
  });

  it('given a kill the runtime refuses, should report it and leave the manifestation alone', async () => {
    const { deps: d, recorded } = deps({
      listViews: async () => [view],
      findSession: async () => agentRow('worker'),
      killSession: async () => ({ ok: false, reason: 'error' }),
    });
    const tools = createSessionTools(d);

    const result = (await exec(tools.kill_session, { name: 'worker' }, context(rootBinding()))) as {
      success: boolean;
    };

    assert({
      given: 'a kill the runtime could not complete',
      should: 'report the failure and close no panes',
      actual: { success: result.success, writes: recorded.writes.length },
      expected: { success: false, writes: 0 },
    });
  });
});
