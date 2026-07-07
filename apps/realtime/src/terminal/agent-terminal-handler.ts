import type { TerminalSessionMap, TerminalSession } from './terminal-session-map';
import { DETACHED_IDLE_MS, appendScrollback } from './terminal-session-map';
import type { OpenPtyShellArgs, PtyShell } from './sprites-shell';
import type { SpriteInstanceLike } from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import type { SandboxBillingDeps } from '@pagespace/lib/services/sandbox/tool-runners';
import { validateAgentTerminalConnectPayload, clampTerminalDimensions } from './validation';
import { loggers } from '@pagespace/lib/logging/logger-config';

/**
 * Realtime PTY bridge for a named, pluggable-agent-typed terminal at one of
 * the three universal Terminal scopes (tasks/terminal.md) — machine
 * (a plain shell IS a machine-scope agent terminal of `agentType: 'shell'`,
 * replacing the retired human-only `terminal:*` event family), project (the
 * SAME machine Sprite, different cwd), or branch (its own isolated Sprite).
 * One connect/input/resize/disconnect life-cycle serves all three, keyed by
 * `sessionKey` (one per (scope, name)) so several can run concurrently on one
 * Sprite, and so a fresh session launches the resolved
 * `AgentLaunchSpec.command` (or a per-terminal `command` override) inside the
 * resolved `cwd` instead of always `bash` at the bare sandbox root (see
 * `sprites-shell.ts`'s `openPtyShell`).
 *
 * Continuity across a realtime-process restart works the same way a human
 * terminal's used to (rediscover the live Sprite session), but because a
 * Sprite can now host MULTIPLE tty sessions at once, "any tty session" is no
 * longer unambiguous — so this bridge persists the Sprite's own exec-session
 * id back to `machine_agent_terminals.streamSessionId` (via
 * `persistStreamSessionId`) the first time it discovers one, and `checkAuth`
 * hands that id back on the next connect so THIS specific session is
 * reattached, not just any one.
 *
 * `billing` (Terminal Epic 3) meters this PTY session's active-runtime cost
 * against the machine's payer — the same hold/gate/settle seam the retired
 * human terminal used, now applied uniformly to every agent-terminal
 * connection regardless of scope, since Sprite wall-clock time is equally
 * billable whether a human or a pluggable agent is driving the PTY. Omitted
 * -> unmetered (no hold, no settle).
 */

export type AgentTerminalCheckAuthResult =
  | {
      ok: true;
      agentTerminalId: string;
      sandboxId: string;
      /** The resolved working directory for a FRESH session — machine's SANDBOX_ROOT, a project's clone path, or a branch's repo checkout. */
      cwd: string;
      sessionKey: string;
      sprite: SpriteInstanceLike;
      releaseSlot: () => void;
      /** The agentType's resolved launch command — the literal sentinel `'shell'` when unresolved to an actual shell binary yet (see `resolveAgentTerminalCommand`). */
      command: string;
      args: string[];
      /** A per-terminal program override (PurePoint `AgentEntry.command` parity), or null to use `command`/`args` as-is. */
      commandOverride: string | null;
      /** The Sprite exec-session id this agent terminal was last known to run under, if any. */
      streamSessionId: string | null;
      /** The machine's resolved payer — metering attribution (Terminal Epic 3), present regardless of whether `billing` is wired. */
      payerId: string;
    }
  | { ok: false; reason: string };

export type AgentTerminalCheckAuthFn = (args: {
  userId: string;
  terminalId: string;
  projectName?: string;
  branchName?: string;
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
  /** Terminal Epic 3 metering seam — see module doc. Omitted -> unmetered. */
  billing?: SandboxBillingDeps;
};

export type AgentTerminalHandlers = {
  onConnect(payload: unknown): Promise<void>;
  onInput(payload: unknown): void;
  onResize(payload: unknown): void;
  /** No payload (or no `connectionId` on it) — the real socket disconnected — tears down every connection this socket had open. A payload WITH `connectionId` closes just that one pane, leaving the socket's other connections (other split panes) live. */
  onDisconnect(payload?: unknown): void;
};

/** Extracts the caller-supplied per-pane connection id from an input/resize/disconnect payload, if any — falls back to the socket's own id (this connection's ONLY agent-terminal session) for every caller that predates the splittable-panes UI. */
function readConnectionId(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  const value = (payload as { connectionId?: unknown }).connectionId;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export const MAX_INPUT_BYTES = 4096;

/**
 * How often a live metered session settles its accrued active window mid-flight.
 * Sessions live in an in-memory map, so a realtime restart (every deploy) used to
 * silently lose the WHOLE session's billing; heartbeat settling bounds that loss
 * to one interval. Kept under the credit hold's TTL (15 min) so the window's
 * reservation never expires while its session is still accruing.
 */
export const SETTLE_HEARTBEAT_MS = 10 * 60 * 1000;

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

/**
 * Resolve WHAT to actually exec for a fresh session: a per-terminal `command`
 * override (an arbitrary program string, possibly with shell metacharacters)
 * is wrapped `$SHELL -c '<override>'` rather than naively splitting on
 * whitespace; the `'shell'` sentinel (PurePoint `default_agents()` parity —
 * see `agent-terminal-types.ts`) resolves to the actual interactive shell
 * binary; any other agentType's resolved command/args pass through unchanged.
 */
export function resolveAgentTerminalCommand({
  command,
  args,
  commandOverride,
}: {
  command: string;
  args: string[];
  commandOverride: string | null;
}): { command: string; args: string[] } {
  const shell = process.env.SHELL || 'bash';
  if (commandOverride) return { command: shell, args: ['-c', commandOverride] };
  if (command === 'shell') return { command: shell, args: [] };
  return { command, args };
}

/**
 * Ends a metered session: settles the tail of its active window (wall-clock from
 * `connectedAt` — the connect time, or the last heartbeat rebase — to now)
 * BEFORE removing it from the map, so a near-simultaneous reconnect can never
 * observe a stale, already-billed session. Settle keys on the payer + window
 * start; `holdId` is optional (mirrors tool-runners — a gate that placed no
 * hold still had a real, billable window). Best-effort and fire-and-forget — a
 * billing failure must never block session cleanup.
 */
function endAgentTerminalSession(
  billing: SandboxBillingDeps | undefined,
  sessionMap: TerminalSessionMap,
  session: TerminalSession,
  sessionKey: string,
): void {
  sessionMap.deleteByKey(sessionKey);
  // This is the one funnel every teardown path goes through, so it owns clearing
  // ALL of the session's timers — a caller that forgets one can't leak a firing
  // interval against a dead session.
  if (session.reAuthInterval !== undefined) {
    clearInterval(session.reAuthInterval);
    session.reAuthInterval = undefined;
  }
  if (session.settleInterval !== undefined) {
    clearInterval(session.settleInterval);
    session.settleInterval = undefined;
  }
  if (session.idleTimer !== undefined) {
    clearTimeout(session.idleTimer);
    session.idleTimer = undefined;
  }
  if (billing && session.payerId && session.connectedAt !== undefined) {
    const activeSeconds = Math.max(0, (Date.now() - session.connectedAt) / 1000);
    void billing
      .trackUsage({ payerId: session.payerId, holdId: session.holdId, activeSeconds, pageId: session.pageId })
      .catch((error) => {
        loggers.realtime.error('Agent terminal session billing settle failed', error instanceof Error ? error : new Error(String(error)), {
          sessionKey,
        });
      });
  }
}

/**
 * Forced teardown of a live session (failed re-auth, payer insolvent at a
 * heartbeat): release the concurrency slot, kill the PTY, settle + remove the
 * session (endAgentTerminalSession clears all timers), and notify the viewer.
 */
function teardownAgentTerminalSession(
  billing: SandboxBillingDeps | undefined,
  sessionMap: TerminalSessionMap,
  session: TerminalSession,
  sessionKey: string,
  exitCode: number,
): void {
  session.releaseSlot();
  session.command.kill();
  endAgentTerminalSession(billing, sessionMap, session, sessionKey);
  session.closedFn(exitCode);
}

/**
 * Heartbeat settle for a live metered session: settles the window accrued since
 * `connectedAt` against the current hold, rebases the window start to now, and
 * places a fresh hold for the next interval. The rebase happens SYNCHRONOUSLY
 * before any await so a teardown racing this settle only ever bills the
 * (near-zero) tail, never the same window twice. If the settle FAILS, the
 * rebase is rolled back and the hold kept, so the next heartbeat (or the
 * end-of-session settle) retries the whole window instead of silently losing
 * it — and no fresh hold is stacked on top of the still-live one. No fresh
 * hold is placed if the session ended while the settle was in flight — there
 * would be nobody left to settle or release it.
 *
 * Returns false ONLY on an explicit gate denial after a successful settle
 * (the payer genuinely can't cover the next window) — the caller tears the
 * session down. Infra errors keep the session alive (fail-open): killing a
 * live PTY over a transient billing outage is worse than a delayed settle.
 */
async function settleAccruedWindow(
  billing: SandboxBillingDeps,
  sessionMap: TerminalSessionMap,
  session: TerminalSession,
  sessionKey: string,
): Promise<boolean> {
  if (!session.payerId || session.connectedAt === undefined) return true;
  const payerId = session.payerId;
  const holdId = session.holdId;
  const windowStart = session.connectedAt;
  session.connectedAt = Date.now();
  session.holdId = undefined;
  const activeSeconds = Math.max(0, (session.connectedAt - windowStart) / 1000);
  try {
    await billing.trackUsage({ payerId, holdId, activeSeconds, pageId: session.pageId });
  } catch (error) {
    loggers.realtime.error('Agent terminal heartbeat settle failed', error instanceof Error ? error : new Error(String(error)), {
      sessionKey,
    });
    // Roll the rebase back (if no teardown settled the tail meanwhile) so the
    // unbilled window is retried later against its original, still-live hold.
    if (sessionMap.getByKey(sessionKey) === session) {
      session.connectedAt = windowStart;
      session.holdId = holdId;
    }
    return true;
  }
  if (sessionMap.getByKey(sessionKey) !== session) return true;
  try {
    const gate = await billing.gate({ payerId });
    if (!gate.allowed) return false;
    // Re-check liveness: the session may have ended while the gate ran, and a
    // hold assigned to a dead session would leak until its TTL expiry.
    if (sessionMap.getByKey(sessionKey) !== session) {
      if (gate.holdId) void billing.releaseHold(gate.holdId).catch(() => {});
      return true;
    }
    session.holdId = gate.holdId;
  } catch (error) {
    loggers.realtime.error('Agent terminal heartbeat re-hold failed', error instanceof Error ? error : new Error(String(error)), {
      sessionKey,
    });
  }
  return true;
}

/**
 * Arms the heartbeat for a metered session (see SETTLE_HEARTBEAT_MS). A
 * module-level factory rather than a closure inside onConnect so the
 * long-lived interval callback captures only what it needs — not the whole
 * connect scope (auth result, Sprite handle, session-list snapshots).
 */
function startSettleHeartbeat(
  billing: SandboxBillingDeps,
  sessionMap: TerminalSessionMap,
  session: TerminalSession,
  sessionKey: string,
): ReturnType<typeof setInterval> {
  let settling = false;
  const interval = setInterval(async () => {
    if (sessionMap.getByKey(sessionKey) !== session) { clearInterval(interval); return; }
    if (settling) return;
    settling = true;
    try {
      const solvent = await settleAccruedWindow(billing, sessionMap, session, sessionKey);
      if (!solvent && sessionMap.getByKey(sessionKey) === session) {
        loggers.realtime.info('Agent terminal session ended (payer out of credits at heartbeat)', {
          sessionKey,
          sandboxId: session.sandboxId,
        });
        teardownAgentTerminalSession(billing, sessionMap, session, sessionKey, -2);
      }
    } finally {
      settling = false;
    }
  }, SETTLE_HEARTBEAT_MS);
  return interval;
}

export function buildAgentTerminalHandlers({
  sessionMap,
  openShell,
  checkAuth,
  socket,
  persistStreamSessionId,
  billing,
}: AgentTerminalHandlerDeps): AgentTerminalHandlers {
  /**
   * Every connectionId this SOCKET currently has a live agent-terminal
   * session under. `buildAgentTerminalHandlers` is instantiated once per
   * socket connection (see `apps/realtime/src/index.ts`), so this closure is
   * exactly as socket-scoped as `socket` itself — a real socket disconnect
   * (browser tab closed/reloaded) needs to tear down ALL of them, not just
   * one pane's.
   */
  const activeConnectionIds = new Set<string>();

  function disconnectConnection(connectionId: string) {
    const session = sessionMap.getBySocket(connectionId);
    activeConnectionIds.delete(connectionId);
    if (!session) return;
    const { sessionKey } = session;
    session.outputFn = () => {};
    session.closedFn = () => {};
    sessionMap.detach(connectionId);
    session.idleTimer = setTimeout(() => {
      session.releaseSlot();
      session.command.kill();
      // Clears all of the session's timers (re-auth, settle heartbeat, idle).
      endAgentTerminalSession(billing, sessionMap, session, sessionKey);
      loggers.realtime.info('Agent terminal session reaped (idle)', { sessionKey, sandboxId: session.sandboxId });
    }, DETACHED_IDLE_MS);
  }

  return {
    async onConnect(payload: unknown) {
      const validation = validateAgentTerminalConnectPayload(payload);
      if (!validation.ok) {
        socket.emit('agent-terminal:error', { message: validation.error });
        return;
      }
      const { terminalId, projectName, branchName, name, cols, rows } = validation.value;
      const connectionId = validation.value.connectionId ?? socket.id;
      const { cols: clampedCols, rows: clampedRows } = clampTerminalDimensions({ cols, rows });

      const userId = socket.data.user?.id ?? '';
      const authResult = await checkAuth({ userId, terminalId, projectName, branchName, name });
      if (!authResult.ok) {
        socket.emit('agent-terminal:error', { message: `Agent terminal access denied: ${authResult.reason}`, connectionId });
        return;
      }

      const { sessionKey } = authResult;

      const existingSession = sessionMap.getByKey(sessionKey);
      if (existingSession) {
        if (existingSession.idleTimer !== undefined) {
          clearTimeout(existingSession.idleTimer);
          existingSession.idleTimer = undefined;
        }
        existingSession.outputFn = (data) => socket.emit('agent-terminal:output', { data, connectionId });
        existingSession.closedFn = (exitCode) => socket.emit('agent-terminal:closed', { exitCode, connectionId });
        sessionMap.reattach(sessionKey, connectionId);
        activeConnectionIds.add(connectionId);
        authResult.releaseSlot();
        socket.emit('agent-terminal:ready', { scrollback: existingSession.scrollback.join(''), connectionId });
        return;
      }

      // Terminal Epic 3 metering: place a flat-estimate hold for this NEW
      // machine-active window BEFORE opening the shell (hibernated/idle time
      // between sessions is free). Settled at session end — see
      // endAgentTerminalSession. Deliberately NOT in checkAuth: that also runs
      // on every periodic re-auth tick below, which must never place a second
      // hold for the same still-open session.
      let holdId: string | undefined;
      if (billing) {
        const gateResult = await billing.gate({ payerId: authResult.payerId });
        if (!gateResult.allowed) {
          authResult.releaseSlot();
          socket.emit('agent-terminal:error', { message: 'Insufficient credits to open an agent terminal session.', connectionId });
          return;
        }
        holdId = gateResult.holdId;
      }
      const connectedAt = Date.now();

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
        payerId: authResult.payerId,
        holdId,
        connectedAt,
        pageId: terminalId,
        outputFn: (data) => socket.emit('agent-terminal:output', { data, connectionId }),
        closedFn: (exitCode) => socket.emit('agent-terminal:closed', { exitCode, connectionId }),
        scrollback: [],
        scrollbackBytes: 0,
        reAuthInterval: undefined,
        idleTimer: undefined,
      };

      const launch = resolveAgentTerminalCommand({
        command: authResult.command,
        args: authResult.args,
        commandOverride: authResult.commandOverride,
      });

      let shell: PtyShell;
      try {
        shell = openShell({
          sprite,
          cols: clampedCols,
          rows: clampedRows,
          sessionId: authResult.streamSessionId ?? undefined,
          command: launch.command,
          args: launch.args,
          cwd: authResult.cwd,
          onOutput: (data) => {
            appendScrollback(session, data);
            session.outputFn(data);
          },
          onExit: (exitCode) => {
            session.releaseSlot();
            loggers.realtime.info('Agent terminal session closed', { exitCode, sandboxId, sessionKey });
            session.closedFn(exitCode);
            // Clears all of the session's timers (re-auth, settle heartbeat, idle).
            endAgentTerminalSession(billing, sessionMap, session, sessionKey);
          },
        });
      } catch {
        authResult.releaseSlot();
        if (holdId) void billing?.releaseHold(holdId).catch(() => {});
        socket.emit('agent-terminal:error', { message: 'Failed to open agent terminal session', connectionId });
        return;
      }

      session.command = shell;
      sessionMap.setNew(sessionKey, connectionId, session);
      activeConnectionIds.add(connectionId);

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

      // Heartbeat settle (see SETTLE_HEARTBEAT_MS): bill the accrued window and
      // re-hold on an interval so a realtime restart loses at most one interval
      // of runtime, not the whole session. A gate DENIAL (payer out of credits)
      // tears the session down exactly like a failed re-auth below.
      if (billing) {
        session.settleInterval = startSettleHeartbeat(billing, sessionMap, session, sessionKey);
      }

      // Periodically re-check authorization while the session is alive.
      // Routes closed notification through closedFn so it reaches the current socket.
      const reAuthInterval = setInterval(async () => {
        const liveSession = sessionMap.getByKey(sessionKey);
        if (!liveSession) { clearInterval(reAuthInterval); return; }
        const result = await checkAuth({ userId, terminalId, projectName, branchName, name });
        // Re-check liveness after the await: another actor (heartbeat insolvency,
        // PTY exit, idle reap) may have torn the session down while checkAuth ran —
        // acting on the stale reference would double releaseSlot/kill/closedFn.
        if (sessionMap.getByKey(sessionKey) !== liveSession) {
          if (result.ok) result.releaseSlot();
          clearInterval(reAuthInterval);
          return;
        }
        if (!result.ok) {
          teardownAgentTerminalSession(billing, sessionMap, liveSession, sessionKey, -2);
        } else {
          result.releaseSlot();
        }
      }, 60_000);

      session.reAuthInterval = reAuthInterval;

      socket.emit('agent-terminal:ready', { connectionId });
    },

    onInput(payload: unknown) {
      const connectionId = readConnectionId(payload) ?? socket.id;
      if (!activeConnectionIds.has(connectionId)) return;
      const session = sessionMap.getBySocket(connectionId);
      if (!session) return;
      const p = payload as { data?: string };
      if (typeof p?.data === 'string' && p.data.length <= MAX_INPUT_BYTES) {
        session.command.write(p.data);
      }
    },

    onResize(payload: unknown) {
      const connectionId = readConnectionId(payload) ?? socket.id;
      if (!activeConnectionIds.has(connectionId)) return;
      const session = sessionMap.getBySocket(connectionId);
      if (!session) return;
      const p = payload as { cols?: number; rows?: number };
      if (typeof p?.cols === 'number' && typeof p?.rows === 'number' && Number.isFinite(p.cols) && Number.isFinite(p.rows)) {
        const { cols, rows } = clampTerminalDimensions({ cols: p.cols, rows: p.rows });
        session.command.resize(cols, rows);
      }
    },

    onDisconnect(payload?: unknown) {
      const explicitConnectionId = readConnectionId(payload);
      if (explicitConnectionId !== undefined) {
        // One pane explicitly closed (e.g. the Terminal workspace's "Split"
        // panes closing one of several) — leave this socket's OTHER
        // connections (other live panes) untouched. Only a connectionId THIS
        // socket itself registered via a successful, authorized `onConnect`
        // is honored — `agentTerminalSessionMap` is one shared, server-wide
        // instance (every socket's sessions live in it), so a connectionId a
        // client merely CLAIMS (rather than one this socket actually
        // established) must never be trusted to reach another socket's PTY.
        if (activeConnectionIds.has(explicitConnectionId)) {
          disconnectConnection(explicitConnectionId);
        }
        return;
      }
      // The socket itself disconnected (tab closed/reloaded, network drop) —
      // every connection this socket had open loses its viewer at once.
      for (const connectionId of [...activeConnectionIds]) {
        disconnectConnection(connectionId);
      }
    },
  };
}
