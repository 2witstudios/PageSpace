import type { TerminalSessionMap, TerminalSession } from './terminal-session-map';
import { DETACHED_IDLE_MS } from './terminal-session-map';
import type { OpenPtyShellArgs, PtyShell } from './sprites-shell';
import type { SpriteInstanceLike } from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import { validateAgentTerminalConnectPayload, clampTerminalDimensions } from './validation';
import { loggers } from '@pagespace/lib/logging/logger-config';

/**
 * Realtime PTY bridge for a named, pluggable-agent-typed terminal running
 * inside a branch's Sprite (Terminal Epic 2, Runtime tier) — the SAME
 * connect/input/resize/disconnect life-cycle `terminal-handler.ts` drives for
 * a human Terminal page, generalized so several of these can run
 * concurrently on ONE Sprite (keyed by `sessionKey`, one per (branch, name))
 * and so a fresh session launches the resolved `AgentLaunchSpec.command`
 * instead of always `bash` (see `sprites-shell.ts`'s `openPtyShell`).
 *
 * Continuity across a realtime-process restart works the same way a human
 * terminal's does (rediscover the live Sprite session), but because a Sprite
 * can now host MULTIPLE tty sessions at once, "any tty session" is no longer
 * unambiguous — so this bridge persists the Sprite's own exec-session id back
 * to `machine_agent_terminals.streamSessionId` (via `persistStreamSessionId`)
 * the first time it discovers one, and `checkAuth` hands that id back on the
 * next connect so THIS specific session is reattached, not just any one.
 */

export type AgentTerminalCheckAuthResult =
  | {
      ok: true;
      agentTerminalId: string;
      sandboxId: string;
      sessionKey: string;
      sprite: SpriteInstanceLike;
      releaseSlot: () => void;
      command: string;
      args: string[];
      /** The Sprite exec-session id this agent terminal was last known to run under, if any. */
      streamSessionId: string | null;
    }
  | { ok: false; reason: string };

export type AgentTerminalCheckAuthFn = (args: {
  userId: string;
  terminalId: string;
  projectName: string;
  branchName: string;
  name: string;
}) => Promise<AgentTerminalCheckAuthResult>;

export type OpenShellFn = (args: OpenPtyShellArgs) => PtyShell;

export type SocketLike = {
  id: string;
  data: { user?: { id: string } };
  emit(event: string, payload?: unknown): void;
};

export type AgentTerminalHandlerDeps = {
  sessionMap: TerminalSessionMap;
  openShell: OpenShellFn;
  checkAuth: AgentTerminalCheckAuthFn;
  socket: SocketLike;
  /** Best-effort: persists the Sprite session id this agent terminal is now known to run under, so a later reconnect (even after a realtime-process restart) reattaches to THIS session rather than creating a duplicate. */
  persistStreamSessionId: (args: { agentTerminalId: string; sessionId: string }) => Promise<void>;
};

export type AgentTerminalHandlers = {
  onConnect(payload: unknown): Promise<void>;
  onInput(payload: unknown): void;
  onResize(payload: unknown): void;
  onDisconnect(): void;
};

export const MAX_INPUT_BYTES = 4096;

/** Discover the NEWLY created session's id by diffing the Sprite's session list against a snapshot taken before it was launched. Best-effort — an ambiguous or failed lookup just means the next reconnect falls back to a fresh session, exactly like a vanished session already does. */
async function discoverNewSessionId(sprite: SpriteInstanceLike, before: { id: string }[]): Promise<string | undefined> {
  try {
    const beforeIds = new Set(before.map((s) => s.id));
    const after = await sprite.listSessions();
    return after.find((s) => s.tty && !beforeIds.has(s.id))?.id;
  } catch {
    return undefined;
  }
}

export function buildAgentTerminalHandlers({
  sessionMap,
  openShell,
  checkAuth,
  socket,
  persistStreamSessionId,
}: AgentTerminalHandlerDeps): AgentTerminalHandlers {
  return {
    async onConnect(payload: unknown) {
      const validation = validateAgentTerminalConnectPayload(payload);
      if (!validation.ok) {
        socket.emit('agent-terminal:error', { message: validation.error });
        return;
      }
      const { terminalId, projectName, branchName, name, cols, rows } = validation.value;
      const { cols: clampedCols, rows: clampedRows } = clampTerminalDimensions({ cols, rows });

      const userId = socket.data.user?.id ?? '';
      const authResult = await checkAuth({ userId, terminalId, projectName, branchName, name });
      if (!authResult.ok) {
        socket.emit('agent-terminal:error', { message: `Agent terminal access denied: ${authResult.reason}` });
        return;
      }

      const { sessionKey } = authResult;

      const existingSession = sessionMap.getByKey(sessionKey);
      if (existingSession) {
        if (existingSession.idleTimer !== undefined) {
          clearTimeout(existingSession.idleTimer);
          existingSession.idleTimer = undefined;
        }
        existingSession.outputFn = (data) => socket.emit('agent-terminal:output', { data });
        existingSession.closedFn = (exitCode) => socket.emit('agent-terminal:closed', { exitCode });
        sessionMap.reattach(sessionKey, socket.id);
        authResult.releaseSlot();
        socket.emit('agent-terminal:ready', { scrollback: existingSession.scrollback.join('') });
        return;
      }

      const { sandboxId, sprite } = authResult;

      let sessionsBeforeLaunch: { id: string }[] = [];
      if (authResult.streamSessionId === null) {
        try {
          sessionsBeforeLaunch = await sprite.listSessions();
        } catch {
          sessionsBeforeLaunch = [];
        }
      }

      const session: TerminalSession = {
        command: null as unknown as PtyShell,
        sandboxId,
        sessionKey,
        sessionId: authResult.streamSessionId ?? undefined,
        releaseSlot: authResult.releaseSlot,
        outputFn: (data) => socket.emit('agent-terminal:output', { data }),
        closedFn: (exitCode) => socket.emit('agent-terminal:closed', { exitCode }),
        scrollback: [],
        scrollbackBytes: 0,
        reAuthInterval: undefined,
        idleTimer: undefined,
      };

      let shell: PtyShell;
      try {
        shell = openShell({
          sprite,
          cols: clampedCols,
          rows: clampedRows,
          sessionId: authResult.streamSessionId ?? undefined,
          command: authResult.command,
          args: authResult.args,
          onOutput: (data) => {
            session.scrollback.push(data);
            session.outputFn(data);
          },
          onExit: (exitCode) => {
            if (session.reAuthInterval !== undefined) clearInterval(session.reAuthInterval);
            if (session.idleTimer !== undefined) clearTimeout(session.idleTimer);
            session.releaseSlot();
            loggers.realtime.info('Agent terminal session closed', { exitCode, sandboxId, sessionKey });
            session.closedFn(exitCode);
            sessionMap.deleteByKey(sessionKey);
          },
        });
      } catch {
        authResult.releaseSlot();
        socket.emit('agent-terminal:error', { message: 'Failed to open agent terminal session' });
        return;
      }

      session.command = shell;
      sessionMap.setNew(sessionKey, socket.id, session);

      if (authResult.streamSessionId === null) {
        void discoverNewSessionId(sprite, sessionsBeforeLaunch).then((sessionId) => {
          if (sessionId === undefined) return;
          session.sessionId = sessionId;
          void persistStreamSessionId({ agentTerminalId: authResult.agentTerminalId, sessionId }).catch((error) => {
            loggers.realtime.error('Failed to persist agent terminal session id', error instanceof Error ? error : new Error(String(error)), {
              sessionKey,
            });
          });
        });
      }

      socket.emit('agent-terminal:ready', {});
    },

    onInput(payload: unknown) {
      const session = sessionMap.getBySocket(socket.id);
      if (!session) return;
      const p = payload as { data?: string };
      if (typeof p?.data === 'string' && p.data.length <= MAX_INPUT_BYTES) {
        session.command.write(p.data);
      }
    },

    onResize(payload: unknown) {
      const session = sessionMap.getBySocket(socket.id);
      if (!session) return;
      const p = payload as { cols?: number; rows?: number };
      if (typeof p?.cols === 'number' && typeof p?.rows === 'number' && Number.isFinite(p.cols) && Number.isFinite(p.rows)) {
        const { cols, rows } = clampTerminalDimensions({ cols: p.cols, rows: p.rows });
        session.command.resize(cols, rows);
      }
    },

    onDisconnect() {
      const session = sessionMap.getBySocket(socket.id);
      if (!session) return;
      const { sessionKey } = session;
      session.outputFn = () => {};
      session.closedFn = () => {};
      sessionMap.detach(socket.id);
      session.idleTimer = setTimeout(() => {
        if (session.reAuthInterval !== undefined) clearInterval(session.reAuthInterval);
        session.releaseSlot();
        session.command.kill();
        sessionMap.deleteByKey(sessionKey);
        loggers.realtime.info('Agent terminal session reaped (idle)', { sessionKey, sandboxId: session.sandboxId });
      }, DETACHED_IDLE_MS);
    },
  };
}
