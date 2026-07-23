import type { TerminalSessionMap, TerminalSession, TerminalViewer } from './terminal-session-map';
import { DETACHED_IDLE_MS, appendScrollback, broadcastOutput, broadcastClosed } from './terminal-session-map';
import type { OpenPtyShellArgs, PtyShell } from './sprites-shell';
import type { SpriteInstanceLike } from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import type { TaskHoldController } from '@pagespace/lib/services/sandbox/sandbox-client/sprite-tasks';
import type { SandboxBillingDeps } from '@pagespace/lib/services/sandbox/tool-runners';
import {
  validateAgentTerminalConnectPayload,
  clampTerminalDimensions,
  type AgentTerminalConnectPayload,
} from './validation';
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
 * Continuity across a realtime-process restart is by EXACT session id, never by
 * guesswork: a Sprite hosts every agent terminal on its machine, so "any tty
 * session" could just as easily be a sibling terminal's shell. Each freshly
 * created session announces its own id on its own socket (`session_info` — see
 * `readSessionInfoId`), the shell reports it via `onSessionId`, and this bridge
 * persists it to `machine_agent_terminals.streamSessionId` (via
 * `persistStreamSessionId`). The sandbox resolution hands that id back on the
 * next COLD connect, so THIS specific session is reattached — and if it is gone
 * (exec sessions do not survive a pause), the shell creates a fresh one and
 * persists the new authoritative id in its place.
 *
 * A restart is the only time that costs anything, though: while this process is
 * up, the session stays in `sessionMap` for the whole 30-min detached grace, so
 * a tab-back is served by `planConnect`'s reattach path — the access check, the
 * in-memory lookup, and `agent-terminal:ready` with the buffered scrollback. No
 * sandbox is resolved, no Sprite is woken and no audit row is written, because
 * `checkAuth` hands the sprite half back as an UNCALLED `resolveSandbox` thunk
 * (see `agent-terminal-access.ts`) that only the cold path invokes.
 *
 * `billing` (Terminal Epic 3) meters this PTY session's active-runtime cost
 * against the machine's payer — the same hold/gate/settle seam the retired
 * human terminal used, now applied uniformly to every agent-terminal
 * connection regardless of scope, since Sprite wall-clock time is equally
 * billable whether a human or a pluggable agent is driving the PTY. Omitted
 * -> unmetered (no hold, no settle).
 *
 * A session is MULTI-VIEWER (issue #2093): attach JOINS a live session rather
 * than taking it over, output is fanned out to every attached viewer (each
 * tagged with its own connectionId), and every attached authorized viewer may
 * type — write access is deliberately tmux-style free-for-all, with no
 * driver/write-lock. Billing is per-session wall-clock, never per viewer.
 */

/**
 * The Sprite and launch metadata a FRESH PTY needs. Produced lazily, by
 * `AgentTerminalCheckAuthResult.resolveSandbox`, and therefore ONLY on the cold
 * (create) path — reattaching to a live in-memory session never resolves it.
 */
export type AgentTerminalSandboxResult =
  | {
      ok: true;
      agentTerminalId: string;
      sandboxId: string;
      /** The resolved working directory for a FRESH session — machine's SANDBOX_ROOT, a project's clone path, or a branch's repo checkout. */
      cwd: string;
      sprite: SpriteInstanceLike;
      /** The agentType's resolved launch command — the literal sentinel `'shell'` when unresolved to an actual shell binary yet (see `resolveAgentTerminalCommand`). */
      command: string;
      args: string[];
      /** A per-terminal program override (PurePoint `AgentEntry.command` parity), or null to use `command`/`args` as-is. */
      commandOverride: string | null;
      /** The Sprite exec-session id this agent terminal was last known to run under, if any. */
      streamSessionId: string | null;
      /**
       * Releases the concurrency slot this resolution reserved for the PTY it is
       * about to start. Present ONLY here, on the success result, because this
       * is the only path that reserves one — a reattach starts no PTY, takes no
       * slot, and so has nothing to release.
       */
      releaseSlot: () => void;
    }
  | { ok: false; reason: string };

/**
 * The CHEAP half of a connect: a DB-only authorization verdict (leaf 1-2) plus
 * the session key, which derives from the (scope, name) target alone (leaf 1-1).
 * Nothing here has touched — let alone woken — a Sprite, and nothing here has
 * reserved a concurrency slot. That is what lets `onConnect` look up a live
 * in-memory session and reattach to it before any sandbox work happens at all,
 * and what lets the 60s re-auth tick re-check a LIVE session's authorization
 * without competing with that very session for its own slot.
 */
export type AgentTerminalCheckAuthResult =
  | {
      ok: true;
      sessionKey: string;
      /** The machine's resolved payer — metering attribution (Terminal Epic 3), present regardless of whether `billing` is wired. */
      payerId: string;
      /**
       * Reserve the concurrency slot and resolve the Sprite for a FRESH PTY —
       * called ONLY on the create path. Owns the slot's release on its OWN
       * failure paths: a denial releases it (and logs) before returning
       * `ok: false`, and a rejection releases it before propagating. On success
       * the slot stays reserved and the caller owns it via the returned
       * `releaseSlot`.
       */
      resolveSandbox: () => Promise<AgentTerminalSandboxResult>;
    }
  | { ok: false; reason: string };

export type AgentTerminalCheckAuthFn = (args: {
  userId: string;
  machineId: string;
  projectName?: string;
  branchName?: string;
  name: string;
}) => Promise<AgentTerminalCheckAuthResult>;

/** An authorized connect — the `ok` arm of a check-auth result. */
export type AgentTerminalAccessGranted = Extract<AgentTerminalCheckAuthResult, { ok: true }>;

/**
 * The three ways a connect can go, once the access verdict and the live-session
 * lookup are both in hand. Each arm carries exactly the (already-narrowed) data
 * its branch of the handler needs, so the shell executes the plan without
 * re-deriving or re-checking any part of the decision.
 */
export type ConnectPlan =
  | { kind: 'deny'; reason: string }
  | { kind: 'reattach'; access: AgentTerminalAccessGranted; session: TerminalSession }
  | { kind: 'create'; access: AgentTerminalAccessGranted };

/**
 * Pure: decide the connect path from the (cheap, DB-only) access verdict and
 * whether a live in-memory session already exists for this session key.
 *
 * A denied verdict ALWAYS denies — the presence of a live session must never
 * shortcut authorization, or a user who just lost access could tab back into a
 * PTY that outlived their permission. An allowed verdict reattaches to a live
 * session when there is one (the fast path: no slot, no sprite resolution, no
 * wake exec, no audit write — docs.sprites.dev/concepts/lifecycle puts even a
 * warm wake at 100-500ms, and this skips it entirely), and otherwise creates a
 * fresh one.
 */
export function planConnect({
  accessResult,
  existingSession,
}: {
  accessResult: AgentTerminalCheckAuthResult;
  existingSession: TerminalSession | undefined;
}): ConnectPlan {
  if (!accessResult.ok) return { kind: 'deny', reason: accessResult.reason };
  if (existingSession !== undefined) return { kind: 'reattach', access: accessResult, session: existingSession };
  return { kind: 'create', access: accessResult };
}

export type OpenShellFn = (args: OpenPtyShellArgs) => PtyShell;

export type SocketLike = {
  id: string;
  data: { user?: { id: string } };
  emit(event: string, payload?: unknown): void;
};

/**
 * Everything STARTING a PTY needs — and nothing about who asked for it.
 *
 * Socket-free on purpose: the same cold-create sequence (reserve a slot, gate
 * billing, verify liveness, open the shell, arm the hold/settle/re-auth
 * heartbeats) serves a viewer's `agent-terminal:connect` and a HEADLESS start
 * driven by agent IO over signed HTTP (`session-io.ts`, issue #2206). The two
 * differ only in who watches the result, which is `EnsureSessionRequest`'s
 * business — everything deciding what a session COSTS and how it is collected
 * lives here, in one place, so the callers cannot drift apart on slot
 * accounting, metering or reaping.
 */
export type AgentTerminalSessionDeps = {
  sessionMap: TerminalSessionMap;
  openShell: OpenShellFn;
  checkAuth: AgentTerminalCheckAuthFn;
  /** Best-effort: persists the Sprite session id this agent terminal is now known to run under, so a later reconnect (even after a realtime-process restart) reattaches to THIS session rather than creating a duplicate. */
  persistStreamSessionId: (args: { agentTerminalId: string; sessionId: string }) => Promise<void>;
  /** Terminal Epic 3 metering seam — see module doc. Omitted -> unmetered. */
  billing?: SandboxBillingDeps;
  /**
   * Sprites Tasks API hold seam (leaf 5-1). Called once per COLD create with
   * the resolved Sprite; the controller it returns keeps a self-expiring
   * platform task hold alive while work is in progress (viewer attached OR
   * agent output flowing) and releases it when idle, so a sprite that leaves
   * 3-1/3-2's now-real idle pause can't cold-pause an agent mid-run — and CAN
   * pause the moment the agent goes quiet. Omitted -> no holds (the sprite
   * pauses on the platform's own idle clock, mid-run or not).
   */
  createTaskHold?: (args: { sprite: SpriteInstanceLike; sessionKey: string }) => TaskHoldController;
};

/** The session deps plus the ONE socket this handler set serves. */
export type AgentTerminalHandlerDeps = AgentTerminalSessionDeps & {
  socket: SocketLike;
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
  // Defensive: only evict the key if THIS session is still the one under it, so a
  // teardown can never delete a DIFFERENT session that now holds the key and
  // orphan its running PTY. Per-key create serialization (see onConnect) already
  // guarantees one session per key at a time, so today `getByKey` is always this
  // session or already-absent; this guard just keeps that invariant from being a
  // silent precondition of correctness here.
  if (sessionMap.getByKey(sessionKey) === session) {
    sessionMap.deleteByKey(sessionKey);
  }
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
  if (session.holdInterval !== undefined) {
    clearInterval(session.holdInterval);
    session.holdInterval = undefined;
  }
  // Session over: delete the platform task hold so the sprite can pause.
  // Best-effort (end() never throws) — and even a lost delete self-expires,
  // because every hold this seam creates carries a short expiry.
  if (session.taskHold !== undefined) {
    session.taskHold.end();
    session.taskHold = undefined;
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
 *
 * `'forced-teardown'`: this is the PLATFORM ending a session on the user's
 * behalf (revoked access, or an insolvent payer) — never a click. It still
 * needs a genuine, permanent termination (see `planTeardown`), so it maps to
 * the same `TeardownPlan` an explicit kill would, but the trigger name says
 * plainly who actually decided this, not "user-kill" — an incident review
 * reading this trigger off a log line should not conclude the user did it.
 */
function teardownAgentTerminalSession(
  billing: SandboxBillingDeps | undefined,
  sessionMap: TerminalSessionMap,
  session: TerminalSession,
  sessionKey: string,
  exitCode: number,
): void {
  session.releaseSlot();
  session.command.kill('forced-teardown');
  endAgentTerminalSession(billing, sessionMap, session, sessionKey);
  broadcastClosed(session, exitCode);
  // Nothing may emit to those panes again. `deleteByKey` (inside
  // endAgentTerminalSession) already dropped every binding; clearing the
  // registry closes the other half.
  session.viewers.clear();
}

/**
 * One viewer leaves a live session — a pane closed, its socket dropped, or the
 * 60s re-auth tick evicted it. Removes that viewer's registry entry and socket
 * binding; the OTHER viewers keep streaming, untouched.
 *
 * The detach transition — quiet the shell's watchdog, re-evaluate the platform
 * task hold, arm the 30-min idle reap — fires only when the LAST viewer
 * leaves: a session with anyone still watching is simply not detached.
 *
 * Module-level (not a closure inside `buildAgentTerminalHandlers`) because two
 * different scopes need it: a pane's own socket handler on disconnect, and the
 * session's re-auth interval evicting a viewer who attached on a DIFFERENT
 * socket. The eviction leaves that other socket's `activeConnectionIds` entry
 * stale, which is harmless for the PTY: `onInput`/`onResize` also require the
 * `bySocket` binding this removes, so a revoked viewer's keystrokes no-op, and
 * their eventual disconnect finds no session and cleans the set. One residue
 * remains (shared with the pre-#2093 whole-session teardown): a later connect
 * on that same socket REUSING the evicted connectionId hits the
 * "already in use" guard until the pane disconnects — the real client never
 * does this (a fresh UUID per mount, and a dead pane refuses to re-bind).
 */
function removeViewer(
  billing: SandboxBillingDeps | undefined,
  sessionMap: TerminalSessionMap,
  session: TerminalSession,
  viewerKey: string,
): void {
  const viewer = session.viewers.get(viewerKey);
  session.viewers.delete(viewerKey);
  sessionMap.detach(viewerKey);
  if (session.viewers.size > 0) return;
  // The last viewer out is who the detached re-auth tick keeps checking.
  if (viewer) session.lastViewerUserId = viewer.userId;
  // No viewer is left watching this PTY: stop the shell's watchdog reconnect
  // loop (sprites-shell.ts's `planWatchdogResponse`) so an idle detached
  // terminal stops waking the Sprite every ~45s for nobody. This only quiets
  // OUR exec connection — an agent still running inside the shell keeps
  // running, exactly as it already does across the 30-min idle reap below.
  session.command.setViewerAttached(false);
  // Re-evaluate the platform task hold now that the viewer is gone: with no
  // recent activity this DELETES the hold, so the sprite can pause long
  // before the 30-min reap — an agent mid-run (recent output OR a
  // just-typed prompt still awaiting its first byte) keeps it. Staleness is
  // trustworthy AT this instant (the viewer was attached until now, so the
  // socket was live and silence was real silence) — with one exception: a
  // RESUMED agent that has never emitted a byte since we picked it up. Our
  // silence says nothing about a run that was verified live at connect
  // (`resumedAtCreate`), so that one keeps its hold rather than being
  // paused on ignorance.
  session.taskHold?.tick({
    attached: false,
    lastActivityAt: latestActivityAt(session),
    activityObservable: session.hasOutput || !session.resumedAtCreate,
  });
  armIdleReap(billing, sessionMap, session);
}

/**
 * Arm (or re-arm) the reap that collects a session nobody is watching after
 * `DETACHED_IDLE_MS` of quiet — the one thing that eventually releases a
 * viewer-less PTY's concurrency slot and settles its billing.
 *
 * Three callers, all meaning "this session has no viewer right now":
 *
 *   - the last viewer leaving (`removeViewer`, above) — the original;
 *   - a HEADLESS create (`ensureAgentTerminalSession`), which installs a session
 *     with zero viewers and so never reaches that transition at all. Without an
 *     arm here its PTY, slot and billing heartbeat would run for the life of the
 *     process;
 *   - agent input into a viewer-less session (`session-io.ts`), which RE-arms:
 *     an agent driving a headless shell is activity, and reaping mid-command
 *     thirty minutes after it started would kill work in progress.
 *
 * Idempotent by construction — any pending timer is cleared first, so a re-arm
 * moves the deadline rather than stacking a second reap onto the same session.
 */
export function armIdleReap(
  billing: SandboxBillingDeps | undefined,
  sessionMap: TerminalSessionMap,
  session: TerminalSession,
): void {
  const { sessionKey } = session;
  if (session.idleTimer !== undefined) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    session.releaseSlot();
    // 'idle-reap': ending the session server-side is this timer's whole
    // point — the exec socket is almost always already dead by now (no
    // viewer means no reconnect since the detach above), so the REST
    // session-kill (not a local WS signal that would silently no-op) is
    // what actually reaches it — see `planTeardown`.
    session.command.kill('idle-reap');
    // Clears all of the session's timers (re-auth, settle heartbeat, idle).
    endAgentTerminalSession(billing, sessionMap, session, sessionKey);
    loggers.realtime.info('Agent terminal session reaped (idle)', { sessionKey, sandboxId: session.sandboxId });
  }, DETACHED_IDLE_MS);
}

/**
 * Kick ONE viewer off a live session — the re-auth tick's move when that
 * viewer's access was revoked while the PTY keeps running for everyone else.
 * Notify-then-remove, as one operation, so no future eviction site can remove
 * a viewer and forget to tell their pane why output just stopped.
 *
 * The notification is `agent-terminal:error` with a reason, NOT
 * `agent-terminal:closed`: closed means "the process exited", and for an
 * eviction that is false — the agent is still running and other panes still
 * show it live. The client treats both the same way mechanically (pane goes
 * dead, editing lock released), so the only difference is that the user reads
 * the truth ("access revoked") instead of a phantom crash ("exited with code
 * -2") for a process that did not exit.
 */
function evictViewer(
  billing: SandboxBillingDeps | undefined,
  sessionMap: TerminalSessionMap,
  session: TerminalSession,
  viewerKey: string,
  viewer: TerminalViewer,
  reason: string,
): void {
  viewer.emitError(reason);
  removeViewer(billing, sessionMap, session, viewerKey);
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
  { stopClock = false }: { stopClock?: boolean } = {},
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
    if (sessionMap.getByKey(sessionKey) === session) {
      // Roll the rebase back so the unbilled window is retried at the next
      // heartbeat (or session end) against its original, still-live hold.
      session.connectedAt = windowStart;
      session.holdId = holdId;
    } else {
      // The session was torn down while this settle was failing: the teardown's
      // end-settle only billed the post-rebase tail (with no hold), so nothing
      // will ever retry THIS window. One compensating best-effort attempt —
      // the same fire-and-forget guarantee the end-settle itself has. If it
      // also fails, the hold expires via TTL and the window is lost.
      void billing
        .trackUsage({ payerId, holdId, activeSeconds, pageId: session.pageId })
        .catch(() => {});
    }
    return true;
  }
  if (sessionMap.getByKey(sessionKey) !== session) return true;
  // The shell quiesced: its exec socket is deliberately down and its Sprite is
  // free to pause (the task hold was released with it — see
  // `startTaskHoldHeartbeat`). A paused sandbox costs us nothing, so billing the
  // payer wall-clock for it would charge them for a tab, not for a sandbox — and
  // an ATTACHED session is never reaped, so that overbilling would be unbounded.
  // Stop the clock instead: the window just settled is the last billable one
  // until the socket comes back (`resumeBillingClock`).
  //
  // Set only AFTER a successful settle and only while this session is still the
  // live one — a failed settle has already rolled `connectedAt` back to the
  // window start, and clearing it here would silently discard that unbilled
  // window instead of retrying it.
  //
  // No fresh hold is placed either: a hold RESERVES the payer's credits for the
  // next window, and there is no next window until they come back.
  //
  // Skipping the gate does mean an insolvent payer's quiesced terminal is not
  // torn down while it sits there — correct, since it is consuming nothing — and
  // that they are re-gated at the first heartbeat AFTER they resume rather than
  // at the instant of resume. That is the same bounded exposure any mid-window
  // insolvency already carries (a payer who runs out with nine minutes left in a
  // ten-minute window keeps those nine minutes), not a new one: the settle
  // cadence, not this branch, is what bounds it.
  if (stopClock) {
    session.connectedAt = undefined;
    return true;
  }
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
 * Restart the billing clock a quiesced window stopped (`settleAccruedWindow`'s
 * `stopClock`). Called at the very instant the shell resumes — a keystroke, or a
 * viewer returning — NOT left to the next heartbeat: that is `SETTLE_HEARTBEAT_MS`
 * (ten minutes) away, and a session that resumed nine minutes before its next
 * tick would have those nine minutes billed as free.
 *
 * Idempotent, and inert for an unmetered session (no `payerId`) or one whose
 * clock is already running — `connectedAt` is only ever `undefined` here because
 * a quiesce stopped it.
 */
export function resumeBillingClock(session: TerminalSession): void {
  if (!session.payerId) return;
  if (session.connectedAt !== undefined) return;
  session.connectedAt = Date.now();
}

/**
 * Arms the heartbeat for a metered session (see SETTLE_HEARTBEAT_MS). A
 * module-level factory rather than a closure inside onConnect so the
 * long-lived interval callback captures only what it needs — not the whole
 * connect scope (auth result, Sprite handle, session-list snapshots).
 *
 * Each tick re-reads whether the shell is QUIESCED, so the same beat that bills
 * a live session's window stops an idle one's clock — and starts it again when
 * the socket comes back. Billing tracks sandbox residency, not tab-open time.
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
      const quiesced = session.command.isQuiesced();
      // A backstop for the precise `resumeBillingClock` calls at the resume
      // sites: if a socket came back through some path that did not restart the
      // clock, this beat notices and restarts it rather than letting the session
      // run on free forever.
      if (!quiesced) resumeBillingClock(session);
      const solvent = await settleAccruedWindow(billing, sessionMap, session, sessionKey, { stopClock: quiesced });
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

/**
 * Pure: when this session was last ACTIVE — output produced, input typed, or
 * the PTY launched (creation seeds `lastInputAt`). This is what the task hold
 * feeds on rather than output alone: a typed prompt that kicks off a long
 * silent run is work in progress from the moment it is typed, not from the
 * agent's first byte.
 */
export function latestActivityAt(
  session: Pick<TerminalSession, 'lastOutputAt' | 'lastInputAt'>,
): number | undefined {
  const { lastOutputAt, lastInputAt } = session;
  if (lastOutputAt === undefined) return lastInputAt;
  if (lastInputAt === undefined) return lastOutputAt;
  return Math.max(lastOutputAt, lastInputAt);
}

/**
 * Arms the platform-task-hold heartbeat (leaf 5-1): one immediate tick — the
 * viewer is attached, so the hold must exist NOW, not a cadence from now —
 * then one tick per controller cadence (the documented 60s refresh against a
 * 5m expiry) for as long as the session is live. Each tick re-reads the
 * session's CURRENT attached/output state, so the same beat that refreshes a
 * busy session's hold deletes an idle one's. A module-level factory for the
 * same reason as `startSettleHeartbeat`: the long-lived callback captures
 * only what it needs, not the whole connect scope.
 */
function startTaskHoldHeartbeat(
  taskHold: TaskHoldController,
  sessionMap: TerminalSessionMap,
  session: TerminalSession,
  sessionKey: string,
): ReturnType<typeof setInterval> {
  const tick = () =>
    taskHold.tick({
      // `attached` means "a LIVE EXEC CONNECTION exists on the Sprite for a
      // viewer", not merely "a browser tab is open". Those were the same thing
      // until the watchdog learned to quiet an attached-but-idle shell: a
      // quiesced socket (`isQuiesced`) is deliberately DOWN, so it gives the
      // platform nothing to keep the sandbox resident FOR, and holding the
      // sprite up for it is exactly the idle-cost bug this change exists to
      // close. Without this, `planHold`'s `needHold = attached || agentRunning`
      // would refresh the hold forever behind any open tab — the watchdog would
      // have gone quiet while the hold went on pinning the Sprite, and the RAM
      // bill would not move.
      //
      // A viewer whose shell was paused out from under them gets it back
      // transparently: their next keystroke resumes the socket, and the shell's
      // own reconnect either reattaches the surviving session or falls back to a
      // fresh one (`planReconnect`) — the same recovery a returning DETACHED
      // viewer has always had.
      attached: session.viewers.size > 0 && !session.command.isQuiesced(),
      lastActivityAt: latestActivityAt(session),
      // Whether a STALE clock is trustworthy evidence of idleness.
      //
      // While DETACHED the exec socket may have died mid-run — the shell
      // deliberately never reconnects it (leaf 3-2) — so the clock can freeze
      // under an agent that is still working. That is blind, and the controller
      // then keeps an existing hold rather than deleting it under an agent it
      // can no longer see. And a detached agent that FINISHES while the socket
      // survived still releases promptly: its PTY exit reaches onExit, whose
      // teardown ends the hold.
      //
      // An ATTACHED shell stays observable even once the watchdog quiets it,
      // which is why this is still just "any viewer attached". A shell is only
      // ever quiesced-while-attached BECAUSE its clock was already stale past
      // the idle window while the socket was live and watching (`attach-quiet`
      // is unreachable with fresh activity — see `planWatchdogResponse`). The
      // freeze is a CONSEQUENCE of idleness we observed, not a blindfold that
      // hides work. Passing `false` here instead would invert the policy and
      // pin the hold forever: `agentRunning` is
      // `isAgentActive(...) || (!activityObservable && holdExists)`, so an
      // unobservable session with a live hold counts as running by definition.
      activityObservable: session.viewers.size > 0,
    });
  tick();
  const interval = setInterval(() => {
    if (sessionMap.getByKey(sessionKey) !== session) { clearInterval(interval); return; }
    tick();
  }, taskHold.tickIntervalMs);
  return interval;
}

/** How long the connect will wait to hear which sessions a Sprite has. */
const LIST_SESSIONS_TIMEOUT_MS = 5_000;

/**
 * Whether the Sprite ACTUALLY still has this exec session — and whether we could
 * find out at all.
 *
 * `unknown` is a first-class answer, not a boolean in disguise. The caller does
 * two different things with the verdict, and only one of them may act on a guess:
 * what it tells the CLIENT (fail safe — see `resumedFor`) and what it records on
 * the SESSION, which every later reattach inherits for the next 30 minutes. A
 * transient 429 must not freeze a guess into that.
 */
type SessionLiveness = 'live' | 'gone' | 'unknown';

/**
 * `streamSessionId` on the row only records a session that existed at some point:
 * exec sessions do not survive a Sprite pause, and nothing ever clears the column
 * (see `updateStreamSessionId` — it only ever writes a new id over an old one).
 *
 * BOUNDED, because this now gates the shell from opening at all. There is no
 * timeout anywhere in the `listSessions` chain, and a stalled control plane would
 * otherwise mean: no PTY, a concurrency slot and a billing hold both held, and —
 * because `finishCreate()` never runs — every subsequent connect for this terminal
 * blocked behind the create claim. A terminal that will not open and cannot be
 * retried is a far worse failure than not knowing whether its agent was running.
 */
async function sessionLiveness(sprite: SpriteInstanceLike, streamSessionId: string | null): Promise<SessionLiveness> {
  if (!streamSessionId) return 'gone';

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<'unknown'>((resolve) => {
      timer = setTimeout(() => resolve('unknown'), LIST_SESSIONS_TIMEOUT_MS);
    });
    const listing = sprite
      .listSessions()
      .then((sessions): SessionLiveness => (sessions.some((session) => session.id === streamSessionId) ? 'live' : 'gone'));

    return await Promise.race([listing, timeout]);
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What to TELL a client about an agent it may be about to type a starting prompt
 * into. Fails safe: an unknown liveness is reported as resumed, because the two
 * ways of being wrong are not symmetric — refusing to type at an agent that turns
 * out to be fresh costs the user a prompt they can retype, while typing at one
 * that turns out to be live can answer a confirmation it was waiting on.
 */
function resumedFor(liveness: SessionLiveness): boolean {
  return liveness !== 'gone';
}

/** The (scope, name) address a session is created for — the same tuple `checkAuth` takes. */
export interface AgentTerminalTargetNames {
  machineId: string;
  projectName?: string;
  branchName?: string;
  name: string;
}

export interface EnsureSessionRequest {
  /** The ALREADY-GRANTED access verdict for this target — `sessionKey`, `payerId`, and the uncalled `resolveSandbox` thunk. */
  access: AgentTerminalAccessGranted;
  target: AgentTerminalTargetNames;
  /** Who this session is being started FOR — the re-auth tick's identity while nobody is attached. */
  userId: string;
  /** Already clamped by the caller (`clampTerminalDimensions`). */
  cols: number;
  rows: number;
  /**
   * The creating viewer, registered in the session literal BEFORE `openShell`
   * so output arriving between the shell opening and `setNew` still reaches
   * their pane.
   *
   * Absent = a HEADLESS start: the session begins with zero viewers, because
   * the thing that wanted it is an agent reading over HTTP, not a pane. That is
   * a supported state, not a degenerate one — a session whose humans have all
   * closed their tabs is already exactly this — but it does mean the
   * last-viewer-leaves transition that normally arms the reap never fires, so
   * this function arms it itself (see `armIdleReap` below).
   */
  viewer?: { key: string; viewer: TerminalViewer };
  /**
   * Has the requester gone away since asking? Checked at the last `await`
   * before the PTY exists, so an abandoned create declines instead of starting
   * an agent nobody will ever see. For a headless start (`index.ts`'s
   * `startHeadlessAgentTerminal`), this is the HTTP request's own connection —
   * the web tier's `fetch` to this endpoint times out sooner than a cold
   * Sprite wake can finish, and without tracking that, a client who gave up
   * could see its retried input executed twice on a create that finished
   * after the fact. Addressed by KEY regardless: the next `send_session`
   * finds whatever this create did or didn't leave behind.
   */
  abandoned: () => boolean;
  /**
   * Called SYNCHRONOUSLY once the session is installed — no await between it
   * and `openShell`.
   *
   * That is the whole reason this is a callback rather than the returned
   * `resumed`: awaiting this function's result is a microtask, and an attach
   * REPLAYS the session's scrollback immediately, so a caller that emitted
   * `ready` on the returned value would let that replay overtake it. A client
   * that types its starting prompt on first output would then type it into an
   * agent it has not yet been told was already running — precisely the hazard
   * `resumed` exists to prevent. The returned `resumed` is for callers with no
   * such race (a headless start has no client to overtake).
   */
  onStarted?: (resumed: boolean) => void;
}

export type EnsureSessionResult =
  /** A live session already held this key — the caller attaches to it rather than creating a second PTY. */
  | { kind: 'existing'; session: TerminalSession }
  | { kind: 'created'; session: TerminalSession; resumed: boolean }
  | {
      kind: 'failed';
      reason: 'abandoned' | 'denied' | 'insolvent' | 'open_failed';
      /** The deny reason, for the arms that have one — the caller decides how (and whether) to word it. */
      message?: string;
    };

/**
 * Get a live PTY session for this key, creating one if there is none.
 *
 * THE one place a PTY is started. Both callers — a viewer's socket connect and
 * a headless agent-IO start — come through here, so the slot reservation, the
 * billing gate and window, the platform task hold, the settle and re-auth
 * heartbeats, and the per-key create serialization are written once and behave
 * identically no matter who asked.
 *
 * Emits nothing and knows no socket: every outcome is a returned value. The
 * socket caller turns those into `agent-terminal:error`/`ready`; the headless
 * caller turns them into an HTTP answer.
 */
export async function ensureAgentTerminalSession(
  deps: AgentTerminalSessionDeps,
  request: EnsureSessionRequest,
): Promise<EnsureSessionResult> {
  const { sessionMap, openShell, checkAuth, persistStreamSessionId, billing, createTaskHold } = deps;
  const { access, target, userId, cols, rows, viewer } = request;
  const { machineId, projectName, branchName, name } = target;
  const { sessionKey } = access;

  const alreadyLive = sessionMap.getByKey(sessionKey);
  if (alreadyLive !== undefined) return { kind: 'existing', session: alreadyLive };

  // The cold path — slow (it resolves, and may wake, a Sprite), which makes it
  // exactly the window a double-mount's second connect lands in. Join a create
  // already in flight for this key rather than starting a second one: opening
  // a second PTY here is not merely wasteful, it is destructive. Both connects
  // would attach to the SAME persisted Sprite exec session, so discarding the
  // duplicate afterwards would SIGKILL the process the survivor is attached to.
  //
  // Loop rather than check once: if the create we waited on FAILED, another
  // connect may already have claimed the key behind it.
  for (;;) {
    const inFlight = sessionMap.pendingCreate(sessionKey);
    if (inFlight === undefined) break;
    await inFlight.catch(() => {});
    const created = sessionMap.getByKey(sessionKey);
    if (created !== undefined) return { kind: 'existing', session: created };
    // That create failed and installed nothing — see if another is in flight,
    // otherwise fall through and create it ourselves.
  }

  // Claim the key BEFORE the first await, so a connect that arrives while we
  // are resolving joins us instead of racing us. There is no await between the
  // loop's exit and this claim, so the claim is atomic w.r.t. the event loop.
  // The claim is released by the `finally` below, on every exit from the cold
  // path — success, denial, or throw.
  let finishCreate!: () => void;
  sessionMap.trackCreate(sessionKey, new Promise<void>((resolve) => { finishCreate = resolve; }));
  try {
    // ONLY now is a concurrency slot reserved and the Sprite resolved: a
    // reattach above returned without ever calling this.
    const sandbox = await access.resolveSandbox();
    if (!sandbox.ok) {
      // resolveSandbox released the slot (if it had reserved one) and logged.
      return { kind: 'failed', reason: 'denied', message: sandbox.reason };
    }
    // Every teardown path below can race another (a PTY exit landing while the
    // idle reap is pending, a lost double-mount whose onExit fires later), and
    // the slot is a bare counter — releasing it twice silently hands back
    // capacity this connect never held, letting the user exceed their tier.
    // Collapse them: the slot goes back exactly once, whoever gets there first.
    let slotReleased = false;
    const releaseSlot = () => {
      if (slotReleased) return;
      slotReleased = true;
      sandbox.releaseSlot();
    };

    // Terminal Epic 3 metering: place a flat-estimate hold for this NEW
    // machine-active window BEFORE opening the shell (hibernated/idle time
    // between sessions is free). Settled at session end — see
    // endAgentTerminalSession. Deliberately NOT in checkAuth: that also runs
    // on every periodic re-auth tick below, which must never place a second
    // hold for the same still-open session.
    let holdId: string | undefined;
    if (billing) {
      // The slot is already reserved, and nothing owns it yet — no session
      // exists to release it on teardown. A gate that THROWS (a billing/DB blip)
      // would otherwise propagate straight out of onConnect with the slot still
      // held, and `activeByUser` is a process-lifetime counter: one transient
      // failure would lock a free-tier user (limit 1) out of agent terminals on
      // this replica until the process restarts.
      let gateResult: Awaited<ReturnType<SandboxBillingDeps['gate']>>;
      try {
        gateResult = await billing.gate({ payerId: access.payerId });
      } catch (error) {
        releaseSlot();
        throw error;
      }
      if (!gateResult.allowed) {
        releaseSlot();
        return { kind: 'failed', reason: 'insolvent' };
      }
      holdId = gateResult.holdId;
    }
    const connectedAt = Date.now();

    const { sandboxId, sprite } = sandbox;

    // Resolved BEFORE the shell opens, deliberately. It is the answer to
    // "was this agent already running", and it must be in hand by the time
    // `ready` is emitted — which has to leave with NO await between it and
    // `openShell`, or the shell's first output can reach the client before
    // `ready` does. A client that types a starting prompt on first output
    // would then type it without yet knowing the agent was resumed, which is
    // precisely the hazard `resumed` exists to prevent.
    const liveness = await sessionLiveness(sprite, sandbox.streamSessionId);
    const resumed = resumedFor(liveness);

    // The verdict has to CONSTRAIN the attach, not merely predict it.
    //
    // `openPtyShell` attaches to a `sessionId` optimistically — it does not
    // consult this verdict — so handing it the stored id while telling the
    // client `resumed: false` would be a bet that the listing was right. Lose
    // that bet (the listing omits a session `attachSession` then binds to) and
    // the bridge is attached to a LIVE agent having just told the client it was
    // safe to type into. `resumed` is the only defence on this path.
    //
    // So a `gone` verdict makes ITSELF true: no id, a genuinely fresh session,
    // and the prompt is correct by construction. Anything else (`live`, or an
    // `unknown` we could not settle) keeps the id — abandoning a running agent
    // to start a second one is the worse error, and it is the same policy
    // `planReconnect` already applies on every reconnect.
    const attachSessionId = liveness === 'gone' ? undefined : (sandbox.streamSessionId ?? undefined);

    // The pane is already gone. Do not START the agent just to reap it.
    //
    // Tearing an abandoned create down AFTER the fact is safe (nobody else is
    // watching a PTY that did not exist a moment ago) — but safe is not free. The
    // reap is armed for DETACHED_IDLE_MS, so a pane closed during a cold boot would
    // hold a concurrency slot and bill the MACHINE's payer for thirty minutes of
    // Sprite runtime for an agent nobody ever saw. On the free tier (one terminal)
    // that is a thirty-minute lockout from the user's own machine — a smaller
    // version of the very harm this machinery exists to prevent.
    //
    // This is the last `await` before the PTY exists, and everything from here to
    // `setNew` is synchronous, so no abandonment can slip past this check. Nothing
    // is stranded by leaving: the key claim is released in the `finally` below, so
    // a racer parked on it wakes, finds no session, and creates one itself.
    if (request.abandoned()) {
      releaseSlot();
      if (holdId) void billing?.releaseHold(holdId).catch(() => {});
      return { kind: 'failed', reason: 'abandoned' };
    }

    const session: TerminalSession = {
      command: null as unknown as PtyShell,
      sandboxId,
      sessionKey,
      lastViewerUserId: userId,
      sessionId: attachSessionId,
      releaseSlot,
      payerId: access.payerId,
      holdId,
      connectedAt,
      pageId: machineId,
      // The creator is viewer #1, registered in the literal — BEFORE
      // `openShell` — so output arriving between the shell opening and
      // `setNew` still reaches their pane (`onOutput` reads `viewers` live).
      // A headless start has no such pane and begins empty.
      viewers: new Map(viewer ? [[viewer.key, viewer.viewer]] : []),
      scrollback: [],
      hasOutput: false,
      // The launch itself is the session's first activity: an agent booted
      // with a command that works silently must hold its sprite up through
      // that silence, not wait for its first byte of output.
      lastInputAt: Date.now(),
      // Fails safe, EXACTLY as the wire does. The reattach path has no way to
      // say "unknown" — it re-derives `resumed` from this field — so recording
      // `false` for an unknown liveness would put a live agent straight back
      // into the window this field exists to close: `hasOutput` is still false
      // in the moment before its first byte, and a pane re-mounting there (a
      // torn-down mount carries its unspent prompt into the next connect) would
      // be told "fresh boot, safe to type".
      //
      // Recording `true` for an unknown costs a prompt the user retypes, and it
      // stops costing anything the instant the agent speaks and `hasOutput`
      // takes over. Recording `false` costs a line typed into a live agent
      // sitting at a confirmation. The asymmetry decides it.
      resumedAtCreate: resumed,
      scrollbackBytes: 0,
      reAuthInterval: undefined,
      idleTimer: undefined,
    };

    // Serializes this terminal's streamSessionId writes — see `onSessionId`.
    let persistQueue: Promise<void> = Promise.resolve();

    const launch = resolveAgentTerminalCommand({
      command: sandbox.command,
      args: sandbox.args,
      commandOverride: sandbox.commandOverride,
    });

    let shell: PtyShell;
    try {
      shell = openShell({
        sprite,
        cols,
        rows,
        sessionId: attachSessionId,
        command: launch.command,
        args: launch.args,
        cwd: sandbox.cwd,
        // The watchdog's idle signal, read off the SAME clock the Tasks API
        // hold ticks on (`startTaskHoldHeartbeat` below): once this session
        // has been idle long enough for the platform hold to be dropped, the
        // watchdog stops reattaching for it too, instead of reconnecting to
        // the Sprite every ~45s for a viewer who is only watching an idle
        // prompt. The next keystroke reattaches transparently. See
        // `planWatchdogResponse`'s `attach-quiet`.
        //
        // `undefined` — "no trustworthy idleness signal, keep the socket up" —
        // for the ONE session whose silence proves nothing: a RESUMED agent
        // that has not yet emitted a byte to us. It was verified live at
        // connect, so it may be mid-run and merely thinking; our clock holds
        // nothing but the connect stamp, and letting that age into a quiet
        // verdict would drop the hold (see the tick below) and pause the
        // sprite under a working agent. This is the SAME trust rule
        // `disconnectConnection` already applies to its own hold tick
        // (`hasOutput || !resumedAtCreate`) — silence is only evidence of
        // idleness once we have heard this session speak at least once. The
        // moment it does, `hasOutput` flips and the normal idle window governs.
        getLastActivityAt: () =>
          (session.hasOutput || !session.resumedAtCreate ? latestActivityAt(session) : undefined),
        // The window the hold is ACTUALLY judging idleness on — configurable
        // (`SPRITE_TASK_HOLD_REFRESH_MS`), so it is read from the controller
        // rather than assumed to be the default. Both signals must answer "may
        // this sprite pause?" on the same window or they contradict each other.
        // A getter because the controller is built after this shell is opened;
        // `undefined` (no hold wired) falls back to `TASK_HOLD_AGENT_IDLE_MS`.
        getIdleMs: () => session.taskHold?.agentIdleMs,
        onOutput: (data) => {
          // The hold's "agent output is flowing" signal — kept fresh here so
          // a DETACHED session with an agent mid-run keeps its sprite up.
          session.lastOutputAt = Date.now();
          appendScrollback(session, data);
          broadcastOutput(session, data);
        },
        onExit: (exitCode) => {
          session.releaseSlot();
          loggers.realtime.info('Agent terminal session closed', { exitCode, sandboxId, sessionKey });
          broadcastClosed(session, exitCode);
          // Clears all of the session's timers (re-auth, settle heartbeat, idle).
          endAgentTerminalSession(billing, sessionMap, session, sessionKey);
        },
        // A fresh Sprite session was created and announced its own id (on its
        // own socket — see `readSessionInfoId`): this terminal's first shell,
        // or a replacement for a streamSessionId left dangling by a pause.
        // Persist it so the next cold connect reattaches to THIS session. The
        // id is authoritative, so it can never name a sibling terminal's shell
        // — which is precisely what the retired listSessions before/after diff
        // could not guarantee on a Sprite with concurrent terminals.
        //
        // Writes are CHAINED, not fired in parallel. A flapping Sprite can
        // create session A, drop, and create session B in quick succession;
        // two independent un-awaited UPDATEs race, and if A's lands last the
        // DB ends up naming the session that is already dead, sending the next
        // cold connect at a corpse. Serializing keeps the last write the last
        // session. A failed write is logged and does NOT break the chain — the
        // next session's id still gets its turn.
        onSessionId: (sessionId) => {
          session.sessionId = sessionId;
          persistQueue = persistQueue
            .then(() => persistStreamSessionId({ agentTerminalId: sandbox.agentTerminalId, sessionId }))
            .catch((error) => {
              loggers.realtime.error('Failed to persist agent terminal session id', error instanceof Error ? error : new Error(String(error)), {
                sessionKey,
              });
            });
        },
      });
    } catch {
      releaseSlot();
      if (holdId) void billing?.releaseHold(holdId).catch(() => {});
      return { kind: 'failed', reason: 'open_failed' };
    }

    session.command = shell;
    sessionMap.setNew(sessionKey, viewer?.key, session);

    // Nobody is watching this PTY — a HEADLESS start. The reap that collects a
    // viewer-less session (releasing its slot and settling its billing) is
    // normally armed by the last viewer LEAVING, a transition a session that
    // never had one cannot reach. Arm it here instead, so a shell an agent
    // started and then forgot about is collected on the same clock as one a
    // human opened and closed — rather than running, billing and holding a
    // slot for the life of the process.
    //
    // Deliberately NOT paired with `setViewerAttached(false)`: the shell opens
    // attached, and an agent reading this session's bytes over `read_session`
    // is as real a consumer of them as a pane is. An idle headless session
    // still quiets its own socket through the watchdog's `attach-quiet`
    // verdict, and the next `send_session` resumes it — so keeping it attached
    // costs no sprite residency, and losing output an agent asked for would.
    if (session.viewers.size === 0) armIdleReap(billing, sessionMap, session);

    // Sprites Tasks API hold (leaf 5-1): tell the platform work is in
    // progress so the sprite can't cold-pause an agent mid-run — and stop
    // telling it the moment nothing is (see startTaskHoldHeartbeat). Armed
    // only on the cold path: a reattach joins a session whose controller
    // and heartbeat already live for exactly as long as the session does
    // (cleared in endAgentTerminalSession).
    if (createTaskHold) {
      session.taskHold = createTaskHold({ sprite, sessionKey });
      session.holdInterval = startTaskHoldHeartbeat(session.taskHold, sessionMap, session, sessionKey);
    }

    // Heartbeat settle (see SETTLE_HEARTBEAT_MS): bill the accrued window and
    // re-hold on an interval so a realtime restart loses at most one interval
    // of runtime, not the whole session. A gate DENIAL (payer out of credits)
    // tears the session down exactly like a failed re-auth below.
    if (billing) {
      session.settleInterval = startSettleHeartbeat(billing, sessionMap, session, sessionKey);
    }

    // Periodically re-check authorization while the session is alive.
    //
    // This re-check reserves NOTHING: it never calls `resolveSandbox`, so it
    // takes no concurrency slot and has none to hand back. That is load-bearing,
    // not incidental — while the slot lived in the access check, this tick
    // competed with the very session it was checking. A free-tier user (limit 1)
    // whose one live session already held the only slot failed to acquire a
    // second, the tick read that `concurrency_limit` as a REVOKED authorization,
    // and tore the session down ~60s after it opened.
    //
    // Re-auth is PER-VIEWER (issue #2093): with N viewers attached, checking any
    // single identity would turn fan-out into a hole — a viewer whose access was
    // revoked would keep receiving output because someone else, still
    // authorized, was the one being checked. So every attached viewer is
    // checked (once per DISTINCT userId — two panes of one user are one DB
    // check) and a failing viewer is evicted INDIVIDUALLY (`evictViewer`):
    // their pane learns why, their registry entry and socket binding go, and
    // everyone else streams on uninterrupted. Their socket's own
    // `activeConnectionIds` entry goes stale, which is harmless — see
    // `removeViewer`. While DETACHED the tick keeps running DB-only checks
    // against the LAST attacher — whoever was watching when the session went
    // dark, or, for a headless start, whoever the agent was acting as —
    // because the PTY/agent process a viewer-less session leaves running
    // is not idle just because nobody is looking at it, and a revoked user's
    // still-running process must not get to keep executing, unsupervised,
    // until the 30-min idle reap. (Skipping the check while detached would
    // also buy nothing toward Sprite pause/billing — an open exec session
    // already counts as Sprite activity on its own, per
    // docs.sprites.dev/concepts/lifecycle.) And when the eviction loop
    // empties the viewer set and the last attacher is among the revoked, the
    // session is torn down IMMEDIATELY — same latency as the pre-#2093
    // whole-session teardown, no one-tick grace for an unsupervised revoked
    // process.
    //
    // A `checkAuth` that THROWS (a transient DB blip) revokes nobody this
    // tick — deliberately fail-open, in BOTH the attached and detached
    // shapes: revocation is a verdict, not an error, and a blip must not
    // kick live viewers or kill a detached session. (An uncaught throw here
    // would be worse than a wrong verdict: an async interval callback's
    // rejection is unhandled, and this process installs no unhandledRejection
    // hook, so one DB blip would take down every session on the replica.)
    //
    // `reauthing` mirrors `startSettleHeartbeat`'s `settling` guard: an
    // async interval body can outlive its own cadence when the DB is slow,
    // and overlapping ticks would stack redundant per-user auth queries onto
    // the very DB that is already struggling.
    let reauthing = false;
    const reAuthInterval = setInterval(async () => {
      const liveSession = sessionMap.getByKey(sessionKey);
      if (!liveSession) { clearInterval(reAuthInterval); return; }
      if (reauthing) return;
      reauthing = true;
      try {
        const attachedViewers = [...liveSession.viewers.entries()];
        const userIds = attachedViewers.length > 0
          ? [...new Set(attachedViewers.map(([, v]) => v.userId))]
          : [liveSession.lastViewerUserId];

        const revoked = new Set<string>();
        await Promise.all(
          userIds.map(async (uid) => {
            try {
              const result = await checkAuth({ userId: uid, machineId, projectName, branchName, name });
              if (!result.ok) revoked.add(uid);
            } catch (error) {
              // Fail-open — see above. Absent from `revoked` can only ever
              // mean "not revoked", so an error needs no sentinel encoding.
              loggers.realtime.warn('Agent terminal re-auth check failed; keeping viewer this tick', {
                sessionKey,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }),
        );

        // Re-check liveness after the await: another actor (heartbeat
        // insolvency, PTY exit, idle reap) may have torn the session down
        // while checkAuth ran — acting on the stale reference would double
        // kill/broadcast.
        if (sessionMap.getByKey(sessionKey) !== liveSession) {
          clearInterval(reAuthInterval);
          return;
        }

        for (const [viewerKey, attached] of attachedViewers) {
          if (!revoked.has(attached.userId)) continue;
          // Still the SAME viewer entry? It may have detached during the await —
          // and a same-key rejoin is a fresh object, checked next tick.
          if (liveSession.viewers.get(viewerKey) !== attached) continue;
          evictViewer(billing, sessionMap, liveSession, viewerKey, attached, 'Machine access revoked');
        }

        // Whole-session teardown ONLY with nobody watching: re-derived from
        // the live registry, not the pre-await snapshot, because an
        // authorized viewer can join DURING the checkAuth round-trip
        // (attachToLiveSession runs synchronously off another socket's
        // event) — the session object is unchanged so the identity guard
        // above cannot see them, and killing the PTY under a fully
        // authorized, just-joined pane would be exactly the takeover-era
        // harm this PR removes. If viewers exist now, they were either
        // checked this tick (and the revoked ones evicted) or they joined
        // mid-check and are checked next tick.
        if (liveSession.viewers.size === 0 && revoked.has(liveSession.lastViewerUserId)) {
          teardownAgentTerminalSession(billing, sessionMap, liveSession, sessionKey, -2);
        }
      } finally {
        reauthing = false;
      }
    }, 60_000);

    session.reAuthInterval = reAuthInterval;

    // Still inside the synchronous span that began at `openShell` — see
    // `onStarted`. Nothing above has awaited, so a socket caller's `ready` emit
    // leaves ahead of any output this shell has already produced.
    request.onStarted?.(resumed);

    return { kind: 'created', session, resumed };
  } finally {
    // Release the key claim on EVERY exit from the cold path — success, denial
    // or throw — so a failed create never wedges the key against future connects.
    finishCreate();
  }
}

/**
 * Pure: what a client is TOLD when a create failed, or `undefined` when it is
 * told nothing.
 *
 * A separate function from the create itself because the create must not know
 * about sockets, and because these strings are a wire contract the pane renders
 * verbatim — each maps byte-for-byte to what this surface emitted before the
 * headless split, so a client matching on them still matches.
 *
 * `'abandoned'` is the `undefined` arm rather than a message nobody reads: the
 * pane that asked has gone, and the create already released the slot and hold
 * it had taken. Total over the failure type, so a new arm cannot be added
 * without deciding what it says.
 */
export function connectFailureMessage(failure: Extract<EnsureSessionResult, { kind: 'failed' }>): string | undefined {
  switch (failure.reason) {
    case 'abandoned':
      return undefined;
    case 'denied':
      return `Agent terminal access denied: ${failure.message ?? 'unknown'}`;
    case 'insolvent':
      return 'Insufficient credits to open an agent terminal session.';
    case 'open_failed':
      return 'Failed to open agent terminal session';
  }
}

export function buildAgentTerminalHandlers({
  sessionMap,
  openShell,
  checkAuth,
  socket,
  persistStreamSessionId,
  billing,
  createTaskHold,
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

  /**
   * Connections inside `onConnect` — i.e. anywhere between the payload validating
   * and the connection landing in `activeConnectionIds`. That covers the access
   * check, waiting on a create another pane already has in flight, and the cold
   * create itself (resolving a Sprite, waking it, asking which sessions it has,
   * exec'ing the agent). Seconds, on a cold boot.
   *
   * A pane that goes away inside that window (the tab closed, the user switched
   * workspace, StrictMode's double-mount) sends its `agent-terminal:disconnect`
   * BEFORE the connect has registered anything to disconnect. Without this set the
   * message lands on nothing and the connect finishes into the void — and EVERY
   * exit from that void leaves a live PTY with no viewer:
   *
   *   - a cold create installs a session that is never detached, so it never arms
   *     the idle reap that releases its concurrency slot and settles its billing;
   *   - an attach (the reattach fast path, or a racer that lost a double-mount)
   *     is WORSE — it CANCELS a pending idle reap and registers a viewer for a
   *     socket that is already gone.
   *
   * Either way nothing collects it: an agent CLI sits at its prompt forever, and no
   * further disconnect can arrive for a socket that has already left. It runs for
   * the life of the process. On the free tier (one terminal) that locks the user out.
   *
   * So the window is the WHOLE of `onConnect`, and every path out of it DECLINES
   * rather than binding-and-undoing. Both halves of that matter:
   *
   *   - An ATTACH must not happen, because `attachToLiveSession` adds a viewer
   *     entry nothing will ever remove — no disconnect can arrive for a pane that
   *     already left — so the session would count a ghost among its viewers
   *     forever: the "last viewer leaves" transition (watchdog quiet, task-hold
   *     release, idle reap) never fires, and the PTY runs for the life of the
   *     process. Declining leaves the session exactly as it was: its live
   *     viewers, or a reap already ticking.
   *   - A CREATE must not happen either. Tearing an abandoned create down afterwards
   *     is safe (nobody else is watching a PTY that did not exist a moment ago) but
   *     it is not free: the reap is armed for DETACHED_IDLE_MS, so it would hold a
   *     concurrency slot and bill the machine's payer for thirty minutes of Sprite
   *     runtime for an agent nobody ever saw.
   *
   * The check sits after the last `await` before the PTY exists (`sessionLiveness`);
   * `openShell` is synchronous, so nothing can be abandoned between the check and the
   * session being installed. Once installed, an ordinary disconnect collects it.
   */
  const connectingConnectionIds = new Set<string>();
  /** Connects whose pane went away before they had bound a session. */
  const abandonedWhileConnecting = new Set<string>();

  /** The pane behind this connect is already gone — see `connectingConnectionIds`. */
  function abandoned(connectionId: string): boolean {
    return abandonedWhileConnecting.has(connectionId);
  }

  /**
   * The key a session is filed under on its VIEWER side.
   *
   * `connectionId` is a UUID the CLIENT mints, and `agentTerminalSessionMap` is one
   * shared, server-wide instance — so filing by the bare id lets one client's chosen
   * string address ANOTHER client's session. Two sockets picking the same id (a
   * buggy client, or a hostile one: it is validated only as a non-empty string) then
   * collide inside the map, where `setNew` silently overwrites the socket entry of a
   * session that is still running. That session is then unreachable: no viewer, no
   * armed reap, so its PTY, its concurrency slot and its billing heartbeat run for
   * the life of the process — billed to the MACHINE's payer, not the caller's. Worse,
   * the first socket's later disconnect resolves to the SECOND socket's session and
   * reaps it, killing a terminal someone else is watching.
   *
   * Namespacing by the server-assigned socket id makes that collision unrepresentable
   * rather than merely detected: a client can only ever name its own connections.
   */
  const socketKey = (connectionId: string) => `${socket.id}\u0000${connectionId}`;

  function disconnectConnection(connectionId: string) {
    const session = sessionMap.getBySocket(socketKey(connectionId));
    activeConnectionIds.delete(connectionId);
    if (!session) return;
    // Removing the viewer's registry entry IS the silencing: nothing emits to
    // this pane again. Other viewers (and the detach transition, when this was
    // the last one) are `removeViewer`'s business.
    removeViewer(billing, sessionMap, session, socketKey(connectionId));
  }

  /**
   * The one place a viewer entry is built — the create path registers the
   * creator through this too, so the wire contract (two event names, two
   * payload shapes, the connectionId tag the client routes panes by) is
   * spelled exactly once and joiner panes can never drift from creator panes.
   */
  const makeViewer = (connectionId: string, userId: string): TerminalViewer => ({
    userId,
    emitOutput: (data) => socket.emit('agent-terminal:output', { data, connectionId }),
    emitClosed: (exitCode) => socket.emit('agent-terminal:closed', { exitCode, connectionId }),
    emitError: (message) => socket.emit('agent-terminal:error', { message, connectionId }),
  });

  /**
   * JOIN this connection to an ALREADY-RUNNING session and hand the viewer its
   * buffered scrollback: cancel any pending idle reap, add a viewer entry for
   * this socket+pane, and add its socket binding. Reserves nothing and touches
   * no Sprite. Any number of viewers may be attached at once (issue #2093) —
   * joining never disturbs the viewers already watching, each gets output
   * tagged with its own connectionId, and every attached authorized viewer can
   * type (deliberate tmux-style free-for-all; there is no driver/write-lock).
   *
   * Two paths land here: the tab-back fast path (`planConnect` -> 'reattach'),
   * and a cold-path racer that lost a double-mount (see `onConnect`) — both are
   * "someone else's PTY is already live under this key; join it".
   */
  function attachToLiveSession(session: TerminalSession, connectionId: string, viewerUserId: string) {
    // Registration first, and all three tracking structures in one
    // uninterrupted block: the registry entry, its socket binding, and this
    // socket's connection set are pure Map/Set writes that cannot throw, so
    // the viewer is either fully tracked or not tracked at all. The fallible
    // calls (the shell resume, the task-hold tick) come AFTER — if one of
    // them throws, every tracking entry exists and an ordinary disconnect
    // still collects this viewer. The reverse order would leave a GHOST: a
    // registry entry in no tracking set, which nothing can ever remove, so
    // `viewers.size` never returns to zero and the last-viewer transition —
    // the reap, the slot release, the billing settle behind it — never fires
    // for the life of the process.
    session.viewers.set(socketKey(connectionId), makeViewer(connectionId, viewerUserId));
    sessionMap.addBinding(session.sessionKey, socketKey(connectionId));
    activeConnectionIds.add(connectionId);
    if (session.idleTimer !== undefined) {
      clearTimeout(session.idleTimer);
      session.idleTimer = undefined;
    }
    // The most recent attacher — the identity the re-auth tick falls back to
    // while the session is detached. Attached viewers are each checked
    // individually off the registry entry added above.
    session.lastViewerUserId = viewerUserId;
    // A viewer is here: let the shell reattach lazily if its watchdog went quiet
    // while detached (sprites-shell.ts's `setViewerAttached`) — a no-op when a
    // live viewer already has the connection up, since output is already flowing.
    // Called on EVERY join, not just the first: idempotent, and a joiner waking
    // a quiesced shell is wanted regardless of how many others are watching.
    session.command.setViewerAttached(true);
    // The line above resumes a shell that quiesced while they were gone, which
    // wakes the Sprite — so the payer is consuming a sandbox again and the
    // billing clock (stopped at the quiesce — see `settleAccruedWindow`'s
    // `stopClock`) restarts HERE, not at the next ten-minute heartbeat. A no-op
    // for a session that never quiesced: its clock never stopped.
    resumeBillingClock(session);
    // A viewer is back AND the `setViewerAttached(true)` above has just resumed
    // the shell's socket, so the hold (deleted while idle) is re-created
    // immediately rather than waiting out a heartbeat interval. Derived, not
    // hardcoded `true`: `attached` means "a LIVE exec connection exists" (see
    // `startTaskHoldHeartbeat`), and a viewer alone no longer earns a hold.
    // Both terms are necessarily true right here — the resume clears quiescence
    // synchronously — so this is the same value either way; deriving it is what
    // keeps the two tick sites from drifting apart.
    session.taskHold?.tick({
      attached: session.viewers.size > 0 && !session.command.isQuiesced(),
      lastActivityAt: latestActivityAt(session),
      activityObservable: true,
    });
    // `resumed` says the agent was ALREADY DOING THINGS before this connect, so a
    // client holding a starting prompt must not type it. Asking `hasOutput` rather
    // than "is the scrollback non-empty": one chunk over the scrollback cap is
    // trimmed straight back off, leaving an empty buffer for a session that has
    // been producing output for hours. A session that has emitted NOTHING is the
    // boot a pane is still waiting for (a re-mount onto a silent cold start), and
    // may still be prompted.
    socket.emit('agent-terminal:ready', {
      scrollback: session.scrollback.join(''),
      resumed: session.hasOutput || session.resumedAtCreate,
      connectionId,
    });
  }

  /**
   * The connect proper, once the payload is known good. Its caller holds the
   * connection in `connectingConnectionIds` for the whole of it — every path out
   * of here either binds a session (and settles any abandonment) or binds nothing.
   */
  async function establishConnection(value: AgentTerminalConnectPayload, connectionId: string) {
    const { machineId, projectName, branchName, name, cols, rows } = value;
    const { cols: clampedCols, rows: clampedRows } = clampTerminalDimensions({ cols, rows });

    const userId = socket.data.user?.id ?? '';

    // The access check is DB-only (leaf 1-2), reserves no concurrency slot, and
    // the session key derives from the (scope, name) target without the Sprite
    // (leaf 1-1) — so the live in-memory session lookup happens HERE, before
    // anything has resolved, woken or written policy to a Sprite. A tab-back
    // inside the detached grace window is therefore decided on the strength of
    // the access check alone: milliseconds, not the seconds a sandbox
    // resolution costs.
    const accessResult = await checkAuth({ userId, machineId, projectName, branchName, name });
    const existingSession = accessResult.ok ? sessionMap.getByKey(accessResult.sessionKey) : undefined;
    const plan = planConnect({ accessResult, existingSession });

    if (plan.kind === 'deny') {
      socket.emit('agent-terminal:error', { message: `Agent terminal access denied: ${plan.reason}`, connectionId });
      return;
    }

    if (plan.kind === 'reattach') {
      // No slot to release: reattaching starts no PTY, so the access check
      // reserved none. The live session still holds the one it was created
      // with, and keeps it until it is torn down or reaped.
      // Gone already: decline rather than attach. Attaching would take the session
      // away from whoever has it (a live pane, or a pending reap) on behalf of a
      // socket that no longer exists — see `abandoned`.
      if (abandoned(connectionId)) return;
      attachToLiveSession(plan.session, connectionId, userId);
      return;
    }

    // Everything from here STARTS a PTY, and that sequence is not this
    // socket's — it is shared verbatim with a headless agent start
    // (`ensureAgentTerminalSession`). What this connect contributes is the two
    // things only a socket has: the pane that will watch the result, and
    // whether that pane is still there by the time there is one.
    const outcome = await ensureAgentTerminalSession(
      { sessionMap, openShell, checkAuth, persistStreamSessionId, billing, createTaskHold },
      {
        access: plan.access,
        target: { machineId, projectName, branchName, name },
        userId,
        cols: clampedCols,
        rows: clampedRows,
        viewer: { key: socketKey(connectionId), viewer: makeViewer(connectionId, userId) },
        abandoned: () => abandoned(connectionId),
        // Synchronous with the install, so `ready` cannot be overtaken by the
        // shell's own first output — see `onStarted`. This is also where the
        // creator's connection joins `activeConnectionIds`: its viewer entry and
        // socket binding went in inside the create (before `openShell`, so no
        // output could be missed), and the three tracking structures must be
        // installed in one uninterrupted, throw-free block.
        onStarted: (resumed) => {
          activeConnectionIds.add(connectionId);
          // `resumed` says whether this connect picked up an agent that was
          // ALREADY RUNNING, or started a fresh one. The client cannot infer it:
          // after a restart of THIS process the session map is empty, so a
          // connect to an agent that has been running for hours takes the create
          // path and looks exactly like a cold boot. A caller that types a
          // starting prompt into the terminal has to know the difference — a
          // line plus a carriage return delivered to a live agent sitting at a
          // confirmation is destructive.
          //
          // It is a VERIFIED fact, not the row's word for it. `streamSessionId`
          // is a memory of a session that was alive once: exec sessions do not
          // survive a Sprite pause, nothing ever clears the column, and
          // `openPtyShell` attaches to the id optimistically and only discovers
          // it is dangling when the socket fails — at which point it quietly
          // launches a FRESH agent (`planReconnect`). Trusting the row would tell
          // that fresh agent's pane its prompt had already been taken, and the
          // agent would sit there having never been given its task. So we ask the
          // Sprite which sessions it actually has.
          socket.emit('agent-terminal:ready', { connectionId, resumed });
        },
      },
    );

    if (outcome.kind === 'existing') {
      // Someone else's create installed this session while we waited on it (a
      // double-mount's loser, or a racer that got there first). Same rule as the
      // reattach path above: a pane that has left must not take the session the
      // creator is watching. The creator settles its own abandonment.
      if (abandoned(connectionId)) return;
      attachToLiveSession(outcome.session, connectionId, userId);
      return;
    }

    if (outcome.kind === 'failed') {
      // `undefined` is the abandoned arm — nobody is left to tell.
      const message = connectFailureMessage(outcome);
      if (message !== undefined) socket.emit('agent-terminal:error', { message, connectionId });
      return;
    }
  }

  return {
    async onConnect(payload: unknown) {
      const validation = validateAgentTerminalConnectPayload(payload);
      if (!validation.ok) {
        // Tagged like every other emit, even though the payload it is complaining
        // about is malformed. ONE socket carries every pane in the grid, and a
        // client treats an untagged event as its own — so an untagged error is
        // shown by EVERY pane. And no `?? socket.id` fallback: a connectionId is a
        // UUID the client minted, never the socket's own id, so falling back to
        // socket.id would match NO pane and the error would be swallowed in
        // silence. Left undefined it degrades to the old broadcast — every pane
        // shows it — which is worse than one pane showing it, but far better than
        // nobody seeing it at all.
        socket.emit('agent-terminal:error', {
          message: validation.error,
          connectionId: readConnectionId(payload),
        });
        return;
      }
      const connectionId = validation.value.connectionId ?? socket.id;

      // Reusing an id THIS SOCKET already has in flight does not merely confuse the
      // bookkeeping, it defeats it: the first connect's `finally` clears the abandon
      // mark the second is relying on, and the second's `setNew` displaces the first's
      // still-running session — leaving a PTY with no viewer and no armed reap, its
      // concurrency slot and billing heartbeat running for the life of the process.
      //
      // Cross-SOCKET reuse is not checked here, and must not be: these sets are this
      // socket's own, so a check against them could never have seen another socket's
      // ids anyway. That collision is prevented at the source instead, by `socketKey`
      // — a client can only ever name its own connections.
      //
      // The real client mints a fresh UUID per mount and disconnects on unmount, so
      // this never fires for honest traffic — but "the client wouldn't do that" is
      // not an invariant.
      if (activeConnectionIds.has(connectionId) || connectingConnectionIds.has(connectionId)) {
        socket.emit('agent-terminal:error', { message: 'Agent terminal connectionId already in use', connectionId });
        return;
      }

      // Held for the WHOLE connect, not just the create: a pane can leave while the
      // access check is still running, and the attach paths below would otherwise
      // take a live pane's session away from it on behalf of a socket that is gone.
      connectingConnectionIds.add(connectionId);
      try {
        await establishConnection(validation.value, connectionId);
      } finally {
        connectingConnectionIds.delete(connectionId);
        abandonedWhileConnecting.delete(connectionId);
      }
    },

    onInput(payload: unknown) {
      // Every attached authorized viewer passes this guard — multi-viewer write
      // access is deliberately tmux-style free-for-all (issue #2093); there is
      // no driver/write-lock. The guard's job is authenticity, not exclusivity:
      // only a connection THIS socket established (and whose binding a re-auth
      // eviction has not since removed) reaches the PTY.
      const connectionId = readConnectionId(payload) ?? socket.id;
      if (!activeConnectionIds.has(connectionId)) return;
      const session = sessionMap.getBySocket(socketKey(connectionId));
      if (!session) return;
      const p = payload as { data?: string };
      if (typeof p?.data === 'string' && p.data.length <= MAX_INPUT_BYTES) {
        // Input is activity for the task hold: a typed prompt is work in
        // progress even before the agent's first byte of output.
        session.lastInputAt = Date.now();
        // A keystroke also RESUMES a quiesced shell (sprites-shell.ts's `write`
        // pays back the swallowed watchdog trip), which wakes the Sprite and
        // re-takes the platform hold — so the payer starts consuming a sandbox
        // again, and the billing clock has to start with it. Done here, at the
        // instant of the keystroke, rather than at the next heartbeat: that is
        // ten minutes away (`SETTLE_HEARTBEAT_MS`), and every one of those
        // minutes would otherwise be billed as free.
        resumeBillingClock(session);
        session.command.write(p.data);
      }
    },

    onResize(payload: unknown) {
      // With several viewers attached the last resize wins — the PTY has one
      // geometry. Documented, not solved (issue #2093 non-goal).
      const connectionId = readConnectionId(payload) ?? socket.id;
      if (!activeConnectionIds.has(connectionId)) return;
      const session = sessionMap.getBySocket(socketKey(connectionId));
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
        } else if (connectingConnectionIds.has(explicitConnectionId)) {
          // It has not bound a session yet. Remember, and tear it down the moment it does.
          abandonedWhileConnecting.add(explicitConnectionId);
        }
        return;
      }
      // The socket itself disconnected (tab closed/reloaded, network drop) —
      // every connection this socket had open loses its viewer at once.
      for (const connectionId of [...activeConnectionIds]) {
        disconnectConnection(connectionId);
      }
      // Including the ones still mid-connect: the tab is gone, and whatever they
      // bind — a PTY they create, or one they join — must not be left with no viewer.
      for (const connectionId of connectingConnectionIds) {
        abandonedWhileConnecting.add(connectionId);
      }
    },
  };
}
