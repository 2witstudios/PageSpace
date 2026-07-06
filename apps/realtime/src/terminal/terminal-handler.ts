import type { TerminalSessionMap, TerminalSession } from './terminal-session-map';
import { MAX_SCROLLBACK_BYTES, DETACHED_IDLE_MS } from './terminal-session-map';
import type { OpenPtyShellArgs, PtyShell } from './sprites-shell';
import { pickShellSession } from './sprites-shell';
import type { SpriteInstanceLike } from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import type { SandboxBillingDeps } from '@pagespace/lib/services/sandbox/tool-runners';
import { validateTerminalConnectPayload, clampTerminalDimensions } from './validation';
import { loggers } from '@pagespace/lib/logging/logger-config';

export const MAX_INPUT_BYTES = 4096;

export type CheckAuthResult =
  | { ok: true; sandboxId: string; sessionKey: string; sprite: SpriteInstanceLike; releaseSlot: () => void; payerId: string }
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
  /**
   * Optional metering seam (Terminal Epic 3): meters this PTY session's
   * active-runtime cost against the machine's payer. Omitted -> unmetered (no
   * hold, no charge) — mirrors the same optional seam in tool-runners.ts.
   */
  billing?: SandboxBillingDeps;
};

export type TerminalHandlers = {
  onConnect(payload: unknown): Promise<void>;
  onInput(payload: unknown): void;
  onResize(payload: unknown): void;
  onDisconnect(): void;
};

export function appendScrollback(session: Pick<TerminalSession, 'scrollback' | 'scrollbackBytes'>, data: string): void {
  const bytes = Buffer.byteLength(data, 'utf8');
  session.scrollback.push(data);
  session.scrollbackBytes += bytes;
  while (session.scrollbackBytes > MAX_SCROLLBACK_BYTES && session.scrollback.length > 0) {
    const removed = session.scrollback.shift()!;
    session.scrollbackBytes -= Buffer.byteLength(removed, 'utf8');
  }
}

/**
 * Ends a metered session: settles its hold to the real active-window cost
 * (wall-clock from `connectedAt` to now) BEFORE removing it from the map, so a
 * near-simultaneous reconnect can never observe a stale, already-billed
 * session. Best-effort and fire-and-forget — a billing failure must never
 * block session cleanup (mirrors every other billing seam's swallow-and-log
 * behavior). No-op billing fields (unset `billing`, or no `holdId` because the
 * session was never gated) mean nothing to settle.
 */
function endTerminalSession(
  billing: SandboxBillingDeps | undefined,
  sessionMap: TerminalSessionMap,
  session: TerminalSession,
  sessionKey: string,
): void {
  sessionMap.deleteByKey(sessionKey);
  if (billing && session.holdId && session.payerId && session.connectedAt !== undefined) {
    const activeSeconds = Math.max(0, (Date.now() - session.connectedAt) / 1000);
    void billing
      .trackUsage({ payerId: session.payerId, holdId: session.holdId, activeSeconds, pageId: session.pageId })
      .catch((error) => {
        loggers.realtime.error('Terminal session billing settle failed', error instanceof Error ? error : new Error(String(error)), {
          sessionKey,
        });
      });
  }
}

export function buildTerminalHandlers({ sessionMap, openShell, checkAuth, socket, billing }: TerminalHandlerDeps): TerminalHandlers {
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

      const { sessionKey } = authResult;

      // Reattach to a live session that survived a previous navigation away.
      const existingSession = sessionMap.getByKey(sessionKey);
      if (existingSession) {
        if (existingSession.idleTimer !== undefined) {
          clearTimeout(existingSession.idleTimer);
          existingSession.idleTimer = undefined;
        }
        existingSession.outputFn = (data) => socket.emit('terminal:output', { data });
        existingSession.closedFn = (exitCode) => socket.emit('terminal:closed', { exitCode });
        sessionMap.reattach(sessionKey, socket.id);
        // Release the extra concurrency slot acquired by the re-auth check above.
        authResult.releaseSlot();
        socket.emit('terminal:ready', { scrollback: existingSession.scrollback.join('') });
        return;
      }

      // No in-memory session in THIS process. The TTY shell may still be alive on
      // the Sprite (max_run_after_disconnect:0 outlives both socket drops and
      // realtime restarts), so discover it and reattach — the Sprite is the source
      // of truth. Falls back to a fresh shell on any lookup failure or when none
      // is found.
      const { sandboxId } = authResult;

      let existingSessionId: string | undefined;
      try {
        existingSessionId = pickShellSession(await authResult.sprite.listSessions())?.id;
      } catch {
        existingSessionId = undefined;
      }

      // Terminal Epic 3 metering: place a flat-estimate hold for this NEW
      // machine-active window BEFORE opening the shell (hibernated/idle time
      // between sessions is free). Settled at session end — see
      // endTerminalSession. Deliberately NOT in checkAuth/makeTerminalCheckAuth:
      // that also runs on every reattach and periodic re-auth tick below, which
      // must never place a second hold for the same still-open session.
      let holdId: string | undefined;
      if (billing) {
        const gateResult = await billing.gate({ payerId: authResult.payerId });
        if (!gateResult.allowed) {
          authResult.releaseSlot();
          socket.emit('terminal:error', { message: 'Insufficient credits to open a terminal session.' });
          return;
        }
        holdId = gateResult.holdId;
      }
      const connectedAt = Date.now();

      const session: TerminalSession = {
        command: null as unknown as PtyShell, // assigned below before any async
        sandboxId,
        sessionKey,
        sessionId: existingSessionId,
        releaseSlot: authResult.releaseSlot,
        payerId: authResult.payerId,
        holdId,
        connectedAt,
        pageId,
        outputFn: (data) => socket.emit('terminal:output', { data }),
        closedFn: (exitCode) => socket.emit('terminal:closed', { exitCode }),
        scrollback: [],
        scrollbackBytes: 0,
        reAuthInterval: undefined,
        idleTimer: undefined,
      };

      let shell: PtyShell;
      try {
        shell = openShell({
          sprite: authResult.sprite,
          cols: clampedCols,
          rows: clampedRows,
          sessionId: existingSessionId,
          onOutput: (data) => {
            appendScrollback(session, data);
            session.outputFn(data);
          },
          onExit: (exitCode) => {
            if (session.reAuthInterval !== undefined) clearInterval(session.reAuthInterval);
            if (session.idleTimer !== undefined) clearTimeout(session.idleTimer);
            session.releaseSlot();
            loggers.realtime.info('Terminal session closed', { exitCode, sandboxId, sessionKey });
            session.closedFn(exitCode);
            endTerminalSession(billing, sessionMap, session, sessionKey);
          },
        });
      } catch {
        authResult.releaseSlot();
        if (holdId) void billing?.releaseHold(holdId).catch(() => {});
        socket.emit('terminal:error', { message: 'Failed to open shell session' });
        return;
      }

      session.command = shell;
      sessionMap.setNew(sessionKey, socket.id, session);

      // Periodically re-check authorization while the session is alive.
      // Routes closed notification through closedFn so it reaches the current socket.
      const reAuthInterval = setInterval(async () => {
        const liveSession = sessionMap.getByKey(sessionKey);
        if (!liveSession) { clearInterval(reAuthInterval); return; }
        const result = await checkAuth({ userId, pageId });
        if (!result.ok) {
          clearInterval(reAuthInterval);
          if (liveSession.idleTimer !== undefined) clearTimeout(liveSession.idleTimer);
          liveSession.releaseSlot();
          liveSession.command.kill();
          endTerminalSession(billing, sessionMap, liveSession, sessionKey);
          liveSession.closedFn(-2);
        } else {
          result.releaseSlot();
        }
      }, 60_000);

      session.reAuthInterval = reAuthInterval;

      socket.emit('terminal:ready', {});
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
      if (typeof p?.cols === 'number' && typeof p?.rows === 'number' &&
          Number.isFinite(p.cols) && Number.isFinite(p.rows)) {
        const { cols, rows } = clampTerminalDimensions({ cols: p.cols, rows: p.rows });
        session.command.resize(cols, rows);
      }
    },

    onDisconnect() {
      const session = sessionMap.getBySocket(socket.id);
      if (!session) return;
      const { sessionKey } = session;
      // Silence output and detach from socket routing — shell keeps running.
      session.outputFn = () => {};
      session.closedFn = () => {};
      sessionMap.detach(socket.id);
      // Kill and release resources after idle timeout.
      session.idleTimer = setTimeout(() => {
        if (session.reAuthInterval !== undefined) clearInterval(session.reAuthInterval);
        session.releaseSlot();
        session.command.kill();
        endTerminalSession(billing, sessionMap, session, sessionKey);
        loggers.realtime.info('Terminal session reaped (idle)', { sessionKey, sandboxId: session.sandboxId });
      }, DETACHED_IDLE_MS);
    },
  };
}
