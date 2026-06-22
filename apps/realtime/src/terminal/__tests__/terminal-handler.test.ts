import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildTerminalHandlers } from '../terminal-handler';
import { createTerminalSessionMap } from '../terminal-session-map';
import type { CheckAuthFn, OpenShellFn, SocketLike } from '../terminal-handler';
import type { PtyShell } from '../sprites-shell';

function makeSocket(userId = 'user1'): SocketLike & { emit: ReturnType<typeof vi.fn> } {
  return { id: 'sock1', data: { user: { id: userId } }, emit: vi.fn() };
}

function makeShell(): PtyShell & { write: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> } {
  return { write: vi.fn(), resize: vi.fn(), kill: vi.fn() };
}

function makeSprite() {
  return { name: 'sbx1', spawn: vi.fn(), filesystem: vi.fn(), updateNetworkPolicy: vi.fn(), destroy: vi.fn() };
}

const validPayload = { pageId: 'page1', cols: 80, rows: 24 };

describe('buildTerminalHandlers', () => {
  let sessionMap: ReturnType<typeof createTerminalSessionMap>;
  let shell: ReturnType<typeof makeShell>;
  let openShell: ReturnType<typeof vi.fn> & OpenShellFn;
  let checkAuth: ReturnType<typeof vi.fn> & CheckAuthFn;
  let socket: ReturnType<typeof makeSocket>;

  beforeEach(() => {
    sessionMap = createTerminalSessionMap();
    shell = makeShell();
    openShell = vi.fn().mockReturnValue(shell) as unknown as ReturnType<typeof vi.fn> & OpenShellFn;
    checkAuth = vi.fn().mockResolvedValue({ ok: true, sandboxId: 'sbx1', sprite: makeSprite() }) as unknown as ReturnType<typeof vi.fn> & CheckAuthFn;
    socket = makeSocket();
  });

  describe('onConnect', () => {
    it('given valid payload and auth succeeds, should call openShell and emit terminal:ready', async () => {
      const { onConnect } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      await onConnect(validPayload);

      expect(openShell).toHaveBeenCalledWith(expect.objectContaining({ cols: 80, rows: 24 }));
      expect(socket.emit).toHaveBeenCalledWith('terminal:ready');
    });

    it('given valid payload and auth succeeds, should store session in sessionMap', async () => {
      const { onConnect } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      await onConnect(validPayload);

      expect(sessionMap.has('sock1')).toBe(true);
    });

    it('given auth fails with not_admin, should emit terminal:error and not store session', async () => {
      checkAuth = vi.fn().mockResolvedValue({ ok: false, reason: 'not_admin' }) as unknown as ReturnType<typeof vi.fn> & CheckAuthFn;
      const { onConnect } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      await onConnect(validPayload);

      expect(socket.emit).toHaveBeenCalledWith('terminal:error', expect.objectContaining({ message: expect.any(String) }));
      expect(sessionMap.has('sock1')).toBe(false);
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
      expect(sessionMap.has('sock1')).toBe(false);
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
  });

  describe('onDisconnect', () => {
    it('given a connected session, should kill the shell and remove from sessionMap', async () => {
      const { onConnect, onDisconnect } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      await onConnect(validPayload);

      onDisconnect();

      expect(shell.kill).toHaveBeenCalled();
      expect(sessionMap.has('sock1')).toBe(false);
    });

    it('given no active session, should be a silent no-op', () => {
      const { onDisconnect } = buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket });
      expect(() => onDisconnect()).not.toThrow();
    });
  });
});
