import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Tool } from 'ai';
import {
  createSessionTools,
  MAX_TRANSCRIPT_MESSAGE_CHARS,
  UNTRUSTED_TRANSCRIPT_NOTE,
  type SessionToolsDeps,
  type AgentToolSurfaceReport,
} from '../session-tools';
import { MAX_AGENT_DEPTH } from '@pagespace/lib/agent-workspaces/plan-spawn-worker';
import type { ToolExecutionContext } from '../../core/types';

const USER_ID = 'user-1';
const CALLER_CONVERSATION = 'conv-caller';
const CALLER_AGENT = 'page-agent-1';
// The caller's WORKSPACE (agent_workspaces.id) — deliberately a DIFFERENT id
// namespace from the conversation. Review H2 hid behind fakes that reused the
// conversation id here, so the always-false comparison always "passed".
const WORKSPACE_ID = 'workspace-row-1';

const SHELL = {
  shellId: 'shell-row-1',
  workspaceId: WORKSPACE_ID,
  sessionId: WORKSPACE_ID,
  ownerId: USER_ID,
  name: 'shell-1',
  agentType: 'shell' as const,
  command: null,
  createdAt: '2026-07-28T00:00:00.000Z',
};

/** The layout a spawn reports back: the pane it landed in, and how many the workspace holds. */
const PANES = { paneCount: 2, nodeId: 'pane-shell' };

function makeDeps(over: Partial<SessionToolsDeps> = {}): SessionToolsDeps {
  return {
    findOwnWorkspace: vi.fn(async () => ({ workspaceId: WORKSPACE_ID, driveId: null })),
    // The layout family's session-access gate (security review HIGH 2).
    checkWorkspaceAccess: vi.fn(async () => ({ allowed: true })),
    checkWorkspaceEndAccess: vi.fn(async () => ({ allowed: true })),
    listWorkspaceWorkers: vi.fn(async () => ({ sandbox: 'running' as const, workers: [], shells: [] })),
    listOwnWorkspaces: vi.fn(async () => []),
    listSharedWorkspaces: vi.fn(async () => []),
    findWorker: vi.fn(async (conversationId: string) => ({
      conversationId,
      ownerId: USER_ID,
      agentPageId: CALLER_AGENT,
      name: 'worker',
      workspaceId: WORKSPACE_ID,
      isClosed: false,
      isShared: false,
      workspaceOwnerId: null,
      workspaceDriveId: null,
    })),
    countOpenConversations: vi.fn(async () => 0),
    canUseAgent: vi.fn(async () => true),
    describeAgentToolSurface: vi.fn(async () => ({ configured: null, granted: [], blocked: [], conditional: [], deferred: [], notes: [] })),
    createWorkerSession: vi.fn(async () => ({ ok: true as const, workspaceId: WORKSPACE_ID })),
    dispatch: vi.fn(async () => ({ ok: true as const, waited: false as const })),
    readTranscript: vi.fn(async () => []),
    killWorker: vi.fn(async () => ({ ok: true as const, spriteTornDown: true })),
    ensureOwnSessionSandbox: vi.fn(async () => ({ ok: true as const })),
    spawnShell: vi.fn(async () => ({ ok: true as const, shell: SHELL, panes: PANES })),
    findShell: vi.fn(async () => ({ shellId: SHELL.shellId, workspaceId: WORKSPACE_ID, name: SHELL.name })),
    killShell: vi.fn(async () => ({ ok: true as const, killed: true, panes: { paneCount: 2, nodeId: 'pane-shell' } })),
    shellIo: {
      read: vi.fn(async () => ({ ok: true as const, live: true, hasOutput: true, output: 'hello' })),
      send: vi.fn(async () => ({ ok: true as const, delivered: true as const })),
    },
    newId: vi.fn(() => 'new-session-id'),
    ...over,
  };
}

function contextOptions(overrides: Partial<ToolExecutionContext> = {}): { experimental_context: ToolExecutionContext } {
  return {
    experimental_context: {
      userId: USER_ID,
      conversationId: CALLER_CONVERSATION,
      chatSource: { type: 'page', agentPageId: CALLER_AGENT, agentTitle: 'Agent' },
      ...overrides,
    } as ToolExecutionContext,
  };
}

type ToolResult = Record<string, unknown>;

async function run(toolDef: Tool, input: unknown, options: unknown): Promise<ToolResult> {
  const execute = toolDef.execute as (input: unknown, options: unknown) => Promise<ToolResult>;
  return execute(input, options);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the fourteen-tool surface', () => {
  it('should export EXACTLY the fourteen tools of the three verb families', () => {
    const tools = createSessionTools(makeDeps());
    // Workers + shells (frozen since Phase 1) plus the LAYOUT family that
    // issue #2208 added once the pane grid became relational entities.
    //
    // `close_pane` is a REPLACEMENT rather than a fourteenth capability: an
    // agent used to take a pane off the grid with `move_pane(toParentId: null)`,
    // because null was a legal destination meaning PARKED. There is one place a
    // node can be now, so that destination is gone and taking a pane away needs
    // its own verb.
    expect(Object.keys(tools).sort()).toEqual([
      'arrange_panes',
      'close_pane',
      'kill_session',
      'kill_shell',
      'list_panes',
      'list_sessions',
      'move_pane',
      'read_session',
      'read_shell',
      'resize_pane',
      'send_session',
      'send_shell',
      'spawn_session',
      'spawn_shell',
    ]);
  });
});

describe('list_sessions', () => {
  it("lists the caller's WORKSPACE: workers in the verbs' own address namespace, plus shells and the shared sandbox", async () => {
    const listing = {
      sandbox: 'running' as const,
      workers: [
        { sessionId: 'conv-worker-1', name: 'w', agent: { agentId: CALLER_AGENT, title: 'Agent' }, isCaller: false },
        { sessionId: CALLER_CONVERSATION, name: 'me', agent: null, isCaller: true },
      ],
      shells: [{ shellId: SHELL.shellId, name: SHELL.name, createdAt: SHELL.createdAt }],
    };
    const deps = makeDeps({ listWorkspaceWorkers: vi.fn(async () => listing) });
    const tools = createSessionTools(deps);
    const result = await run(tools.list_sessions, {}, contextOptions());
    expect(result).toEqual({
      success: true,
      workspaceId: WORKSPACE_ID,
      ...listing,
      otherWorkspaces: [],
      sharedWorkspaces: [],
    });
    // Review H2b's pin: the listing is resolved from the caller's workspace,
    // and every worker id it returns is a conversation id — the exact address
    // send_session/read_session/kill_session take. The caller's user id rides
    // along as the VIEWER for the shared-workspace title redaction rule.
    expect(deps.listWorkspaceWorkers).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      callerConversationId: CALLER_CONVERSATION,
      callerUserId: USER_ID,
    });
    // The caller's own workspace is excluded from BOTH cross-workspace lists
    // — it is already the top-level detail view (and a caller spawned into a
    // shared workspace has a current workspace they do not own).
    expect(deps.listOwnWorkspaces).toHaveBeenCalledWith({
      userId: USER_ID,
      excludeWorkspaceId: WORKSPACE_ID,
    });
    expect(deps.listSharedWorkspaces).toHaveBeenCalledWith({
      userId: USER_ID,
      excludeWorkspaceId: WORKSPACE_ID,
    });
  });

  it('a conversation with NO session says so — and still lists the caller\'s OTHER workspaces, whose workers are addressable from anywhere', async () => {
    const elsewhere = {
      workspaceId: 'ws-elsewhere',
      name: 'research fleet',
      driveId: null,
      sandbox: 'running' as const,
      workers: [{ sessionId: 'conv-far-worker', name: 'far worker', agent: null }],
    };
    const deps = makeDeps({
      findOwnWorkspace: vi.fn(async () => null),
      listOwnWorkspaces: vi.fn(async () => [elsewhere]),
    });
    const tools = createSessionTools(deps);
    const result = await run(tools.list_sessions, {}, contextOptions());
    expect(result).toMatchObject({
      success: true,
      workspaceId: null,
      sandbox: 'none',
      workers: [],
      shells: [],
      otherWorkspaces: [elsewhere],
    });
    expect(result.note).toContain('no workspace');
    expect(deps.listWorkspaceWorkers).not.toHaveBeenCalled();
  });

  it('given no authenticated user, should refuse', async () => {
    const tools = createSessionTools(makeDeps());
    const result = await run(tools.list_sessions, {}, { experimental_context: {} });
    expect(result.success).toBe(false);
  });
});

describe('spawn_session', () => {
  it('should create a labeled worker and dispatch its first turn one level deeper', async () => {
    const deps = makeDeps();
    const tools = createSessionTools(deps);
    const result = await run(
      tools.spawn_session,
      { name: 'worker', prompt: 'do the thing' },
      contextOptions(),
    );
    expect(result).toEqual(
      expect.objectContaining({ success: true, sessionId: 'new-session-id', name: 'worker' }),
    );
    expect(deps.createWorkerSession).toHaveBeenCalledWith({
      conversationId: 'new-session-id',
      // Default placement: the worker joins its SPAWNER's workspace.
      callerConversationId: CALLER_CONVERSATION,
      ownerId: USER_ID,
      agentPageId: CALLER_AGENT,
      name: 'worker',
      workspace: undefined,
      // The calling credential's ceiling rides placement — empty here because
      // this caller is unscoped. Pinned in the scoped block below.
      allowedDriveIds: [],
    });
    expect(deps.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'new-session-id', depth: 1, wait: false, input: 'do the thing' }),
    );
  });

  it('workspace targeting passes through, reports where the worker landed, and skips the caller-workspace advisory count — fan-out aims wherever it likes', async () => {
    const deps = makeDeps({
      createWorkerSession: vi.fn(async () => ({ ok: true as const, workspaceId: 'ws-target' })),
      // The caller's own workspace being FULL must not refuse a spawn aimed
      // elsewhere — the target's own enforced cap answers instead.
      countOpenConversations: vi.fn(async () => 10_000),
    });
    const tools = createSessionTools(deps);
    const result = await run(
      tools.spawn_session,
      { name: 'w', prompt: 'p', workspace: 'ws-target' },
      contextOptions(),
    );
    expect(result).toEqual(expect.objectContaining({ success: true, workspaceId: 'ws-target' }));
    expect(deps.createWorkerSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: 'ws-target' }),
    );
    expect(deps.countOpenConversations).not.toHaveBeenCalled();
  });

  it("workspace: 'new' passes through for an isolated worker", async () => {
    const deps = makeDeps({
      createWorkerSession: vi.fn(async () => ({ ok: true as const, workspaceId: 'ws-fresh' })),
    });
    const tools = createSessionTools(deps);
    const result = await run(
      tools.spawn_session,
      { name: 'w', prompt: 'p', workspace: 'new' },
      contextOptions(),
    );
    expect(result).toEqual(expect.objectContaining({ success: true, workspaceId: 'ws-fresh' }));
    expect(deps.createWorkerSession).toHaveBeenCalledWith(expect.objectContaining({ workspace: 'new' }));
  });

  it('given wait: true, should return the worker\'s reply directly', async () => {
    const deps = makeDeps({
      dispatch: vi.fn(async () => ({ ok: true as const, waited: true as const, reply: 'done: 42' })),
    });
    const tools = createSessionTools(deps);
    const result = await run(
      tools.spawn_session,
      { name: 'w', prompt: 'p', wait: true },
      contextOptions(),
    );
    expect(result).toEqual(expect.objectContaining({ success: true, reply: 'done: 42' }));
  });

  it('given a caller at the depth cap, should refuse BEFORE creating anything', async () => {
    const deps = makeDeps();
    const tools = createSessionTools(deps);
    const result = await run(
      tools.spawn_session,
      { name: 'w', prompt: 'p' },
      contextOptions({ agentCallDepth: MAX_AGENT_DEPTH }),
    );
    expect(result).toEqual(expect.objectContaining({ success: false, reason: 'depth_exceeded' }));
    expect(deps.createWorkerSession).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('should not consult any sandbox-concurrency quota — a worker spawn mints a conversation, never a sandbox (codex round 11)', async () => {
    const deps = makeDeps();
    const tools = createSessionTools(deps);
    const result = await run(tools.spawn_session, { name: 'w', prompt: 'p' }, contextOptions());
    expect(result).toEqual(expect.objectContaining({ success: true }));
  });

  it('given a blank prompt, should refuse — spawning a worker means giving it work', async () => {
    const deps = makeDeps();
    const tools = createSessionTools(deps);
    const result = await run(tools.spawn_session, { name: 'w', prompt: '   ' }, contextOptions());
    expect(result).toEqual(expect.objectContaining({ success: false, reason: 'missing_prompt' }));
  });

  it('given an explicit agent the caller cannot use, should refuse with agent_not_found', async () => {
    const deps = makeDeps({ canUseAgent: vi.fn(async () => false) });
    const tools = createSessionTools(deps);
    const result = await run(
      tools.spawn_session,
      { name: 'w', prompt: 'p', agent: 'someone-elses-agent' },
      contextOptions(),
    );
    expect(result).toEqual(expect.objectContaining({ success: false, reason: 'agent_not_found' }));
    expect(deps.createWorkerSession).not.toHaveBeenCalled();
  });

  it('given an explicit agent, should anchor the worker to IT, not the caller\'s agent', async () => {
    const deps = makeDeps();
    const tools = createSessionTools(deps);
    await run(tools.spawn_session, { name: 'w', prompt: 'p', agent: 'other-agent' }, contextOptions());
    expect(deps.createWorkerSession).toHaveBeenCalledWith(
      expect.objectContaining({ agentPageId: 'other-agent' }),
    );
  });

  it('given a global-assistant caller, should spawn a global worker (agentPageId null) without an agent check', async () => {
    const deps = makeDeps();
    const tools = createSessionTools(deps);
    await run(
      tools.spawn_session,
      { name: 'w', prompt: 'p' },
      contextOptions({ chatSource: { type: 'global' } as ToolExecutionContext['chatSource'] }),
    );
    expect(deps.createWorkerSession).toHaveBeenCalledWith(expect.objectContaining({ agentPageId: null }));
    expect(deps.canUseAgent).not.toHaveBeenCalled();
  });

  it('given a dispatch failure AFTER the session was created, should report the failure WITH the sessionId', async () => {
    const deps = makeDeps({
      dispatch: vi.fn(async () => ({ ok: false as const, reason: 'failed' as const, detail: 'gate refused' })),
    });
    const tools = createSessionTools(deps);
    const result = await run(tools.spawn_session, { name: 'w', prompt: 'p' }, contextOptions());
    expect(result).toEqual(
      expect.objectContaining({ success: false, sessionId: 'new-session-id' }),
    );
  });
});

describe('send_session', () => {
  it('should dispatch to an owned session one level deeper', async () => {
    const deps = makeDeps();
    const tools = createSessionTools(deps);
    const result = await run(
      tools.send_session,
      { sessionId: 's1', input: 'continue' },
      contextOptions({ agentCallDepth: 1 }),
    );
    expect(result).toEqual(expect.objectContaining({ success: true, accepted: true }));
    expect(deps.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 's1', depth: 2, wait: false }),
    );
  });

  it('given a caller at the depth cap, should refuse the send too — a send IS a dispatch', async () => {
    const deps = makeDeps();
    const tools = createSessionTools(deps);
    const result = await run(
      tools.send_session,
      { sessionId: 's1', input: 'x' },
      contextOptions({ agentCallDepth: MAX_AGENT_DEPTH }),
    );
    expect(result).toEqual(expect.objectContaining({ success: false, reason: 'depth_exceeded' }));
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('given someone else\'s session in a drive the caller cannot reach, should read as nonexistent', async () => {
    const deps = makeDeps({
      findWorker: vi.fn(async () => ({
        conversationId: 's1',
        ownerId: 'someone-else',
        agentPageId: null,
        name: '',
        workspaceId: WORKSPACE_ID,
        isClosed: false,
        isShared: false,
        workspaceOwnerId: null,
        workspaceDriveId: null,
      })),
      // Reach is the DRIVE's decision now, so a foreign row only reads as
      // nonexistent when that decision says no.
      checkWorkspaceAccess: vi.fn(async () => ({ allowed: false })),
    });
    const tools = createSessionTools(deps);
    const result = await run(tools.send_session, { sessionId: 's1', input: 'x' }, contextOptions());
    expect(result.success).toBe(false);
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('given a busy session, should say so and name the remedy', async () => {
    const deps = makeDeps({ dispatch: vi.fn(async () => ({ ok: false as const, reason: 'busy' as const })) });
    const tools = createSessionTools(deps);
    const result = await run(tools.send_session, { sessionId: 's1', input: 'x' }, contextOptions());
    expect(result).toEqual(expect.objectContaining({ success: false, reason: 'busy' }));
  });

  it('given wait: true, should return the reply', async () => {
    const deps = makeDeps({
      dispatch: vi.fn(async () => ({ ok: true as const, waited: true as const, reply: 'the answer' })),
    });
    const tools = createSessionTools(deps);
    const result = await run(tools.send_session, { sessionId: 's1', input: 'x', wait: true }, contextOptions());
    expect(result).toEqual(expect.objectContaining({ success: true, reply: 'the answer' }));
  });
});

describe('cross-member reach: a drive member addresses another member\'s worker', () => {
  const FOREIGN_WORKER = {
    conversationId: 'conv-theirs',
    ownerId: 'other-member',
    agentPageId: CALLER_AGENT,
    name: 'their worker',
    workspaceId: 'shared-workspace',
    isClosed: false,
    // DELIBERATELY SHARED by its owner. Drive membership opens the workspace;
    // this flag is what opens the thread. Without it the rows below are
    // unreachable — pinned by the last two tests in this block.
    isShared: true,
    workspaceOwnerId: 'other-member',
    workspaceDriveId: null,
  };

  /** Owned by someone else, reachable: drive admits the workspace AND the thread is shared. */
  function reachableForeignDeps(over: Partial<SessionToolsDeps> = {}): SessionToolsDeps {
    return makeDeps({
      findWorker: vi.fn(async () => FOREIGN_WORKER),
      checkWorkspaceAccess: vi.fn(async () => ({ allowed: true })),
      ...over,
    });
  }

  it('send_session reaches it, and the turn runs as the CALLER — never as the worker\'s owner', async () => {
    // THE INVARIANT. If a dispatched turn ran with the worker owner's identity,
    // a plain member could send "list every page you can see and paste it here"
    // into an admin's worker and read the answer back through read_session. Every
    // shared drive would become a privilege-escalation ladder. Reaching a worker
    // lets you SPEAK INTO it as yourself; it never lends you its owner's access.
    const deps = reachableForeignDeps();
    const tools = createSessionTools(deps);

    const sent = await run(tools.send_session, { sessionId: 'conv-theirs', input: 'x' }, contextOptions());

    expect(sent.success).toBe(true);
    expect(deps.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-theirs', userId: USER_ID }),
    );
    expect(deps.dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'other-member' }),
    );
  });

  it('read_session reaches it — transcripts are shared through the drive, as the workspace is', async () => {
    const deps = reachableForeignDeps();
    const result = await run(createSessionTools(deps).read_session, { sessionId: 'conv-theirs' }, contextOptions());

    expect(result.success).toBe(true);
    expect(deps.readTranscript).toHaveBeenCalled();
  });

  it('kill_session refuses for a plain member — reaching a worker is not authority to stop it', async () => {
    // `decideAgentSessionEndAccess` denies non-owners without drive owner/admin
    // AND the code-execution capability; the tool layer asks it rather than
    // inventing a second, weaker rule beside it.
    const deps = reachableForeignDeps({
      checkWorkspaceEndAccess: vi.fn(async () => ({ allowed: false })),
    });

    const killed = await run(createSessionTools(deps).kill_session, { sessionId: 'conv-theirs' }, contextOptions());

    expect(killed).toEqual(expect.objectContaining({ success: false, reason: 'not_yours_to_stop' }));
    expect(deps.killWorker).not.toHaveBeenCalled();
  });

  it('kill_session succeeds for a drive admin, and aborts the WORKER OWNER\'s streams', async () => {
    const deps = reachableForeignDeps({
      checkWorkspaceEndAccess: vi.fn(async () => ({ allowed: true })),
    });

    const killed = await run(createSessionTools(deps).kill_session, { sessionId: 'conv-theirs' }, contextOptions());

    expect(killed.success).toBe(true);
    // Not `actingUserId` — aborting as the admin would match no stream rows and
    // report success while the worker kept running.
    expect(deps.killWorker).toHaveBeenCalledWith({
      conversationId: 'conv-theirs',
      streamOwnerId: 'other-member',
      actingUserId: USER_ID,
    });
  });

  it('a NON-member gets one indistinguishable refusal from all three verbs', async () => {
    const deps = reachableForeignDeps({
      checkWorkspaceAccess: vi.fn(async () => ({ allowed: false })),
    });
    const missingDeps = makeDeps({ findWorker: vi.fn(async () => null) });
    const tools = createSessionTools(deps);

    for (const verb of ['send_session', 'read_session', 'kill_session'] as const) {
      const input = verb === 'send_session' ? { sessionId: 'conv-theirs', input: 'x' } : { sessionId: 'conv-theirs' };
      const refused = await run(tools[verb], input, contextOptions());
      const missing = await run(createSessionTools(missingDeps)[verb], input, contextOptions());
      expect(refused).toEqual(missing);
    }
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.readTranscript).not.toHaveBeenCalled();
    expect(deps.killWorker).not.toHaveBeenCalled();
  });

  it('the owner may always stop their own worker without the END check running at all', async () => {
    const deps = makeDeps({
      checkWorkspaceEndAccess: vi.fn(async () => ({ allowed: false })),
    });

    const killed = await run(createSessionTools(deps).kill_session, { sessionId: 's1' }, contextOptions());

    expect(killed.success).toBe(true);
    expect(deps.checkWorkspaceEndAccess).not.toHaveBeenCalled();
  });

  it('a foreign worker with NO workspace is unreachable — there is nothing to derive drive reach from', async () => {
    const deps = makeDeps({
      findWorker: vi.fn(async () => ({ ...FOREIGN_WORKER, workspaceId: null })),
      checkWorkspaceAccess: vi.fn(async () => ({ allowed: true })),
    });

    const sent = await run(createSessionTools(deps).send_session, { sessionId: 'conv-theirs', input: 'x' }, contextOptions());

    expect(sent.success).toBe(false);
    // It must not leak the typed "not a worker yet" remedy to a stranger, and it
    // must not have consulted the drive at all.
    expect(sent).not.toHaveProperty('reason');
    expect(deps.checkWorkspaceAccess).not.toHaveBeenCalled();
  });
  it('an UNSHARED foreign worker reads as nonexistent even with full drive access', async () => {
    // THE OPT-IN. Drive membership opens the working context, not every private
    // conversation inside it. This is the same predicate that prints
    // "(private thread)" for this row in list_sessions — one rule, so an agent
    // can address exactly the rows it can name.
    const deps = reachableForeignDeps({
      findWorker: vi.fn(async () => ({ ...FOREIGN_WORKER, isShared: false })),
    });
    const missingDeps = makeDeps({ findWorker: vi.fn(async () => null) });
    const tools = createSessionTools(deps);

    for (const verb of ['send_session', 'read_session', 'kill_session'] as const) {
      const input = verb === 'send_session' ? { sessionId: 'conv-theirs', input: 'x' } : { sessionId: 'conv-theirs' };
      const refused = await run(tools[verb], input, contextOptions());
      const missing = await run(createSessionTools(missingDeps)[verb], input, contextOptions());
      // Indistinguishable from a row that does not exist — a member learns
      // nothing about a colleague's private thread from the refusal.
      expect(refused).toEqual(missing);
    }
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.readTranscript).not.toHaveBeenCalled();
    expect(deps.killWorker).not.toHaveBeenCalled();
  });

  it('the WORKSPACE owner reaches an unshared thread inside their own workspace', async () => {
    // They are the tenant of that working context, and the listing already shows
    // them every title in it — the same third arm of the predicate.
    const deps = reachableForeignDeps({
      findWorker: vi.fn(async () => ({
        ...FOREIGN_WORKER,
        isShared: false,
        workspaceOwnerId: USER_ID,
        workspaceDriveId: null,
      })),
    });

    const sent = await run(createSessionTools(deps).send_session, { sessionId: 'conv-theirs', input: 'x' }, contextOptions());

    expect(sent.success).toBe(true);
  });

  it('an unresolvable workspace owner fails CLOSED rather than opening every thread', async () => {
    const deps = reachableForeignDeps({
      findWorker: vi.fn(async () => ({ ...FOREIGN_WORKER, isShared: false, workspaceOwnerId: null })),
    });

    const sent = await run(createSessionTools(deps).send_session, { sessionId: 'conv-theirs', input: 'x' }, contextOptions());

    expect(sent.success).toBe(false);
  });
});

describe('worker verbs are RESOURCE-addressed — REACH is the gate, the calling surface is not (issue #2335 product decision, superseding #2262 finding 1\'s workspace confinement)', () => {
  // The verbs work like read_page: the id is the address, permission decides.
  // Deliberate tradeoff, decided by the product owner: the assistant
  // orchestrates the user's workers from ANY surface, so "is this worker in
  // MY workspace" is no longer a refusal. What still refuses: a row the
  // caller does not OWN, a listing the human CLOSED, and a thread that is
  // not a worker at all (no workspace binding). A page worker's dispatch
  // additionally re-enforces the agent's RBAC inside the standard chat
  // pipeline it runs through.
  const OTHER_WORKSPACE_ROW = {
    conversationId: 'conv-other',
    ownerId: USER_ID,
    agentPageId: CALLER_AGENT,
    name: 'worker elsewhere',
    workspaceId: 'another-of-my-workspaces',
    isClosed: false,
    isShared: false,
    workspaceOwnerId: null,
    workspaceDriveId: null,
  };

  it('the caller\'s own worker in ANOTHER workspace is addressable — send/read/kill all reach it', async () => {
    const deps = makeDeps({ findWorker: vi.fn(async () => OTHER_WORKSPACE_ROW) });
    const tools = createSessionTools(deps);

    const sent = await run(tools.send_session, { sessionId: 'conv-other', input: 'x' }, contextOptions());
    expect(sent.success).toBe(true);
    expect(deps.dispatch).toHaveBeenCalled();

    const readResult = await run(tools.read_session, { sessionId: 'conv-other' }, contextOptions());
    expect(readResult.success).toBe(true);
    expect(deps.readTranscript).toHaveBeenCalled();

    const killed = await run(tools.kill_session, { sessionId: 'conv-other' }, contextOptions());
    expect(killed.success).toBe(true);
    expect(deps.killWorker).toHaveBeenCalled();
  });

  it('a FOREIGN-owned worker the caller cannot reach through the drive reads as nonexistent', async () => {
    const deps = makeDeps({
      findWorker: vi.fn(async () => ({ ...OTHER_WORKSPACE_ROW, ownerId: 'someone-else' })),
      checkWorkspaceAccess: vi.fn(async () => ({ allowed: false })),
    });
    const tools = createSessionTools(deps);

    const sent = await run(tools.send_session, { sessionId: 'conv-other', input: 'x' }, contextOptions());
    expect(sent.success).toBe(false);
    expect(deps.dispatch).not.toHaveBeenCalled();

    const readResult = await run(tools.read_session, { sessionId: 'conv-other' }, contextOptions());
    expect(readResult.success).toBe(false);
    expect(deps.readTranscript).not.toHaveBeenCalled();

    const killed = await run(tools.kill_session, { sessionId: 'conv-other' }, contextOptions());
    expect(killed.success).toBe(false);
    expect(deps.killWorker).not.toHaveBeenCalled();
  });

  it('the caller\'s OWN worker with a CLOSED listing refuses with the typed worker_closed remedy — never dispatch/read/kill into it (spec §2 Phase 1)', async () => {
    const deps = makeDeps({
      findWorker: vi.fn(async () => ({ ...OTHER_WORKSPACE_ROW, workspaceId: WORKSPACE_ID, isClosed: true })),
    });
    const tools = createSessionTools(deps);

    const sent = await run(tools.send_session, { sessionId: 'conv-other', input: 'x' }, contextOptions());
    expect(sent).toEqual(expect.objectContaining({ success: false, reason: 'worker_closed' }));
    expect((sent as { error: string }).error).toContain('closed');
    expect(deps.dispatch).not.toHaveBeenCalled();

    const readResult = await run(tools.read_session, { sessionId: 'conv-other' }, contextOptions());
    expect(readResult).toEqual(expect.objectContaining({ success: false, reason: 'worker_closed' }));
    expect(deps.readTranscript).not.toHaveBeenCalled();

    const killed = await run(tools.kill_session, { sessionId: 'conv-other' }, contextOptions());
    expect(killed).toEqual(expect.objectContaining({ success: false, reason: 'worker_closed' }));
    expect(deps.killWorker).not.toHaveBeenCalled();
  });

  it('the caller\'s OWN workspace-less conversation refuses with the typed not_a_worker guidance — it is not a worker anywhere (spec §2 Phase 1)', async () => {
    const deps = makeDeps({
      findWorker: vi.fn(async () => ({ ...OTHER_WORKSPACE_ROW, workspaceId: null })),
    });
    const tools = createSessionTools(deps);
    const result = await run(tools.read_session, { sessionId: 'conv-other' }, contextOptions());
    expect(result).toEqual(expect.objectContaining({ success: false, reason: 'not_a_worker' }));
    expect((result as { error: string }).error).toContain('spawn_session');
    expect(deps.readTranscript).not.toHaveBeenCalled();
  });

  it('a caller whose own conversation has NO workspace can still address workers by id — the source surface is irrelevant', async () => {
    const deps = makeDeps({ findOwnWorkspace: vi.fn(async () => null) });
    const tools = createSessionTools(deps);
    const result = await run(tools.send_session, { sessionId: 's1', input: 'x' }, contextOptions());
    expect(result.success).toBe(true);
    expect(deps.dispatch).toHaveBeenCalled();
  });

  it('a caller with no conversation in context can still read a worker — auth is the only context requirement', async () => {
    const deps = makeDeps();
    const tools = createSessionTools(deps);
    const result = await run(
      tools.read_session,
      { sessionId: 's1' },
      contextOptions({ conversationId: undefined }),
    );
    expect(result.success).toBe(true);
    expect(deps.readTranscript).toHaveBeenCalled();
  });

  it('the refusal reads exactly like a nonexistent session — nothing to learn from the difference', async () => {
    const deps = makeDeps({
      findWorker: vi.fn(async () => ({ ...OTHER_WORKSPACE_ROW, ownerId: 'someone-else' })),
      checkWorkspaceAccess: vi.fn(async () => ({ allowed: false })),
    });
    const noRowDeps = makeDeps({ findWorker: vi.fn(async () => null) });
    const foreign = await run(
      createSessionTools(deps).send_session,
      { sessionId: 'conv-other', input: 'x' },
      contextOptions(),
    );
    const noRow = await run(
      createSessionTools(noRowDeps).send_session,
      { sessionId: 'conv-other', input: 'x' },
      contextOptions(),
    );
    expect(foreign).toEqual(noRow);
  });
});

describe('read_session', () => {
  it('should return the transcript framed as UNTRUSTED, long turns truncated with a visible marker', async () => {
    const long = 'a'.repeat(MAX_TRANSCRIPT_MESSAGE_CHARS + 100);
    const deps = makeDeps({
      readTranscript: vi.fn(async () => [
        { role: 'user' as const, content: 'hi', at: new Date('2026-07-28T00:00:00Z') },
        { role: 'assistant' as const, content: long, at: new Date('2026-07-28T00:01:00Z'), pending: true },
      ]),
    });
    const tools = createSessionTools(deps);
    const result = (await run(tools.read_session, { sessionId: 's1' }, contextOptions())) as {
      success: boolean;
      messages: Array<{ content: string; pending?: boolean }>;
      untrusted: string;
    };
    expect(result.success).toBe(true);
    expect(result.untrusted).toBe(UNTRUSTED_TRANSCRIPT_NOTE);
    expect(result.messages[1].content).toContain('[truncated');
    expect(result.messages[1].pending).toBe(true);
  });

  it('given an empty transcript, should answer it as a real (empty) answer', async () => {
    const tools = createSessionTools(makeDeps());
    const result = (await run(tools.read_session, { sessionId: 's1' }, contextOptions())) as {
      success: boolean;
      messages: unknown[];
    };
    expect(result.success).toBe(true);
    expect(result.messages).toEqual([]);
  });
});

describe('kill_session', () => {
  it('should end an owned session and report the teardown', async () => {
    const deps = makeDeps();
    const tools = createSessionTools(deps);
    const result = await run(tools.kill_session, { sessionId: 's1' }, contextOptions());
    expect(result).toEqual({ success: true, sessionId: 's1', spriteTornDown: true });
    expect(deps.killWorker).toHaveBeenCalledWith({
      conversationId: 's1',
      streamOwnerId: USER_ID,
      actingUserId: USER_ID,
    });
  });

  it('given a teardown failure, should say the sandbox may still be running', async () => {
    const deps = makeDeps({
      killWorker: vi.fn(async () => ({ ok: false as const, reason: 'teardown_failed' })),
    });
    const tools = createSessionTools(deps);
    const result = await run(tools.kill_session, { sessionId: 's1' }, contextOptions());
    expect(result).toEqual(expect.objectContaining({ success: false, reason: 'teardown_failed' }));
  });
});

describe('spawn_shell', () => {
  it('should lazily ensure the CALLER\'s own session + sandbox, then reserve the shell', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      ensureOwnSessionSandbox: vi.fn(async () => {
        order.push('ensure');
        return { ok: true as const };
      }),
      spawnShell: vi.fn(async () => {
        order.push('spawn');
        return { ok: true as const, shell: SHELL, panes: PANES };
      }),
    });
    const tools = createSessionTools(deps);
    const result = await run(tools.spawn_shell, {}, contextOptions());
    expect(result).toEqual({
      success: true,
      shellId: SHELL.shellId,
      name: SHELL.name,
      paneNodeId: PANES.nodeId,
      paneCount: PANES.paneCount,
    });
    expect(order).toEqual(['ensure', 'spawn']);
    expect(deps.ensureOwnSessionSandbox).toHaveBeenCalledWith({
      conversationId: CALLER_CONVERSATION,
      userId: USER_ID,
      agentPageId: CALLER_AGENT,
    });
  });

  it('given a taken name, should refuse with the remedy', async () => {
    const deps = makeDeps({ spawnShell: vi.fn(async () => ({ ok: false as const, reason: 'name_taken' })) });
    const tools = createSessionTools(deps);
    const result = await run(tools.spawn_shell, { name: 'build' }, contextOptions());
    expect(result).toEqual(expect.objectContaining({ success: false, reason: 'name_taken' }));
    expect((result as { error: string }).error).toContain('"build"');
  });

  it('given NO requested name, should not blame a name the caller never chose', async () => {
    // The auto-label path only collides by losing a race. The single message
    // interpolated `"undefined"` and then advised omitting a name — the exact
    // thing the caller had already done.
    const deps = makeDeps({ spawnShell: vi.fn(async () => ({ ok: false as const, reason: 'name_taken' })) });
    const tools = createSessionTools(deps);
    const result = await run(tools.spawn_shell, {}, contextOptions());
    const error = (result as { error: string }).error;
    expect(error).not.toContain('undefined');
    expect(error).not.toContain('omit name');
    expect(error).toContain('Try again');
  });

  it('given a provisioning failure, should surface it and never reserve a row', async () => {
    const deps = makeDeps({
      ensureOwnSessionSandbox: vi.fn(async () => ({ ok: false as const, error: 'no sandbox for you' })),
    });
    const tools = createSessionTools(deps);
    const result = await run(tools.spawn_shell, {}, contextOptions());
    expect(result).toEqual({ success: false, error: 'no sandbox for you' });
    expect(deps.spawnShell).not.toHaveBeenCalled();
  });
});

describe('send_shell / read_shell — shells target only the CALLER\'s own session', () => {
  it('given a shell of ANOTHER session, should read as nonexistent', async () => {
    const deps = makeDeps({
      findShell: vi.fn(async () => ({ shellId: 'x', workspaceId: 'someone-elses-workspace', name: 's' })),
    });
    const tools = createSessionTools(deps);
    const sent = await run(tools.send_shell, { shellId: 'x', keystrokes: 'ls\n' }, contextOptions());
    expect(sent.success).toBe(false);
    expect(deps.shellIo.send).not.toHaveBeenCalled();
    const readResult = await run(tools.read_shell, { shellId: 'x' }, contextOptions());
    expect(readResult.success).toBe(false);
    expect(deps.shellIo.read).not.toHaveBeenCalled();
  });

  it('should deliver keystrokes and report delivery', async () => {
    const deps = makeDeps();
    const tools = createSessionTools(deps);
    const result = await run(tools.send_shell, { shellId: SHELL.shellId, keystrokes: 'ls\n' }, contextOptions());
    expect(result).toEqual(expect.objectContaining({ success: true, delivered: true }));
    expect(deps.shellIo.send).toHaveBeenCalledWith({ shellId: SHELL.shellId, keystrokes: 'ls\n', userId: USER_ID });
  });

  it('should read scrollback, threading the cold-tail record through', async () => {
    const cold = { tail: 'bye', at: new Date(), hasOutput: true };
    const deps = makeDeps({
      findShell: vi.fn(async () => ({ shellId: SHELL.shellId, workspaceId: WORKSPACE_ID, name: SHELL.name, cold })),
    });
    const tools = createSessionTools(deps);
    const result = await run(tools.read_shell, { shellId: SHELL.shellId, tail: 50 }, contextOptions());
    expect(result).toEqual(expect.objectContaining({ success: true, output: 'hello' }));
    expect(deps.shellIo.read).toHaveBeenCalledWith({ shellId: SHELL.shellId, lines: 50, userId: USER_ID, cold });
  });
});

describe('kill_shell', () => {
  it('should kill an owned shell', async () => {
    const deps = makeDeps();
    const tools = createSessionTools(deps);
    const result = await run(tools.kill_shell, { shellId: SHELL.shellId }, contextOptions());
    expect(result).toEqual({ success: true, shellId: SHELL.shellId, killed: true, paneNodeId: 'pane-shell', paneCount: 2 });
    // The pane went with the process, in the kill's own write — so this is the
    // acting HUMAN's id, never the model's word for one (issue #2462).
    expect(deps.killShell).toHaveBeenCalledWith({ shellId: SHELL.shellId, actingUserId: USER_ID });
  });

  it('given an already-gone shell, should SUCCEED — teardown callers retry', async () => {
    const deps = makeDeps({ findShell: vi.fn(async () => null) });
    const tools = createSessionTools(deps);
    const result = await run(tools.kill_shell, { shellId: 'gone' }, contextOptions());
    expect(result).toEqual(expect.objectContaining({ success: true, killed: false }));
    expect(deps.killShell).not.toHaveBeenCalled();
  });

  it('given an unconfirmable kill, should report failure so the caller retries', async () => {
    const deps = makeDeps({ killShell: vi.fn(async () => ({ ok: false as const, reason: 'error' })) });
    const tools = createSessionTools(deps);
    const result = await run(tools.kill_shell, { shellId: SHELL.shellId }, contextOptions());
    expect(result).toEqual(expect.objectContaining({ success: false, reason: 'error' }));
  });
});

describe('shell addressing across the two id namespaces (review H2)', () => {
  it('send_shell reaches a shell whose row carries the WORKSPACE id, not the conversation id', async () => {
    // The regression this whole fixture-shape exists for: rows store
    // agent_workspaces.id, context carries the conversation id, and the old
    // comparison across the two namespaces refused every real shell ever.
    const deps = makeDeps();
    const tools = createSessionTools(deps);
    const result = await run(tools.send_shell, { shellId: SHELL.shellId, keystrokes: 'ls\n' }, contextOptions());
    expect(result).toMatchObject({ success: true });
    expect(deps.findOwnWorkspace).toHaveBeenCalledWith(CALLER_CONVERSATION);
  });

  it('a caller whose conversation has NO workspace cannot address any shell', async () => {
    const deps = makeDeps({ findOwnWorkspace: vi.fn(async () => null) });
    const tools = createSessionTools(deps);
    const sent = await run(tools.send_shell, { shellId: SHELL.shellId, keystrokes: 'ls\n' }, contextOptions());
    expect(sent.success).toBe(false);
    const killed = await run(tools.kill_shell, { shellId: SHELL.shellId }, contextOptions());
    // kill answers already-gone (fail-closed success), and never kills.
    expect(killed).toMatchObject({ success: true, killed: false });
    expect(deps.killShell).not.toHaveBeenCalled();
  });

  it("kill_shell treats another workspace's shell as already gone and never kills it", async () => {
    const deps = makeDeps({
      findShell: vi.fn(async () => ({ shellId: SHELL.shellId, workspaceId: 'someone-elses-workspace', name: SHELL.name })),
    });
    const tools = createSessionTools(deps);
    const result = await run(tools.kill_shell, { shellId: SHELL.shellId }, contextOptions());
    expect(result).toMatchObject({ success: true, killed: false });
    expect(deps.killShell).not.toHaveBeenCalled();
  });
});

describe('a drive-scoped credential is held to its ceiling, whoever owns the worker', () => {
  // A scoped MCP/API token is NOT its user: it is confined to a subset of that
  // user's drives. Every other gate in this family asks about the user, so
  // without this the token reached any worker its owner could — including in
  // drives outside its scope (PR review, P1).
  const scoped = { mcpAllowedDriveIds: ['drive-in-scope'], mcpTokenId: 'mcp-token-1' };

  function rowInDrive(driveId: string | null, over: Record<string, unknown> = {}) {
    return {
      conversationId: 's1',
      ownerId: USER_ID,
      agentPageId: CALLER_AGENT,
      name: 'worker',
      workspaceId: WORKSPACE_ID,
      isClosed: false,
      isShared: false,
      workspaceOwnerId: USER_ID,
      workspaceDriveId: driveId,
      ...over,
    };
  }

  it('reaches its OWN worker inside the ceiling', async () => {
    const deps = makeDeps({ findWorker: vi.fn(async () => rowInDrive('drive-in-scope')) });

    const sent = await run(
      createSessionTools(deps).send_session,
      { sessionId: 's1', input: 'x' },
      contextOptions(scoped),
    );

    expect(sent.success).toBe(true);
  });

  it('refuses its OWN worker outside the ceiling — ownership is not an escape from scope', async () => {
    const deps = makeDeps({ findWorker: vi.fn(async () => rowInDrive('drive-out-of-scope')) });
    const missingDeps = makeDeps({ findWorker: vi.fn(async () => null) });
    const tools = createSessionTools(deps);

    for (const verb of ['send_session', 'read_session', 'kill_session'] as const) {
      const input = verb === 'send_session' ? { sessionId: 's1', input: 'x' } : { sessionId: 's1' };
      const refused = await run(tools[verb], input, contextOptions(scoped));
      const missing = await run(createSessionTools(missingDeps)[verb], input, contextOptions(scoped));
      expect(refused).toEqual(missing);
    }
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.readTranscript).not.toHaveBeenCalled();
    expect(deps.killWorker).not.toHaveBeenCalled();
  });

  it('refuses a worker whose workspace drive cannot be resolved — fails CLOSED', async () => {
    const deps = makeDeps({ findWorker: vi.fn(async () => rowInDrive(null)) });

    const sent = await run(
      createSessionTools(deps).send_session,
      { sessionId: 's1', input: 'x' },
      contextOptions(scoped),
    );

    expect(sent.success).toBe(false);
  });

  it('an UNSCOPED caller is unaffected — an empty ceiling admits everything', async () => {
    const deps = makeDeps({ findWorker: vi.fn(async () => rowInDrive('any-drive')) });

    const sent = await run(
      createSessionTools(deps).send_session,
      { sessionId: 's1', input: 'x' },
      contextOptions(),
    );

    expect(sent.success).toBe(true);
  });

  it('an UNSCOPED caller reaches a GLOBAL-assistant worker, which has no drive at all', async () => {
    // The asymmetry that is easy to get backwards: `null` means "no drive", so
    // an unscoped credential admits it (this is the case the whole epic set out
    // to enable — the SDK/CLI driving the global assistant), while a scoped one
    // never can, because there is no drive for a drive-scope to have granted.
    const deps = makeDeps({ findWorker: vi.fn(async () => rowInDrive(null)) });

    const sent = await run(
      createSessionTools(deps).send_session,
      { sessionId: 's1', input: 'x' },
      contextOptions(),
    );

    expect(sent.success).toBe(true);
  });

  it('the BOUND workspace is held to the ceiling too — a binding can point outside it', async () => {
    // `spawn_session` takes an explicit `workspace` id, so a conversation driven
    // by an agent page in drive A can be bound to a workspace in drive B. The
    // page-scope check upstream covers the PAGE, not the binding — so without
    // this gate a scoped token got the richest view in the file (every worker's
    // sessionId and agent binding, every shell, live sandbox status) for a drive
    // it may not touch.
    const deps = makeDeps({
      findOwnWorkspace: vi.fn(async () => ({ workspaceId: WORKSPACE_ID, driveId: 'drive-out-of-scope' })),
      listOwnWorkspaces: vi.fn(async () => []),
      listSharedWorkspaces: vi.fn(async () => []),
    });

    const result = await run(createSessionTools(deps).list_sessions, {}, contextOptions(scoped));

    // Degrades to the no-workspace answer rather than erroring, exactly as a
    // revoked drive membership does.
    expect(result.workspaceId).toBeNull();
    expect(result.workers).toEqual([]);
    expect(deps.listWorkspaceWorkers).not.toHaveBeenCalled();
  });

  it('spawn_session cannot PLACE a worker into an out-of-scope workspace', async () => {
    // Placement is a WRITE, and the worst of the class: it puts an agent, and
    // its sandbox reach, into a workspace the token was never granted. The
    // ceiling rides `createWorkerSession` so the runtime's placement resolver
    // enforces it alongside the user-level session-access decision.
    const deps = makeDeps();

    await run(
      createSessionTools(deps).spawn_session,
      { name: 'w', prompt: 'go', workspace: 'ws-elsewhere' },
      contextOptions(scoped),
    );

    expect(deps.createWorkerSession).toHaveBeenCalledWith(
      expect.objectContaining({ allowedDriveIds: ['drive-in-scope'] }),
    );
  });

  it('spawn_shell refuses when the conversation is bound OUT of scope', async () => {
    // A shell is live PTY access. Only an EXISTING binding can point out of
    // scope — with none, `ensure` mints in the agent's own drive, which the
    // page-scope check upstream already admitted.
    const deps = makeDeps({
      findOwnWorkspace: vi.fn(async () => ({ workspaceId: WORKSPACE_ID, driveId: 'drive-out-of-scope' })),
    });

    const result = await run(createSessionTools(deps).spawn_shell, {}, contextOptions(scoped));

    expect(result.success).toBe(false);
    expect(deps.ensureOwnSessionSandbox).not.toHaveBeenCalled();
    expect(deps.spawnShell).not.toHaveBeenCalled();
  });

  it('the pane grid is unreachable when the bound workspace is out of scope', async () => {
    const deps = makeDeps({
      findOwnWorkspace: vi.fn(async () => ({ workspaceId: WORKSPACE_ID, driveId: 'drive-out-of-scope' })),
    });

    const result = await run(createSessionTools(deps).list_panes, {}, contextOptions(scoped));

    expect(result.success).toBe(false);
    expect(deps.checkWorkspaceAccess).not.toHaveBeenCalled();
  });

  it('list_sessions discovers only workspaces inside the ceiling', async () => {
    // Discovery resolves from the USER's drive relationships, so without the
    // same filter it advertised workspace ids and every worker's sessionId in
    // drives the token may not touch — the addressability gate would then refuse
    // exactly what the listing had just offered.
    const deps = makeDeps({
      findOwnWorkspace: vi.fn(async () => null),
      listOwnWorkspaces: vi.fn(async () => [
        { workspaceId: 'ws-in', name: 'mine', driveId: 'drive-in-scope', sandbox: 'running' as const, workers: [] },
        { workspaceId: 'ws-out', name: 'other', driveId: 'drive-out-of-scope', sandbox: 'running' as const, workers: [] },
      ]),
      listSharedWorkspaces: vi.fn(async () => [
        { workspaceId: 'ws-shared-in', name: 'team', driveId: 'drive-in-scope', sandbox: 'running' as const, workers: [] },
        { workspaceId: 'ws-shared-out', name: 'elsewhere', driveId: 'drive-out-of-scope', sandbox: 'running' as const, workers: [] },
      ]),
    });

    const result = await run(createSessionTools(deps).list_sessions, {}, contextOptions(scoped));

    expect((result.otherWorkspaces as Array<{ workspaceId: string }>).map((w) => w.workspaceId)).toEqual(['ws-in']);
    expect((result.sharedWorkspaces as Array<{ workspaceId: string }>).map((w) => w.workspaceId)).toEqual(['ws-shared-in']);
    expect(JSON.stringify(result)).not.toContain('drive-out-of-scope');
  });
});

/**
 * Issue #2460: three spawns of an agent whose enabledTools named 24 sandbox
 * tools produced three different page-only surfaces and no error anywhere. The
 * allowlist was never ignored — the sandbox switch stripped the family
 * downstream of it — so the spawn is where the divergence has to become
 * audible.
 */
describe('spawn_session: honouring the agent\'s configured tool surface', () => {
  const surface = (over: Partial<AgentToolSurfaceReport> = {}): AgentToolSurfaceReport => ({
    configured: null,
    granted: [],
    blocked: [],
    conditional: [],
    deferred: [],
    notes: [],
    ...over,
  });

  it('given an agent whose enabledTools name sandbox tools its own switch strips, should REFUSE and name the tools and the gate', async () => {
    const deps = makeDeps({
      describeAgentToolSurface: vi.fn(async () =>
        surface({
          configured: ['read_page', 'bash', 'spawn_shell'],
          granted: ['read_page'],
          blocked: [
            { tool: 'bash', gate: 'sandbox_disabled' as const },
            { tool: 'spawn_shell', gate: 'sandbox_disabled' as const },
          ],
        }),
      ),
    });
    const tools = createSessionTools(deps);
    const result = await run(
      tools.spawn_session,
      { name: 'w', prompt: 'p', agent: 'scraper-runner' },
      contextOptions(),
    );

    expect(result).toEqual(
      expect.objectContaining({ success: false, reason: 'agent_tools_ungrantable' }),
    );
    expect(String(result.error)).toContain('bash, spawn_shell');
    expect(String(result.error)).toContain('sandboxEnabled');
    // A crippled worker is worse than no worker: nothing was created, nothing
    // was dispatched, and the caller has an actionable fix instead of a
    // silently useless session id.
    expect(deps.createWorkerSession).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('given drops the caller cannot fix (unregistered names, search-mode deferral), should spawn anyway and WARN on the success payload', async () => {
    const deps = makeDeps({
      describeAgentToolSurface: vi.fn(async () =>
        surface({
          configured: ['read_page', 'read_file'],
          granted: ['read_page'],
          blocked: [{ tool: 'read_file', gate: 'not_registered' as const }],
          deferred: ['trash_page'],
          notes: ['no tool named read_file', 'trash_page is reached through tool_search'],
        }),
      ),
    });
    const tools = createSessionTools(deps);
    const result = await run(
      tools.spawn_session,
      { name: 'w', prompt: 'p', agent: 'scraper-runner' },
      contextOptions(),
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        toolSurfaceWarnings: ['no tool named read_file', 'trash_page is reached through tool_search'],
      }),
    );
    expect(deps.dispatch).toHaveBeenCalled();
  });

  it('given a config the gates honour verbatim, should say nothing about tools at all', async () => {
    const deps = makeDeps();
    const tools = createSessionTools(deps);
    const result = await run(tools.spawn_session, { name: 'w', prompt: 'p' }, contextOptions());

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(result).not.toHaveProperty('toolSurfaceWarnings');
  });

  it('given a global-assistant caller with no agent, should not ask about a tool surface there is no agent to describe', async () => {
    const deps = makeDeps();
    const tools = createSessionTools(deps);
    await run(
      tools.spawn_session,
      { name: 'w', prompt: 'p' },
      contextOptions({ chatSource: { type: 'global' } as ToolExecutionContext['chatSource'] }),
    );

    expect(deps.describeAgentToolSurface).not.toHaveBeenCalled();
  });
});
