import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildAgentTerminalHandlers, MAX_INPUT_BYTES, SETTLE_HEARTBEAT_MS, resolveAgentTerminalCommand, planConnect, ensureAgentTerminalSession, connectFailureMessage, armIdleReap, planColdTailPersist } from '../agent-terminal-handler';
import { createTerminalSessionMap, DETACHED_IDLE_MS } from '../terminal-session-map';
import type { AgentTerminalCheckAuthFn, OpenShellFn, SocketLike } from '../agent-terminal-handler';
import type { TerminalSession } from '../terminal-session-map';
import type { PtyShell, OpenPtyShellArgs } from '../sprites-shell';
import { assert } from './riteway';
import { BRANCH_REPO_PATH } from '@pagespace/lib/services/machines/machine-branches';
import { SANDBOX_ROOT } from '@pagespace/lib/services/sandbox/sandbox-paths';

/**
 * Fire the `onSessionId` callback the handler handed to `openShell` — i.e. do
 * what `openPtyShell` does when the created session announces its id on its own
 * socket. Non-null asserted rather than optional-chained: the handler ALWAYS
 * supplies this callback, and `?.` would silently no-op (passing the test for
 * the wrong reason) if it ever stopped doing so.
 */
function announceSessionId(openShellFn: ReturnType<typeof vi.fn>, sessionId: string): void {
  const args = openShellFn.mock.calls[0][0] as OpenPtyShellArgs;
  expect(args.onSessionId).toBeDefined();
  (args.onSessionId as (id: string) => void)(sessionId);
}

/**
 * A promise whose settlement the test drives. Preferred over a
 * `let resolve = () => {}` placeholder: that throwaway arrow is never called, so
 * v8 scores it as an uncovered function.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function makeSocket(id = 'sock1', userId = 'user1'): SocketLike & { emit: ReturnType<typeof vi.fn> } {
  return { id, data: { user: { id: userId } }, emit: vi.fn() };
}

/**
 * The key a session is filed under on its viewer side. The handler namespaces the
 * client-minted `connectionId` with the SERVER-assigned socket id (see `socketKey`),
 * so that two clients choosing the same id cannot address each other's sessions.
 * Tests must ask for the same key the handler files under, or they assert nothing.
 */
const viewer = (connectionId: string, socketId = 'sock1') => `${socketId}\u0000${connectionId}`;

function makeShell(): PtyShell & {
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  setViewerAttached: ReturnType<typeof vi.fn>;
  /** Stands in for the shell swallowing a watchdog trip (detach-quiet / attach-quiet). */
  setQuiesced: (quiesced: boolean) => void;
} {
  let quiesced = false;
  return {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    setViewerAttached: vi.fn(),
    isQuiesced: () => quiesced,
    setQuiesced: (next: boolean) => { quiesced = next; },
  };
}

function makeSprite(sessions: Array<{ id: string; command: string; isActive: boolean; tty: boolean }> = []) {
  return {
    name: 'sbx1',
    spawn: vi.fn(),
    createSession: vi.fn(),
    attachSession: vi.fn(),
    listSessions: vi.fn(async () => sessions),
    filesystem: vi.fn(),
    updateNetworkPolicy: vi.fn(),
    destroy: vi.fn(),
  };
}

/**
 * A successful two-phase checkAuth result: the cheap DB-only access verdict,
 * plus the LAZY `resolveSandbox` thunk the cold path calls to reserve the
 * concurrency slot and resolve the Sprite. `sprite` and `releaseSlot` are
 * re-surfaced at the top level purely so tests can spy on them (they are the
 * very same objects the thunk hands back) — a reattach must leave the sprite's
 * methods, the slot, and the thunk itself untouched.
 */
function makeAuthSuccess(over: Partial<{
  sessionKey: string;
  streamSessionId: string | null;
  sessions: Array<{ id: string; command: string; isActive: boolean; tty: boolean }>;
  command: string;
  args: string[];
  commandOverride: string | null;
  cwd: string;
  payerId: string;
}> = {}) {
  const sprite = makeSprite(over.sessions ?? []);
  const releaseSlot = vi.fn();
  const sandbox = {
    ok: true as const,
    agentTerminalId: 'agent-terminal-1',
    sandboxId: 'sbx1',
    cwd: over.cwd ?? BRANCH_REPO_PATH,
    sprite,
    command: over.command ?? 'pagespace-cli',
    args: over.args ?? [],
    commandOverride: over.commandOverride ?? null,
    streamSessionId: over.streamSessionId ?? null,
    releaseSlot,
  };
  return {
    ok: true as const,
    sessionKey: over.sessionKey ?? 'branch1:agent:cli',
    payerId: over.payerId ?? 'owner-1',
    resolveSandbox: vi.fn(async () => sandbox),
    sprite,
    releaseSlot,
  };
}

function makeBilling(over: Partial<{
  gate: ReturnType<typeof vi.fn>;
  trackUsage: ReturnType<typeof vi.fn>;
  releaseHold: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    gate: vi.fn().mockResolvedValue({ allowed: true, holdId: 'hold-1' }),
    trackUsage: vi.fn().mockResolvedValue(undefined),
    releaseHold: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

const validPayload = { machineId: 't1', projectName: 'repo', branchName: 'feature-x', name: 'cli', cols: 80, rows: 24 };

describe('resolveAgentTerminalCommand', () => {
  const ORIGINAL_SHELL = process.env.SHELL;

  afterEach(() => {
    process.env.SHELL = ORIGINAL_SHELL;
  });

  it('given a non-shell agentType with no override, should pass command/args through unchanged', () => {
    expect(resolveAgentTerminalCommand({ command: 'claude', args: ['--foo'], commandOverride: null })).toEqual({
      command: 'claude',
      args: ['--foo'],
    });
  });

  it('given the shell sentinel with no override, should resolve to $SHELL with no args', () => {
    process.env.SHELL = '/bin/zsh';
    expect(resolveAgentTerminalCommand({ command: 'shell', args: [], commandOverride: null })).toEqual({
      command: '/bin/zsh',
      args: [],
    });
  });

  it('given the shell sentinel with $SHELL unset, should fall back to bash', () => {
    delete process.env.SHELL;
    expect(resolveAgentTerminalCommand({ command: 'shell', args: [], commandOverride: null })).toEqual({
      command: 'bash',
      args: [],
    });
  });

  it('given a command override, should wrap it as `$SHELL -c override` regardless of agentType', () => {
    process.env.SHELL = '/bin/zsh';
    expect(resolveAgentTerminalCommand({ command: 'pagespace-cli', args: [], commandOverride: 'htop' })).toEqual({
      command: '/bin/zsh',
      args: ['-c', 'htop'],
    });
  });
});

describe('planConnect', () => {
  const liveSession = { sessionKey: 'branch1:agent:cli' } as TerminalSession;
  const granted = makeAuthSuccess();
  const denied = { ok: false as const, reason: 'no_edit_access' };

  it('given access denied, should deny regardless of an existing session', () => {
    assert({
      given: 'a denied access verdict with a live in-memory session',
      should: 'deny (auth still gates the fast path — never reattach)',
      actual: planConnect({ accessResult: denied, existingSession: liveSession }),
      expected: { kind: 'deny', reason: 'no_edit_access' },
    });
  });

  it('given access denied and no session, should deny with the verdict reason', () => {
    assert({
      given: 'a denied access verdict and no live session',
      should: 'deny, surfacing the verdict reason',
      actual: planConnect({ accessResult: denied, existingSession: undefined }),
      expected: { kind: 'deny', reason: 'no_edit_access' },
    });
  });

  it('given access allowed and a live session, should reattach carrying that session', () => {
    assert({
      given: 'an allowed access verdict and a live in-memory session',
      should: 'reattach, carrying the live session and the granted access',
      actual: planConnect({ accessResult: granted, existingSession: liveSession }),
      expected: { kind: 'reattach', access: granted, session: liveSession },
    });
  });

  it('given access allowed and no session, should create', () => {
    assert({
      given: 'an allowed access verdict and no live session',
      should: 'create a fresh session (cold path)',
      actual: planConnect({ accessResult: granted, existingSession: undefined }),
      expected: { kind: 'create', access: granted },
    });
  });
});

describe('planColdTailPersist', () => {
  const ENDED_AT = new Date('2026-01-01T00:00:00Z');

  it('given a session with no agentTerminalId, should return undefined — nothing to persist onto', () => {
    assert({
      given: 'a session that never carried an agentTerminalId',
      should: 'return undefined rather than persisting to a nonexistent row',
      actual: planColdTailPersist({ agentTerminalId: undefined, scrollback: ['hi\r\n'], hasOutput: true }, ENDED_AT),
      expected: undefined,
    });
  });

  it('given a session with output, should cap and byte-normalize the WHOLE ring (no line limit) and carry hasOutput/endedAt', () => {
    assert({
      given: 'a session with CRLF-joined scrollback chunks',
      should: 'produce the args recordColdTail needs, tail normalized to LF',
      actual: planColdTailPersist({ agentTerminalId: 'agent-terminal-1', scrollback: ['one\r\n', 'two\r\n'], hasOutput: true }, ENDED_AT),
      expected: { agentTerminalId: 'agent-terminal-1', tail: 'one\ntwo', hasOutput: true, endedAt: ENDED_AT },
    });
  });

  it('given a session whose one oversized chunk was trimmed straight back off the ring, should still say hasOutput:true with an empty tail — silence must never look like it', () => {
    assert({
      given: 'hasOutput true but an empty scrollback ring',
      should: 'carry hasOutput separately from the (empty) tail',
      actual: planColdTailPersist({ agentTerminalId: 'agent-terminal-1', scrollback: [], hasOutput: true }, ENDED_AT),
      expected: { agentTerminalId: 'agent-terminal-1', tail: '', hasOutput: true, endedAt: ENDED_AT },
    });
  });
});

describe('buildAgentTerminalHandlers', () => {
  let sessionMap: ReturnType<typeof createTerminalSessionMap>;
  let shell: ReturnType<typeof makeShell>;
  let openShell: ReturnType<typeof vi.fn> & OpenShellFn;
  let checkAuth: ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
  let socket: ReturnType<typeof makeSocket>;
  let persistStreamSessionId: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    sessionMap = createTerminalSessionMap();
    shell = makeShell();
    openShell = vi.fn().mockReturnValue(shell) as unknown as ReturnType<typeof vi.fn> & OpenShellFn;
    checkAuth = vi.fn().mockResolvedValue(makeAuthSuccess()) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
    socket = makeSocket();
    persistStreamSessionId = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('onConnect', () => {
    it('given valid payload and auth succeeds, should launch the resolved agent command and emit agent-terminal:ready', async () => {
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      expect(openShell).toHaveBeenCalledWith(
        expect.objectContaining({ cols: 80, rows: 24, command: 'pagespace-cli', args: [] }),
      );
      expect(socket.emit).toHaveBeenCalledWith('agent-terminal:ready', { connectionId: 'sock1', resumed: false });
    });

    it('given a branch-scoped agent terminal, should launch inside the branch\'s cloned repo cwd resolved by checkAuth', async () => {
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      expect(openShell).toHaveBeenCalledWith(expect.objectContaining({ cwd: BRANCH_REPO_PATH }));
    });

    it('given a machine-scoped agent terminal, should launch inside the resolved SANDBOX_ROOT cwd', async () => {
      checkAuth = vi.fn().mockResolvedValue(makeAuthSuccess({ cwd: SANDBOX_ROOT })) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect({ machineId: 't1', name: 'cli', cols: 80, rows: 24 });

      expect(openShell).toHaveBeenCalledWith(expect.objectContaining({ cwd: SANDBOX_ROOT }));
    });

    it('given a project-scoped agent terminal, should launch inside the resolved project path cwd', async () => {
      checkAuth = vi.fn().mockResolvedValue(makeAuthSuccess({ cwd: '/workspace/projects/my-repo' })) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect({ machineId: 't1', projectName: 'repo', name: 'cli', cols: 80, rows: 24 });

      expect(openShell).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/workspace/projects/my-repo' }));
    });

    it('given a claude agent terminal, should launch claude instead of pagespace-cli', async () => {
      checkAuth = vi.fn().mockResolvedValue(makeAuthSuccess({ command: 'claude', args: ['--dangerously-skip-permissions'] })) as unknown as ReturnType<typeof vi.fn> &
        AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      expect(openShell).toHaveBeenCalledWith(expect.objectContaining({ command: 'claude', args: ['--dangerously-skip-permissions'] }));
    });

    it('given a machine-scope shell agent terminal, should resolve the shell sentinel to $SHELL', async () => {
      const originalShell = process.env.SHELL;
      process.env.SHELL = '/bin/zsh';
      checkAuth = vi.fn().mockResolvedValue(makeAuthSuccess({ command: 'shell', args: [], cwd: SANDBOX_ROOT })) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect({ machineId: 't1', name: 'shell', cols: 80, rows: 24 });

      expect(openShell).toHaveBeenCalledWith(expect.objectContaining({ command: '/bin/zsh', args: [] }));
      process.env.SHELL = originalShell;
    });

    it('given a command override, should wrap it as `$SHELL -c override` instead of the agentType default', async () => {
      const originalShell = process.env.SHELL;
      process.env.SHELL = '/bin/zsh';
      checkAuth = vi.fn().mockResolvedValue(makeAuthSuccess({ command: 'shell', commandOverride: 'htop' })) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      expect(openShell).toHaveBeenCalledWith(expect.objectContaining({ command: '/bin/zsh', args: ['-c', 'htop'] }));
      process.env.SHELL = originalShell;
    });

    it('given valid payload and auth succeeds, should store the session under a key unique to this (branch, name)', async () => {
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      expect(sessionMap.getBySocket(viewer('sock1'))).toBeDefined();
      expect(sessionMap.getByKey('branch1:agent:cli')).toBeDefined();
    });

    it('given a second agent terminal with a DIFFERENT sessionKey on the same socket-less connection, should not collide', async () => {
      const cliAuth = makeAuthSuccess({ sessionKey: 'branch1:agent:cli' });
      const claudeAuth = makeAuthSuccess({ sessionKey: 'branch1:agent:reviewer', command: 'claude' });
      checkAuth = vi.fn().mockResolvedValueOnce(cliAuth).mockResolvedValueOnce(claudeAuth) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;

      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect({ ...validPayload, name: 'cli' });
      const secondSocket = makeSocket('sock2');
      const secondHandlers = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket: secondSocket, persistStreamSessionId });
      await secondHandlers.onConnect({ ...validPayload, name: 'reviewer' });

      expect(sessionMap.getByKey('branch1:agent:cli')).toBeDefined();
      expect(sessionMap.getByKey('branch1:agent:reviewer')).toBeDefined();
    });

    it('given auth fails, should emit agent-terminal:error and not store session', async () => {
      checkAuth = vi.fn().mockResolvedValue({ ok: false, reason: 'no_edit_access' }) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      expect(socket.emit).toHaveBeenCalledWith('agent-terminal:error', expect.objectContaining({ message: expect.any(String) }));
      expect(sessionMap.getBySocket(viewer('sock1'))).toBeUndefined();
      expect(openShell).not.toHaveBeenCalled();
    });

    it('given invalid payload (missing name), should emit agent-terminal:error without calling checkAuth', async () => {
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      const { name: _omit, ...rest } = validPayload;
      await onConnect(rest);

      expect(socket.emit).toHaveBeenCalledWith('agent-terminal:error', expect.objectContaining({ message: expect.any(String) }));
      expect(checkAuth).not.toHaveBeenCalled();
    })

    it('given an invalid payload, should tag the error with the CONNECTION it came from', async () => {
      // One socket carries every pane of the grid, and a client treats an untagged
      // event as its own — so an untagged error is rendered by EVERY pane at once,
      // covering healthy running terminals with a failure that belongs to one.
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      const { name: _omit, ...rest } = validPayload;
      await onConnect({ ...rest, connectionId: 'pane-b' });

      expect(socket.emit).toHaveBeenCalledWith(
        'agent-terminal:error',
        expect.objectContaining({ connectionId: 'pane-b' }),
      );
    });

    it('given a payload with neither projectName nor branchName (machine scope), should call checkAuth with both undefined', async () => {
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect({ machineId: 't1', name: 'shell', cols: 80, rows: 24 });

      expect(checkAuth).toHaveBeenCalledWith(
        expect.objectContaining({ machineId: 't1', projectName: undefined, branchName: undefined, name: 'shell' }),
      );
    });

    it('given openShell throws, should emit agent-terminal:error, release the slot, and not store session', async () => {
      const auth = makeAuthSuccess();
      checkAuth = vi.fn().mockResolvedValue(auth) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      openShell = vi.fn().mockImplementation(() => {
        throw new Error('sprite unreachable');
      }) as unknown as ReturnType<typeof vi.fn> & OpenShellFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      expect(socket.emit).toHaveBeenCalledWith('agent-terminal:error', expect.objectContaining({ message: expect.any(String) }));
      expect(sessionMap.getBySocket(viewer('sock1'))).toBeUndefined();
      expect(auth.releaseSlot).toHaveBeenCalled();
    });

    it('given a known streamSessionId the Sprite STILL HAS, should reattach to it instead of creating a fresh session', async () => {
      // The Sprite is asked, and it still has the session — so continuity across a
      // realtime restart is preserved. (A stored id the Sprite does NOT have is
      // dangling: attaching to it optimistically is what the shell used to do and
      // what the liveness verdict now prevents — see the dangling-id test below.)
      checkAuth = vi.fn().mockResolvedValue(
        makeAuthSuccess({
          streamSessionId: 'sess-existing',
          sessions: [{ id: 'sess-existing', command: 'pagespace-cli', isActive: true, tty: true }],
        }),
      ) as unknown as ReturnType<typeof vi.fn> &
        AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      expect(openShell).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-existing' }));
      // Already-known session id — nothing new to discover/persist.
      expect(persistStreamSessionId).not.toHaveBeenCalled();
    });

    it('given a streamSessionId the Sprite STILL HAS, should tell the client the agent was RESUMED', async () => {
      // This process holds no session for it (a restart empties the map), so the
      // connect takes the cold CREATE path — but the Sprite still has the agent
      // running and the shell picks it back up. The client cannot tell that apart
      // from a cold boot, and one that types a starting prompt into the terminal
      // MUST: a line plus a carriage return delivered to an agent that has been
      // running for hours, sitting at a confirmation prompt, is destructive.
      checkAuth = vi.fn().mockResolvedValue(
        makeAuthSuccess({
          streamSessionId: 'sess-existing',
          sessions: [{ id: 'sess-existing', command: 'pagespace-cli', isActive: true, tty: true }],
        }),
      ) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      expect(socket.emit).toHaveBeenCalledWith('agent-terminal:ready', { connectionId: 'sock1', resumed: true });
    });

    it('given a DANGLING streamSessionId, should report a fresh boot — the row is a memory, not a fact', async () => {
      // Exec sessions do not survive a Sprite pause, and nothing ever clears the
      // column: the id names a session the Sprite no longer has, so the shell will
      // discover the dangling attach and launch a FRESH agent (`planReconnect`).
      // Reporting `resumed` from the row's word alone would tell that fresh
      // agent's pane its starting prompt had already been taken, and the agent
      // would sit there having never been given its task.
      checkAuth = vi.fn().mockResolvedValue(
        makeAuthSuccess({ streamSessionId: 'sess-long-dead', sessions: [] }),
      ) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      expect(socket.emit).toHaveBeenCalledWith('agent-terminal:ready', { connectionId: 'sock1', resumed: false });
    });

    it('given the Sprite will not say which sessions it has, should assume the agent is STILL RUNNING', async () => {
      const auth = makeAuthSuccess({ streamSessionId: 'sess-existing' });
      auth.sprite.listSessions = vi.fn(async () => {
        throw new Error('control plane unreachable');
      });
      checkAuth = vi.fn().mockResolvedValue(auth) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      // The two ways of being wrong are not symmetric: refusing to type at an agent
      // that turns out to be fresh costs a prompt the user can retype; typing at one
      // that turns out to be live can answer a confirmation it was waiting on.
      expect(socket.emit).toHaveBeenCalledWith('agent-terminal:ready', { connectionId: 'sock1', resumed: true });
    });

    it('given a FRESH session whose shell reports its authoritative id, should persist that id', async () => {
      // The shell learns the id from the created session's own socket and hands it
      // up via onSessionId — the handler no longer discovers anything itself.
      const auth = makeAuthSuccess({ streamSessionId: null });
      checkAuth = vi.fn().mockResolvedValue(auth) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      announceSessionId(openShell, 'sess-new');
      await vi.advanceTimersByTimeAsync(0);

      expect(persistStreamSessionId).toHaveBeenCalledWith({ agentTerminalId: 'agent-terminal-1', sessionId: 'sess-new' });
    });

    it('given two sessions announced in quick succession, should persist them IN ORDER (a dead id must not win)', async () => {
      // A flapping Sprite creates session A, drops, then creates B. Two un-awaited
      // UPDATEs would race; if A's landed last the DB would name a session that is
      // already dead, sending the next cold connect at a corpse. The writes are
      // chained, so the last session announced is the last one written.
      const writes: string[] = [];
      const slowFirst = deferred<void>();
      persistStreamSessionId = vi.fn().mockImplementationOnce(async (a: { sessionId: string }) => {
        await slowFirst.promise;            // A's write is slow...
        writes.push(a.sessionId);
      }).mockImplementation(async (a: { sessionId: string }) => {
        writes.push(a.sessionId);           // ...B's would otherwise overtake it
      });
      checkAuth = vi.fn().mockResolvedValue(makeAuthSuccess({ streamSessionId: null })) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      const args = openShell.mock.calls[0][0] as OpenPtyShellArgs;
      const announce = args.onSessionId as (id: string) => void;
      announce('sess-a');
      announce('sess-b');
      slowFirst.resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(writes).toEqual(['sess-a', 'sess-b']); // B last — the live session wins
      expect(sessionMap.getByKey('branch1:agent:cli')?.sessionId).toBe('sess-b');
    });

    it('given a FRESH session whose shell never reports an id, should not call persistStreamSessionId', async () => {
      const auth = makeAuthSuccess({ streamSessionId: null, sessions: [] });
      checkAuth = vi.fn().mockResolvedValue(auth) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);
      await vi.advanceTimersByTimeAsync(0);

      expect(persistStreamSessionId).not.toHaveBeenCalled();
    });

    it('given a FRESH session, should NOT list the Sprite\'s sessions at all (identity comes from the create handle, not a diff)', async () => {
      // A FRESH session (no stored id) lists nothing: the retired before/after
      // listSessions diff added two control-plane round
      // trips to every cold connect AND could not tell our new shell from a
      // sibling terminal's. Both are gone: the connect path never lists.
      const auth = makeAuthSuccess({ streamSessionId: null });
      checkAuth = vi.fn().mockResolvedValue(auth) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);
      await vi.advanceTimersByTimeAsync(0);

      expect(auth.sprite.listSessions).not.toHaveBeenCalled();
      expect(openShell).toHaveBeenCalled();
      expect(sessionMap.getByKey('branch1:agent:cli')).toBeDefined();
    });

    it('given a persist that rejects with a NON-Error value, should coerce it and still not throw', async () => {
      const auth = makeAuthSuccess({ streamSessionId: null });
      persistStreamSessionId = vi.fn().mockRejectedValue('db string blip');
      checkAuth = vi.fn().mockResolvedValue(auth) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      announceSessionId(openShell, 'sess-new');
      await expect(vi.advanceTimersByTimeAsync(0)).resolves.not.toThrow();
      expect(sessionMap.getByKey('branch1:agent:cli')).toBeDefined();
    });

    it('given a persist that rejects, should not throw out of the connect (best-effort persistence)', async () => {
      const auth = makeAuthSuccess({ streamSessionId: null });
      persistStreamSessionId = vi.fn().mockRejectedValue(new Error('db unreachable'));
      checkAuth = vi.fn().mockResolvedValue(auth) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      announceSessionId(openShell, 'sess-new');
      await expect(vi.advanceTimersByTimeAsync(0)).resolves.not.toThrow();
      expect(sessionMap.getByKey('branch1:agent:cli')).toBeDefined();
    });

    it('given no authenticated user on the socket, should call checkAuth with an empty-string userId rather than throwing', async () => {
      socket.data.user = undefined;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      expect(checkAuth).toHaveBeenCalledWith(expect.objectContaining({ userId: '' }));
    });

    it('given a reconnect while a prior disconnect\'s idle timer is still pending, should cancel the pending reap so the session survives past the original timeout', async () => {
      const { onConnect, onDisconnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);
      onDisconnect();

      // Reconnect partway through the idle window — cancels the pending reap.
      await vi.advanceTimersByTimeAsync(DETACHED_IDLE_MS / 2);
      const reconnectSocket = makeSocket('sock2');
      const handlers2 = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket: reconnectSocket, persistStreamSessionId });
      await handlers2.onConnect(validPayload);

      // Advance past when the ORIGINAL idle timer would have fired.
      await vi.advanceTimersByTimeAsync(DETACHED_IDLE_MS / 2 + 1_000);

      expect(shell.kill).not.toHaveBeenCalled();
      expect(sessionMap.getByKey('branch1:agent:cli')).toBeDefined();
    });

    it('given the re-auth interval fires after the session was already removed, should clear the interval rather than re-checking auth', async () => {
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);
      expect(checkAuth).toHaveBeenCalledTimes(1);

      sessionMap.deleteByKey('branch1:agent:cli');
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(checkAuth).toHaveBeenCalledTimes(1);
    });

    it('given reconnecting to an in-memory live session, should reuse it and emit scrollback instead of reopening', async () => {
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);
      await vi.advanceTimersByTimeAsync(0);

      const reconnectSocket = makeSocket('sock2');
      const handlers2 = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket: reconnectSocket, persistStreamSessionId });
      await handlers2.onConnect(validPayload);

      expect(openShell).toHaveBeenCalledTimes(1);
      expect(reconnectSocket.emit).toHaveBeenCalledWith('agent-terminal:ready', expect.objectContaining({ scrollback: expect.any(String) }));
    });

    it('given a live in-memory session, should reattach after the access check with ZERO sprite SDK calls and without resolving the sandbox', async () => {
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);
      await vi.advanceTimersByTimeAsync(0);

      // The reconnect gets a fresh auth result whose sprite is a dedicated spy —
      // the tab-back fast path must not touch it, nor its resolveSandbox thunk.
      const reattachAuth = makeAuthSuccess();
      checkAuth.mockResolvedValueOnce(reattachAuth);
      const reconnectSocket = makeSocket('sock2');
      const handlers2 = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket: reconnectSocket, persistStreamSessionId });
      await handlers2.onConnect(validPayload);

      expect(reattachAuth.resolveSandbox).not.toHaveBeenCalled();
      expect(reattachAuth.sprite.listSessions).not.toHaveBeenCalled();
      expect(reattachAuth.sprite.spawn).not.toHaveBeenCalled();
      expect(reattachAuth.sprite.createSession).not.toHaveBeenCalled();
      expect(reattachAuth.sprite.attachSession).not.toHaveBeenCalled();
      expect(reattachAuth.sprite.updateNetworkPolicy).not.toHaveBeenCalled();
      expect(openShell).toHaveBeenCalledTimes(1);
      // No slot was reserved for the reattach (resolveSandbox is what reserves
      // one), so there is nothing to release — releasing here would decrement
      // the LIVE session's own reservation.
      expect(reattachAuth.releaseSlot).not.toHaveBeenCalled();
      expect(reconnectSocket.emit).toHaveBeenCalledWith('agent-terminal:ready', expect.objectContaining({ scrollback: expect.any(String) }));
      // The tab-back fast path tells the shell a viewer is attached again, so it
      // can reattach lazily if its watchdog went quiet while detached (leaf 3-2).
      expect(shell.setViewerAttached).toHaveBeenCalledWith(true);
    });

    it('given no live session, should follow the cold path and resolve the sandbox', async () => {
      const auth = makeAuthSuccess();
      checkAuth = vi.fn().mockResolvedValue(auth) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      expect(auth.resolveSandbox).toHaveBeenCalledTimes(1);
      expect(openShell).toHaveBeenCalledTimes(1);
      expect(socket.emit).toHaveBeenCalledWith('agent-terminal:ready', { connectionId: 'sock1', resumed: false });
    });

    it('given a denied user with a live session, should refuse and NOT reattach (auth gates the fast path)', async () => {
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);
      await vi.advanceTimersByTimeAsync(0);

      // A different, now-unauthorized user tabs back to the same (scope, name).
      checkAuth.mockResolvedValueOnce({ ok: false, reason: 'permission_revoked' });
      const attackerSocket = makeSocket('attacker-sock', 'user2');
      const attacker = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket: attackerSocket, persistStreamSessionId });
      await attacker.onConnect(validPayload);

      expect(attackerSocket.emit).toHaveBeenCalledWith('agent-terminal:error', expect.objectContaining({ message: expect.any(String) }));
      expect(attackerSocket.emit).not.toHaveBeenCalledWith('agent-terminal:ready', expect.anything());
      // The victim's live session is untouched and still owned by the original socket.
      expect(sessionMap.getBySocket(viewer('sock1'))).toBeDefined();
      expect(sessionMap.getBySocket(viewer('attacker-sock', 'attacker-sock'))).toBeUndefined();
    });

    it('given two CONCURRENT cold connects for the same key, should open exactly ONE PTY — the second joins the first', async () => {
      // The genuinely racy double-mount: connect #2 arrives while connect #1 is
      // still seconds deep in its cold resolveSandbox. Opening a second PTY here
      // is not merely wasteful — when both attach to the SAME persisted Sprite exec
      // session, discarding one would SIGKILL the process the other is attached to.
      // So the key is claimed before the first await and #2 joins #1 instead.
      const authA = makeAuthSuccess();
      const authB = makeAuthSuccess();
      checkAuth = vi.fn().mockResolvedValueOnce(authA).mockResolvedValueOnce(authB) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });

      await Promise.all([
        onConnect({ ...validPayload, connectionId: 'pane-a' }),
        onConnect({ ...validPayload, connectionId: 'pane-b' }),
      ]);

      // Exactly one PTY — the loser never opened one, so there is none to kill.
      expect(openShell).toHaveBeenCalledTimes(1);
      // The loser never even resolved a sandbox, so it reserved no slot and no hold.
      expect(authB.resolveSandbox).not.toHaveBeenCalled();
      expect(authB.releaseSlot).not.toHaveBeenCalled();
      expect(authA.releaseSlot).not.toHaveBeenCalled();

      // Both panes end up on the one live session.
      const session = sessionMap.getByKey('branch1:agent:cli');
      expect(session).toBeDefined();
      expect(sessionMap.getBySocket(viewer('pane-b'))).toBe(session);
      expect(socket.emit).toHaveBeenCalledWith('agent-terminal:ready', expect.objectContaining({ connectionId: 'pane-b', scrollback: expect.any(String) }));
    });

    it('given a CONCURRENT connect while a cold create is attaching to a PERSISTED Sprite session, should never kill that session', async () => {
      // The destructive case: both connects resolve the SAME streamSessionId, so
      // openPtyShell would attachSession() to one shared server-side exec session.
      // A "discard the duplicate" strategy would SIGKILL the very process the
      // survivor is attached to. Serializing means the second never opens one.
      const shared = { id: 'sess-shared', command: 'pagespace-cli', isActive: true, tty: true };
      checkAuth = vi
        .fn()
        .mockResolvedValueOnce(makeAuthSuccess({ streamSessionId: 'sess-shared', sessions: [shared] }))
        .mockResolvedValueOnce(makeAuthSuccess({ streamSessionId: 'sess-shared', sessions: [shared] })) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });

      await Promise.all([
        onConnect({ ...validPayload, connectionId: 'pane-a' }),
        onConnect({ ...validPayload, connectionId: 'pane-b' }),
      ]);

      expect(openShell).toHaveBeenCalledTimes(1);
      expect(openShell).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-shared' }));
      // Nothing was killed — the shared Sprite session survives for the live viewer.
      expect(shell.kill).not.toHaveBeenCalled();
      expect(sessionMap.getByKey('branch1:agent:cli')?.command).toBe(shell);
    });

    it('given an in-flight cold create that FAILS, should let a queued connect create the session itself (no wedged key)', async () => {
      const failing = makeAuthSuccess();
      failing.resolveSandbox = vi.fn(async () => ({ ok: false as const, reason: 'provision_failed' }));
      const succeeding = makeAuthSuccess();
      checkAuth = vi.fn().mockResolvedValueOnce(failing).mockResolvedValueOnce(succeeding) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });

      await Promise.all([
        onConnect({ ...validPayload, connectionId: 'pane-a' }),
        onConnect({ ...validPayload, connectionId: 'pane-b' }),
      ]);

      // The failed create released its claim, so the queued connect went on to
      // create the session rather than joining a session that never existed.
      expect(succeeding.resolveSandbox).toHaveBeenCalledTimes(1);
      expect(openShell).toHaveBeenCalledTimes(1);
      expect(sessionMap.getByKey('branch1:agent:cli')).toBeDefined();
    });

    it('given a fresh session where a SIBLING terminal opened a tty in the same window, should persist OUR id (never the sibling\'s)', async () => {
      // One Sprite hosts every agent terminal on the machine. The retired diff saw
      // two new tty sessions, could not tell which was ours, and had to abstain —
      // persisting nothing precisely when the machine was busiest. Our shell now
      // learns its id on its own socket, so a sibling is simply irrelevant: we
      // persist the right id instead of abstaining.
      const auth = makeAuthSuccess({
        streamSessionId: null,
        sessions: [
          { id: 'sess-ours', command: 'pagespace-cli', isActive: true, tty: true },
          { id: 'sess-sibling', command: 'claude', isActive: true, tty: true },
        ],
      });
      checkAuth = vi.fn().mockResolvedValue(auth) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      announceSessionId(openShell, 'sess-ours');
      await vi.advanceTimersByTimeAsync(0);

      expect(persistStreamSessionId).toHaveBeenCalledWith({ agentTerminalId: 'agent-terminal-1', sessionId: 'sess-ours' });
      expect(persistStreamSessionId).not.toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-sibling' }));
    });

    it('given two connects for the same key (double-mount remount), should not double-create — the second reattaches via getByKey', async () => {
      // A StrictMode/HMR double-mount fires connect twice for the same
      // (scope, name). Once the first has established the session (setNew), the
      // second must find it via getByKey and reattach rather than open a second
      // PTY — the existing setNew/getByKey identity is what prevents a duplicate.
      checkAuth = vi.fn().mockResolvedValue(makeAuthSuccess({ sessionKey: 'branch1:agent:cli' })) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });

      await onConnect({ ...validPayload, connectionId: 'pane-a' });
      await onConnect({ ...validPayload, connectionId: 'pane-b' });

      expect(openShell).toHaveBeenCalledTimes(1);
      expect(sessionMap.getByKey('branch1:agent:cli')).toBeDefined();
      // The second connect reattached the shared session onto pane-b.
      expect(sessionMap.getBySocket(viewer('pane-b'))).toMatchObject({ sessionKey: 'branch1:agent:cli' });
    });

    it('given a successful connect, should set up a re-auth interval on the session', async () => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
      const session = sessionMap.getByKey('branch1:agent:cli');
      expect(session?.reAuthInterval).toBeDefined();
    });

    it('given re-auth fires and checkAuth still succeeds, should not kill the shell', async () => {
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(shell.kill).not.toHaveBeenCalled();
      expect(sessionMap.getByKey('branch1:agent:cli')).toBeDefined();
    });

    it('given a 60s re-auth tick on a live ATTACHED session, should perform zero sprite SDK calls (DB-only check)', async () => {
      const auth = makeAuthSuccess();
      checkAuth = vi.fn().mockResolvedValue(auth) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(checkAuth).toHaveBeenCalledTimes(2); // connect + one tick
      expect(auth.resolveSandbox).toHaveBeenCalledTimes(1); // only the connect's cold-path create
      expect(auth.sprite.listSessions).not.toHaveBeenCalled();
      expect(auth.sprite.spawn).not.toHaveBeenCalled();
      expect(auth.sprite.createSession).not.toHaveBeenCalled();
      expect(auth.sprite.attachSession).not.toHaveBeenCalled();
      expect(auth.sprite.updateNetworkPolicy).not.toHaveBeenCalled();
    });

    it('given revoked access on a DETACHED session, should still tear it down within one interval — a detached viewer buys no extended grace', async () => {
      // The PTY (and any agent/command it is running) keeps executing after the
      // viewer disconnects — it is not idle just because nobody is watching. A
      // detached session must lose access on the SAME 60s cadence an attached
      // one does; letting it run unsupervised until the 30-min idle reap would
      // leave a revoked user's process executing long after access was pulled.
      const { onConnect, onDisconnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);
      onDisconnect();

      checkAuth.mockResolvedValue({ ok: false, reason: 'permission_revoked' });
      await vi.advanceTimersByTimeAsync(60_000);

      expect(shell.kill).toHaveBeenCalledWith('forced-teardown');
      expect(sessionMap.getByKey('branch1:agent:cli')).toBeUndefined();
    });

    it('given re-auth resolves AFTER the session was already torn down, should not double-teardown (no second kill/releaseSlot)', async () => {
      const auth = makeAuthSuccess();
      let resolveReauth: (v: unknown) => void = () => {};
      checkAuth
        .mockResolvedValueOnce(auth) // connect
        .mockImplementationOnce(() => new Promise((res) => { resolveReauth = res; })); // re-auth tick hangs
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing: makeBilling() });
      await onConnect(validPayload);

      await vi.advanceTimersByTimeAsync(60_000); // re-auth fires and is left pending
      const onExitArg = openShell.mock.calls[0][0].onExit as (exitCode: number) => void;
      onExitArg(0); // session ends naturally while the re-auth check is still in flight
      expect(auth.releaseSlot).toHaveBeenCalledTimes(1);

      resolveReauth({ ok: false, reason: 'permission_revoked' });
      await vi.advanceTimersByTimeAsync(0);

      expect(shell.kill).not.toHaveBeenCalled(); // natural exit — the stale re-auth must not kill
      expect(auth.releaseSlot).toHaveBeenCalledTimes(1); // slot not double-released
    });

    it('given two users attached, should re-auth EVERY attached viewer — checking any single identity would let a revoked co-viewer keep streaming (#2093)', async () => {
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload); // user1 creates

      // user2 JOINS on their own socket; user1 stays attached.
      const socket2 = makeSocket('sock2', 'user2');
      const handlers2 = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket: socket2, persistStreamSessionId });
      await handlers2.onConnect(validPayload);

      checkAuth.mockClear();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(checkAuth).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user1' }));
      expect(checkAuth).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user2' }));
    });

    it('given the creator has left and a DIFFERENT user is watching, should re-auth the remaining viewer, not the creator', async () => {
      // A session outlives its creator's connection. If re-auth kept checking the
      // creator — who of course remains authorized — a viewer who joined and
      // then had their access revoked would keep receiving PTY output, and could
      // keep typing, indefinitely.
      const { onConnect, onDisconnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload); // user1 creates

      const socket2 = makeSocket('sock2', 'user2');
      const handlers2 = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket: socket2, persistStreamSessionId });
      await handlers2.onConnect(validPayload); // user2 joins
      onDisconnect(); // user1's socket leaves — user2 is the sole viewer

      checkAuth.mockClear();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(checkAuth).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user2' }));
      expect(checkAuth).not.toHaveBeenCalledWith(expect.objectContaining({ userId: 'user1' }));
    });

    it('given one of two attached users loses access, should evict ONLY that viewer — the other keeps streaming and the PTY survives (#2093)', async () => {
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload); // user1 creates

      const socket2 = makeSocket('sock2', 'user2');
      const handlers2 = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket: socket2, persistStreamSessionId });
      await handlers2.onConnect(validPayload); // user2 joins

      // user2's access is revoked; user1 still passes.
      checkAuth.mockImplementation(async ({ userId }: { userId: string }) =>
        userId === 'user2' ? { ok: false, reason: 'permission_revoked' } : makeAuthSuccess(),
      );
      await vi.advanceTimersByTimeAsync(60_000);

      // user2's pane is told the truth — an eviction, not a phantom process
      // exit (the PTY is still running for user1)…
      expect(socket2.emit).toHaveBeenCalledWith('agent-terminal:error', { message: 'Machine access revoked', connectionId: 'sock2' });
      // …but the session is alive and user1 is untouched.
      expect(shell.kill).not.toHaveBeenCalled();
      expect(sessionMap.getByKey('branch1:agent:cli')).toBeDefined();
      socket.emit.mockClear();
      socket2.emit.mockClear();
      const onOutput = openShell.mock.calls[0][0].onOutput as (data: string) => void;
      onOutput('still streaming');
      expect(socket.emit).toHaveBeenCalledWith('agent-terminal:output', { data: 'still streaming', connectionId: 'sock1' });
      expect(socket2.emit).not.toHaveBeenCalled();
      // The revoked viewer's keystrokes no-op: eviction removed their binding.
      handlers2.onInput({ data: 'rm -rf /\n', connectionId: 'sock2' });
      expect(shell.write).not.toHaveBeenCalledWith('rm -rf /\n');
    });

    it('given the SOLE viewer loses access, should evict them AND tear the session down in the same tick — no grace for an unsupervised revoked process', async () => {
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      checkAuth.mockResolvedValue({ ok: false, reason: 'permission_revoked' });
      await vi.advanceTimersByTimeAsync(60_000);

      expect(socket.emit).toHaveBeenCalledWith('agent-terminal:error', { message: 'Machine access revoked', connectionId: 'sock1' });
      expect(shell.kill).toHaveBeenCalledWith('forced-teardown');
      expect(sessionMap.getByKey('branch1:agent:cli')).toBeUndefined();
    });

    it('given a DETACHED session whose checkAuth THROWS, should keep the session alive (fail-open in both tick shapes — no unhandled rejection)', async () => {
      const { onConnect, onDisconnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);
      onDisconnect(); // detach — the tick now checks lastViewerUserId

      checkAuth.mockRejectedValue(new Error('db blip'));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(shell.kill).not.toHaveBeenCalled();
      expect(sessionMap.getByKey('branch1:agent:cli')).toBeDefined();
    });

    it('given an authorized viewer who joins WHILE the detached tick\'s checkAuth is in flight, should not tear the session down under them', async () => {
      const { onConnect, onDisconnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload); // user1 creates
      onDisconnect(); // detached; lastViewerUserId = user1

      // The detached tick's checkAuth(user1) hangs in flight…
      const verdict = deferred<{ ok: false; reason: string }>();
      checkAuth.mockImplementationOnce(() => verdict.promise);
      await vi.advanceTimersByTimeAsync(60_000);

      // …and an authorized user2 joins DURING that round-trip.
      checkAuth.mockResolvedValue(makeAuthSuccess());
      const socket2 = makeSocket('sock2', 'user2');
      const handlers2 = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket: socket2, persistStreamSessionId });
      await handlers2.onConnect(validPayload);

      // The in-flight check now resolves REVOKED for user1 (who is long gone).
      verdict.resolve({ ok: false, reason: 'permission_revoked' });
      await vi.advanceTimersByTimeAsync(0);

      // The session must survive: an authorized viewer is watching it NOW.
      expect(shell.kill).not.toHaveBeenCalled();
      expect(sessionMap.getByKey('branch1:agent:cli')).toBeDefined();
      socket2.emit.mockClear();
      const onOutput = openShell.mock.calls[0][0].onOutput as (data: string) => void;
      onOutput('survived the race');
      expect(socket2.emit).toHaveBeenCalledWith('agent-terminal:output', { data: 'survived the race', connectionId: 'sock2' });
    });

    it('given a checkAuth slower than the tick cadence, should not stack overlapping re-auth rounds (re-entry guard)', async () => {
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      checkAuth.mockClear();
      checkAuth.mockImplementation(() => new Promise(() => {})); // never resolves
      await vi.advanceTimersByTimeAsync(180_000); // three cadences

      expect(checkAuth).toHaveBeenCalledTimes(1);
    });

    it('given the shell resume THROWS during an attach, the joiner is still fully tracked — a later disconnect collects them and the reap still fires (no ghost viewer)', async () => {
      const { onConnect, onDisconnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);
      onDisconnect(); // detached, reap armed

      // The reattach's shell resume blows up mid-attach.
      shell.setViewerAttached.mockImplementationOnce(() => { throw new Error('resume failed'); });
      await expect(onConnect({ ...validPayload, connectionId: 'pane-2' })).rejects.toThrow('resume failed');

      // Registration happened BEFORE the fallible call, so the viewer is
      // tracked and removable — the failure cannot pin viewers.size >= 1
      // (which would disarm the last-viewer reap for the process lifetime).
      expect(sessionMap.getBySocket(viewer('pane-2'))).toBeDefined();
      onDisconnect({ connectionId: 'pane-2' });
      expect(sessionMap.getBySocket(viewer('pane-2'))).toBeUndefined();
      await vi.advanceTimersByTimeAsync(DETACHED_IDLE_MS);
      expect(shell.kill).toHaveBeenCalledWith('idle-reap');
    });

    it('given the same user in TWO panes, should checkAuth once per distinct userId per tick, not once per pane', async () => {
      checkAuth = vi.fn().mockResolvedValue(makeAuthSuccess({ sessionKey: 'branch1:agent:cli' })) as unknown as ReturnType<typeof vi.fn> &
        AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect({ ...validPayload, connectionId: 'pane-a' });
      await onConnect({ ...validPayload, connectionId: 'pane-b' }); // same user, same session, second pane

      checkAuth.mockClear();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(checkAuth).toHaveBeenCalledTimes(1);
      expect(checkAuth).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user1' }));
    });

    it('given checkAuth THROWS for an attached viewer, should evict nobody this tick (fail-open — a DB blip is not a revocation)', async () => {
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      checkAuth.mockRejectedValue(new Error('db blip'));
      await vi.advanceTimersByTimeAsync(60_000);

      expect(shell.kill).not.toHaveBeenCalled();
      expect(sessionMap.getByKey('branch1:agent:cli')).toBeDefined();
      expect(sessionMap.getBySocket(viewer('sock1'))).toBeDefined();
    });
  });

  describe('onInput', () => {
    it('given input within size limits, should write to the shell', async () => {
      const { onConnect, onInput } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);
      onInput({ data: 'ls\n' });

      expect(shell.write).toHaveBeenCalledWith('ls\n');
    });

    it('given input over MAX_INPUT_BYTES, should drop it', async () => {
      const { onConnect, onInput } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);
      onInput({ data: 'x'.repeat(MAX_INPUT_BYTES + 1) });

      expect(shell.write).not.toHaveBeenCalled();
    });

    it('given no session for this socket, should not throw', () => {
      const { onInput } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      expect(() => onInput({ data: 'ls\n' })).not.toThrow();
    });
  });

  describe('onResize', () => {
    it('given valid dimensions, should resize the shell', async () => {
      const { onConnect, onResize } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);
      onResize({ cols: 100, rows: 40 });

      expect(shell.resize).toHaveBeenCalledWith(100, 40);
    });
  });

  describe('multiplexed connections on one socket (splittable panes)', () => {
    it('given two connect calls on the SAME socket with distinct connectionIds and different scopes, should track them independently', async () => {
      const shellA = makeShell();
      const shellB = makeShell();
      openShell = vi.fn().mockReturnValueOnce(shellA).mockReturnValueOnce(shellB) as unknown as ReturnType<typeof vi.fn> & OpenShellFn;
      checkAuth = vi
        .fn()
        .mockResolvedValueOnce(makeAuthSuccess({ sessionKey: 'branch1:agent:cli' }))
        .mockResolvedValueOnce(makeAuthSuccess({ sessionKey: 'branch1:agent:reviewer', command: 'claude' })) as unknown as ReturnType<typeof vi.fn> &
        AgentTerminalCheckAuthFn;
      const { onConnect, onInput } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });

      await onConnect({ ...validPayload, name: 'cli', connectionId: 'pane-a' });
      await onConnect({ ...validPayload, name: 'reviewer', connectionId: 'pane-b' });

      expect(sessionMap.getBySocket(viewer('pane-a'))).toMatchObject({ sessionKey: 'branch1:agent:cli' });
      expect(sessionMap.getBySocket(viewer('pane-b'))).toMatchObject({ sessionKey: 'branch1:agent:reviewer' });

      // Input routed by connectionId reaches the pane it was typed into, not whichever pane connected last.
      onInput({ data: 'echo a\n', connectionId: 'pane-a' });
      onInput({ data: 'echo b\n', connectionId: 'pane-b' });
      expect(shellA.write).toHaveBeenCalledWith('echo a\n');
      expect(shellB.write).toHaveBeenCalledWith('echo b\n');
      expect(shellA.write).not.toHaveBeenCalledWith('echo b\n');
      expect(shellB.write).not.toHaveBeenCalledWith('echo a\n');
    });

    it('given output on two different panes, should tag each emitted event with its own connectionId so the client can route it to the right pane', async () => {
      const shellA = makeShell();
      const shellB = makeShell();
      openShell = vi.fn().mockReturnValueOnce(shellA).mockReturnValueOnce(shellB) as unknown as ReturnType<typeof vi.fn> & OpenShellFn;
      checkAuth = vi
        .fn()
        .mockResolvedValueOnce(makeAuthSuccess({ sessionKey: 'branch1:agent:cli' }))
        .mockResolvedValueOnce(makeAuthSuccess({ sessionKey: 'branch1:agent:reviewer' })) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });

      await onConnect({ ...validPayload, name: 'cli', connectionId: 'pane-a' });
      await onConnect({ ...validPayload, name: 'reviewer', connectionId: 'pane-b' });

      const onOutputA = openShell.mock.calls[0][0].onOutput as (data: string) => void;
      const onOutputB = openShell.mock.calls[1][0].onOutput as (data: string) => void;
      onOutputA('from A');
      onOutputB('from B');

      expect(socket.emit).toHaveBeenCalledWith('agent-terminal:output', { data: 'from A', connectionId: 'pane-a' });
      expect(socket.emit).toHaveBeenCalledWith('agent-terminal:output', { data: 'from B', connectionId: 'pane-b' });
    });

    it('given onDisconnect for one specific connectionId, should detach only that pane and leave the other live', async () => {
      const shellA = makeShell();
      const shellB = makeShell();
      openShell = vi.fn().mockReturnValueOnce(shellA).mockReturnValueOnce(shellB) as unknown as ReturnType<typeof vi.fn> & OpenShellFn;
      checkAuth = vi
        .fn()
        .mockResolvedValueOnce(makeAuthSuccess({ sessionKey: 'branch1:agent:cli' }))
        .mockResolvedValueOnce(makeAuthSuccess({ sessionKey: 'branch1:agent:reviewer' })) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect, onDisconnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });

      await onConnect({ ...validPayload, name: 'cli', connectionId: 'pane-a' });
      await onConnect({ ...validPayload, name: 'reviewer', connectionId: 'pane-b' });

      onDisconnect({ connectionId: 'pane-a' });

      expect(sessionMap.getBySocket(viewer('pane-a'))).toBeUndefined();
      expect(sessionMap.getBySocket(viewer('pane-b'))).toBeDefined();
      expect(sessionMap.getByKey('branch1:agent:cli')).toBeDefined(); // shell survives until the idle timeout, same as a single-pane disconnect
    });

    it('given onDisconnect with no payload (the socket itself disconnected), should detach every connection this socket had open', async () => {
      const shellA = makeShell();
      const shellB = makeShell();
      openShell = vi.fn().mockReturnValueOnce(shellA).mockReturnValueOnce(shellB) as unknown as ReturnType<typeof vi.fn> & OpenShellFn;
      checkAuth = vi
        .fn()
        .mockResolvedValueOnce(makeAuthSuccess({ sessionKey: 'branch1:agent:cli' }))
        .mockResolvedValueOnce(makeAuthSuccess({ sessionKey: 'branch1:agent:reviewer' })) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect, onDisconnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });

      await onConnect({ ...validPayload, name: 'cli', connectionId: 'pane-a' });
      await onConnect({ ...validPayload, name: 'reviewer', connectionId: 'pane-b' });

      onDisconnect();

      expect(sessionMap.getBySocket(viewer('pane-a'))).toBeUndefined();
      expect(sessionMap.getBySocket(viewer('pane-b'))).toBeUndefined();
    });

    it('given a DIFFERENT socket referencing a connectionId it never established itself, should ignore it rather than acting on another socket\'s session', async () => {
      // `agentTerminalSessionMap` is one shared, server-wide instance — a
      // connectionId is only trustworthy when the CALLING socket is the one
      // that registered it via its own authorized onConnect. A second socket
      // merely claiming someone else's connectionId (e.g. observed, guessed,
      // or replayed) must never be able to write input to, resize, or tear
      // down that session.
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect({ ...validPayload, name: 'cli', connectionId: 'victim-pane' });

      const attackerSocket = makeSocket('attacker-sock');
      const attackerHandlers = buildAgentTerminalHandlers({
        sessionMap,
        openShell,
        checkAuth,
        socket: attackerSocket,
        persistStreamSessionId,
      });

      attackerHandlers.onInput({ data: 'rm -rf /\n', connectionId: 'victim-pane' });
      expect(shell.write).not.toHaveBeenCalled();

      attackerHandlers.onResize({ cols: 1, rows: 1, connectionId: 'victim-pane' });
      expect(shell.resize).not.toHaveBeenCalled();

      attackerHandlers.onDisconnect({ connectionId: 'victim-pane' });
      expect(sessionMap.getBySocket(viewer('victim-pane'))).toBeDefined(); // still alive — the attacker's disconnect was a no-op
    });

    it('given two connects on the SAME socket resolving to the SAME sessionKey, the second JOINS — both panes stay bound, both receive output, and both can type (#2093)', async () => {
      // Both connects resolve to the identical (scope, name) sessionKey — e.g.
      // two panes of the same terminal in one browser. Attach is a join, not a
      // takeover: 'pane-b' arriving must not steal 'pane-a's mapping.
      checkAuth = vi.fn().mockResolvedValue(makeAuthSuccess({ sessionKey: 'branch1:agent:cli' })) as unknown as ReturnType<typeof vi.fn> &
        AgentTerminalCheckAuthFn;
      const { onConnect, onInput, onDisconnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });

      await onConnect({ ...validPayload, connectionId: 'pane-a' });
      await onConnect({ ...validPayload, connectionId: 'pane-b' });
      expect(sessionMap.getBySocket(viewer('pane-a'))).toBeDefined();
      expect(sessionMap.getBySocket(viewer('pane-b'))).toBeDefined();

      // Output reaches BOTH panes, each tagged with its own connectionId.
      const onOutput = openShell.mock.calls[0][0].onOutput as (data: string) => void;
      onOutput('shared');
      expect(socket.emit).toHaveBeenCalledWith('agent-terminal:output', { data: 'shared', connectionId: 'pane-a' });
      expect(socket.emit).toHaveBeenCalledWith('agent-terminal:output', { data: 'shared', connectionId: 'pane-b' });

      // Both panes' input reaches the one PTY (deliberate free-for-all).
      onInput({ data: 'ls\n', connectionId: 'pane-a' });
      onInput({ data: 'pwd\n', connectionId: 'pane-b' });
      expect(shell.write).toHaveBeenCalledWith('ls\n');
      expect(shell.write).toHaveBeenCalledWith('pwd\n');

      // Closing one pane leaves the other's viewer intact.
      onDisconnect({ connectionId: 'pane-a' });
      expect(sessionMap.getBySocket(viewer('pane-a'))).toBeUndefined();
      expect(sessionMap.getBySocket(viewer('pane-b'))).toBeDefined();
      expect(sessionMap.getByKey('branch1:agent:cli')).toBeDefined();
    });
  });

  describe('onDisconnect', () => {
    it('given a disconnect, should silence output but keep the session alive until the idle timeout', async () => {
      const { onConnect, onDisconnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);
      onDisconnect();

      expect(sessionMap.getByKey('branch1:agent:cli')).toBeDefined();
      expect(shell.kill).not.toHaveBeenCalled();
    });

    it('given a disconnect, should signal the shell that no viewer is attached (leaf 3-2: stops the watchdog reconnect loop)', async () => {
      const { onConnect, onDisconnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);
      onDisconnect();

      expect(shell.setViewerAttached).toHaveBeenCalledWith(false);
    });

    it('given the idle timeout elapses, should HAND BACK the concurrency slot as well as killing the shell', async () => {
      // The reaped session held a slot for its whole detached grace; the reap must
      // return it, or a user's tier capacity bleeds away one abandoned tab at a time.
      const auth = makeAuthSuccess();
      checkAuth = vi.fn().mockResolvedValue(auth) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect, onDisconnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);
      onDisconnect();
      await vi.advanceTimersByTimeAsync(DETACHED_IDLE_MS);

      expect(auth.releaseSlot).toHaveBeenCalledTimes(1);
      expect(shell.kill).toHaveBeenCalledWith('idle-reap');
    });

    it('given the idle timeout elapses, should kill the shell and drop the session', async () => {
      const { onConnect, onDisconnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);
      onDisconnect();
      await vi.advanceTimersByTimeAsync(DETACHED_IDLE_MS);

      expect(shell.kill).toHaveBeenCalledWith('idle-reap');
      expect(sessionMap.getByKey('branch1:agent:cli')).toBeUndefined();
    });
  });

  describe('cold-tail persist on teardown (issue #2205)', () => {
    let persistColdTail: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      persistColdTail = vi.fn().mockResolvedValue(undefined);
    });

    it('given the idle reap fires, should persist the byte-capped tail and hasOutput once, keyed by the row\'s agentTerminalId', async () => {
      const { onConnect, onDisconnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, persistColdTail });
      await onConnect(validPayload);
      const onOutput = openShell.mock.calls[0][0].onOutput as (data: string) => void;
      onOutput('last words\r\n');
      onDisconnect();

      await vi.advanceTimersByTimeAsync(DETACHED_IDLE_MS);

      expect(persistColdTail).toHaveBeenCalledTimes(1);
      expect(persistColdTail).toHaveBeenCalledWith({
        agentTerminalId: 'agent-terminal-1',
        tail: 'last words',
        hasOutput: true,
        endedAt: expect.any(Date),
      });
    });

    it('given the PTY exits naturally (onExit), should persist the cold tail', async () => {
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, persistColdTail });
      await onConnect(validPayload);
      const args = openShell.mock.calls[0][0] as OpenPtyShellArgs;
      (args.onOutput as (data: string) => void)('bye\r\n');

      (args.onExit as (exitCode: number) => void)(0);

      expect(persistColdTail).toHaveBeenCalledTimes(1);
      expect(persistColdTail).toHaveBeenCalledWith(
        expect.objectContaining({ agentTerminalId: 'agent-terminal-1', tail: 'bye', hasOutput: true }),
      );
    });

    it('given a forced teardown (access revoked, sole viewer), should persist the cold tail', async () => {
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, persistColdTail });
      await onConnect(validPayload);

      checkAuth.mockResolvedValue({ ok: false, reason: 'permission_revoked' });
      await vi.advanceTimersByTimeAsync(60_000);

      expect(shell.kill).toHaveBeenCalledWith('forced-teardown');
      expect(persistColdTail).toHaveBeenCalledTimes(1);
      expect(persistColdTail).toHaveBeenCalledWith(
        expect.objectContaining({ agentTerminalId: 'agent-terminal-1' }),
      );
    });

    it('given no persistColdTail dep is wired, should tear the session down without throwing', async () => {
      const { onConnect, onDisconnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);
      onDisconnect();

      await expect(vi.advanceTimersByTimeAsync(DETACHED_IDLE_MS)).resolves.not.toThrow();
      expect(sessionMap.getByKey('branch1:agent:cli')).toBeUndefined();
    });

    it('given persistColdTail REJECTS, should not break teardown — the session is still removed and its timers still cleared', async () => {
      persistColdTail = vi.fn().mockRejectedValue(new Error('db unreachable'));
      const { onConnect, onDisconnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, persistColdTail });
      await onConnect(validPayload);
      onDisconnect();

      await expect(vi.advanceTimersByTimeAsync(DETACHED_IDLE_MS)).resolves.not.toThrow();
      expect(shell.kill).toHaveBeenCalledWith('idle-reap');
      expect(sessionMap.getByKey('branch1:agent:cli')).toBeUndefined();
    });
  });

  describe('multi-viewer fan-out — attach is a join, not a takeover (#2093)', () => {
    /** Creator on `socket`, then a second user joins on their own socket. */
    async function connectTwoViewers() {
      const handlers1 = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await handlers1.onConnect(validPayload);
      const socket2 = makeSocket('sock2', 'user2');
      const handlers2 = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket: socket2, persistStreamSessionId });
      await handlers2.onConnect(validPayload);
      const onOutput = openShell.mock.calls[0][0].onOutput as (data: string) => void;
      return { handlers1, handlers2, socket2, onOutput };
    }

    it('given two sockets attached to one PTY, output reaches BOTH, each tagged with its own connectionId — the incumbent is never silenced', async () => {
      const { socket2, onOutput } = await connectTwoViewers();

      onOutput('hello both');

      expect(socket.emit).toHaveBeenCalledWith('agent-terminal:output', { data: 'hello both', connectionId: 'sock1' });
      expect(socket2.emit).toHaveBeenCalledWith('agent-terminal:output', { data: 'hello both', connectionId: 'sock2' });
    });

    it('given a joiner, they get the buffered scrollback and the incumbent gets NO duplicate replay', async () => {
      const handlers1 = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await handlers1.onConnect(validPayload);
      const onOutput = openShell.mock.calls[0][0].onOutput as (data: string) => void;
      onOutput('history line');

      const socket2 = makeSocket('sock2', 'user2');
      const handlers2 = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket: socket2, persistStreamSessionId });
      await handlers2.onConnect(validPayload);

      expect(socket2.emit).toHaveBeenCalledWith('agent-terminal:ready', {
        scrollback: 'history line',
        resumed: true,
        connectionId: 'sock2',
      });
      // The incumbent saw exactly one ready — its own, at create.
      const incumbentReadies = socket.emit.mock.calls.filter(([event]) => event === 'agent-terminal:ready');
      expect(incumbentReadies).toHaveLength(1);
    });

    it('given one of two viewers detaches, the other keeps streaming and NO detach transition fires — no watchdog quiet, no idle reap', async () => {
      const { handlers1, socket2, onOutput } = await connectTwoViewers();

      handlers1.onDisconnect();

      expect(shell.setViewerAttached).not.toHaveBeenCalledWith(false);
      onOutput('for the survivor');
      expect(socket2.emit).toHaveBeenCalledWith('agent-terminal:output', { data: 'for the survivor', connectionId: 'sock2' });

      // The reap must not be armed while anyone is still watching.
      await vi.advanceTimersByTimeAsync(DETACHED_IDLE_MS);
      expect(shell.kill).not.toHaveBeenCalled();
      expect(sessionMap.getByKey('branch1:agent:cli')).toBeDefined();
    });

    it('given the LAST viewer detaches, the detach transition fires and the idle reap kills the session once', async () => {
      const { handlers1, handlers2 } = await connectTwoViewers();

      handlers1.onDisconnect();
      handlers2.onDisconnect();

      expect(shell.setViewerAttached).toHaveBeenCalledWith(false);
      await vi.advanceTimersByTimeAsync(DETACHED_IDLE_MS);
      expect(shell.kill).toHaveBeenCalledTimes(1);
      expect(shell.kill).toHaveBeenCalledWith('idle-reap');
      expect(sessionMap.getByKey('branch1:agent:cli')).toBeUndefined();
    });

    it('given the PTY exits, every attached viewer receives agent-terminal:closed', async () => {
      const { socket2 } = await connectTwoViewers();

      const onExit = openShell.mock.calls[0][0].onExit as (exitCode: number) => void;
      onExit(0);

      expect(socket.emit).toHaveBeenCalledWith('agent-terminal:closed', { exitCode: 0, connectionId: 'sock1' });
      expect(socket2.emit).toHaveBeenCalledWith('agent-terminal:closed', { exitCode: 0, connectionId: 'sock2' });
    });

    it('given two viewers on separate sockets, BOTH can type into the one PTY (deliberate tmux-style free-for-all)', async () => {
      const { handlers1, handlers2 } = await connectTwoViewers();

      handlers1.onInput({ data: 'from user1\n', connectionId: 'sock1' });
      handlers2.onInput({ data: 'from user2\n', connectionId: 'sock2' });

      expect(shell.write).toHaveBeenCalledWith('from user1\n');
      expect(shell.write).toHaveBeenCalledWith('from user2\n');
    });

    it('billing is per-session wall-clock: an identical timeline settles IDENTICAL seconds for 1 viewer and for 2 (#2093 regression)', async () => {
      async function runTimeline(viewerCount: 1 | 2): Promise<{ gateCalls: number; trackUsageCalls: Array<Record<string, unknown>> }> {
        const localMap = createTerminalSessionMap();
        const localShell = makeShell();
        const localOpenShell = vi.fn().mockReturnValue(localShell) as unknown as ReturnType<typeof vi.fn> & OpenShellFn;
        const localCheckAuth = vi.fn().mockResolvedValue(makeAuthSuccess()) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
        const billing = makeBilling();

        const h1 = buildAgentTerminalHandlers({ sessionMap: localMap, openShell: localOpenShell, checkAuth: localCheckAuth, socket: makeSocket('sockA', 'user1'), persistStreamSessionId, billing });
        await h1.onConnect(validPayload);
        if (viewerCount === 2) {
          const h2 = buildAgentTerminalHandlers({ sessionMap: localMap, openShell: localOpenShell, checkAuth: localCheckAuth, socket: makeSocket('sockB', 'user2'), persistStreamSessionId, billing });
          await h2.onConnect(validPayload);
        }

        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        const onExit = localOpenShell.mock.calls[0][0].onExit as (exitCode: number) => void;
        onExit(0);

        return {
          gateCalls: billing.gate.mock.calls.length,
          trackUsageCalls: billing.trackUsage.mock.calls.map(([args]: [Record<string, unknown>]) => args),
        };
      }

      const solo = await runTimeline(1);
      const pair = await runTimeline(2);

      expect(solo.gateCalls).toBe(1);
      expect(pair.gateCalls).toBe(1); // the joiner never gates or places a hold
      expect(pair.trackUsageCalls).toEqual(solo.trackUsageCalls); // same windows, same seconds, same count
    });
  });

  describe('machine billing (Terminal Epic 3)', () => {
    it('given no billing dep, connects unmetered (no gate, no settle)', async () => {
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      expect(sessionMap.getByKey('branch1:agent:cli')).toBeDefined();
    });

    it('places a hold for the resolved payerId BEFORE opening the shell', async () => {
      const billing = makeBilling();
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing });
      await onConnect(validPayload);

      expect(billing.gate).toHaveBeenCalledWith({ payerId: 'owner-1' });
      expect(openShell).toHaveBeenCalled();
      expect(sessionMap.getByKey('branch1:agent:cli')).toMatchObject({ holdId: 'hold-1', payerId: 'owner-1' });
    });

    it('given the gate denies, emits agent-terminal:error, releases the slot, and never opens a shell', async () => {
      const auth = makeAuthSuccess();
      checkAuth.mockResolvedValue(auth);
      const billing = makeBilling({ gate: vi.fn().mockResolvedValue({ allowed: false, reason: 'insufficient_balance' }) });
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing });
      await onConnect(validPayload);

      expect(openShell).not.toHaveBeenCalled();
      expect(auth.releaseSlot).toHaveBeenCalled();
      expect(sessionMap.getBySocket(viewer('sock1'))).toBeUndefined();
      expect(socket.emit).toHaveBeenCalledWith('agent-terminal:error', expect.objectContaining({ message: expect.any(String) }));
    });

    it('given openShell throws AFTER the hold was placed, releases the hold (safety net)', async () => {
      const billing = makeBilling();
      openShell = vi.fn().mockImplementation(() => { throw new Error('sprite unreachable'); }) as unknown as ReturnType<typeof vi.fn> & OpenShellFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing });
      await onConnect(validPayload);

      expect(billing.releaseHold).toHaveBeenCalledWith('hold-1');
      expect(billing.trackUsage).not.toHaveBeenCalled();
    });

    /**
     * Billing must track SANDBOX RESIDENCY, not tab-open time. Once the watchdog
     * quiesces an idle shell, its task hold is released and the Sprite pauses —
     * costing us nothing. An ATTACHED session is never reaped (`DETACHED_IDLE_MS`
     * only arms on disconnect), so billing wall-clock through a quiesce would
     * charge the payer, without bound, for a sandbox that is not running: leave a
     * tab open overnight, get billed for the night.
     */
    it('given the shell quiesced, settles the window so far and then STOPS the clock (a paused sprite is not billable)', async () => {
      const billing = makeBilling();
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing });
      await onConnect(validPayload);

      // Ten minutes of real, live session — billable.
      await vi.advanceTimersByTimeAsync(SETTLE_HEARTBEAT_MS);
      expect(billing.trackUsage).toHaveBeenCalledTimes(1);
      expect(billing.trackUsage.mock.calls[0][0]).toMatchObject({ activeSeconds: SETTLE_HEARTBEAT_MS / 1000 });

      // The viewer goes idle; the watchdog quiets the shell and the sprite pauses.
      shell.setQuiesced(true);
      await vi.advanceTimersByTimeAsync(SETTLE_HEARTBEAT_MS);

      // That beat bills the window that ended at the quiesce…
      expect(billing.trackUsage).toHaveBeenCalledTimes(2);

      // …and every beat after it bills NOTHING, however long the tab stays open.
      await vi.advanceTimersByTimeAsync(SETTLE_HEARTBEAT_MS * 5);
      expect(billing.trackUsage).toHaveBeenCalledTimes(2);
    });

    it('given a quiesced shell, does not reserve the payer\'s credits for a window that is not running', async () => {
      const billing = makeBilling();
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing });
      await onConnect(validPayload);
      const gatesAtConnect = billing.gate.mock.calls.length;

      shell.setQuiesced(true);
      await vi.advanceTimersByTimeAsync(SETTLE_HEARTBEAT_MS * 3);

      expect(billing.gate).toHaveBeenCalledTimes(gatesAtConnect); // no re-hold while paused
      expect(sessionMap.getByKey('branch1:agent:cli')).toMatchObject({ connectedAt: undefined });
    });

    it('given a keystroke resumes a quiesced shell, restarts the clock AT THE KEYSTROKE, not at the next heartbeat', async () => {
      // The heartbeat is ten minutes wide. Restarting the clock on the next beat
      // would hand the payer up to ten minutes of a live, running sandbox free.
      const billing = makeBilling();
      const handlers = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing });
      await handlers.onConnect(validPayload);

      shell.setQuiesced(true);
      await vi.advanceTimersByTimeAsync(SETTLE_HEARTBEAT_MS); // clock stops
      const settlesWhileQuiet = billing.trackUsage.mock.calls.length;

      // The viewer types: the shell resumes, the sprite wakes, consumption starts.
      shell.setQuiesced(false);
      handlers.onInput({ data: 'ls\n' });

      // Nine minutes of live sandbox BEFORE the next beat — all of it billable.
      await vi.advanceTimersByTimeAsync(SETTLE_HEARTBEAT_MS);

      expect(billing.trackUsage).toHaveBeenCalledTimes(settlesWhileQuiet + 1);
      const resumed = billing.trackUsage.mock.calls[settlesWhileQuiet][0] as { activeSeconds: number };
      expect(resumed.activeSeconds).toBe(SETTLE_HEARTBEAT_MS / 1000); // the whole window, not zero
    });

    it('given a viewer returns to a quiesced shell, restarts the clock on the reattach', async () => {
      const billing = makeBilling();
      const handlers = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing });
      await handlers.onConnect(validPayload);

      shell.setQuiesced(true);
      await vi.advanceTimersByTimeAsync(SETTLE_HEARTBEAT_MS);
      expect(sessionMap.getByKey('branch1:agent:cli')).toMatchObject({ connectedAt: undefined });

      handlers.onDisconnect();
      shell.setQuiesced(false);

      const socket2 = makeSocket('sock2');
      const handlers2 = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket: socket2, persistStreamSessionId, billing });
      await handlers2.onConnect(validPayload); // tab-back -> attachToLiveSession

      const session = sessionMap.getByKey('branch1:agent:cli') as { connectedAt?: number };
      expect(session.connectedAt).toBeTypeOf('number'); // clock running again
    });

    it('given the END-of-session settle rejects, should log and still tear the session down (billing never blocks cleanup)', async () => {
      // The last settle is fire-and-forget: a billing/DB outage at the moment a
      // terminal closes must not strand the session in the map (leaking its slot
      // and its PTY) — the window is lost, the terminal is not.
      const billing = makeBilling({ trackUsage: vi.fn().mockRejectedValue(new Error('ledger unreachable')) });
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing });
      await onConnect(validPayload);

      const onExitArg = openShell.mock.calls[0][0].onExit as (exitCode: number) => void;
      await vi.advanceTimersByTimeAsync(5_000);
      onExitArg(0);
      await expect(vi.advanceTimersByTimeAsync(0)).resolves.not.toThrow();

      expect(billing.trackUsage).toHaveBeenCalledTimes(1);
      expect(sessionMap.getByKey('branch1:agent:cli')).toBeUndefined();
      expect(socket.emit).toHaveBeenCalledWith('agent-terminal:closed', { exitCode: 0, connectionId: 'sock1' });
    });

    it('given the end-of-session settle rejects with a NON-Error value, should still log without throwing', async () => {
      // The catch normalizes an arbitrary thrown value; a bare string must not
      // blow up the logger call and take the teardown down with it.
      const billing = makeBilling({ trackUsage: vi.fn().mockRejectedValue('ledger string blip') });
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing });
      await onConnect(validPayload);

      const onExitArg = openShell.mock.calls[0][0].onExit as (exitCode: number) => void;
      onExitArg(0);
      await expect(vi.advanceTimersByTimeAsync(0)).resolves.not.toThrow();

      expect(sessionMap.getByKey('branch1:agent:cli')).toBeUndefined();
    });

    it('on natural shell exit, settles the hold to the real connected-window seconds and never releases it separately', async () => {
      const billing = makeBilling();
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing });
      await onConnect(validPayload);

      const onExitArg = openShell.mock.calls[0][0].onExit as (exitCode: number) => void;
      await vi.advanceTimersByTimeAsync(7_000);
      onExitArg(0);

      expect(billing.trackUsage).toHaveBeenCalledTimes(1);
      const call = billing.trackUsage.mock.calls[0][0];
      expect(call).toMatchObject({ payerId: 'owner-1', holdId: 'hold-1', pageId: 't1' });
      expect(call.activeSeconds).toBeCloseTo(7, 0);
      expect(billing.releaseHold).not.toHaveBeenCalled();
      expect(sessionMap.getByKey('branch1:agent:cli')).toBeUndefined();
    });

    it('on idle-timeout reap after disconnect, settles the FULL active window across heartbeat slices (revenue conservation)', async () => {
      const billing = makeBilling();
      const { onConnect, onDisconnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing });
      await onConnect(validPayload);

      onDisconnect();
      await vi.advanceTimersByTimeAsync(DETACHED_IDLE_MS);

      // The 30-min detached window spans heartbeat settles plus the reap's tail —
      // however it is sliced, the settled seconds must sum to the whole window and
      // every slice must carry the payer/page attribution.
      const calls = billing.trackUsage.mock.calls.map((c) => c[0]);
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls.reduce((s, c) => s + c.activeSeconds, 0)).toBeCloseTo(DETACHED_IDLE_MS / 1000, 0);
      for (const call of calls) {
        expect(call.payerId).toBe('owner-1');
        expect(call.pageId).toBe('t1');
      }
      expect(calls[0].holdId).toBe('hold-1');
      expect(billing.releaseHold).not.toHaveBeenCalled();
    });

    describe('heartbeat settle (bounds deploy-time loss to one interval)', () => {
      it('settles the accrued window at each heartbeat and re-holds, so session end only settles the tail', async () => {
        let holdN = 0;
        const billing = makeBilling({
          gate: vi.fn().mockImplementation(async () => ({ allowed: true, holdId: `hold-${++holdN}` })),
        });
        const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing });
        await onConnect(validPayload);

        await vi.advanceTimersByTimeAsync(SETTLE_HEARTBEAT_MS);

        expect(billing.trackUsage).toHaveBeenCalledTimes(1);
        const first = billing.trackUsage.mock.calls[0][0];
        expect(first).toMatchObject({ payerId: 'owner-1', holdId: 'hold-1', pageId: 't1' });
        expect(first.activeSeconds).toBeCloseTo(SETTLE_HEARTBEAT_MS / 1000, 0);
        // The session survives the heartbeat with a fresh hold in place.
        expect(shell.kill).not.toHaveBeenCalled();
        expect(sessionMap.getByKey('branch1:agent:cli')).toMatchObject({ holdId: 'hold-2' });

        const onExitArg = openShell.mock.calls[0][0].onExit as (exitCode: number) => void;
        await vi.advanceTimersByTimeAsync(30_000);
        onExitArg(0);

        expect(billing.trackUsage).toHaveBeenCalledTimes(2);
        const tail = billing.trackUsage.mock.calls[1][0];
        expect(tail.holdId).toBe('hold-2');
        expect(tail.activeSeconds).toBeCloseTo(30, 0);
        expect(billing.releaseHold).not.toHaveBeenCalled();
      });

      it('given the gate denies at a heartbeat, settles the accrued window then tears the session down like a failed re-auth', async () => {
        const billing = makeBilling({
          gate: vi.fn()
            .mockResolvedValueOnce({ allowed: true, holdId: 'hold-1' })
            .mockResolvedValue({ allowed: false, reason: 'insufficient_balance' }),
        });
        const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing });
        await onConnect(validPayload);

        await vi.advanceTimersByTimeAsync(SETTLE_HEARTBEAT_MS);

        // The accrued window settles against the original hold; the uniform
        // teardown then settles the (near-zero) tail — total billed stays the window.
        const calls = billing.trackUsage.mock.calls.map((c) => c[0]);
        expect(calls[0].holdId).toBe('hold-1');
        expect(calls[0].activeSeconds).toBeCloseTo(SETTLE_HEARTBEAT_MS / 1000, 0);
        expect(calls.reduce((s, c) => s + c.activeSeconds, 0)).toBeCloseTo(SETTLE_HEARTBEAT_MS / 1000, 0);
        expect(shell.kill).toHaveBeenCalledWith('forced-teardown');
        expect(sessionMap.getByKey('branch1:agent:cli')).toBeUndefined();
        expect(socket.emit).toHaveBeenCalledWith('agent-terminal:closed', expect.objectContaining({ exitCode: -2 }));
      });

      it('given the settle fails at a heartbeat, restores the window and hold so the next heartbeat retries the FULL window (no slice lost, no hold stacked)', async () => {
        const billing = makeBilling({
          trackUsage: vi.fn()
            .mockRejectedValueOnce(new Error('db blip'))
            .mockResolvedValue(undefined),
        });
        const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing });
        await onConnect(validPayload);

        await vi.advanceTimersByTimeAsync(SETTLE_HEARTBEAT_MS); // settle fails
        expect(billing.trackUsage).toHaveBeenCalledTimes(1);
        expect(billing.gate).toHaveBeenCalledTimes(1); // connect only — no fresh hold stacked on the failure
        expect(shell.kill).not.toHaveBeenCalled(); // fail-open: session stays alive
        expect(sessionMap.getByKey('branch1:agent:cli')).toMatchObject({ holdId: 'hold-1' }); // hold restored

        await vi.advanceTimersByTimeAsync(SETTLE_HEARTBEAT_MS); // next heartbeat retries the whole window
        expect(billing.trackUsage).toHaveBeenCalledTimes(2);
        const retry = billing.trackUsage.mock.calls[1][0];
        expect(retry.holdId).toBe('hold-1');
        expect(retry.activeSeconds).toBeCloseTo((2 * SETTLE_HEARTBEAT_MS) / 1000, 0);
      });

      it('given the session is torn down while a heartbeat settle is FAILING, retries the pre-heartbeat window once instead of dropping it', async () => {
        let rejectSettle: (e: Error) => void = () => {};
        const billing = makeBilling({
          trackUsage: vi.fn()
            .mockImplementationOnce(() => new Promise((_, rej) => { rejectSettle = rej; })) // heartbeat settle hangs, then fails
            .mockResolvedValue(undefined),
        });
        const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing });
        await onConnect(validPayload);

        await vi.advanceTimersByTimeAsync(SETTLE_HEARTBEAT_MS); // heartbeat fires; settle in flight
        const onExitArg = openShell.mock.calls[0][0].onExit as (exitCode: number) => void;
        onExitArg(0); // teardown races the failing settle — its end-settle bills only the ~0s tail
        rejectSettle(new Error('db blip'));
        await vi.advanceTimersByTimeAsync(0);

        // The compensating attempt re-bills the full pre-heartbeat window against the original hold.
        const calls = billing.trackUsage.mock.calls.map((c) => c[0]);
        const compensating = calls.filter((c) => c.holdId === 'hold-1');
        expect(compensating.length).toBeGreaterThanOrEqual(2); // the failed attempt + the retry
        expect(compensating[compensating.length - 1].activeSeconds).toBeCloseTo(SETTLE_HEARTBEAT_MS / 1000, 0);
        // Total billed across all successful-looking calls still sums to the window (tail ≈ 0).
        expect(calls.reduce((s, c) => s + c.activeSeconds, 0)).toBeCloseTo((2 * SETTLE_HEARTBEAT_MS) / 1000, 0);
      });

      it('given a gate infra error at a heartbeat, keeps the session alive (fail-open) rather than killing a live PTY', async () => {
        const billing = makeBilling({
          gate: vi.fn()
            .mockResolvedValueOnce({ allowed: true, holdId: 'hold-1' })
            .mockRejectedValue(new Error('db unreachable')),
        });
        const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing });
        await onConnect(validPayload);

        await vi.advanceTimersByTimeAsync(SETTLE_HEARTBEAT_MS);

        expect(billing.trackUsage).toHaveBeenCalledTimes(1);
        expect(shell.kill).not.toHaveBeenCalled();
        expect(sessionMap.getByKey('branch1:agent:cli')).toBeDefined();
      });

      it('records usage at session end even when the gate placed no hold (settle keys on payer, hold optional)', async () => {
        const billing = makeBilling({ gate: vi.fn().mockResolvedValue({ allowed: true }) });
        const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing });
        await onConnect(validPayload);

        const onExitArg = openShell.mock.calls[0][0].onExit as (exitCode: number) => void;
        await vi.advanceTimersByTimeAsync(5_000);
        onExitArg(0);

        expect(billing.trackUsage).toHaveBeenCalledTimes(1);
        const call = billing.trackUsage.mock.calls[0][0];
        expect(call.holdId).toBeUndefined();
        expect(call.activeSeconds).toBeCloseTo(5, 0);
      });

      it('given a settle that rejects with a NON-Error value, wraps it and keeps the session alive (fail-open)', async () => {
        const billing = makeBilling({ trackUsage: vi.fn().mockRejectedValue('db string blip') });
        const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing });
        await onConnect(validPayload);

        await vi.advanceTimersByTimeAsync(SETTLE_HEARTBEAT_MS);

        // The non-Error rejection is coerced (never thrown), so the PTY survives.
        expect(shell.kill).not.toHaveBeenCalled();
        expect(sessionMap.getByKey('branch1:agent:cli')).toMatchObject({ holdId: 'hold-1' });
      });

      it('given the re-hold gate rejects with a NON-Error value at a heartbeat, keeps the session alive (fail-open)', async () => {
        const billing = makeBilling({
          gate: vi.fn().mockResolvedValueOnce({ allowed: true, holdId: 'hold-1' }).mockRejectedValue('gate string blip'),
        });
        const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing });
        await onConnect(validPayload);

        await vi.advanceTimersByTimeAsync(SETTLE_HEARTBEAT_MS);

        // Settle succeeded; only the re-hold failed (and with a non-Error) — session stays alive.
        expect(billing.trackUsage).toHaveBeenCalledTimes(1);
        expect(shell.kill).not.toHaveBeenCalled();
        expect(sessionMap.getByKey('branch1:agent:cli')).toBeDefined();
      });

      it('given the session ends while the re-hold GATE is in flight, releases the fresh hold instead of leaking it', async () => {
        // The heartbeat settled, then asked for a hold covering the NEXT window.
        // If the terminal closes while that gate is still running, the hold it
        // returns belongs to a session that no longer exists — nobody is left to
        // settle or release it, so it would sit on the payer's balance until its
        // TTL expired. It must be handed straight back.
        const reHold = deferred<{ allowed: boolean; holdId: string }>();
        const billing = makeBilling({
          gate: vi
            .fn()
            .mockResolvedValueOnce({ allowed: true, holdId: 'hold-1' }) // the connect-time hold
            .mockImplementationOnce(() => reHold.promise), // re-hold hangs
        });
        const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing });
        await onConnect(validPayload);

        await vi.advanceTimersByTimeAsync(SETTLE_HEARTBEAT_MS); // heartbeat: settle done, gate in flight
        const onExitArg = openShell.mock.calls[0][0].onExit as (exitCode: number) => void;
        onExitArg(0);                                           // terminal closes mid-gate
        reHold.resolve({ allowed: true, holdId: 'hold-2' });    // the now-orphaned hold lands
        await vi.advanceTimersByTimeAsync(0);

        expect(billing.releaseHold).toHaveBeenCalledWith('hold-2');
        expect(sessionMap.getByKey('branch1:agent:cli')).toBeUndefined();
      });

      it('given the session ends while the re-hold gate is in flight and the gate returns NO hold, releases nothing', async () => {
        // Same race, but the gate allowed the window without reserving anything —
        // there is no hold to hand back, and releaseHold(undefined) must not fire.
        const reHold = deferred<{ allowed: boolean }>();
        const billing = makeBilling({
          gate: vi
            .fn()
            .mockResolvedValueOnce({ allowed: true, holdId: 'hold-1' })
            .mockImplementationOnce(() => reHold.promise),
        });
        const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing });
        await onConnect(validPayload);

        await vi.advanceTimersByTimeAsync(SETTLE_HEARTBEAT_MS);
        const onExitArg = openShell.mock.calls[0][0].onExit as (exitCode: number) => void;
        onExitArg(0);
        reHold.resolve({ allowed: true }); // allowed, but no hold reserved
        await vi.advanceTimersByTimeAsync(0);

        expect(billing.releaseHold).not.toHaveBeenCalled();
        expect(sessionMap.getByKey('branch1:agent:cli')).toBeUndefined();
      });

      it('given the session ends while a SUCCEEDING heartbeat settle is in flight, does not re-hold for the dead session', async () => {
        // Mirror of the failing-settle race: the settle lands fine, but by then the
        // terminal is gone. Asking the gate for the next window's hold would
        // reserve credit for a session nobody will ever settle or release.
        const settle = deferred<void>();
        const billing = makeBilling({
          trackUsage: vi.fn().mockImplementationOnce(() => settle.promise).mockResolvedValue(undefined),
        });
        const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing });
        await onConnect(validPayload);

        await vi.advanceTimersByTimeAsync(SETTLE_HEARTBEAT_MS); // heartbeat: settle in flight
        const onExitArg = openShell.mock.calls[0][0].onExit as (exitCode: number) => void;
        onExitArg(0);          // terminal closes while the settle is still running
        settle.resolve();      // ...and the settle then SUCCEEDS
        await vi.advanceTimersByTimeAsync(0);

        // Only the connect-time gate ran: no hold was taken out for a dead session.
        expect(billing.gate).toHaveBeenCalledTimes(1);
        expect(sessionMap.getByKey('branch1:agent:cli')).toBeUndefined();
      });

      it('given a session with no resolved payer, heartbeats settle nothing (an unmetered session is not billable)', async () => {
        const billing = makeBilling();
        checkAuth = vi.fn().mockResolvedValue(makeAuthSuccess({ payerId: '' })) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
        const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing });
        await onConnect(validPayload);

        await vi.advanceTimersByTimeAsync(SETTLE_HEARTBEAT_MS);

        expect(billing.trackUsage).not.toHaveBeenCalled();
        expect(shell.kill).not.toHaveBeenCalled();
        expect(sessionMap.getByKey('branch1:agent:cli')).toBeDefined();
      });

      it('given the session was already removed when a heartbeat fires, clears its interval without settling', async () => {
        const billing = makeBilling();
        const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing });
        await onConnect(validPayload);

        // Session vanished (e.g. reaped elsewhere) before the heartbeat tick.
        sessionMap.deleteByKey('branch1:agent:cli');
        await vi.advanceTimersByTimeAsync(SETTLE_HEARTBEAT_MS);
        await vi.advanceTimersByTimeAsync(SETTLE_HEARTBEAT_MS);

        // No settle attempted for a gone session, and the interval stopped firing.
        expect(billing.trackUsage).not.toHaveBeenCalled();
      });

      it('given a settle still in flight when the next heartbeat fires, skips the overlapping run', async () => {
        let resolveSettle: () => void = () => {};
        const billing = makeBilling({
          trackUsage: vi
            .fn()
            .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveSettle = () => resolve(undefined); }))
            .mockResolvedValue(undefined),
        });
        const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing });
        await onConnect(validPayload);

        await vi.advanceTimersByTimeAsync(SETTLE_HEARTBEAT_MS); // first heartbeat: settle hangs
        await vi.advanceTimersByTimeAsync(SETTLE_HEARTBEAT_MS); // second heartbeat: still settling → skipped

        // Only the first settle is in flight; the overlapping tick did not start a second.
        expect(billing.trackUsage).toHaveBeenCalledTimes(1);

        resolveSettle();
        await vi.advanceTimersByTimeAsync(0);
        expect(sessionMap.getByKey('branch1:agent:cli')).toBeDefined();
      });
    });

    it('given two teardown paths fire for one session, hands the concurrency slot back exactly ONCE (idempotent release)', async () => {
      // The slot is a bare counter — a second release would hand back capacity the
      // connect never held, letting the user exceed their tier. A re-auth teardown
      // releases it; a late onExit for the same (now killed) PTY must be a no-op.
      const auth = makeAuthSuccess();
      checkAuth = vi.fn().mockResolvedValue(auth) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing: makeBilling() });
      await onConnect(validPayload);
      const onExitArg = openShell.mock.calls[0][0].onExit as (exitCode: number) => void;

      checkAuth.mockResolvedValue({ ok: false, reason: 'permission_revoked' });
      await vi.advanceTimersByTimeAsync(60_000); // re-auth teardown → release #1
      onExitArg(0); // the killed PTY's exit lands later → release #2 attempt, must no-op

      expect(auth.releaseSlot).toHaveBeenCalledTimes(1);
    });

    it('given the shell exits naturally WHILE disconnected (idle reap still pending), should cancel the pending reap so it never double-settles', async () => {
      const billing = makeBilling();
      const { onConnect, onDisconnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing });
      await onConnect(validPayload);
      onDisconnect();

      const onExitArg = openShell.mock.calls[0][0].onExit as (exitCode: number) => void;
      await vi.advanceTimersByTimeAsync(5_000);
      onExitArg(0);

      // Advance past when the (now-cancelled) idle timer would have reaped it again.
      await vi.advanceTimersByTimeAsync(DETACHED_IDLE_MS);

      expect(billing.trackUsage).toHaveBeenCalledTimes(1);
      expect(shell.kill).not.toHaveBeenCalled();
    });

    it('on a re-auth failure kill, settles the hold rather than leaking it', async () => {
      const billing = makeBilling();
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing });
      await onConnect(validPayload);

      checkAuth.mockResolvedValue({ ok: false, reason: 'permission_revoked' });
      // Two ticks: the first evicts the sole viewer (session goes detached),
      // the second fails the detached check and tears the session down.
      await vi.advanceTimersByTimeAsync(120_000);

      expect(billing.trackUsage).toHaveBeenCalledTimes(1);
      expect(billing.releaseHold).not.toHaveBeenCalled();
    });

    it('given a re-auth failure WHILE disconnected (idle reap still pending), should clear the pending idle timer too, settling only once', async () => {
      const billing = makeBilling();
      const { onConnect, onDisconnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing });
      await onConnect(validPayload);
      onDisconnect();

      checkAuth.mockResolvedValue({ ok: false, reason: 'permission_revoked' });
      await vi.advanceTimersByTimeAsync(60_000);

      // Advance past when the (now-cancelled) idle timer would have reaped it again.
      await vi.advanceTimersByTimeAsync(DETACHED_IDLE_MS);

      expect(shell.kill).toHaveBeenCalledTimes(1);
      expect(billing.trackUsage).toHaveBeenCalledTimes(1);
    });

    it('given two CONCURRENT cold connects, places exactly ONE hold — the joiner never gates', async () => {
      // Serializing the key means the second connect never resolves a sandbox, so
      // it never gates and never places a hold there is nobody left to settle.
      const billing = makeBilling();
      const authA = makeAuthSuccess();
      const authB = makeAuthSuccess();
      checkAuth = vi.fn().mockResolvedValueOnce(authA).mockResolvedValueOnce(authB) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing });

      await Promise.all([
        onConnect({ ...validPayload, connectionId: 'pane-a' }),
        onConnect({ ...validPayload, connectionId: 'pane-b' }),
      ]);

      expect(billing.gate).toHaveBeenCalledTimes(1);
      expect(billing.releaseHold).not.toHaveBeenCalled();
      expect(billing.trackUsage).not.toHaveBeenCalled();
      expect(sessionMap.getByKey('branch1:agent:cli')).toMatchObject({ holdId: 'hold-1' });
    });

    it('given the billing gate THROWS after the slot was reserved, releases the slot rather than leaking it forever', async () => {
      // `activeByUser` is a process-lifetime counter. A gate that throws with the
      // slot still held would lock a free-tier user (limit 1) out of agent terminals
      // on this replica until the process restarts.
      const auth = makeAuthSuccess();
      checkAuth = vi.fn().mockResolvedValue(auth) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const billing = makeBilling({ gate: vi.fn().mockRejectedValue(new Error('billing db blip')) });
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing });

      await expect(onConnect(validPayload)).rejects.toThrow('billing db blip');

      expect(auth.releaseSlot).toHaveBeenCalledTimes(1);
      expect(openShell).not.toHaveBeenCalled();
      expect(sessionMap.getByKey('branch1:agent:cli')).toBeUndefined();
    });

    it('reattaching to a live session does NOT place a second hold', async () => {
      const billing = makeBilling();
      const { onConnect: connect1 } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing });
      await connect1(validPayload);
      expect(billing.gate).toHaveBeenCalledTimes(1);

      const socket2 = makeSocket('sock2');
      checkAuth.mockResolvedValue(makeAuthSuccess());
      const { onConnect: connect2 } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket: socket2, persistStreamSessionId, billing });
      await connect2(validPayload);

      expect(billing.gate).toHaveBeenCalledTimes(1);
    });
  });

  describe('reattach — telling a client whether it may prompt the agent', () => {
    it('given a session that was RESUMED at create and has not spoken yet, should still report resumed on reattach', async () => {
      // The cold connect learned the agent was already running. If that fact is not
      // carried on the session, a reattach landing before the first replayed byte —
      // a React StrictMode remount does exactly this — would be told `resumed: false`
      // with an empty scrollback, i.e. "a fresh boot, safe to type", and a client
      // holding a starting prompt would type it into an agent running for hours.
      checkAuth = vi.fn().mockResolvedValue(
        makeAuthSuccess({
          streamSessionId: 'sess-existing',
          sessions: [{ id: 'sess-existing', command: 'pagespace-cli', isActive: true, tty: true }],
        }),
      ) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      // A second pane connects to the same live session, before any output.
      const reconnectSocket = makeSocket();
      const { onConnect: onReconnect } = buildAgentTerminalHandlers({
        sessionMap,
        openShell,
        checkAuth,
        socket: reconnectSocket,
        persistStreamSessionId,
      });
      await onReconnect({ ...validPayload, connectionId: 'pane-b' });

      expect(reconnectSocket.emit).toHaveBeenCalledWith(
        'agent-terminal:ready',
        expect.objectContaining({ connectionId: 'pane-b', resumed: true }),
      );
    });

    it('given a FRESH session that has not spoken yet, should report a fresh boot on reattach', async () => {
      // The mirror image: a cold boot the pane is still waiting on. Re-mounting onto
      // it must NOT spend the prompt — an agent that has emitted nothing cannot be
      // sitting at a confirmation.
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      const reconnectSocket = makeSocket();
      const { onConnect: onReconnect } = buildAgentTerminalHandlers({
        sessionMap,
        openShell,
        checkAuth,
        socket: reconnectSocket,
        persistStreamSessionId,
      });
      await onReconnect({ ...validPayload, connectionId: 'pane-b' });

      expect(reconnectSocket.emit).toHaveBeenCalledWith(
        'agent-terminal:ready',
        expect.objectContaining({ connectionId: 'pane-b', resumed: false }),
      );
    });
  });

  describe('the liveness check must not delay `ready` past the shell\'s first output', () => {
    it('given a stored session id, should ask the Sprite BEFORE opening the shell', async () => {
      // The invariant: `agent-terminal:ready` carries `resumed`, and it must reach
      // the client before any output can. `openPtyShell` may attach to a live
      // session, and every attach REPLAYS its scrollback immediately — so an await
      // between openShell and the emit lets that replay overtake `ready`, and a
      // client that types its starting prompt on first output types it into an
      // agent it has not yet been told was already running. Enforced here, not by a
      // comment: re-inline the await and this fails.
      const order: string[] = [];
      const auth = makeAuthSuccess({
        streamSessionId: 'sess-existing',
        sessions: [{ id: 'sess-existing', command: 'pagespace-cli', isActive: true, tty: true }],
      });
      auth.sprite.listSessions = vi.fn(async () => {
        order.push('listSessions');
        return [{ id: 'sess-existing', command: 'pagespace-cli', isActive: true, tty: true }];
      });
      openShell = vi.fn(() => {
        order.push('openShell');
        return shell;
      }) as unknown as ReturnType<typeof vi.fn> & OpenShellFn;
      checkAuth = vi.fn().mockResolvedValue(auth) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;

      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      expect(order).toEqual(['listSessions', 'openShell']);
    });

    it('given a shell that speaks the instant it opens, should have announced `ready` FIRST', async () => {
      // The invariant is not "listSessions before openShell" — it is that NOTHING
      // awaits between `openShell` and the `ready` emit. An attach replays the
      // session's scrollback immediately, so any await in that span lets output
      // overtake `ready`, and a client that types its prompt on first output types
      // it into an agent it has not yet been told was already running. Asserting
      // the emit ORDER pins that directly: insert an await anywhere in the span and
      // this fails, where an openShell/listSessions order-log would not.
      openShell = vi.fn((args: { onOutput: (data: string) => void }) => {
        // The replay lands as soon as the socket is wired.
        queueMicrotask(() => args.onOutput('replayed scrollback'));
        return shell;
      }) as unknown as ReturnType<typeof vi.fn> & OpenShellFn;
      checkAuth = vi.fn().mockResolvedValue(
        makeAuthSuccess({
          streamSessionId: 'sess-existing',
          sessions: [{ id: 'sess-existing', command: 'pagespace-cli', isActive: true, tty: true }],
        }),
      ) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;

      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);
      await vi.advanceTimersByTimeAsync(0);

      const events = socket.emit.mock.calls.map(([event]: [string]) => event);
      const ready = events.indexOf('agent-terminal:ready');
      const output = events.indexOf('agent-terminal:output');
      expect(ready).toBeGreaterThanOrEqual(0);
      expect(output).toBeGreaterThanOrEqual(0);
      expect(ready).toBeLessThan(output);
    });

    it('given a Sprite that never answers, should give up and open the shell anyway', async () => {
      // Unbounded, this would gate the shell from opening AT ALL: no PTY, the
      // concurrency slot and billing hold both held, and — because finishCreate()
      // never runs — every later connect for this terminal blocked behind the
      // create claim. A terminal that will not open and cannot be retried is far
      // worse than not knowing whether its agent was running.
      const auth = makeAuthSuccess({ streamSessionId: 'sess-existing' });
      auth.sprite.listSessions = vi.fn(() => new Promise(() => {})) as unknown as typeof auth.sprite.listSessions;
      checkAuth = vi.fn().mockResolvedValue(auth) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;

      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      const connecting = onConnect(validPayload);
      await vi.advanceTimersByTimeAsync(6000);
      await connecting;

      // The shell opened, and the client was told the safe thing (an unknown agent
      // is treated as still running, so no prompt is typed at it).
      expect(openShell).toHaveBeenCalled();
      expect(socket.emit).toHaveBeenCalledWith('agent-terminal:ready', { connectionId: 'sock1', resumed: true });
    });

    it('given a listing that FAILS, should fail safe on the session too, not just on the wire', async () => {
      // The reattach path cannot say "unknown" — it re-derives `resumed` from
      // `resumedAtCreate`. Recording `false` for an unknown liveness would put a
      // live agent back into the very window that field exists to close: in the
      // moment before its first byte, `hasOutput` is false, so a pane re-mounting
      // there (carrying the prompt its torn-down mount never spent) would be told
      // "fresh boot, safe to type" and would type into a running agent.
      //
      // An unknown recorded as resumed costs a prompt the user retypes, and stops
      // costing anything the moment the agent speaks. The asymmetry decides it.
      const auth = makeAuthSuccess({ streamSessionId: 'sess-existing' });
      auth.sprite.listSessions = vi.fn(async () => {
        throw new Error('429');
      }) as unknown as typeof auth.sprite.listSessions;
      checkAuth = vi.fn().mockResolvedValue(auth) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;

      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      expect(socket.emit).toHaveBeenCalledWith('agent-terminal:ready', { connectionId: 'sock1', resumed: true });
      expect(sessionMap.getByKey('branch1:agent:cli')?.resumedAtCreate).toBe(true);
    });

    it('given a listing that failed, a REATTACH before the first byte should still say resumed', async () => {
      // The end-to-end shape of the same hazard: the connect could not confirm
      // liveness, the agent IS running, and a second pane attaches before it has
      // spoken. `hasOutput` is false, so only the durable verdict can answer.
      const auth = makeAuthSuccess({ streamSessionId: 'sess-existing' });
      auth.sprite.listSessions = vi.fn(async () => {
        throw new Error('429');
      }) as unknown as typeof auth.sprite.listSessions;
      checkAuth = vi.fn().mockResolvedValue(auth) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      const reconnectSocket = makeSocket();
      const { onConnect: onReconnect } = buildAgentTerminalHandlers({
        sessionMap,
        openShell,
        checkAuth,
        socket: reconnectSocket,
        persistStreamSessionId,
      });
      await onReconnect({ ...validPayload, connectionId: 'pane-b' });

      expect(reconnectSocket.emit).toHaveBeenCalledWith(
        'agent-terminal:ready',
        expect.objectContaining({ connectionId: 'pane-b', resumed: true }),
      );
    });
  });

  describe('a verdict must constrain what happens, not merely predict it', () => {
    it('given a session the Sprite says is GONE, should NOT hand that id to the shell', async () => {
      // `openPtyShell` attaches to a sessionId optimistically — it never consults
      // the verdict. Handing it the stored id while telling the client `resumed:
      // false` bets that the listing was right; lose that bet (a listing that omits
      // a session `attachSession` then binds to) and the bridge is attached to a
      // LIVE agent having just told the client it was safe to type into it. So
      // `gone` makes itself true: no id, a genuinely fresh session.
      checkAuth = vi.fn().mockResolvedValue(
        makeAuthSuccess({ streamSessionId: 'sess-long-dead', sessions: [] }),
      ) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      expect(openShell).toHaveBeenCalledWith(expect.objectContaining({ sessionId: undefined }));
      expect(socket.emit).toHaveBeenCalledWith('agent-terminal:ready', { connectionId: 'sock1', resumed: false });
    });

    it('given a liveness it could not settle, should still attach — abandoning a running agent is the worse error', async () => {
      const auth = makeAuthSuccess({ streamSessionId: 'sess-existing' });
      auth.sprite.listSessions = vi.fn(async () => {
        throw new Error('429');
      }) as unknown as typeof auth.sprite.listSessions;
      checkAuth = vi.fn().mockResolvedValue(auth) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      expect(openShell).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-existing' }));
    });
  });

  describe('a pane that leaves DURING a cold create', () => {
    it('should not START the agent at all — not start it and reap it 30 minutes later', async () => {
      // The disconnect arrives before the connect has registered anything to
      // disconnect: the create is still resolving the Sprite. Dropped, the create
      // finishes into the void — a session with no viewer, never detached, so the
      // idle reap that releases its slot and settles its billing never arms, and the
      // agent CLI sits at its prompt for the life of the process.
      //
      // But merely tearing it down on arrival is not enough. The reap is armed for
      // DETACHED_IDLE_MS, so booting the agent anyway would hold a concurrency slot
      // and bill the machine's payer for THIRTY MINUTES of Sprite runtime for a pane
      // that had already left — a free-tier user (one terminal) locked out of their
      // own machine for half an hour. The pane is gone; do not start the agent.
      const auth = makeAuthSuccess();
      const resolveSandbox = auth.resolveSandbox;
      const gate = deferred<void>();
      auth.resolveSandbox = vi.fn(async () => {
        await gate.promise;
        return resolveSandbox();
      }) as unknown as typeof auth.resolveSandbox;
      checkAuth = vi.fn().mockResolvedValue(auth) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;

      const handlers = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      const connecting = handlers.onConnect(validPayload);
      await vi.advanceTimersByTimeAsync(0);

      // The pane goes away mid-boot (tab closed, workspace switched, StrictMode).
      handlers.onDisconnect({ connectionId: 'sock1' });
      gate.resolve();
      await connecting;
      await vi.advanceTimersByTimeAsync(0);

      // No PTY was ever opened, no session installed, and the slot handed straight
      // back — not thirty minutes from now.
      expect(openShell).not.toHaveBeenCalled();
      expect(sessionMap.getByKey('branch1:agent:cli')).toBeUndefined();
      expect(auth.releaseSlot).toHaveBeenCalled();
    });

    it('given a SECOND pane that joined the create, should not let its attach cancel the reap', async () => {
      // The sibling path, and the nastier one. A connect that joins a create already
      // in flight (a double-mount: the same terminal open in two panes) attaches when
      // the create lands — and attaching CLEARS the idle timer. So a tab that closes
      // mid-create had the reap armed for pane A and then cancelled by pane B, on
      // behalf of a socket that is already gone: the PTY, its slot and its billing run
      // for the life of the process, which is the exact leak the create path fixes.
      const auth = makeAuthSuccess();
      const resolveSandbox = auth.resolveSandbox;
      const gate = deferred<void>();
      auth.resolveSandbox = vi.fn(async () => {
        await gate.promise;
        return resolveSandbox();
      }) as unknown as typeof auth.resolveSandbox;
      checkAuth = vi.fn().mockResolvedValue(auth) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;

      const handlers = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      const creating = handlers.onConnect({ ...validPayload, connectionId: 'pane-a' });
      await vi.advanceTimersByTimeAsync(0);
      // Pane B lands on the same key while A is still booting: it joins rather than
      // opening a second PTY, and parks until the create resolves.
      const joining = handlers.onConnect({ ...validPayload, connectionId: 'pane-b' });
      await vi.advanceTimersByTimeAsync(0);

      // The tab closes — BOTH panes are gone, and neither has a session yet.
      handlers.onDisconnect();
      gate.resolve();
      await Promise.all([creating, joining]);
      await vi.advanceTimersByTimeAsync(0);

      // Nothing was started for either of them, and the slot went straight back. The
      // joiner in particular must not resurrect what the creator declined to boot.
      expect(openShell).not.toHaveBeenCalled();
      expect(sessionMap.getByKey('branch1:agent:cli')).toBeUndefined();
      expect(auth.releaseSlot).toHaveBeenCalled();
    });

    it('given a pane that leaves during the ACCESS CHECK of a reattach, should not cancel the reap', async () => {
      // The same hole, one path further back. A reattach binds no PTY of its own, but
      // it does cancel the pending idle reap of the session it joins — and a pane can
      // leave while its access check (a DB round-trip) is still in flight, before the
      // connect has registered anything to disconnect. Left unhandled, a tab-back that
      // is immediately closed again resurrects a session nobody is watching and no
      // further disconnect can ever collect.
      const first = makeAuthSuccess();
      checkAuth = vi.fn().mockResolvedValue(first) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const handlers = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });

      await handlers.onConnect({ ...validPayload, connectionId: 'pane-a' });
      handlers.onDisconnect({ connectionId: 'pane-a' });
      expect(sessionMap.getByKey('branch1:agent:cli')?.idleTimer).toBeDefined();

      // The tab-back: a fresh pane reattaches, but its access check is slow…
      const authGate = deferred<void>();
      checkAuth = vi.fn(async () => {
        await authGate.promise;
        return makeAuthSuccess();
      }) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const reattaching = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      const connecting = reattaching.onConnect({ ...validPayload, connectionId: 'pane-b' });
      await vi.advanceTimersByTimeAsync(0);

      // …and the pane is gone before it comes back.
      reattaching.onDisconnect({ connectionId: 'pane-b' });
      authGate.resolve();
      await connecting;
      await vi.advanceTimersByTimeAsync(0);

      expect(sessionMap.getByKey('branch1:agent:cli')?.idleTimer).toBeDefined();
      await vi.advanceTimersByTimeAsync(DETACHED_IDLE_MS + 1000);
      expect(first.releaseSlot).toHaveBeenCalled();
      expect(shell.kill).toHaveBeenCalledWith('idle-reap');
    });

    it('must not take the session away from a pane that is still WATCHING it', async () => {
      // The trap in "tear it down on arrival": attaching is not free. It STEALS the
      // session — `sessionMap.reattach` drops the previous owner's socket entry and
      // re-points the PTY's output at the new pane. So a connect that attaches and
      // THEN tears down (because its own pane left) takes a live pane's terminal
      // away from it and kills the PTY 30 minutes later, with the user still
      // watching. An abandoned connect must therefore DECLINE to attach, not attach
      // and undo: the session it was joining already has an owner.
      const auth = makeAuthSuccess();
      checkAuth = vi.fn().mockResolvedValue(auth) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const handlers = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });

      // Pane A creates the terminal and is watching it.
      await handlers.onConnect({ ...validPayload, connectionId: 'pane-a' });

      // The same terminal is opened in a second pane (a double-mount), whose access
      // check is slow — and that pane is closed before it completes.
      const authGate = deferred<void>();
      checkAuth = vi.fn(async () => {
        await authGate.promise;
        return makeAuthSuccess();
      }) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const second = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      const connecting = second.onConnect({ ...validPayload, connectionId: 'pane-b' });
      await vi.advanceTimersByTimeAsync(0);
      second.onDisconnect({ connectionId: 'pane-b' });
      authGate.resolve();
      await connecting;
      await vi.advanceTimersByTimeAsync(0);

      const session = sessionMap.getByKey('branch1:agent:cli');
      // Pane A still owns it: not stolen, not detached, no reap armed…
      expect(sessionMap.getBySocket(viewer('pane-a'))).toBe(session);
      expect(session?.idleTimer).toBeUndefined();
      // …and it is still alive long after the reap would have fired.
      await vi.advanceTimersByTimeAsync(DETACHED_IDLE_MS + 1000);
      expect(shell.kill).not.toHaveBeenCalled();
      expect(auth.releaseSlot).not.toHaveBeenCalled();
    });

    it('given ANOTHER socket that picks the same connectionId, should not orphan the first socket\'s PTY', async () => {
      // The session map is one shared, server-wide instance, so filing a session under
      // the bare client-minted id would let one client's chosen string address another
      // client's session. A second socket picking the same id (a buggy client, or a
      // hostile one — it is validated only as a non-empty string) would have its
      // `setNew` displace the first session's socket entry: no viewer, no armed reap,
      // its PTY and concurrency slot and billing heartbeat running for the life of the
      // process, billed to the MACHINE's payer. And the first socket's later disconnect
      // would then resolve to the SECOND socket's session and reap it — killing a
      // terminal somebody else is watching.
      //
      // The per-socket duplicate guard cannot see this: it is this socket's own set.
      // The key itself has to make the collision unrepresentable.
      const first = makeAuthSuccess({ sessionKey: 'branch1:agent:cli' });
      checkAuth = vi.fn().mockResolvedValue(first) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const owner = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await owner.onConnect({ ...validPayload, connectionId: 'shared-id' });
      const live = sessionMap.getByKey('branch1:agent:cli');

      // A different socket, a different terminal — but the same connectionId.
      const second = makeAuthSuccess({ sessionKey: 'branch1:agent:other' });
      checkAuth = vi.fn().mockResolvedValue(second) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const otherSocket = makeSocket('sock2', 'user2');
      const intruder = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket: otherSocket, persistStreamSessionId });
      await intruder.onConnect({ ...validPayload, name: 'other', connectionId: 'shared-id' });

      // The first socket's session is still its own — not displaced, not orphaned.
      expect(sessionMap.getBySocket(viewer('shared-id'))).toBe(live);
      expect(sessionMap.getBySocket(viewer('shared-id', 'sock2'))).toBe(sessionMap.getByKey('branch1:agent:other'));

      // And the owner's disconnect collects the OWNER's session, not the intruder's.
      owner.onDisconnect({ connectionId: 'shared-id' });
      expect(live?.idleTimer).toBeDefined();
      expect(sessionMap.getByKey('branch1:agent:other')?.idleTimer).toBeUndefined();
    });

    it('refuses a connectionId that is already in use on this socket', async () => {
      // Everything the lifecycle does is keyed on this client-minted id: which
      // disconnect means what, and which session a socket owns. A second concurrent
      // connect reusing it would have the first connect's `finally` clear the abandon
      // mark the second relies on, and `setNew` overwrite the socket entry of a
      // session that is still running — orphaning its PTY, its concurrency slot and
      // its billing heartbeat for the life of the process. That bill is the MACHINE
      // owner's, not the caller's, so this is refused rather than trusted.
      // A REALISTIC checkAuth: the session key derives from the target, so a different
      // terminal is a different key. (A fixture that hard-codes one key would send the
      // second connect down the reattach path, which opens no shell either way — the
      // test would pass against the very bug it is meant to catch.)
      const first = makeAuthSuccess({ sessionKey: 'branch1:agent:cli' });
      const second = makeAuthSuccess({ sessionKey: 'branch1:agent:other' });
      checkAuth = vi.fn(async ({ name }: { name: string }) =>
        name === 'cli' ? first : second,
      ) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const handlers = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });

      await handlers.onConnect({ ...validPayload, connectionId: 'pane-a' });
      const live = sessionMap.getByKey('branch1:agent:cli');
      openShell.mockClear();

      // The same id, a DIFFERENT terminal: without the guard this opens a second PTY
      // and `setNew` displaces the first session's socket entry — leaving it with no
      // viewer and no armed reap, running (and billing) for the life of the process.
      await handlers.onConnect({ ...validPayload, name: 'other', connectionId: 'pane-a' });

      assert({
        given: 'a second connect reusing a live connectionId for a different terminal',
        should: 'be refused, leaving the first session reachable rather than orphaning its PTY',
        actual: {
          opened: openShell.mock.calls.length,
          firstStillOwned: sessionMap.getBySocket(viewer('pane-a')) === live,
          firstOrphaned: live !== undefined && live.idleTimer === undefined && sessionMap.getBySocket(viewer('pane-a')) !== live,
          errored: socket.emit.mock.calls.some(
            ([event, payload]) =>
              event === 'agent-terminal:error' &&
              (payload as { message: string }).message.includes('already in use'),
          ),
        },
        expected: { opened: 0, firstStillOwned: true, firstOrphaned: false, errored: true },
      });
    });
  });
});

/**
 * A HEADLESS start (issue #2206): the same create the socket path runs, asked
 * for by agent IO over signed HTTP instead of by a pane. No viewer, nothing to
 * emit to, and nobody who can go away mid-create — so the interesting questions
 * are all about what nobody-is-watching means for the machinery a viewer
 * normally drives: the reap, the hold, the billing window, the slot.
 */
describe('ensureAgentTerminalSession — headless start', () => {
  let sessionMap: ReturnType<typeof createTerminalSessionMap>;
  let shell: ReturnType<typeof makeShell>;
  let openShell: ReturnType<typeof vi.fn> & OpenShellFn;
  let checkAuth: ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
  let persistStreamSessionId: ReturnType<typeof vi.fn>;

  const target = { machineId: 't1', projectName: 'repo', branchName: 'feature-x', name: 'cli' };

  /** The headless shape: no viewer, no pane to abandon it, nothing to emit. */
  function headlessRequest(access: ReturnType<typeof makeAuthSuccess>) {
    return { access, target, userId: 'user1', cols: 80, rows: 24, abandoned: () => false };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    sessionMap = createTerminalSessionMap();
    shell = makeShell();
    openShell = vi.fn().mockReturnValue(shell) as unknown as ReturnType<typeof vi.fn> & OpenShellFn;
    checkAuth = vi.fn().mockResolvedValue(makeAuthSuccess()) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
    persistStreamSessionId = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('given no viewer, should still open the PTY and install the session under its key', async () => {
    const access = makeAuthSuccess();
    const result = await ensureAgentTerminalSession(
      { sessionMap, openShell, checkAuth, persistStreamSessionId },
      headlessRequest(access),
    );

    assert({
      given: 'a start with no viewer at all',
      should: 'open the shell and file the session by key, reachable to every later caller',
      actual: {
        kind: result.kind,
        opened: openShell.mock.calls.length,
        installed: sessionMap.getByKey('branch1:agent:cli') !== undefined,
        viewers: sessionMap.getByKey('branch1:agent:cli')?.viewers.size,
      },
      expected: { kind: 'created', opened: 1, installed: true, viewers: 0 },
    });
  });

  it('given a headless start, should bind NO socket — there is no connection to route input from', async () => {
    await ensureAgentTerminalSession(
      { sessionMap, openShell, checkAuth, persistStreamSessionId },
      headlessRequest(makeAuthSuccess()),
    );

    assert({
      given: 'a session started with no socket',
      should: 'leave `bySocket` empty rather than inventing a binding nothing can remove',
      actual: sessionMap.getBySocket(viewer('sock1')),
      expected: undefined,
    });
  });

  it('given a headless start, should arm the idle reap immediately — no viewer will ever leave to arm it', async () => {
    // The whole hazard this closes: the reap is normally armed by the LAST
    // VIEWER LEAVING, a transition a session that never had one cannot reach. Left
    // unarmed, a shell an agent started and forgot holds its concurrency slot and
    // bills its payer for the life of the process.
    const access = makeAuthSuccess();
    const billing = makeBilling();
    await ensureAgentTerminalSession(
      { sessionMap, openShell, checkAuth, persistStreamSessionId, billing },
      headlessRequest(access),
    );
    const session = sessionMap.getByKey('branch1:agent:cli');

    assert({
      given: 'a viewer-less session the moment it is created',
      should: 'have a reap pending',
      actual: session?.idleTimer !== undefined,
      expected: true,
    });

    await vi.advanceTimersByTimeAsync(DETACHED_IDLE_MS);

    assert({
      given: 'that reap firing with nobody having ever attached',
      // Three settles, not one: the ten-minute heartbeat bills two windows on
      // the way to the thirty-minute deadline, and the reap settles the tail.
      should: 'kill the PTY, release the slot, settle every accrued window and drop the session',
      actual: {
        killed: shell.kill.mock.calls.map(([reason]) => reason),
        slotReleased: access.releaseSlot.mock.calls.length,
        settled: billing.trackUsage.mock.calls.length,
        stillMapped: sessionMap.getByKey('branch1:agent:cli') !== undefined,
      },
      expected: { killed: ['idle-reap'], slotReleased: 1, settled: 3, stillMapped: false },
    });
  });

  it('given the reap re-armed by later use, should push the deadline back rather than stack a second reap', async () => {
    // An agent driving a headless session at minute 29 must not have its command
    // killed at minute 30 — `session-io` re-arms on delivered input. Re-arming has
    // to MOVE the deadline, not add another timer beside it.
    const access = makeAuthSuccess();
    await ensureAgentTerminalSession(
      { sessionMap, openShell, checkAuth, persistStreamSessionId },
      headlessRequest(access),
    );
    const session = sessionMap.getByKey('branch1:agent:cli')!;

    await vi.advanceTimersByTimeAsync(DETACHED_IDLE_MS - 1000);
    armIdleReap({}, sessionMap, session);
    await vi.advanceTimersByTimeAsync(DETACHED_IDLE_MS - 1000);

    assert({
      given: 'a session used again a second before its reap was due',
      should: 'still be alive most of an idle window later — the original deadline was cancelled, not doubled up',
      actual: { killed: shell.kill.mock.calls.length, stillMapped: sessionMap.getByKey('branch1:agent:cli') !== undefined },
      expected: { killed: 0, stillMapped: true },
    });

    await vi.advanceTimersByTimeAsync(1000);

    assert({
      given: 'a full idle window after that last use',
      should: 'reap it exactly once',
      actual: shell.kill.mock.calls.map(([reason]) => reason),
      expected: ['idle-reap'],
    });
  });

  it('given a headless start, should NOT detach the shell — an agent reading its bytes is a real consumer', async () => {
    // `setViewerAttached(false)` stops the watchdog reconnecting, which is right
    // when a HUMAN closed the last pane. Doing it here would cost an agent the
    // output it started the shell to read. The shell quiets itself through
    // `attach-quiet` if the session actually goes idle.
    await ensureAgentTerminalSession(
      { sessionMap, openShell, checkAuth, persistStreamSessionId },
      headlessRequest(makeAuthSuccess()),
    );

    assert({
      given: 'a session with zero viewers but a live agent driving it',
      should: 'leave the shell attached',
      actual: shell.setViewerAttached.mock.calls,
      expected: [],
    });
  });

  it('given a headless start, should start the billing window at PTY start', async () => {
    const billing = makeBilling();
    await ensureAgentTerminalSession(
      { sessionMap, openShell, checkAuth, persistStreamSessionId, billing },
      headlessRequest(makeAuthSuccess()),
    );
    const session = sessionMap.getByKey('branch1:agent:cli');

    assert({
      given: 'a metered headless start',
      should: 'gate the payer and run the clock from now — a sprite an agent woke is as billable as one a human woke',
      actual: {
        gated: billing.gate.mock.calls.map(([args]) => args),
        clockRunning: session?.connectedAt !== undefined,
        payerId: session?.payerId,
      },
      expected: { gated: [{ payerId: 'owner-1' }], clockRunning: true, payerId: 'owner-1' },
    });
  });

  it('given a headless start, should take the platform task hold — the agent is working with nobody watching', async () => {
    const taskHold = { tick: vi.fn(), end: vi.fn(), tickIntervalMs: 60_000, agentIdleMs: 300_000 };
    await ensureAgentTerminalSession(
      { sessionMap, openShell, checkAuth, persistStreamSessionId, createTaskHold: () => taskHold },
      headlessRequest(makeAuthSuccess()),
    );

    assert({
      given: 'the hold\'s first tick on a viewer-less session',
      should: 'report no viewer but FRESH activity — the launch itself — so the sprite is held for the run',
      actual: taskHold.tick.mock.calls.map(([args]) => ({
        attached: (args as { attached: boolean }).attached,
        activityObservable: (args as { activityObservable: boolean }).activityObservable,
        hasActivity: (args as { lastActivityAt?: number }).lastActivityAt !== undefined,
      })),
      expected: [{ attached: false, activityObservable: false, hasActivity: true }],
    });
  });

  it('given a viewer connecting after a headless start, should join THAT PTY and cancel its reap', async () => {
    const access = makeAuthSuccess();
    checkAuth = vi.fn().mockResolvedValue(access) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
    await ensureAgentTerminalSession(
      { sessionMap, openShell, checkAuth, persistStreamSessionId },
      headlessRequest(access),
    );
    const session = sessionMap.getByKey('branch1:agent:cli');
    session!.scrollback.push('hello from the agent');

    const socket = makeSocket();
    const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
    await onConnect(validPayload);

    assert({
      given: 'a human opening the pane on a shell an agent already started',
      should: 'reattach to the SAME PTY with its scrollback, and stop the reap that was collecting it',
      actual: {
        opened: openShell.mock.calls.length,
        reapPending: session?.idleTimer !== undefined,
        viewers: session?.viewers.size,
        ready: socket.emit.mock.calls.find(([event]) => event === 'agent-terminal:ready')?.[1],
      },
      expected: {
        opened: 1,
        reapPending: false,
        viewers: 1,
        ready: { scrollback: 'hello from the agent', resumed: false, connectionId: 'sock1' },
      },
    });
  });

  it('given a session already live under this key, should join it rather than open a second PTY', async () => {
    const access = makeAuthSuccess();
    await ensureAgentTerminalSession(
      { sessionMap, openShell, checkAuth, persistStreamSessionId },
      headlessRequest(access),
    );
    const first = sessionMap.getByKey('branch1:agent:cli');

    const second = await ensureAgentTerminalSession(
      { sessionMap, openShell, checkAuth, persistStreamSessionId },
      headlessRequest(makeAuthSuccess()),
    );

    assert({
      given: 'a second start for a key that already has a running PTY',
      should: 'hand back the live session, opening nothing and reserving nothing',
      actual: {
        kind: second.kind,
        same: second.kind === 'existing' && second.session === first,
        opened: openShell.mock.calls.length,
      },
      expected: { kind: 'existing', same: true, opened: 1 },
    });
  });

  it('given a session already live under this key but the caller has ABANDONED, should refuse rather than hand it back', async () => {
    // A timed-out `send_session` retried by its caller must not be told "here
    // is your session" for one it will go on to WRITE into — that is exactly
    // the double-execution race the abandonment plumbing exists to close, and
    // this is the ONE path `alreadyLive` skips straight past without ever
    // reaching the create's own `abandoned()` check.
    const access = makeAuthSuccess();
    await ensureAgentTerminalSession(
      { sessionMap, openShell, checkAuth, persistStreamSessionId },
      headlessRequest(access),
    );

    const result = await ensureAgentTerminalSession(
      { sessionMap, openShell, checkAuth, persistStreamSessionId },
      { ...headlessRequest(makeAuthSuccess()), abandoned: () => true },
    );

    assert({
      given: 'a caller who abandoned the request before an already-live session was found',
      should: 'refuse rather than hand back a session it will go on to use',
      actual: result,
      expected: { kind: 'failed', reason: 'abandoned' },
    });
  });

  it('given two headless starts racing the same key, should open exactly one PTY', async () => {
    // Two `send_session` calls landing together on a reserved shell. Without the
    // per-key create claim both would open a PTY against the SAME persisted Sprite
    // session, and discarding the loser would SIGKILL the winner's process.
    const gate = deferred<void>();
    const access = makeAuthSuccess();
    access.resolveSandbox = vi.fn(async () => {
      await gate.promise;
      return (await makeAuthSuccess().resolveSandbox()) as unknown as Awaited<ReturnType<typeof access.resolveSandbox>>;
    }) as unknown as typeof access.resolveSandbox;

    const deps = { sessionMap, openShell, checkAuth, persistStreamSessionId };
    const first = ensureAgentTerminalSession(deps, headlessRequest(access));
    const second = ensureAgentTerminalSession(deps, headlessRequest(makeAuthSuccess()));
    gate.resolve();
    const results = await Promise.all([first, second]);

    assert({
      given: 'two concurrent headless starts for one key',
      should: 'create once and hand the second caller the same session',
      actual: {
        kinds: results.map((result) => result.kind).sort(),
        opened: openShell.mock.calls.length,
      },
      expected: { kinds: ['created', 'existing'], opened: 1 },
    });
  });

  it('given a racing start joins a winner but the caller has ABANDONED by then, should refuse rather than hand it back', async () => {
    // Same hazard as the alreadyLive case, on the OTHER path that can return
    // 'existing': joining a create already in flight. The `await inFlight` is
    // exactly the kind of real suspension point abandonment can newly become
    // true across.
    const gate = deferred<void>();
    const access = makeAuthSuccess();
    access.resolveSandbox = vi.fn(async () => {
      await gate.promise;
      return (await makeAuthSuccess().resolveSandbox()) as unknown as Awaited<ReturnType<typeof access.resolveSandbox>>;
    }) as unknown as typeof access.resolveSandbox;

    const deps = { sessionMap, openShell, checkAuth, persistStreamSessionId };
    let loserAbandoned = false;
    const winner = ensureAgentTerminalSession(deps, headlessRequest(access));
    const loser = ensureAgentTerminalSession(deps, {
      ...headlessRequest(makeAuthSuccess()),
      abandoned: () => loserAbandoned,
    });
    loserAbandoned = true;
    gate.resolve();
    const results = await Promise.all([winner, loser]);

    assert({
      given: 'a racing start that joined the winner only after its own caller had abandoned',
      should: 'refuse the join rather than hand back a session it will go on to use',
      actual: results[1],
      expected: { kind: 'failed', reason: 'abandoned' },
    });
  });

  it('given a denied sandbox resolution, should report the reason and install nothing', async () => {
    const access = makeAuthSuccess();
    access.resolveSandbox = vi.fn(async () => ({ ok: false as const, reason: 'concurrency_limit' })) as unknown as typeof access.resolveSandbox;

    const result = await ensureAgentTerminalSession(
      { sessionMap, openShell, checkAuth, persistStreamSessionId },
      headlessRequest(access),
    );
    // The key claim must not survive its own failed create — asserted by
    // RETRYING rather than by reading the claim, because a caller only ever
    // experiences the claim as "can I create?".
    const retry = await ensureAgentTerminalSession(
      { sessionMap, openShell, checkAuth, persistStreamSessionId },
      headlessRequest(makeAuthSuccess()),
    );

    assert({
      given: 'a start whose sandbox resolution denied',
      should: 'fail with the reason, open nothing, and leave the key free for a retry',
      actual: {
        result,
        openedOnDenial: openShell.mock.calls.length === 1 ? 'retry only' : 'unexpected',
        retried: retry.kind,
        installed: sessionMap.getByKey('branch1:agent:cli') !== undefined,
      },
      expected: {
        result: { kind: 'failed', reason: 'denied', message: 'concurrency_limit' },
        openedOnDenial: 'retry only',
        retried: 'created',
        installed: true,
      },
    });
  });

  it('given an insolvent payer, should refuse the start and hand the slot straight back', async () => {
    const access = makeAuthSuccess();
    const billing = makeBilling({ gate: vi.fn().mockResolvedValue({ allowed: false }) });

    const result = await ensureAgentTerminalSession(
      { sessionMap, openShell, checkAuth, persistStreamSessionId, billing },
      headlessRequest(access),
    );

    assert({
      given: 'a payer who cannot cover a new session',
      should: 'refuse before opening a shell and release the reserved slot exactly once',
      actual: {
        result,
        opened: openShell.mock.calls.length,
        slotReleased: access.releaseSlot.mock.calls.length,
      },
      expected: { result: { kind: 'failed', reason: 'insolvent' }, opened: 0, slotReleased: 1 },
    });
  });

  it('given openShell throwing, should release the slot and the hold exactly once', async () => {
    const access = makeAuthSuccess();
    const billing = makeBilling();
    openShell = vi.fn(() => { throw new Error('sprite exec refused'); }) as unknown as ReturnType<typeof vi.fn> & OpenShellFn;

    const result = await ensureAgentTerminalSession(
      { sessionMap, openShell, checkAuth, persistStreamSessionId, billing },
      headlessRequest(access),
    );

    assert({
      given: 'a shell that could not be opened',
      should: 'report the failure and give back everything the attempt reserved',
      actual: {
        result,
        slotReleased: access.releaseSlot.mock.calls.length,
        holdsReleased: billing.releaseHold.mock.calls.map(([id]) => id),
        installed: sessionMap.getByKey('branch1:agent:cli') !== undefined,
      },
      expected: {
        result: { kind: 'failed', reason: 'open_failed' },
        slotReleased: 1,
        holdsReleased: ['hold-1'],
        installed: false,
      },
    });
  });

  it('given a headless start whose user loses access, should tear the session down at the re-auth tick', async () => {
    // Nobody is attached, so the tick has only the identity the start was made
    // for. A revoked agent's shell must not keep running unsupervised until the
    // 30-minute reap.
    const access = makeAuthSuccess();
    // The start's own verdict is passed in (already granted); `checkAuth` here is
    // only ever the RE-AUTH tick's, so it can revoke from the first call.
    checkAuth = vi.fn().mockResolvedValue({ ok: false, reason: 'no_edit_access' }) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;

    await ensureAgentTerminalSession(
      { sessionMap, openShell, checkAuth, persistStreamSessionId },
      headlessRequest(access),
    );
    await vi.advanceTimersByTimeAsync(60_000);

    assert({
      given: 'the acting user losing machine access while their headless shell runs',
      should: 'kill the PTY and drop the session',
      actual: {
        killed: shell.kill.mock.calls.map(([reason]) => reason),
        stillMapped: sessionMap.getByKey('branch1:agent:cli') !== undefined,
      },
      expected: { killed: ['forced-teardown'], stillMapped: false },
    });
  });
});

describe('connectFailureMessage', () => {
  it('given an abandoned create, should say nothing — nobody is left to read it', () => {
    assert({
      given: 'a create whose pane went away',
      should: 'produce no message',
      actual: connectFailureMessage({ kind: 'failed', reason: 'abandoned' }),
      expected: undefined,
    });
  });

  it('given a denial, should quote the reason on the same wire string as before', () => {
    assert({
      given: 'a denied create',
      should: 'render the deny reason the pane has always rendered',
      actual: connectFailureMessage({ kind: 'failed', reason: 'denied', message: 'no_edit_access' }),
      expected: 'Agent terminal access denied: no_edit_access',
    });
  });

  it('given a denial with no reason, should still name the shape rather than emit "undefined"', () => {
    assert({
      given: 'a denial that arrived without a reason',
      should: 'fall back to a word, not the string "undefined"',
      actual: connectFailureMessage({ kind: 'failed', reason: 'denied' }),
      expected: 'Agent terminal access denied: unknown',
    });
  });

  it('given an insolvent payer, should name credits', () => {
    assert({
      given: 'a create refused by the billing gate',
      should: 'tell the user what to do about it',
      actual: connectFailureMessage({ kind: 'failed', reason: 'insolvent' }),
      expected: 'Insufficient credits to open an agent terminal session.',
    });
  });

  it('given a shell that would not open, should report the open failure', () => {
    assert({
      given: 'openShell throwing',
      should: 'report a failed open',
      actual: connectFailureMessage({ kind: 'failed', reason: 'open_failed' }),
      expected: 'Failed to open agent terminal session',
    });
  });
});
