import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildAgentTerminalHandlers, MAX_INPUT_BYTES, resolveAgentTerminalCommand } from '../agent-terminal-handler';
import { createTerminalSessionMap, DETACHED_IDLE_MS } from '../terminal-session-map';
import type { AgentTerminalCheckAuthFn, OpenShellFn, SocketLike } from '../agent-terminal-handler';
import type { PtyShell } from '../sprites-shell';
import { BRANCH_REPO_PATH } from '@pagespace/lib/services/machines/machine-branches';
import { SANDBOX_ROOT } from '@pagespace/lib/services/sandbox/sandbox-paths';

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
  return {
    ok: true as const,
    agentTerminalId: 'agent-terminal-1',
    sandboxId: 'sbx1',
    cwd: over.cwd ?? BRANCH_REPO_PATH,
    sessionKey: over.sessionKey ?? 'branch1:agent:cli',
    sprite: makeSprite(over.sessions ?? []),
    releaseSlot: vi.fn(),
    command: over.command ?? 'pagespace-cli',
    args: over.args ?? [],
    commandOverride: over.commandOverride ?? null,
    streamSessionId: over.streamSessionId ?? null,
    payerId: over.payerId ?? 'owner-1',
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

const validPayload = { terminalId: 't1', projectName: 'repo', branchName: 'feature-x', name: 'cli', cols: 80, rows: 24 };

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
      expect(socket.emit).toHaveBeenCalledWith('agent-terminal:ready', { connectionId: 'sock1' });
    });

    it('given a branch-scoped agent terminal, should launch inside the branch\'s cloned repo cwd resolved by checkAuth', async () => {
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      expect(openShell).toHaveBeenCalledWith(expect.objectContaining({ cwd: BRANCH_REPO_PATH }));
    });

    it('given a machine-scoped agent terminal, should launch inside the resolved SANDBOX_ROOT cwd', async () => {
      checkAuth = vi.fn().mockResolvedValue(makeAuthSuccess({ cwd: SANDBOX_ROOT })) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect({ terminalId: 't1', name: 'cli', cols: 80, rows: 24 });

      expect(openShell).toHaveBeenCalledWith(expect.objectContaining({ cwd: SANDBOX_ROOT }));
    });

    it('given a project-scoped agent terminal, should launch inside the resolved project path cwd', async () => {
      checkAuth = vi.fn().mockResolvedValue(makeAuthSuccess({ cwd: '/workspace/projects/my-repo' })) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect({ terminalId: 't1', projectName: 'repo', name: 'cli', cols: 80, rows: 24 });

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
      await onConnect({ terminalId: 't1', name: 'shell', cols: 80, rows: 24 });

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
    });

    it('given a payload with neither projectName nor branchName (machine scope), should call checkAuth with both undefined', async () => {
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect({ terminalId: 't1', name: 'shell', cols: 80, rows: 24 });

      expect(checkAuth).toHaveBeenCalledWith(
        expect.objectContaining({ terminalId: 't1', projectName: undefined, branchName: undefined, name: 'shell' }),
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

    it('given a FRESH session with no known streamSessionId, should discover and persist the new Sprite session id', async () => {
      const auth = makeAuthSuccess({ streamSessionId: null });
      // Before launch: no sessions yet. After launch: the newly created one appears.
      auth.sprite.listSessions = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'sess-new', command: 'pagespace-cli', isActive: true, tty: true }]);
      checkAuth = vi.fn().mockResolvedValue(auth) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);
      await vi.advanceTimersByTimeAsync(0);

      expect(persistStreamSessionId).toHaveBeenCalledWith({ agentTerminalId: 'agent-terminal-1', sessionId: 'sess-new' });
    });

    it('given a fresh session where listSessions returns nothing new, should not call persistStreamSessionId', async () => {
      const auth = makeAuthSuccess({ streamSessionId: null, sessions: [] });
      checkAuth = vi.fn().mockResolvedValue(auth) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);
      await vi.advanceTimersByTimeAsync(0);

      expect(persistStreamSessionId).not.toHaveBeenCalled();
    });

    it('given a FRESH session where the post-launch listSessions call rejects, should discover no new session id rather than throwing', async () => {
      const auth = makeAuthSuccess({ streamSessionId: null });
      auth.sprite.listSessions = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error('sprite unreachable'));
      checkAuth = vi.fn().mockResolvedValue(auth) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      await expect(vi.advanceTimersByTimeAsync(0)).resolves.not.toThrow();
      expect(persistStreamSessionId).not.toHaveBeenCalled();
    });

    it('given the pre-launch listSessions snapshot rejects, should still open the shell (defaults to an empty snapshot)', async () => {
      const auth = makeAuthSuccess({ streamSessionId: null });
      auth.sprite.listSessions = vi
        .fn()
        .mockRejectedValueOnce(new Error('sprite unreachable'))
        .mockResolvedValueOnce([]);
      checkAuth = vi.fn().mockResolvedValue(auth) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      expect(openShell).toHaveBeenCalled();
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

    it('on idle-timeout reap after disconnect, settles the hold to the real active-window seconds', async () => {
      const billing = makeBilling();
      const { onConnect, onDisconnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId, billing });
      await onConnect(validPayload);

      onDisconnect();
      await vi.advanceTimersByTimeAsync(DETACHED_IDLE_MS);

      expect(billing.trackUsage).toHaveBeenCalledTimes(1);
      const call = billing.trackUsage.mock.calls[0][0];
      expect(call.payerId).toBe('owner-1');
      expect(call.holdId).toBe('hold-1');
      expect(call.pageId).toBe('t1');
      expect(call.activeSeconds).toBeCloseTo(DETACHED_IDLE_MS / 1000, 0);
      expect(billing.releaseHold).not.toHaveBeenCalled();
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
});
