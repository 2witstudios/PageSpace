import type { PtyShell } from './sprites-shell';
import type { TaskHoldController } from '@pagespace/lib/services/sandbox/sandbox-client/sprite-tasks';

export const MAX_SCROLLBACK_BYTES = 64 * 1024;
export const DETACHED_IDLE_MS = 30 * 60 * 1000;

export type TerminalSession = {
  command: PtyShell;
  sandboxId: string;
  sessionKey: string;
  /**
   * The user CURRENTLY attached to this session — the creator, or whoever last
   * reattached. A session outlives its creator's connection, so this is the
   * identity the 60s re-auth tick must re-check: checking the creator would leave
   * a reattached viewer whose access was revoked still driving the PTY.
   */
  viewerUserId: string;
  /** Detachable exec session id on the Sprite, used to reattach after a WS drop. */
  sessionId?: string;
  /**
   * Is a viewer currently attached? Set true on create/reattach, false on
   * detach — one of the two "work is in progress" signals the Sprites Tasks
   * API hold (leaf 5-1) keys on. Kept explicit rather than inferred from
   * `idleTimer === undefined` so the hold heartbeat reads a stated fact, not
   * a coincidence of the reap machinery.
   */
  viewerAttached: boolean;
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
  outputFn: (data: string) => void;
  closedFn: (exitCode: number) => void;
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

export type TerminalSessionMap = {
  getBySocket(socketId: string): TerminalSession | undefined;
  getByKey(sessionKey: string): TerminalSession | undefined;
  setNew(sessionKey: string, socketId: string, session: TerminalSession): void;
  reattach(sessionKey: string, newSocketId: string): void;
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
