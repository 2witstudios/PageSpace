import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildTerminalHandlers, MAX_INPUT_BYTES } from '../terminal-handler';
import { createTerminalSessionMap, DETACHED_IDLE_MS } from '../terminal-session-map';
import type { CheckAuthFn, OpenShellFn, SocketLike } from '../terminal-handler';
import type { PtyShell } from '../sprites-shell';

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

function makeAuthSuccess(sessionKey = 'key1', sessions: Array<{ id: string; command: string; isActive: boolean; tty: boolean }> = []) {
  return { ok: true as const, sandboxId: 'sbx1', sessionKey, sprite: makeSprite(sessions), releaseSlot: vi.fn() };
}

const validPayload = { pageId: 'page1', cols: 80, rows: 24 };

describe('buildTerminalHandlers', () => {
  let sessionMap: ReturnType<typeof createTerminalSessionMap>;
  let shell: ReturnType<typeof makeShell>;
  let openShell: ReturnType<typeof vi.fn> & OpenShellFn;
  let checkAuth: ReturnType<typeof vi.fn> & CheckAuthFn;
  let socket: ReturnType<typeof makeSocket>;

  beforeEach(() => {
    vi.useFakeTimers();
    sessionMap = createTerminalSessionMap();
    shell = makeShell();
    openShell = vi.fn().mockReturnValue(shell) as unknown as ReturnType<typeof vi.fn> & OpenShellFn;
    checkAuth = vi.fn().mockResolvedValue(makeAuthSuccess()) as unknown as ReturnType<typeof vi.fn> & CheckAuthFn;
    socket = makeSocket();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('onConnect', () => {
    it('given valid payload and auth succeeds, should call openShell and emit terminal:ready', async () => {
      const { onConnect } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      await onConnect(validPayload);

      expect(openShell).toHaveBeenCalledWith(expect.objectContaining({ cols: 80, rows: 24 }));
      expect(socket.emit).toHaveBeenCalledWith('terminal:ready', {});
    });

    it('given valid payload and auth succeeds, should store session in sessionMap', async () => {
      const { onConnect } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      await onConnect(validPayload);

      expect(sessionMap.getBySocket('sock1')).toBeDefined();
      expect(sessionMap.getByKey('key1')).toBeDefined();
    });

    it('given auth fails, should emit terminal:error and not store session', async () => {
      checkAuth = vi.fn().mockResolvedValue({ ok: false, reason: 'not_admin' }) as unknown as ReturnType<typeof vi.fn> & CheckAuthFn;
      const { onConnect } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      await onConnect(validPayload);

      expect(socket.emit).toHaveBeenCalledWith('terminal:error', expect.objectContaining({ message: expect.any(String) }));
      expect(sessionMap.getBySocket('sock1')).toBeUndefined();
      expect(openShell).not.toHaveBeenCalled();
    });

    it('given invalid payload (missing pageId), should emit terminal:error', async () => {
      const { onConnect } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      await onConnect({ cols: 80, rows: 24 });

      expect(socket.emit).toHaveBeenCalledWith('terminal:error', expect.objectContaining({ message: expect.any(String) }));
      expect(checkAuth).not.toHaveBeenCalled();
    });

    it('given openShell throws, should emit terminal:error and not store session', async () => {
      openShell = vi.fn().mockImplementation(() => { throw new Error('sprite unreachable'); }) as unknown as ReturnType<typeof vi.fn> & OpenShellFn;
      const { onConnect } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      await onConnect(validPayload);

      expect(socket.emit).toHaveBeenCalledWith('terminal:error', expect.objectContaining({ message: expect.any(String) }));
      expect(sessionMap.getBySocket('sock1')).toBeUndefined();
    });

    it('given openShell throws, should release the concurrency slot', async () => {
      const auth = makeAuthSuccess();
      checkAuth.mockResolvedValue(auth);
      openShell = vi.fn().mockImplementation(() => { throw new Error('sprite unreachable'); }) as unknown as ReturnType<typeof vi.fn> & OpenShellFn;
      const { onConnect } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      await onConnect(validPayload);

      expect(auth.releaseSlot).toHaveBeenCalled();
    });

    it('given a successful connect, should set up a re-auth interval on the session', async () => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const { onConnect } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      await onConnect(validPayload);

      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
      const session = sessionMap.getByKey('key1');
      expect(session?.reAuthInterval).toBeDefined();
    });

    it('given re-auth fires and checkAuth still succeeds, should not kill the shell', async () => {
      const { onConnect } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      await onConnect(validPayload);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(shell.kill).not.toHaveBeenCalled();
      expect(sessionMap.getByKey('key1')).toBeDefined();
    });

    it('given re-auth fires and checkAuth now fails, should kill shell, remove session, and emit terminal:closed with exitCode -2', async () => {
      const { onConnect } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      await onConnect(validPayload);

      checkAuth.mockResolvedValue({ ok: false, reason: 'permission_revoked' });
      await vi.advanceTimersByTimeAsync(60_000);

      expect(shell.kill).toHaveBeenCalledWith();
      expect(sessionMap.getByKey('key1')).toBeUndefined();
      expect(socket.emit).toHaveBeenCalledWith('terminal:closed', { exitCode: -2 });
    });

    it('given a live tmux session already on the Sprite (e.g. after a realtime restart), should reattach to it via listSessions', async () => {
      const auth = makeAuthSuccess('key1', [{ id: 'sess-9', command: 'bash', isActive: true, tty: true }]);
      checkAuth.mockResolvedValue(auth);
      const { onConnect } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      await onConnect(validPayload);

      expect(auth.sprite.listSessions).toHaveBeenCalled();
      expect(openShell).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-9' }));
      expect(sessionMap.getByKey('key1')?.sessionId).toBe('sess-9');
    });

    it('given a detached TTY shell reporting isActive:false, should still discover and reattach to it', async () => {
      // The API's is_active semantics are undocumented; a running-but-detached
      // shell may report false. Discovery must match on tty, not isActive.
      const auth = makeAuthSuccess('key1', [{ id: 'sess-detached', command: 'bash', isActive: false, tty: true }]);
      checkAuth.mockResolvedValue(auth);
      const { onConnect } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      await onConnect(validPayload);

      expect(openShell).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-detached' }));
    });

    it('given only a non-TTY session on the Sprite, should NOT reattach (opens a fresh shell)', async () => {
      const auth = makeAuthSuccess('key1', [{ id: 'sess-batch', command: 'npm test', isActive: true, tty: false }]);
      checkAuth.mockResolvedValue(auth);
      const { onConnect } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      await onConnect(validPayload);

      expect(openShell).toHaveBeenCalledWith(expect.objectContaining({ sessionId: undefined }));
    });

    it('given no live session on the Sprite, should open a fresh shell with no sessionId', async () => {
      const { onConnect } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      await onConnect(validPayload);

      expect(openShell).toHaveBeenCalledWith(expect.objectContaining({ sessionId: undefined }));
    });

    it('given an existing live session for the same pageId, should reattach rather than spawn a new shell', async () => {
      // First connect from sock1
      const { onConnect: connect1 } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      await connect1(validPayload);
      expect(openShell).toHaveBeenCalledTimes(1);

      // Second connect from a different socket (e.g., page reload) with same sessionKey
      const socket2 = makeSocket('sock2');
      const auth2 = makeAuthSuccess('key1'); // same sessionKey → same page
      checkAuth.mockResolvedValue(auth2);
      const { onConnect: connect2 } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket: socket2 });
      await connect2(validPayload);

      // Shell should not be re-spawned — reattach path
      expect(openShell).toHaveBeenCalledTimes(1);
      // The extra concurrency slot from re-auth should be released
      expect(auth2.releaseSlot).toHaveBeenCalled();
      // terminal:ready is emitted with a scrollback field
      expect(socket2.emit).toHaveBeenCalledWith('terminal:ready', expect.objectContaining({ scrollback: expect.any(String) }));
      // New socket is now routed to the session
      expect(sessionMap.getBySocket('sock2')).toBeDefined();
    });

    it('given reattach, output is routed to the new socket, not the old one', async () => {
      // First connect
      const { onConnect: connect1 } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      await connect1(validPayload);

      // Get the onOutput callback that was passed to openShell
      const onOutputArg = openShell.mock.calls[0][0].onOutput as (data: string) => void;

      // Reattach with a second socket
      const socket2 = makeSocket('sock2');
      checkAuth.mockResolvedValue(makeAuthSuccess('key1'));
      const { onConnect: connect2 } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket: socket2 });
      await connect2(validPayload);

      // Now fire output — should go to socket2, not socket1
      onOutputArg('hello');
      expect(socket2.emit).toHaveBeenCalledWith('terminal:output', { data: 'hello' });
      expect(socket.emit).not.toHaveBeenCalledWith('terminal:output', { data: 'hello' });
    });
  });

  describe('onInput', () => {
    it('given a connected session, should call shell.write with the data', async () => {
      const { onConnect, onInput } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      await onConnect(validPayload);

      onInput({ data: 'ls\n' });

      expect(shell.write).toHaveBeenCalledWith('ls\n');
    });

    it('given no active session, should be a silent no-op', () => {
      const { onInput } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      expect(() => onInput({ data: 'ls\n' })).not.toThrow();
    });

    it('given data exactly at MAX_INPUT_BYTES, should call shell.write', async () => {
      const { onConnect, onInput } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      await onConnect(validPayload);

      const atLimit = 'a'.repeat(MAX_INPUT_BYTES);
      onInput({ data: atLimit });

      expect(shell.write).toHaveBeenCalledWith(atLimit);
    });

    it('given data exceeding MAX_INPUT_BYTES, should not call shell.write', async () => {
      const { onConnect, onInput } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      await onConnect(validPayload);

      const overLimit = 'a'.repeat(MAX_INPUT_BYTES + 1);
      onInput({ data: overLimit });

      expect(shell.write).not.toHaveBeenCalled();
    });
  });

  describe('onResize', () => {
    it('given a connected session, should call shell.resize with cols and rows', async () => {
      const { onConnect, onResize } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      await onConnect(validPayload);

      onResize({ cols: 120, rows: 40 });

      expect(shell.resize).toHaveBeenCalledWith(120, 40);
    });

    it('given no active session, should be a silent no-op', () => {
      const { onResize } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      expect(() => onResize({ cols: 120, rows: 40 })).not.toThrow();
    });

    it('given NaN cols, should be a no-op', async () => {
      const { onConnect, onResize } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      await onConnect(validPayload);

      onResize({ cols: NaN, rows: 40 });

      expect(shell.resize).not.toHaveBeenCalled();
    });

    it('given oversized cols, should clamp to MAX_COLS', async () => {
      const { onConnect, onResize } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      await onConnect(validPayload);

      onResize({ cols: 9999, rows: 40 });

      expect(shell.resize).toHaveBeenCalledWith(500, 40);
    });
  });

  describe('onDisconnect', () => {
    it('given a connected session, should detach the socket but keep the shell alive', async () => {
      const auth = makeAuthSuccess();
      checkAuth.mockResolvedValue(auth);
      const { onConnect, onDisconnect } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      await onConnect(validPayload);

      onDisconnect();

      expect(shell.kill).not.toHaveBeenCalled();
      expect(auth.releaseSlot).not.toHaveBeenCalled();
      expect(sessionMap.getBySocket('sock1')).toBeUndefined();
      expect(sessionMap.getByKey('key1')).toBeDefined();
    });

    it('given a connected session, should kill the shell and release the slot after the idle timeout', async () => {
      const auth = makeAuthSuccess();
      checkAuth.mockResolvedValue(auth);
      const { onConnect, onDisconnect } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      await onConnect(validPayload);

      onDisconnect();
      await vi.advanceTimersByTimeAsync(DETACHED_IDLE_MS);

      expect(shell.kill).toHaveBeenCalledWith();
      expect(auth.releaseSlot).toHaveBeenCalled();
      expect(sessionMap.getByKey('key1')).toBeUndefined();
    });

    it('given a connected session, should NOT clear the re-auth interval on disconnect (keeps running for detached shell)', async () => {
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
      const { onConnect, onDisconnect } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      await onConnect(validPayload);

      const session = sessionMap.getByKey('key1');
      const storedInterval = session?.reAuthInterval;

      onDisconnect();

      expect(clearIntervalSpy).not.toHaveBeenCalledWith(storedInterval);
    });

    it('given no active session, should be a silent no-op', () => {
      const { onDisconnect } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      expect(() => onDisconnect()).not.toThrow();
    });

    it('given a shell that exits while the session is detached, should clean up immediately and cancel the idle timer', async () => {
      const auth = makeAuthSuccess();
      checkAuth.mockResolvedValue(auth);
      const { onConnect, onDisconnect } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      await onConnect(validPayload);

      // Get the onExit callback that was registered with openShell
      const onExitArg = openShell.mock.calls[0][0].onExit as (exitCode: number) => void;

      onDisconnect();
      // Idle timer is now running

      // Shell exits while detached (e.g., the user's script finished)
      onExitArg(0);

      // Session should be cleaned up immediately
      expect(sessionMap.getByKey('key1')).toBeUndefined();
      expect(auth.releaseSlot).toHaveBeenCalledTimes(1);
      // kill() should NOT be called — the shell already exited naturally
      expect(shell.kill).not.toHaveBeenCalled();

      // Advance past the idle timeout — idle timer was cancelled by onExit, so no second releaseSlot
      await vi.advanceTimersByTimeAsync(DETACHED_IDLE_MS);
      expect(auth.releaseSlot).toHaveBeenCalledTimes(1);
    });

    it('given a reconnect before the idle timer fires, should cancel the timer and not kill the shell', async () => {
      const auth = makeAuthSuccess();
      checkAuth.mockResolvedValue(auth);
      const { onConnect, onDisconnect } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      await onConnect(validPayload);

      onDisconnect();
      // Advance partway through idle timeout (but not all the way)
      await vi.advanceTimersByTimeAsync(DETACHED_IDLE_MS / 2);

      // Reconnect from a new socket
      const socket2 = makeSocket('sock2');
      const auth2 = makeAuthSuccess('key1');
      checkAuth.mockResolvedValue(auth2);
      const { onConnect: connect2 } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket: socket2 });
      await connect2(validPayload);

      // Advance past original idle timeout — shell should still be alive
      await vi.advanceTimersByTimeAsync(DETACHED_IDLE_MS);

      expect(shell.kill).not.toHaveBeenCalled();
      expect(sessionMap.getByKey('key1')).toBeDefined();
    });
  });
});
