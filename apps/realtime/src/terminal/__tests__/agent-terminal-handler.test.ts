import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildAgentTerminalHandlers, MAX_INPUT_BYTES, SETTLE_HEARTBEAT_MS, resolveAgentTerminalCommand, planConnect } from '../agent-terminal-handler';
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

function makeShell(): PtyShell & { write: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> } {
  return { write: vi.fn(), resize: vi.fn(), kill: vi.fn() };
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

      expect(sessionMap.getBySocket('sock1')).toBeDefined();
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
      expect(sessionMap.getBySocket('sock1')).toBeUndefined();
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
      expect(sessionMap.getBySocket('sock1')).toBeUndefined();
      expect(auth.releaseSlot).toHaveBeenCalled();
    });

    it('given a known streamSessionId, should reattach to it instead of creating a fresh session', async () => {
      checkAuth = vi.fn().mockResolvedValue(makeAuthSuccess({ streamSessionId: 'sess-existing' })) as unknown as ReturnType<typeof vi.fn> &
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
      expect(sessionMap.getBySocket('sock1')).toBeDefined();
      expect(sessionMap.getBySocket('attacker-sock')).toBeUndefined();
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
      expect(sessionMap.getBySocket('pane-b')).toBe(session);
      expect(socket.emit).toHaveBeenCalledWith('agent-terminal:ready', expect.objectContaining({ connectionId: 'pane-b', scrollback: expect.any(String) }));
    });

    it('given a CONCURRENT connect while a cold create is attaching to a PERSISTED Sprite session, should never kill that session', async () => {
      // The destructive case: both connects resolve the SAME streamSessionId, so
      // openPtyShell would attachSession() to one shared server-side exec session.
      // A "discard the duplicate" strategy would SIGKILL the very process the
      // survivor is attached to. Serializing means the second never opens one.
      checkAuth = vi
        .fn()
        .mockResolvedValueOnce(makeAuthSuccess({ streamSessionId: 'sess-shared' }))
        .mockResolvedValueOnce(makeAuthSuccess({ streamSessionId: 'sess-shared' })) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
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
      expect(sessionMap.getBySocket('pane-b')).toMatchObject({ sessionKey: 'branch1:agent:cli' });
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

      expect(shell.kill).toHaveBeenCalled();
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

    it('given a session reattached by a DIFFERENT user, should re-auth the CURRENT viewer, not the creator', async () => {
      // A session outlives its creator's connection. If re-auth kept checking the
      // creator — who of course remains authorized — a viewer who reattached and
      // then had their access revoked would keep receiving PTY output, and could
      // keep typing, indefinitely.
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload); // user1 creates

      // user2 reattaches on their own socket.
      const socket2 = makeSocket('sock2', 'user2');
      const handlers2 = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket: socket2, persistStreamSessionId });
      await handlers2.onConnect(validPayload);
      expect(sessionMap.getByKey('branch1:agent:cli')).toMatchObject({ viewerUserId: 'user2' });

      checkAuth.mockClear();
      await vi.advanceTimersByTimeAsync(60_000);

      // The tick must ask about user2 — the one actually driving the PTY.
      expect(checkAuth).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user2' }));
      expect(checkAuth).not.toHaveBeenCalledWith(expect.objectContaining({ userId: 'user1' }));
    });

    it('given the reattached viewer loses access, should tear the session down at the next re-auth tick', async () => {
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload); // user1 creates

      const socket2 = makeSocket('sock2', 'user2');
      const handlers2 = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket: socket2, persistStreamSessionId });
      await handlers2.onConnect(validPayload); // user2 takes over the PTY

      // user2's access is revoked; user1 would still pass.
      checkAuth.mockImplementation(async ({ userId }: { userId: string }) =>
        userId === 'user2' ? { ok: false, reason: 'permission_revoked' } : makeAuthSuccess(),
      );
      await vi.advanceTimersByTimeAsync(60_000);

      expect(shell.kill).toHaveBeenCalled();
      expect(sessionMap.getByKey('branch1:agent:cli')).toBeUndefined();
      expect(socket2.emit).toHaveBeenCalledWith('agent-terminal:closed', { exitCode: -2, connectionId: 'sock2' });
    });

    it('given re-auth fires and checkAuth now fails, should kill shell, remove session, and emit agent-terminal:closed with exitCode -2', async () => {
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      checkAuth.mockResolvedValue({ ok: false, reason: 'permission_revoked' });
      await vi.advanceTimersByTimeAsync(60_000);

      expect(shell.kill).toHaveBeenCalledWith();
      expect(sessionMap.getByKey('branch1:agent:cli')).toBeUndefined();
      expect(socket.emit).toHaveBeenCalledWith('agent-terminal:closed', { exitCode: -2, connectionId: 'sock1' });
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

      expect(sessionMap.getBySocket('pane-a')).toMatchObject({ sessionKey: 'branch1:agent:cli' });
      expect(sessionMap.getBySocket('pane-b')).toMatchObject({ sessionKey: 'branch1:agent:reviewer' });

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

      expect(sessionMap.getBySocket('pane-a')).toBeUndefined();
      expect(sessionMap.getBySocket('pane-b')).toBeDefined();
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

      expect(sessionMap.getBySocket('pane-a')).toBeUndefined();
      expect(sessionMap.getBySocket('pane-b')).toBeUndefined();
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
      expect(sessionMap.getBySocket('victim-pane')).toBeDefined(); // still alive — the attacker's disconnect was a no-op
    });

    it('given two connects on the SAME socket resolving to the SAME sessionKey, the second reattach steals the first connectionId\'s socket mapping — onInput/onResize/onDisconnect for the now-dangling first connectionId should no-op rather than throw', async () => {
      // Both connects resolve to the identical (scope, name) sessionKey — e.g.
      // the client reconnected a pane without ever disconnecting the old one
      // first. sessionMap.reattach() steals 'pane-a's socket mapping when
      // 'pane-b' reattaches, but this handler's own activeConnectionIds set
      // still remembers 'pane-a' — every entry point must tolerate that.
      checkAuth = vi.fn().mockResolvedValue(makeAuthSuccess({ sessionKey: 'branch1:agent:cli' })) as unknown as ReturnType<typeof vi.fn> &
        AgentTerminalCheckAuthFn;
      const { onConnect, onInput, onResize, onDisconnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });

      await onConnect({ ...validPayload, connectionId: 'pane-a' });
      await onConnect({ ...validPayload, connectionId: 'pane-b' });
      expect(sessionMap.getBySocket('pane-a')).toBeUndefined(); // stolen by the pane-b reattach

      expect(() => onInput({ data: 'ls\n', connectionId: 'pane-a' })).not.toThrow();
      expect(() => onResize({ cols: 80, rows: 24, connectionId: 'pane-a' })).not.toThrow();
      expect(() => onDisconnect({ connectionId: 'pane-a' })).not.toThrow();

      // The real (pane-b) session is untouched by any of the pane-a no-ops.
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
      expect(shell.kill).toHaveBeenCalled();
    });

    it('given the idle timeout elapses, should kill the shell and drop the session', async () => {
      const { onConnect, onDisconnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);
      onDisconnect();
      await vi.advanceTimersByTimeAsync(DETACHED_IDLE_MS);

      expect(shell.kill).toHaveBeenCalled();
      expect(sessionMap.getByKey('branch1:agent:cli')).toBeUndefined();
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
      expect(sessionMap.getBySocket('sock1')).toBeUndefined();
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
        expect(shell.kill).toHaveBeenCalled();
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
      await vi.advanceTimersByTimeAsync(60_000);

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

    it('given a listing that FAILS, should not freeze that guess onto the session', async () => {
      // `resumed: true` fails safe on the wire, but `resumedAtCreate` is durable
      // state every reattach inherits for the next 30 minutes. A transient 429 must
      // not keep answering for the rest of the session's life.
      const auth = makeAuthSuccess({ streamSessionId: 'sess-existing' });
      auth.sprite.listSessions = vi.fn(async () => {
        throw new Error('429');
      }) as unknown as typeof auth.sprite.listSessions;
      checkAuth = vi.fn().mockResolvedValue(auth) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;

      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      expect(socket.emit).toHaveBeenCalledWith('agent-terminal:ready', { connectionId: 'sock1', resumed: true });
      expect(sessionMap.getByKey('branch1:agent:cli')?.resumedAtCreate).toBe(false);
    });
  });
});
