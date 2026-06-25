import type { PtyShell } from './sprites-shell';

export const MAX_SCROLLBACK_BYTES = 64 * 1024;
export const DETACHED_IDLE_MS = 30 * 60 * 1000;

export type TerminalSession = {
  command: PtyShell;
  sandboxId: string;
  sessionKey: string;
  /** Detachable tmux session id on the Sprite, used to reattach after a WS drop. */
  sessionId?: string;
  reAuthInterval?: ReturnType<typeof setInterval>;
  idleTimer?: ReturnType<typeof setTimeout>;
  releaseSlot(): void;
  outputFn: (data: string) => void;
  closedFn: (exitCode: number) => void;
  scrollback: string[];
  scrollbackBytes: number;
};

export type TerminalSessionMap = {
  getBySocket(socketId: string): TerminalSession | undefined;
  getByKey(sessionKey: string): TerminalSession | undefined;
  setNew(sessionKey: string, socketId: string, session: TerminalSession): void;
  reattach(sessionKey: string, newSocketId: string): void;
  detach(socketId: string): void;
  deleteByKey(sessionKey: string): void;
};

export function createTerminalSessionMap(): TerminalSessionMap {
  const bySocket = new Map<string, string>();        // socketId → sessionKey
  const byKey = new Map<string, TerminalSession>();  // sessionKey → session

  return {
    getBySocket(socketId) {
      const key = bySocket.get(socketId);
      return key !== undefined ? byKey.get(key) : undefined;
    },
    getByKey(sessionKey) {
      return byKey.get(sessionKey);
    },
    setNew(sessionKey, socketId, session) {
      byKey.set(sessionKey, session);
      bySocket.set(socketId, sessionKey);
    },
    reattach(sessionKey, newSocketId) {
      for (const [sid, key] of bySocket) {
        if (key === sessionKey) { bySocket.delete(sid); break; }
      }
      bySocket.set(newSocketId, sessionKey);
    },
    detach(socketId) {
      bySocket.delete(socketId);
    },
    deleteByKey(sessionKey) {
      for (const [sid, key] of bySocket) {
        if (key === sessionKey) { bySocket.delete(sid); break; }
      }
      byKey.delete(sessionKey);
    },
  };
}
