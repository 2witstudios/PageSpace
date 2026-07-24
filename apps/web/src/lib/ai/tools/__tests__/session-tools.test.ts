import { describe, it } from 'vitest';
import { assert } from './riteway';

import {
  createSessionTools,
  readSessionState,
  type SessionIoInput,
  type SessionReadInput,
  type SessionRow,
  type SessionToolsDeps,
} from '../session-tools';
import { readPtySession, sendPtySession } from '../session-io-pty';
import type { SessionView } from '../session-layout';
import type { WorkspaceVerb } from '@/stores/machine-workspace/workspace-verbs';
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
  verbCalls: { machineId: string; verbs: WorkspaceVerb[] }[];
}

function deps(
  overrides: Partial<SessionToolsDeps> = {},
): { deps: SessionToolsDeps; recorded: Recorded } {
  const recorded: Recorded = { spawned: [], verbCalls: [] };
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
    applyVerbs: async (machineId, verbs) => {
      recorded.verbCalls.push({ machineId, verbs });
    },
    io: {
      agent: { read: notDispatched, send: notDispatched },
      pty: { read: notDispatched, send: notDispatched },
    },
    newId: () => `id${++ids}`,
    now: () => NOW,
  };
  return { deps: { ...base, ...overrides }, recorded };
}

/** The default IO seam for suites that are not about dispatch — reaching it is the failure. */
const notDispatched = async (): Promise<never> => {
  throw new Error('session IO must not be dispatched by this case');
};

function context(binding: MachineNodeHandleSet | undefined): ToolExecutionContext {
  return { userId: 'u1', conversationId: 'c1', machineBinding: binding };
}

function exec(tool: { execute?: unknown }, args: unknown, ctx: ToolExecutionContext) {
  const fn = tool.execute as (a: unknown, o: unknown) => Promise<unknown>;
  return fn(args, { experimental_context: ctx });
}

function agentRow(name: string, overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    name,
    agentType: 'pagespace',
    streamSessionId: null,
    coldTail: null,
    coldTailAt: null,
    coldTailHasOutput: false,
    updatedAt: NOW,
    ...overrides,
  };
}
function shellRow(name: string, overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    name,
    agentType: 'shell',
    streamSessionId: null,
    coldTail: null,
    coldTailAt: null,
    coldTailHasOutput: false,
    updatedAt: NOW,
    ...overrides,
  };
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

  it('given the realtime live map says a started PTY is running, should report active however stale the row is', () => {
    assert({
      given: 'a shell whose row has not been touched in an hour but whose PTY is live',
      should: 'trust the live map over the row timestamp',
      actual: readSessionState(
        shellRow('sh', { streamSessionId: 'sess-1', updatedAt: new Date(NOW.getTime() - 3_600_000) }),
        NOW,
        true,
      ),
      expected: 'active',
    });
  });

  it('given the realtime live map says a started PTY is NOT running, should report idle however fresh the row is', () => {
    assert({
      given: 'a shell touched a moment ago whose PTY is gone',
      should: 'report idle rather than an active session nothing is running',
      actual: readSessionState(shellRow('sh', { streamSessionId: 'sess-1' }), NOW, false),
      expected: 'idle',
    });
  });

  it('given an agent session with a run in flight, should report streaming', () => {
    assert({
      given: 'a chat-surface row whose conversation is generating right now',
      should: 'report streaming — the state that says send_session will be refused',
      actual: readSessionState(agentRow('a', { streaming: true }), NOW),
      expected: 'streaming',
    });
  });

  it('given a session that is streaming, should report that ahead of any recency reading', () => {
    assert({
      given: 'a row generating now but untouched in the database for an hour',
      should: 'still report streaming rather than idle',
      actual: readSessionState(
        agentRow('a', { streaming: true, updatedAt: new Date(NOW.getTime() - 3_600_000) }),
        NOW,
      ),
      expected: 'streaming',
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

  it('given the realtime liveness sweep, should report each started shell by its ACTUAL PTY state', async () => {
    const { deps: d } = deps({
      listSessions: async (node) =>
        node.kind === 'machine'
          ? [
              shellRow('running', { streamSessionId: 'sess-1' }),
              shellRow('ended', { streamSessionId: 'sess-2' }),
              shellRow('never-started'),
            ]
          : [],
      ptyLiveness: async (_node, names) => new Set(names.filter((name) => name === 'running')),
    });
    const tools = createSessionTools(d);

    const result = (await exec(tools.list_sessions, { target: {} }, context(rootBinding()))) as {
      nodes: { sessions: { name: string; state: string }[] }[];
    };

    assert({
      given: 'three shells: one live PTY, one whose PTY is gone, one never started',
      should: 'report active / idle / reserved — liveness never overwrites reserved',
      actual: result.nodes[0].sessions.map(({ name, state }) => ({ name, state })),
      expected: [
        { name: 'running', state: 'active' },
        { name: 'ended', state: 'idle' },
        { name: 'never-started', state: 'reserved' },
      ],
    });
  });

  it('given a node with no started shells, should not run a liveness sweep at all', async () => {
    let swept = 0;
    const { deps: d } = deps({
      listSessions: async (node) => (node.kind === 'machine' ? [agentRow('a1'), shellRow('sh')] : []),
      ptyLiveness: async (_node, names) => {
        swept += 1;
        return new Set(names);
      },
    });
    const tools = createSessionTools(d);

    await exec(tools.list_sessions, { target: {} }, context(rootBinding()));

    assert({
      given: 'a node holding only an agent session and a reserved shell',
      should: 'ask the realtime service nothing at all',
      actual: swept,
      expected: 0,
    });
  });

  it('given the realtime service cannot be asked, should fall back to the row-only state', async () => {
    const { deps: d } = deps({
      listSessions: async (node) => (node.kind === 'machine' ? [shellRow('sh', { streamSessionId: 'sess-1' })] : []),
      ptyLiveness: async () => undefined,
    });
    const tools = createSessionTools(d);

    const result = (await exec(tools.list_sessions, { target: {} }, context(rootBinding()))) as {
      nodes: { sessions: { state: string }[] }[];
    };

    assert({
      given: 'a liveness sweep that could not answer',
      should: 'keep the data-only state rather than reporting the session dead',
      actual: result.nodes[0].sessions.map((session) => session.state),
      expected: ['active'],
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
        verbCalls: recorded.verbCalls,
        result,
      },
      expected: {
        spawned: [{ node: machineHandle(), name: 'worker', agentType: 'pagespace' }],
        verbCalls: [
          {
            machineId: 'm1',
            verbs: [
              {
                type: 'create-workspace',
                workspaceId: 'sessionworker',
                name: 'worker',
                scope: {},
                firstPaneId: 'id1',
                session: { name: 'worker', kind: 'chat' },
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
      should: 'plan one split-pane verb against the named view',
      actual: recorded.verbCalls[0]?.verbs.map((verb) => ({ type: verb.type, workspaceId: verb.workspaceId })),
      expected: [{ type: 'split-pane', workspaceId: 'w1' }],
    });
  });

  it('given a splitInto naming a view that does not exist, should refuse WITHOUT spawning', async () => {
    // Placement is validated before the row is reserved: a rejected placement
    // must not leave behind a reserved-but-unreachable session.
    const { deps: d } = deps({
      listViews: async () => [],
      spawnSession: async () => {
        throw new Error('must not reserve a session for a placement that was refused');
      },
    });
    const tools = createSessionTools(d);

    const result = (await exec(
      tools.add_session,
      { type: 'agent', name: 'worker', placement: { splitInto: 'nope', direction: 'down' } },
      context(rootBinding()),
    )) as { success: boolean };

    assert({
      given: 'a split into a nonexistent view',
      should: 'refuse before anything is reserved',
      actual: result.success,
      expected: false,
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
      actual: { success: result.success, verbCalls: recorded.verbCalls.length },
      expected: { success: false, verbCalls: 0 },
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
        verbs: recorded.verbCalls[0]?.verbs.map((verb) => ({ type: verb.type, workspaceId: verb.workspaceId })),
      },
      expected: {
        success: true,
        view: 'w2',
        verbs: [
          { type: 'close-pane', workspaceId: 'w1' },
          { type: 'split-pane', workspaceId: 'w2' },
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
      actual: { success: result.success, verbCalls: recorded.verbCalls.length },
      expected: { success: false, verbCalls: 0 },
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
      actual: { success: result.success, verbCalls: recorded.verbCalls.length },
      expected: { success: false, verbCalls: 0 },
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
      actual: { success: result.success, verbCalls: recorded.verbCalls.length },
      expected: { success: false, verbCalls: 0 },
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
        verbs: recorded.verbCalls[0]?.verbs,
      },
      expected: {
        success: true,
        killed: ['worker'],
        verbs: [{ type: 'close-pane', workspaceId: 'w1', paneId: 'p1' }],
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
      actual: { success: result.success, verbCalls: recorded.verbCalls.length },
      expected: { success: false, verbCalls: 0 },
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
      actual: { success: result.success, verbCalls: recorded.verbCalls.length },
      expected: { success: false, verbCalls: 0 },
    });
  });
});

describe('session IO shells', () => {
  interface Dispatched {
    agent: { verb: string; name: string; node: string }[];
    pty: { verb: string; name: string; node: string }[];
  }

  function ioDeps(row: SessionRow): { deps: SessionToolsDeps; dispatched: Dispatched } {
    const dispatched: Dispatched = { agent: [], pty: [] };
    const record = (surface: 'agent' | 'pty', verb: string) => async (input: SessionIoInput) => {
      dispatched[surface].push({
        verb,
        name: input.identity.name,
        node: input.identity.node.kind,
      });
      return { success: false as const, error: `${surface}/${verb} not implemented` };
    };
    const { deps: d } = deps({
      findSession: async () => row,
      io: {
        agent: { read: record('agent', 'read'), send: record('agent', 'send') },
        pty: { read: record('pty', 'read'), send: record('pty', 'send') },
      },
    });
    return { deps: d, dispatched };
  }

  it('given an agent session, should dispatch read_session to the agent module', async () => {
    const { deps: d, dispatched } = ioDeps(agentRow('worker'));
    const tools = createSessionTools(d);

    await exec(tools.read_session, { name: 'worker' }, context(rootBinding()));

    assert({
      given: 'a chat-surface session',
      should: 'dispatch to the agent transcript module only',
      actual: dispatched,
      expected: { agent: [{ verb: 'read', name: 'worker', node: 'machine' }], pty: [] },
    });
  });

  it('given a shell session, should dispatch send_session to the pty module', async () => {
    const { deps: d, dispatched } = ioDeps(shellRow('sh1'));
    const tools = createSessionTools(d);

    await exec(tools.send_session, { name: 'sh1', input: 'ls\n' }, context(rootBinding()));

    assert({
      given: 'a pty-surface session',
      should: 'dispatch to the pty stdin module only',
      actual: dispatched,
      expected: { agent: [], pty: [{ verb: 'send', name: 'sh1', node: 'machine' }] },
    });
  });

  it('given a shell session with a cold tail on its row, should carry {tail, at, hasOutput} into the pty read module (issue #2205)', async () => {
    const at = new Date('2026-01-01T00:00:00Z');
    const row = shellRow('sh1', { coldTail: 'goodbye', coldTailAt: at, coldTailHasOutput: true });
    let seenCold: SessionReadInput['cold'];
    const { deps: d } = deps({
      findSession: async () => row,
      io: {
        agent: { read: notDispatched, send: notDispatched },
        pty: {
          read: async (input: SessionReadInput) => {
            seenCold = input.cold;
            return { success: true };
          },
          send: notDispatched,
        },
      },
    });
    const tools = createSessionTools(d);
    await exec(tools.read_session, { name: 'sh1' }, context(rootBinding()));

    assert({
      given: 'a row carrying cold-tail columns',
      should: 'pass them through to the pty read module as {tail, at, hasOutput}',
      actual: seenCold,
      expected: { tail: 'goodbye', at, hasOutput: true },
    });
  });

  it('given a shell session with no cold tail ever recorded, should pass cold: undefined rather than a fabricated empty one', async () => {
    const row = shellRow('sh1'); // coldTail: null, coldTailAt: null, coldTailHasOutput: false
    let seenCold: SessionReadInput['cold'] = { tail: 'sentinel', at: new Date(), hasOutput: true };
    const { deps: d } = deps({
      findSession: async () => row,
      io: {
        agent: { read: notDispatched, send: notDispatched },
        pty: {
          read: async (input: SessionReadInput) => {
            seenCold = input.cold;
            return { success: true };
          },
          send: notDispatched,
        },
      },
    });
    const tools = createSessionTools(d);
    await exec(tools.read_session, { name: 'sh1' }, context(rootBinding()));

    assert({
      given: 'a row with no cold-tail columns set',
      should: 'pass cold: undefined',
      actual: seenCold,
      expected: undefined,
    });
  });

  it('given a shell session whose cold tail is EMPTY but produced output, should still carry cold — an empty tail is not "no cold tail"', async () => {
    const at = new Date('2026-01-01T00:00:00Z');
    // A burst larger than the ring left an empty tail on a session that was screaming output.
    const row = shellRow('sh1', { coldTail: '', coldTailAt: at, coldTailHasOutput: true });
    let seenCold: SessionReadInput['cold'];
    const { deps: d } = deps({
      findSession: async () => row,
      io: {
        agent: { read: notDispatched, send: notDispatched },
        pty: {
          read: async (input: SessionReadInput) => {
            seenCold = input.cold;
            return { success: true };
          },
          send: notDispatched,
        },
      },
    });
    const tools = createSessionTools(d);
    await exec(tools.read_session, { name: 'sh1' }, context(rootBinding()));

    assert({
      given: 'hasOutput true with an empty stored tail',
      should: 'still populate cold, carrying hasOutput separately from the empty tail',
      actual: seenCold,
      expected: { tail: '', at, hasOutput: true },
    });
  });

  it('given a target outside the handle set, should deny before dispatching', async () => {
    const { deps: d, dispatched } = ioDeps(agentRow('worker'));
    const tools = createSessionTools(d);

    const result = (await exec(
      tools.read_session,
      { name: 'worker', target: { project: 'sibling' } },
      context(rootBinding()),
    )) as { success: boolean };

    assert({
      given: 'a read aimed at a node the derived set never contained',
      should: 'deny and dispatch nothing',
      actual: { success: result.success, dispatched },
      expected: { success: false, dispatched: { agent: [], pty: [] } },
    });
  });

  // The PTY half is live (see session-io-pty.test.ts): with no realtime
  // service reachable from a unit test, its read refuses rather than
  // fabricating an empty scrollback — the same honesty this case has always
  // been about. The agent half is implemented and exercised through its own
  // factory (session-io-agent.test.ts).
  it('given the shipped IO modules, should refuse rather than pretend emptiness', async () => {
    const identity = {
      node: machineHandle(),
      name: 'sh1',
      address: { machineId: 'm1', name: 'sh1' },
    };
    const actor = { userId: 'u1' };

    // The AGENT half is implemented (see session-io-agent.test.ts) and reaches
    // the database, so it is exercised through its own factory rather than
    // here; the PTY half remains a stub owned by the realtime phase.
    const answers = await Promise.all([
      readPtySession({ identity, actor }),
      sendPtySession({ identity, actor, input: 'ls\n' }),
    ]);

    assert({
      given: 'the shipped IO modules with no realtime service behind them',
      should: 'refuse every call honestly rather than pretending emptiness',
      actual: answers.map((answer) => answer.success),
      expected: [false, false],
    });
  });

  it('given a send to an agent session from inside a chain, should carry the caller\'s depth', async () => {
    const sends: (number | undefined)[] = [];
    const { deps: d } = deps({
      findSession: async () => agentRow('worker'),
      io: {
        agent: {
          read: notDispatched,
          send: async (input) => {
            sends.push(input.depth);
            return { success: true };
          },
        },
        pty: { read: notDispatched, send: notDispatched },
      },
    });
    const tools = createSessionTools(d);

    await exec(
      tools.send_session,
      { name: 'worker', input: 'go' },
      { ...context(rootBinding()), agentCallDepth: 1 },
    );

    assert({
      given: 'a send_session made by a run that is itself a dispatched turn',
      should: 'hand the chain depth to the agent module so the cap can see it',
      actual: sends,
      expected: [1],
    });
  });
});

describe('add_session prompt', () => {
  function promptDeps(sendResult: { success: boolean; error?: string } = { success: true }) {
    const sent: { name: string; input: string; depth?: number }[] = [];
    const { deps: d, recorded } = deps({
      io: {
        agent: {
          read: notDispatched,
          send: async (input) => {
            sent.push({ name: input.identity.name, input: input.input, depth: input.depth });
            return sendResult as never;
          },
        },
        pty: { read: notDispatched, send: notDispatched },
      },
    });
    return { deps: d, sent, recorded };
  }

  it('given add_session with a prompt on an agent session, should dispatch the first turn', async () => {
    const { deps: d, sent } = promptDeps();
    const tools = createSessionTools(d);

    const result = (await exec(
      tools.add_session,
      { type: 'agent', name: 'worker', prompt: 'audit the repo' },
      context(rootBinding()),
    )) as { success: boolean; prompt?: { delivered: boolean } };

    assert({
      given: 'an agent session started with a prompt',
      should: 'spawn it and dispatch that prompt through the send engine',
      actual: { success: result.success, prompt: result.prompt, sent },
      expected: {
        success: true,
        prompt: { delivered: true },
        sent: [{ name: 'worker', input: 'audit the repo', depth: 0 }],
      },
    });
  });

  it('given a prompt for a SHELL session, should refuse before anything is spawned', async () => {
    const { deps: d, sent, recorded } = promptDeps();
    const tools = createSessionTools(d);

    const result = (await exec(
      tools.add_session,
      { type: 'shell', name: 'sh1', prompt: 'ls' },
      context(rootBinding()),
    )) as { success: boolean };

    assert({
      given: 'a starting prompt aimed at a shell session',
      should: 'refuse, spawning nothing and dispatching nothing',
      actual: { success: result.success, spawned: recorded.spawned.length, sent },
      expected: { success: false, spawned: 0, sent: [] },
    });
  });

  it('given a prompt that could not be delivered, should report the session AND the undelivered prompt', async () => {
    const { deps: d } = promptDeps({ success: false, error: 'Session "worker" is already working on something' });
    const tools = createSessionTools(d);

    const result = (await exec(
      tools.add_session,
      { type: 'agent', name: 'worker', prompt: 'go' },
      context(rootBinding()),
    )) as { success: boolean; name: string; prompt?: { delivered: boolean; error?: string } };

    assert({
      given: 'a session that started but whose first turn was refused',
      should: 'report the session as started and the prompt as undelivered',
      actual: {
        success: result.success,
        name: result.name,
        delivered: result.prompt?.delivered,
        hasReason: (result.prompt?.error ?? '').length > 0,
      },
      expected: { success: true, name: 'worker', delivered: false, hasReason: true },
    });
  });
});
