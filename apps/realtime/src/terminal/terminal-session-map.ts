import type { PtyShell } from './sprites-shell';
import type { TaskHoldController } from '@pagespace/lib/services/sandbox/sandbox-client/sprite-tasks';

export const MAX_SCROLLBACK_BYTES = 64 * 1024;
export const DETACHED_IDLE_MS = 30 * 60 * 1000;

/**
 * One attached viewer of a session — a (socket, pane) pair. A session holds a
 * SET of these (issue #2093): attach is a join, not a takeover, so any number
 * of browsers can watch the same PTY. The emit callbacks close over that
 * viewer's own socket AND its client-minted connectionId — every payload they
 * emit is stamped with that connectionId, which is how the client routes
 * events to the right pane (several panes multiplex one socket).
 *
 * `emitClosed` says the PROCESS ended (the pane prints an exit code);
 * `emitError` says something happened to THIS VIEWER (the pane prints the
 * message). An eviction — access revoked while the PTY keeps running for
 * everyone else — must use `emitError`: telling that one pane the process
 * exited would be false, and its user's next move (reopen, file a crash
 * report) would be built on it.
 */
export type TerminalViewer = {
  userId: string;
  emitOutput(data: string): void;
  emitClosed(exitCode: number): void;
  emitError(message: string): void;
};

export type TerminalSession = {
  command: PtyShell;
  sandboxId: string;
  sessionKey: string;
  /**
   * The MOST RECENT attacher — the creator, or whoever last joined, updated to
   * the departing viewer when the last one leaves. While viewers are attached
   * the 60s re-auth tick checks every one of them individually; this field is
   * the identity it checks while the session is DETACHED, so a revoked user's
   * still-running process cannot keep executing, unsupervised, until the
   * 30-min idle reap.
   */
  lastViewerUserId: string;
  /** Detachable exec session id on the Sprite, used to reattach after a WS drop. */
  sessionId?: string;
  /**
   * Every attached viewer, keyed by the handler's namespaced socketKey
   * (`${socket.id}\u0000${connectionId}`) — the SAME string the map's
   * `bySocket` uses, so removing a viewer and removing its binding always
   * share a key. INVARIANT: a viewer entry, its `bySocket` binding, and its
   * handler-side `activeConnectionIds` membership are installed in one
   * uninterrupted (throw-free) block and removed together (`removeViewer` /
   * `disconnectConnection`) — a viewer registered without its tracking
   * entries would be a ghost no disconnect can ever remove, pinning the
   * last-viewer detach transition (and the PTY, slot, and billing behind it)
   * for the life of the process. Attached-ness is derived:
   * `viewers.size > 0`. Output is fanned out to every entry
   * (`broadcastOutput`); ALL attached authorized viewers may type (a
   * deliberate tmux-style decision — issue #2093 — there is no
   * driver/write-lock).
   */
  viewers: Map<string, TerminalViewer>;
  /** When the PTY last produced output — half of the hold's activity signal. */
  lastOutputAt?: number;
  /**
   * When the viewer last typed into the PTY (or the PTY was launched — the
   * launch counts as the first input). The other half of the hold's activity
   * signal: a prompt that kicks off a long SILENT run has produced no output
   * yet, and a detach in that window must not read as "agent idle" and delete
   * the hold out from under work that has already started.
   */
  lastInputAt?: number;
  /** The session's platform task hold (Sprites Tasks API), when the seam is wired. */
  taskHold?: TaskHoldController;
  /** Heartbeat driving `taskHold` ticks on the refresh cadence. */
  holdInterval?: ReturnType<typeof setInterval>;
  reAuthInterval?: ReturnType<typeof setInterval>;
  /** Heartbeat that settles the accrued active window mid-session (see agent-terminal-handler), bounding what a realtime restart can lose to one interval. */
  settleInterval?: ReturnType<typeof setInterval>;
  idleTimer?: ReturnType<typeof setTimeout>;
  releaseSlot(): void;
  scrollback: string[];
  scrollbackBytes: number;
  /**
   * Has this PTY ever produced a byte? NOT the same question as "is the
   * scrollback non-empty": a single chunk larger than MAX_SCROLLBACK_BYTES is
   * pushed and then trimmed straight back off, leaving an EMPTY scrollback for a
   * session that has been screaming output. A client that types a starting prompt
   * into a terminal reads "has produced nothing" as "still booting, safe to type"
   * — so it has to be the truth, not an artefact of the trim.
   */
  hasOutput: boolean;
  /**
   * Was this PTY already running when the bridge picked it up? (`openShell`
   * resumed a Sprite exec session rather than starting one.)
   *
   * Kept ALONGSIDE `hasOutput` because the two answer the same question at
   * different moments and neither covers the other: a resumed agent that has not
   * yet said anything has `hasOutput: false`, and a reattach in that window would
   * otherwise be told the PTY is a fresh boot — and a client holding a starting
   * prompt would type it into an agent that has been running for hours.
   */
  resumedAtCreate: boolean;
  /**
   * Terminal Epic 3 metering (optional — set only when a `billing` seam is
   * wired). `payerId` + `connectedAt` identify who pays for the window that
   * started at `connectedAt` (rebased by each heartbeat settle); `holdId` is the
   * window's reservation when the gate placed one — settle records usage either
   * way, the hold is just the pre-authorization.
   */
  payerId?: string;
  holdId?: string;
  connectedAt?: number;
  /** The Terminal page this session is for — the usage-breakdown's per-machine attribution key. */
  pageId?: string;
  /**
   * The `machine_agent_terminals` row this PTY belongs to (issue #2205's
   * cold-tail persist). Known ONLY on the create path
   * (`AgentTerminalSandboxResult.agentTerminalId`) — the only path that
   * constructs a session — so a session with no row to persist onto (should
   * that ever happen) simply persists nothing on teardown.
   */
  agentTerminalId?: string;
};

export function appendScrollback(
  session: Pick<TerminalSession, 'scrollback' | 'scrollbackBytes' | 'hasOutput'>,
  data: string,
): void {
  const bytes = Buffer.byteLength(data, 'utf8');
  session.hasOutput = true;
  session.scrollback.push(data);
  session.scrollbackBytes += bytes;
  while (session.scrollbackBytes > MAX_SCROLLBACK_BYTES && session.scrollback.length > 0) {
    const removed = session.scrollback.shift()!;
    session.scrollbackBytes -= Buffer.byteLength(removed, 'utf8');
  }
}

/**
 * Fan a PTY output chunk out to every attached viewer, each tagged with its own
 * connectionId (inside `emitOutput`). Zero viewers -> zero emits — a detached
 * session's output goes only to the scrollback, exactly as before.
 */
export function broadcastOutput(session: Pick<TerminalSession, 'viewers'>, data: string): void {
  for (const viewer of session.viewers.values()) viewer.emitOutput(data);
}

/** Fan a PTY exit out to every attached viewer. Zero viewers -> zero emits. */
export function broadcastClosed(session: Pick<TerminalSession, 'viewers'>, exitCode: number): void {
  for (const viewer of session.viewers.values()) viewer.emitClosed(exitCode);
}

export type TerminalSessionMap = {
  getBySocket(socketId: string): TerminalSession | undefined;
  getByKey(sessionKey: string): TerminalSession | undefined;
  setNew(sessionKey: string, socketId: string, session: TerminalSession): void;
  /**
   * Bind one more socket to a live session's key. `bySocket` is many-to-one
   * (issue #2093): every attached viewer holds its own binding, and joining
   * never disturbs the bindings of the viewers already watching.
   */
  addBinding(sessionKey: string, socketId: string): void;
  detach(socketId: string): void;
  deleteByKey(sessionKey: string): void;
  /**
   * The cold create already in flight for this key, if any — see `trackCreate`.
   */
  pendingCreate(sessionKey: string): Promise<void> | undefined;
  /**
   * Claim this key for a cold create that is about to run, so a concurrent
   * connect for the SAME key joins it instead of opening a second PTY.
   *
   * A cold create is slow (it resolves, and may wake, a Sprite), and a
   * double-mount fires its second connect straight into that window. Both would
   * otherwise see an empty map, both open a PTY, and `setNew` would silently
   * overwrite one — orphaning a live PTY that nothing can reach to kill and
   * stranding its concurrency slot for the life of the process. Worse, when the
   * two attach to the same PERSISTED Sprite exec session, killing the duplicate
   * would SIGKILL the process the survivor is attached to.
   *
   * Serializing at the key is what makes all of that unrepresentable: exactly one
   * cold create per key runs at a time, so a second PTY is never opened at all.
   * The claim is released when `create` settles (or when `setNew` installs the
   * session), whichever happens first.
   */
  trackCreate(sessionKey: string, create: Promise<void>): void;
};

export function createTerminalSessionMap(): TerminalSessionMap {
  const bySocket = new Map<string, string>();        // socketId → sessionKey
  const byKey = new Map<string, TerminalSession>();  // sessionKey → session
  const creating = new Map<string, Promise<void>>(); // sessionKey → in-flight cold create

  return {
    pendingCreate(sessionKey) {
      return creating.get(sessionKey);
    },
    trackCreate(sessionKey, create) {
      creating.set(sessionKey, create);
      // Drop the claim once this create settles — but only if it is still OURS,
      // so a later create for the same key can't have its claim revoked by an
      // earlier one finishing late.
      void create
        .catch(() => {})
        .finally(() => {
          if (creating.get(sessionKey) === create) creating.delete(sessionKey);
        });
    },
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
    addBinding(sessionKey, socketId) {
      bySocket.set(socketId, sessionKey);
    },
    detach(socketId) {
      bySocket.delete(socketId);
    },
    deleteByKey(sessionKey) {
      // ALL bindings, not just the first: N viewers hold N bySocket entries,
      // and a survivor left dangling would resolve a detached viewer's later
      // input to a future session reusing this key.
      for (const [sid, key] of bySocket) {
        if (key === sessionKey) bySocket.delete(sid);
      }
      byKey.delete(sessionKey);
    },
  };
}
