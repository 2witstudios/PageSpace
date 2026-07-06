import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildAgentTerminalHandlers, MAX_INPUT_BYTES } from '../agent-terminal-handler';
import { createTerminalSessionMap, DETACHED_IDLE_MS } from '../terminal-session-map';
import type { AgentTerminalCheckAuthFn, OpenShellFn, SocketLike } from '../agent-terminal-handler';
import type { PtyShell } from '../sprites-shell';
import { BRANCH_REPO_PATH } from '@pagespace/lib/services/machines/machine-branches';

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
}> = {}) {
  return {
    ok: true as const,
    agentTerminalId: 'agent-terminal-1',
    sandboxId: 'sbx1',
    sessionKey: over.sessionKey ?? 'branch1:agent:cli',
    sprite: makeSprite(over.sessions ?? []),
    releaseSlot: vi.fn(),
    command: over.command ?? 'pagespace-cli',
    args: over.args ?? [],
    streamSessionId: over.streamSessionId ?? null,
  };
}

const validPayload = { terminalId: 't1', projectName: 'repo', branchName: 'feature-x', name: 'cli', cols: 80, rows: 24 };

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
      expect(socket.emit).toHaveBeenCalledWith('agent-terminal:ready', {});
    });

    it('given a fresh session, should launch inside the branch\'s cloned repo, not the bare sandbox root', async () => {
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      expect(openShell).toHaveBeenCalledWith(expect.objectContaining({ cwd: BRANCH_REPO_PATH }));
    });

    it('given a claude agent terminal, should launch claude instead of pagespace-cli', async () => {
      checkAuth = vi.fn().mockResolvedValue(makeAuthSuccess({ command: 'claude', args: ['--dangerously-skip-permissions'] })) as unknown as ReturnType<typeof vi.fn> &
        AgentTerminalCheckAuthFn;
      const { onConnect } = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
      await onConnect(validPayload);

      expect(openShell).toHaveBeenCalledWith(expect.objectContaining({ command: 'claude', args: ['--dangerously-skip-permissions'] }));
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
});
