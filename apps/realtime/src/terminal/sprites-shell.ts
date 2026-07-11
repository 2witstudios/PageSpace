import { isPreOpenWakeError } from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import type {
  SpriteInstanceLike,
  SpriteCommandLike,
  SpriteSessionInfo,
} from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import { SANDBOX_ROOT } from '@pagespace/lib/services/sandbox/sandbox-paths';

/**
 * The Sprite's live shell (tty) sessions, active ones first — the single source
 * of the "which shell" ordering that both `pickShellSession` (takes the first)
 * and `liveShellSessionIds` (maps to ids) build on, so the tiebreaker can never
 * silently diverge between them. Match on `tty` rather than `isActive` — the
 * API's `is_active` semantics (process-alive vs client-attached) are
 * undocumented and a detached-but-running shell may report `is_active: false`;
 * `isActive` is only the ordering tiebreaker.
 */
function orderedShellSessions(sessions: SpriteSessionInfo[]): SpriteSessionInfo[] {
  const shells = sessions.filter((s) => s.tty);
  const active = shells.filter((s) => s.isActive);
  const inactive = shells.filter((s) => !s.isActive);
  return [...active, ...inactive];
}

/**
 * Pick the live interactive shell to reattach to from a Sprite's exec sessions
 * (active first, else the first shell). One page = one Sprite, but a Sprite can
 * host several tty sessions across concurrent terminals — see
 * `agent-terminal-handler`'s module doc — so this "any live shell" pick is only
 * safe when the caller has no better id; prefer a persisted/diffed id.
 */
export function pickShellSession(sessions: SpriteSessionInfo[]): SpriteSessionInfo | undefined {
  return orderedShellSessions(sessions)[0];
}

/**
 * Live shell (tty) session ids ordered so index 0 equals `pickShellSession`'s
 * pick. The full ordered list lets `planReconnect` test whether a persisted id
 * is still among the live sessions while also naming a fallback to attach to
 * when the known id is unset.
 */
export function liveShellSessionIds(sessions: SpriteSessionInfo[]): string[] {
  return orderedShellSessions(sessions).map((s) => s.id);
}

/**
 * The id of the tty (shell) session that appeared AFTER a create, identified by
 * diffing against the ids that existed BEFORE it. A Sprite can host several tty
 * sessions at once (one per concurrent terminal — see agent-terminal-handler's
 * module doc), so "any tty session" is ambiguous; only a before/after diff
 * reliably names OUR freshly created shell (mirrors the connect path's
 * `discoverNewSessionId`). Returns undefined when the diff is empty OR when more
 * than one new tty session appeared — a concurrent terminal creating its own
 * shell in the same window is indistinguishable from ours, so we persist nothing
 * rather than risk overwriting the DB with another terminal's id.
 */
export function newTtySessionId(beforeIds: string[], after: SpriteSessionInfo[]): string | undefined {
  const before = new Set(beforeIds);
  const created = after.filter((s) => s.tty && !before.has(s.id));
  return created.length === 1 ? created[0].id : undefined;
}

export type ReconnectPlan =
  | { action: 'attach'; id: string }
  | { action: 'create' }
  | { action: 'fatal' };

/**
 * Decide how a dropped shell should reconnect. Exec sessions do NOT survive a
 * Sprite pause (docs.sprites.dev/concepts/lifecycle — "open network connections"
 * are "lost on any pause"), so a persisted `streamSessionId` can be dangling: it
 * MUST be verified against the sessions the Sprite currently reports live before
 * any retry. Pure by construction so every branch is unit-testable:
 *
 * - Over the retry budget → `fatal` (bounded — never an infinite loop).
 * - Known id still live → `attach` it (reattach + replay scrollback; unchanged).
 * - Known id absent from the live list → `create` a fresh session (the stale id
 *   is dead; the shell overwrites the persisted streamSessionId).
 * - No known id but a live shell exists → `attach` it (fresh-create path whose
 *   background id-capture hasn't landed yet).
 * - No known id, nothing live, and the drop was PRE-OPEN → `create` (see below).
 * - No known id and nothing live → `fatal` (the shell is genuinely gone).
 *
 * `preOpenDrop` is what keeps a COLD Sprite openable. A Sprite has no wake API —
 * an incoming request wakes it (docs.sprites.dev/concepts/lifecycle) — so the
 * first `createSession` against a hibernated VM IS its wake, and Fly's
 * wake-on-request can drop that first connection before it ever opens ("closed
 * before open"). At that moment there is no known id (we were creating one) and
 * nothing live (the VM is still booting): identical, on the surface, to a
 * genuinely dead shell. Without this flag that state reads as `fatal` and the
 * user gets `exit -1` instead of a prompt. A pre-open drop is provably a
 * connection that never opened, so nothing was started and re-creating is safe;
 * `consecutiveFailures` still bounds it, so a Sprite that truly never wakes
 * exhausts the budget and surfaces the exit anyway.
 */
export function planReconnect({
  knownId,
  liveSessionIds,
  consecutiveFailures,
  maxAttempts,
  preOpenDrop = false,
}: {
  knownId: string | undefined;
  liveSessionIds: string[];
  consecutiveFailures: number;
  maxAttempts: number;
  /** The failure that triggered this reconnect was a cold-start pre-open drop. */
  preOpenDrop?: boolean;
}): ReconnectPlan {
  if (consecutiveFailures > maxAttempts) return { action: 'fatal' };
  if (knownId !== undefined) {
    return liveSessionIds.includes(knownId)
      ? { action: 'attach', id: knownId }
      : { action: 'create' };
  }
  if (liveSessionIds.length > 0) return { action: 'attach', id: liveSessionIds[0] };
  if (preOpenDrop) return { action: 'create' };
  return { action: 'fatal' };
}

export type PtyShell = {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
};

export type OpenPtyShellArgs = {
  sprite: SpriteInstanceLike;
  cols: number;
  rows: number;
  /**
   * When set, attach to this existing detachable session instead of creating a
   * fresh shell — used to reattach to a shell that survived a navigation away or
   * a realtime-process restart, replaying its scrollback.
   */
  sessionId?: string;
  /**
   * The command a FRESH session launches (ignored when reattaching via
   * `sessionId` — an already-running session keeps whatever it was started
   * with). Defaults to an interactive human shell (`bash`); a pluggable agent
   * terminal (Terminal Epic 2 Runtime tier) passes its resolved
   * `AgentLaunchSpec.command`/`args` instead — see
   * `services/machines/agent-terminal-types.ts`.
   */
  command?: string;
  args?: string[];
  cwd?: string;
  onOutput(data: string): void;
  onExit(exitCode: number): void;
  /**
   * Called when the shell establishes a session id the caller should persist —
   * currently when the fresh-session fallback replaces a dangling persisted id
   * after a pause. The handler overwrites `machine_agent_terminals.streamSessionId`
   * so the NEXT reconnect targets the live session, not the dead one. Not fired
   * for the initial fresh session — that id is persisted by the connect path's
   * own before/after diff (see `discoverNewSessionId`).
   */
  onSessionId?(sessionId: string): void;
};

// The @fly/sprites WSCommand keepalive is output-driven: it declares the socket
// dead after 45s with no INBOUND frame (see websocket.js WS_PONG_WAIT), even
// though the shell is still alive server-side — a TTY session has
// max_run_after_disconnect:0, so it keeps running after the client drops, and
// the docs specify no server ping / idle timeout. An idle prompt therefore trips
// the CLIENT watchdog on a fixed cadence. We treat that (and any mid-session WS
// drop) as a transient disconnect and transparently reattach to the live session
// rather than tearing the terminal down. Consecutive FAILED reattaches are
// bounded so a genuinely dead Sprite still surfaces an exit.
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 200;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const TERMINAL_ENV = { TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' };

export function openPtyShell({
  sprite,
  cols,
  rows,
  sessionId,
  command = 'bash',
  args = [],
  cwd = SANDBOX_ROOT,
  onOutput,
  onExit,
  onSessionId,
}: OpenPtyShellArgs): PtyShell {
  const toStr = (chunk: unknown) => (typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8'));

  // Definite-assignment asserted: every construction path (initial attach,
  // initial fresh, and each reconnect branch) assigns `current` before `wire`.
  let current!: SpriteCommandLike;
  // The live session id to reattach to. Known immediately when attaching;
  // for a freshly created session it is resolved in the background via
  // listSessions() (and again at reconnect time as a fallback).
  let currentSessionId: string | undefined = sessionId;
  let lastCols = cols;
  let lastRows = rows;
  let closed = false; // a real exit (or exhausted reconnects) — stop everything
  let reconnecting = false;
  let consecutiveFailures = 0;
  // Whether the failure that triggered the pending reconnect was a cold-start
  // pre-open drop (the Sprite wake handshake) rather than a post-open death.
  let lastErrorWasPreOpenDrop = false;
  // Bumped on every session (re)establishment (attach or fresh-create). A
  // fresh session resolves its id via a fire-and-forget listSessions(); if a
  // LATER establishment supersedes it before that resolves, the stale resolver
  // must not clobber currentSessionId / persist a now-dead id, so it checks the
  // generation it captured against this counter.
  let sessionGeneration = 0;

  function fatal(exitCode: number, message?: string): void {
    if (closed) return;
    closed = true;
    if (message !== undefined) onOutput(`\r\n\x1b[31mShell error: ${message}\x1b[0m\r\n`);
    onExit(exitCode);
  }

  function wire(cmd: SpriteCommandLike): void {
    // Per-command staleness. A keepalive timeout in the SDK emits 'error' and
    // then closes the socket, which makes the SAME dead command also emit a
    // spurious 'exit' (code 0 or 1). A genuine shell exit (user typed `exit`)
    // emits ONLY 'exit', no preceding 'error'. We mark a command stale the
    // instant it errors so the trailing close/exit it produces can't tear the
    // session down while reconnect() is replacing it.
    let stale = false;
    cmd.stdout.on('data', (chunk) => {
      // Any inbound data proves the connection recovered; reset the failure budget.
      consecutiveFailures = 0;
      onOutput(toStr(chunk));
    });
    cmd.stderr.on('data', (chunk) => onOutput(toStr(chunk)));
    // The SDK emits 'spawn' only AFTER the WebSocket actually opens. A confirmed
    // open is the authoritative signal the connection is healthy — reset the
    // bounded reconnect budget here so an idle shell that reattaches cleanly but
    // stays quiet (no stdout) doesn't slowly exhaust the budget and get killed.
    cmd.on('spawn', () => { consecutiveFailures = 0; });
    cmd.on('exit', (code) => {
      // Ignore the stale exit that trails a keepalive 'error' on the same dead
      // command — only an exit WITHOUT a preceding error is a real shell exit.
      if (stale) return;
      fatal(code ?? -1);
    });
    cmd.on('error', (error) => {
      stale = true;
      // Remember WHY this command died: a pre-open drop (the cold-VM wake
      // handshake) is retryable even with no session to fall back to — see
      // planReconnect's `preOpenDrop`.
      lastErrorWasPreOpenDrop = isPreOpenWakeError(error);
      void reconnect();
    });
  }

  // Start a brand-new shell for the SAME command and resolve its session id in
  // the background. `before` is the pre-create session snapshot on the reconnect
  // fallback: because a Sprite can host several tty sessions at once, OUR new
  // shell is identified by a before/after diff and reported via `onSessionId` so
  // the caller overwrites the dangling streamSessionId with THIS session's id
  // (never another terminal's). `before === undefined` is the initial fresh
  // session — no diff baseline here, so it best-effort resolves a local id for
  // in-session reattach and leaves persistence to the connect path's own diff.
  function launchFreshSession(before: SpriteSessionInfo[] | undefined): void {
    currentSessionId = undefined;
    const gen = (sessionGeneration += 1);
    current = sprite.createSession(command, args, {
      tty: true,
      cols: lastCols,
      rows: lastRows,
      cwd,
      env: TERMINAL_ENV,
    });
    const beforeIds = before?.map((s) => s.id);
    void sprite
      .listSessions()
      .then((after) => {
        // A newer establishment (another reconnect) superseded this one, or the
        // shell was killed, while listSessions was in flight — don't clobber
        // currentSessionId or persist an id that no longer names the live shell.
        if (closed || gen !== sessionGeneration) return;
        if (beforeIds !== undefined) {
          // Reconnect fallback: diff-only. An ambiguous/empty diff persists
          // nothing (next reconnect just creates fresh again) rather than risk
          // overwriting the DB with another terminal's session id.
          const id = newTtySessionId(beforeIds, after);
          if (id === undefined) return;
          currentSessionId = id;
          onSessionId?.(id);
          return;
        }
        const id = pickShellSession(after)?.id;
        if (id !== undefined && currentSessionId === undefined) currentSessionId = id;
      })
      .catch(() => {});
  }

  async function reconnect(): Promise<void> {
    if (closed || reconnecting) return;
    reconnecting = true;
    consecutiveFailures += 1;
    if (consecutiveFailures > MAX_RECONNECT_ATTEMPTS) {
      reconnecting = false;
      fatal(-1, 'lost connection to shell');
      return;
    }
    try {
      await delay(RECONNECT_BASE_DELAY_MS * consecutiveFailures);
      if (closed) { reconnecting = false; return; }

      // Verify the known/persisted id against what the Sprite reports live BEFORE
      // any retry — exec sessions don't survive a pause, so a persisted id can be
      // dangling. Skipping this re-query is exactly the stale-id-retry bug that
      // loops a dead id to fatal(-1) instead of falling back to a fresh shell.
      let before: SpriteSessionInfo[] | undefined;
      try {
        before = await sprite.listSessions();
      } catch {
        before = undefined;
      }
      // kill() may have fired while listSessions was in flight — never (re)open a
      // session for a terminal the user already closed (that would leak a running,
      // billable Sprite shell with no client attached).
      if (closed) { reconnecting = false; return; }
      if (before === undefined) {
        // The control-plane listSessions is transiently unavailable (rate-limited /
        // cold-waking). Don't burn the retry budget killing a shell that's fine: if
        // we still hold a known id, optimistically reattach to it (the pre-verify
        // behavior) — a dead id just errors and re-enters reconnect once listing
        // recovers. With no id to reattach, fall back to a bounded retry.
        if (currentSessionId !== undefined) {
          sessionGeneration += 1;
          current = sprite.attachSession(currentSessionId, { cols: lastCols, rows: lastRows });
          wire(current);
          reconnecting = false;
          return;
        }
        reconnecting = false;
        void reconnect();
        return;
      }
      const liveIds = liveShellSessionIds(before);
      const plan = planReconnect({
        knownId: currentSessionId,
        liveSessionIds: liveIds,
        consecutiveFailures,
        maxAttempts: MAX_RECONNECT_ATTEMPTS,
        preOpenDrop: lastErrorWasPreOpenDrop,
      });

      if (plan.action === 'fatal') {
        // No live session and no known id to fall back to — genuinely gone.
        reconnecting = false;
        fatal(-1);
        return;
      }
      if (plan.action === 'create') {
        // The persisted id is dead (Sprite paused then cold-woke). Start a fresh
        // shell transparently and overwrite the dangling streamSessionId so the
        // user sees a new prompt rather than exit -1. `before` (captured just
        // above, pre-create) is the diff baseline that isolates OUR new session
        // from any other terminal's tty session on the same Sprite.
        launchFreshSession(before);
        wire(current);
        reconnecting = false;
        return;
      }
      sessionGeneration += 1;
      currentSessionId = plan.id;
      current = sprite.attachSession(plan.id, { cols: lastCols, rows: lastRows });
      wire(current);
      reconnecting = false;
    } catch {
      reconnecting = false;
      // Reattach itself failed; retry until the bounded budget is exhausted.
      void reconnect();
    }
  }

  if (currentSessionId !== undefined) {
    current = sprite.attachSession(currentSessionId, { cols, rows });
  } else {
    launchFreshSession(undefined);
  }
  wire(current);

  return {
    write: (data) => { if (!closed) current.stdin?.write(data); },
    resize: (c, r) => { lastCols = c; lastRows = r; if (!closed) current.resize?.(c, r); },
    kill: () => { closed = true; current.kill('SIGKILL'); },
  };
}
