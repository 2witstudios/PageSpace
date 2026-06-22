import type { TerminalSessionMap } from './terminal-session-map';
import type { OpenPtyShellArgs, PtyShell } from './sprites-shell';
import type { SpriteInstanceLike } from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import { validateTerminalConnectPayload, clampTerminalDimensions } from './validation';

export type CheckAuthResult =
  | { ok: true; sandboxId: string; sprite: SpriteInstanceLike }
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
        socket.emit('terminal:error', { message: `Terminal access denied: ${authResult.reason}` });
        return;
      }

      let shell: PtyShell;
      try {
        shell = openShell({
          sprite: authResult.sprite,
          cols: clampedCols,
          rows: clampedRows,
          onOutput: (data) => socket.emit('terminal:output', { data }),
          onExit: (exitCode) => {
            socket.emit('terminal:closed', { exitCode });
            sessionMap.delete(socket.id);
          },
        });
      } catch {
        socket.emit('terminal:error', { message: 'Failed to open shell session' });
        return;
      }

      sessionMap.set(socket.id, { command: shell, sandboxId: authResult.sandboxId });
      socket.emit('terminal:ready');
    },

    onInput(payload: unknown) {
      const session = sessionMap.get(socket.id);
      if (!session) return;
      const p = payload as { data?: string };
      if (typeof p?.data === 'string') session.command.write(p.data);
    },

    onResize(payload: unknown) {
      const session = sessionMap.get(socket.id);
      if (!session) return;
      const p = payload as { cols?: number; rows?: number };
      if (typeof p?.cols === 'number' && typeof p?.rows === 'number') {
        session.command.resize(p.cols, p.rows);
      }
    },

    onDisconnect() {
      const session = sessionMap.get(socket.id);
      if (!session) return;
      session.command.kill('SIGKILL');
      sessionMap.delete(socket.id);
    },
  };
}
