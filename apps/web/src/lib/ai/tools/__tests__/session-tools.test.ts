import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Tool } from 'ai';
import {
  createSessionTools,
  MAX_TRANSCRIPT_MESSAGE_CHARS,
  UNTRUSTED_TRANSCRIPT_NOTE,
  type SessionToolsDeps,
} from '../session-tools';
import { MAX_AGENT_DEPTH } from '@pagespace/lib/agent-sessions/plan-spawn-session';
import type { ToolExecutionContext } from '../../core/types';

const USER_ID = 'user-1';
const CALLER_CONVERSATION = 'conv-caller';
const CALLER_AGENT = 'page-agent-1';
// The caller's WORKSPACE (agent_sessions.id) — deliberately a DIFFERENT id
// namespace from the conversation. Review H2 hid behind fakes that reused the
// conversation id here, so the always-false comparison always "passed".
const WORKSPACE_ID = 'workspace-row-1';

const SHELL = {
  shellId: 'shell-row-1',
  sessionId: WORKSPACE_ID,
  ownerId: USER_ID,
  name: 'shell-1',
  agentType: 'shell' as const,
  command: null,
  createdAt: '2026-07-28T00:00:00.000Z',
};

function makeDeps(over: Partial<SessionToolsDeps> = {}): SessionToolsDeps {
  return {
    findOwnWorkspace: vi.fn(async () => ({ sessionId: WORKSPACE_ID })),
    listSessionWorkers: vi.fn(async () => ({ sandbox: 'running' as const, workers: [], shells: [] })),
    findSession: vi.fn(async (sessionId: string) => ({
      sessionId,
      ownerId: USER_ID,
      agentPageId: CALLER_AGENT,
      name: 'worker',
      endedAt: null,
      workspaceSessionId: WORKSPACE_ID,
      isClosed: false,
    })),
    countSessionConversations: vi.fn(async () => 0),
    canUseAgent: vi.fn(async () => true),
    createWorkerSession: vi.fn(async () => ({ ok: true as const })),
    dispatch: vi.fn(async () => ({ ok: true as const, waited: false as const })),
    readTranscript: vi.fn(async () => []),
    endSession: vi.fn(async () => ({ ok: true as const, spriteTornDown: true })),
    ensureOwnSessionSandbox: vi.fn(async () => ({ ok: true as const })),
    spawnShell: vi.fn(async () => ({ ok: true as const, shell: SHELL })),
    findShell: vi.fn(async () => ({ shellId: SHELL.shellId, sessionId: WORKSPACE_ID, name: SHELL.name })),
    killShell: vi.fn(async () => ({ ok: true as const, killed: true })),
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

describe('the nine-tool surface', () => {
  it('should export EXACTLY the nine tools of the two verb families', () => {
    const tools = createSessionTools(makeDeps());
    expect(Object.keys(tools).sort()).toEqual([
      'kill_session',
      'kill_shell',
      'list_sessions',
      'read_session',
      'read_shell',
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
    const deps = makeDeps({ listSessionWorkers: vi.fn(async () => listing) });
    const tools = createSessionTools(deps);
    const result = await run(tools.list_sessions, {}, contextOptions());
    expect(result).toEqual({ success: true, ...listing });
    // Review H2b's pin: the listing is resolved from the caller's workspace,
    // and every worker id it returns is a conversation id — the exact address
    // send_session/read_session/kill_session take.
    expect(deps.listSessionWorkers).toHaveBeenCalledWith({
      workspaceSessionId: WORKSPACE_ID,
      callerConversationId: CALLER_CONVERSATION,
    });
  });

  it('a conversation with NO session says so instead of listing nothing', async () => {
    const deps = makeDeps({ findOwnWorkspace: vi.fn(async () => null) });
    const tools = createSessionTools(deps);
    const result = await run(tools.list_sessions, {}, contextOptions());
    expect(result).toMatchObject({ success: true, sandbox: 'none', workers: [], shells: [] });
    expect(result.note).toContain('no session');
    expect(deps.listSessionWorkers).not.toHaveBeenCalled();
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
      sessionId: 'new-session-id',
      // The worker joins its SPAWNER's workspace — same session, same sandbox.
      callerConversationId: CALLER_CONVERSATION,
      ownerId: USER_ID,
      agentPageId: CALLER_AGENT,
      name: 'worker',
    });
    expect(deps.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'new-session-id', depth: 1, wait: false, input: 'do the thing' }),
    );
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
      expect.objectContaining({ sessionId: 's1', depth: 2, wait: false }),
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

  it('given someone else\'s session, should read as nonexistent', async () => {
    const deps = makeDeps({
      findSession: vi.fn(async () => ({
        sessionId: 's1',
        ownerId: 'someone-else',
        agentPageId: null,
        name: '',
        endedAt: null,
        workspaceSessionId: WORKSPACE_ID,
        isClosed: false,
      })),
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

describe('worker verbs target only the CALLER\'s own workspace (issue #2262 H2 parity with shells)', () => {
  // The blast-radius case the shells fix (H2) never reached workers: a
  // prompt-injected agent could aim send/read/kill_session at ANY conversation
  // its user owns — another session's worker, another drive's thread, a plain
  // session-less chat — and exfiltrate a private transcript or dispatch turns
  // into a foreign sandbox. One address namespace per verb family means a
  // worker verb resolves ONLY siblings in the caller's own session.
  const CROSS_SESSION_ROW = {
    sessionId: 'conv-other',
    ownerId: USER_ID, // the caller's OWN conversation — ownership alone must not admit it
    agentPageId: CALLER_AGENT,
    name: 'private thread',
    endedAt: null,
    workspaceSessionId: 'someone-elses-workspace',
    isClosed: false,
  };

  it('a conversation in ANOTHER session — even the caller\'s own — reads as nonexistent', async () => {
    const deps = makeDeps({ findSession: vi.fn(async () => CROSS_SESSION_ROW) });
    const tools = createSessionTools(deps);

    const sent = await run(tools.send_session, { sessionId: 'conv-other', input: 'x' }, contextOptions());
    expect(sent.success).toBe(false);
    expect(deps.dispatch).not.toHaveBeenCalled();

    const readResult = await run(tools.read_session, { sessionId: 'conv-other' }, contextOptions());
    expect(readResult.success).toBe(false);
    expect(deps.readTranscript).not.toHaveBeenCalled();

    const killed = await run(tools.kill_session, { sessionId: 'conv-other' }, contextOptions());
    expect(killed.success).toBe(false);
    expect(deps.endSession).not.toHaveBeenCalled();
  });

  it('a sibling the human already CLOSED reads as nonexistent — never dispatch/read/kill into a closed listing', async () => {
    const deps = makeDeps({
      findSession: vi.fn(async () => ({ ...CROSS_SESSION_ROW, workspaceSessionId: WORKSPACE_ID, isClosed: true })),
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
    expect(deps.endSession).not.toHaveBeenCalled();
  });

  it('a SESSION-LESS conversation reads as nonexistent — it is not a worker anywhere', async () => {
    const deps = makeDeps({
      findSession: vi.fn(async () => ({ ...CROSS_SESSION_ROW, workspaceSessionId: null })),
    });
    const tools = createSessionTools(deps);
    const result = await run(tools.read_session, { sessionId: 'conv-other' }, contextOptions());
    expect(result.success).toBe(false);
    expect(deps.readTranscript).not.toHaveBeenCalled();
  });

  it('a caller whose conversation has NO workspace cannot address any worker', async () => {
    const deps = makeDeps({ findOwnWorkspace: vi.fn(async () => null) });
    const tools = createSessionTools(deps);
    const result = await run(tools.send_session, { sessionId: 's1', input: 'x' }, contextOptions());
    expect(result.success).toBe(false);
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('a caller with no conversation at all cannot address any worker', async () => {
    const deps = makeDeps();
    const tools = createSessionTools(deps);
    const result = await run(
      tools.read_session,
      { sessionId: 's1' },
      contextOptions({ conversationId: undefined }),
    );
    expect(result.success).toBe(false);
    expect(deps.readTranscript).not.toHaveBeenCalled();
  });

  it('the refusal reads exactly like a nonexistent session — nothing to learn from the difference', async () => {
    const deps = makeDeps({ findSession: vi.fn(async () => CROSS_SESSION_ROW) });
    const noRowDeps = makeDeps({ findSession: vi.fn(async () => null) });
    const crossSession = await run(
      createSessionTools(deps).send_session,
      { sessionId: 'conv-other', input: 'x' },
      contextOptions(),
    );
    const noRow = await run(
      createSessionTools(noRowDeps).send_session,
      { sessionId: 'conv-other', input: 'x' },
      contextOptions(),
    );
    expect(crossSession).toEqual(noRow);
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
    expect(deps.endSession).toHaveBeenCalledWith({ sessionId: 's1', userId: USER_ID });
  });

  it('given a teardown failure, should say the sandbox may still be running', async () => {
    const deps = makeDeps({
      endSession: vi.fn(async () => ({ ok: false as const, reason: 'teardown_failed' })),
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
        return { ok: true as const, shell: SHELL };
      }),
    });
    const tools = createSessionTools(deps);
    const result = await run(tools.spawn_shell, {}, contextOptions());
    expect(result).toEqual({ success: true, shellId: SHELL.shellId, name: SHELL.name });
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
      findShell: vi.fn(async () => ({ shellId: 'x', sessionId: 'someone-elses-workspace', name: 's' })),
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
      findShell: vi.fn(async () => ({ shellId: SHELL.shellId, sessionId: WORKSPACE_ID, name: SHELL.name, cold })),
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
    expect(result).toEqual({ success: true, shellId: SHELL.shellId, killed: true });
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
    // agent_sessions.id, context carries the conversation id, and the old
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
      findShell: vi.fn(async () => ({ shellId: SHELL.shellId, sessionId: 'someone-elses-workspace', name: SHELL.name })),
    });
    const tools = createSessionTools(deps);
    const result = await run(tools.kill_shell, { shellId: SHELL.shellId }, contextOptions());
    expect(result).toMatchObject({ success: true, killed: false });
    expect(deps.killShell).not.toHaveBeenCalled();
  });
});
