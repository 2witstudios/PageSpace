import type { TerminalSessionMap } from './terminal-session-map';
import type { OpenPtyShellArgs, PtyShell } from './sprites-shell';
import type { SpriteInstanceLike } from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import { validateTerminalConnectPayload, clampTerminalDimensions } from './validation';

export const MAX_INPUT_BYTES = 4096;

export type CheckAuthResult =
  | { ok: true; sandboxId: string; sprite: SpriteInstanceLike; releaseSlot: () => void }
  | { ok: false; reason: string };

export type CheckAuthFn = (args: { userId: string; pageId: string }) => Promise<CheckAuthResult>;

export type OpenShellFn = (args: OpenPtyShellArgs) => PtyShell;

export type SocketLike = {
  id: string;
  data: { user?: { id: string } };
  emit(event: string, payload?: unknown): void;
};

export type TerminalHandlerDeps = {
  sessionMap: TerminalSessionMap;
  openShell: OpenShellFn;
  checkAuth: CheckAuthFn;
  socket: SocketLike;
};

export type TerminalHandlers = {
  onConnect(payload: unknown): Promise<void>;
  onInput(payload: unknown): void;
  onResize(payload: unknown): void;
  onDisconnect(): void;
};

export function buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket }: TerminalHandlerDeps): TerminalHandlers {
  return {
    async onConnect(payload: unknown) {
      const validation = validateTerminalConnectPayload(payload);
      if (!validation.ok) {
        socket.emit('terminal:error', { message: validation.error });
        return;
      }
      const { pageId, cols, rows } = validation.value;
      const { cols: clampedCols, rows: clampedRows } = clampTerminalDimensions({ cols, rows });

      const userId = socket.data.user?.id ?? '';
      const authResult = await checkAuth({ userId, pageId });
      if (!authResult.ok) {
        socket.emit('terminal:error', { message:  });
        return;
      }

      // Kill any existing session for this socket (reconnect scenario)
      const existing = sessionMap.get(socket.id);
      if (existing) {
        if (existing.reAuthInterval !== undefined) clearInterval(existing.reAuthInterval);
        existing.releaseSlot();
        existing.command.kill('SIGKILL');
        sessionMap.delete(socket.id);
      }

      let shell: PtyShell;
      try {
        shell = openShell({
          sprite: authResult.sprite,
          cols: clampedCols,
          rows: clampedRows,
          onOutput: (data) => socket.emit('terminal:output', { data }),
          onExit: (exitCode) => {
            const session = sessionMap.get(socket.id);
            if (session?.reAuthInterval !== undefined) clearInterval(session.reAuthInterval);
            session?.releaseSlot();
            socket.emit('terminal:closed', { exitCode });
            sessionMap.delete(socket.id);
          },
        });
      } catch {
        authResult.releaseSlot();
        socket.emit('terminal:error', { message: 'Failed to open shell session' });
        return;
      }

      sessionMap.set(socket.id, { command: shell, sandboxId: authResult.sandboxId, releaseSlot: authResult.releaseSlot });

      // Periodically re-check authorization while the session is alive.
      // If access is revoked, kill the shell and close the terminal.
      const reAuthInterval = setInterval(async () => {
        const liveSession = sessionMap.get(socket.id);
        if (!liveSession) { clearInterval(reAuthInterval); return; }
        const result = await checkAuth({ userId, pageId });
        if (!result.ok) {
          clearInterval(reAuthInterval);
          liveSession.releaseSlot();
          liveSession.command.kill('SIGKILL');
          sessionMap.delete(socket.id);
          socket.emit('terminal:closed', { exitCode: -2 });
        } else {
          // Re-auth check succeeded; release the slot acquired by re-auth (we already hold one).
          result.releaseSlot();
        }
      }, 60_000);

      // Store the interval on the session so onDisconnect can clear it.
      const session = sessionMap.get(socket.id);
      if (session) session.reAuthInterval = reAuthInterval;

      socket.emit('terminal:ready');
    },

    onInput(payload: unknown) {
      const session = sessionMap.get(socket.id);
      if (!session) return;
      const p = payload as { data?: string };
      if (typeof p?.data === 'string' && p.data.length <= MAX_INPUT_BYTES) {
        session.command.write(p.data);
      }
    },

    onResize(payload: unknown) {
      const session = sessionMap.get(socket.id);
      if (!session) return;
      const p = payload as { cols?: number; rows?: number };
      if (typeof p?.cols === 'number' && typeof p?.rows === 'number' &&
          Number.isFinite(p.cols) && Number.isFinite(p.rows)) {
        const { cols, rows } = clampTerminalDimensions({ cols: p.cols, rows: p.rows });
        session.command.resize(cols, rows);
      }
    },

    onDisconnect() {
      const session = sessionMap.get(socket.id);
      if (!session) return;
      if (session.reAuthInterval !== undefined) clearInterval(session.reAuthInterval);
      session.releaseSlot();
      session.command.kill('SIGKILL');
      sessionMap.delete(socket.id);
    },
  };
}
