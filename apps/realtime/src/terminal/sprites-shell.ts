import type {
  SpriteInstanceLike,
  SpriteCommandLike,
  SpriteSessionInfo,
} from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import { SANDBOX_ROOT } from '@pagespace/lib/services/sandbox/sandbox-paths';

/**
 * Pick the live interactive shell to reattach to from a Sprite's exec sessions.
 * A terminal owns exactly one TTY shell per Sprite (one page = one Sprite), so
 * match on `tty` rather than on `isActive` — the API's `is_active` semantics
 * (process-alive vs client-attached) are undocumented, and a detached-but-running
 * shell may report `is_active: false`. `isActive` is used only as a tiebreaker.
 */
export function pickShellSession(sessions: SpriteSessionInfo[]): SpriteSessionInfo | undefined {
  const shells = sessions.filter((s) => s.tty);
  return shells.find((s) => s.isActive) ?? shells[0];
}

/**
 * Live shell (tty) session ids ordered so index 0 mirrors `pickShellSession`'s
 * pick (active first, else the first shell). The full ordered list lets
 * `planReconnect` test whether a persisted id is still among the live sessions
 * while also naming a fallback to attach to when the known id is unset.
 */
export function liveShellSessionIds(sessions: SpriteSessionInfo[]): string[] {
  const shells = sessions.filter((s) => s.tty);
  const active = shells.filter((s) => s.isActive);
  const inactive = shells.filter((s) => !s.isActive);
  return [...active, ...inactive].map((s) => s.id);
}

/**
 * The id of the tty (shell) session that appeared AFTER a create, identified by
 * diffing against the ids that existed BEFORE it. A Sprite can host several tty
 * sessions at once (one per concurrent terminal — see agent-terminal-handler's
 * module doc), so "any tty session" is ambiguous; only a before/after diff
 * reliably names OUR freshly created shell (mirrors the connect path's
 * `discoverNewSessionId`). Returns undefined when the diff is empty/ambiguous —
 * the caller then persists nothing rather than risk another terminal's id.
 */
export function newTtySessionId(beforeIds: string[], after: SpriteSessionInfo[]): string | undefined {
  const before = new Set(beforeIds);
  return after.find((s) => s.tty && !before.has(s.id))?.id;
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
 * - No known id and nothing live → `fatal` (the shell is genuinely gone).
 */
export function planReconnect({
  knownId,
  liveSessionIds,
  consecutiveFailures,
  maxAttempts,
}: {
  knownId: string | undefined;
  liveSessionIds: string[];
  consecutiveFailures: number;
  maxAttempts: number;
}): ReconnectPlan {
  if (consecutiveFailures > maxAttempts) return { action: 'fatal' };
  if (knownId !== undefined) {
    return liveSessionIds.includes(knownId)
      ? { action: 'attach', id: knownId }
      : { action: 'create' };
  }
  if (liveSessionIds.length > 0) return { action: 'attach', id: liveSessionIds[0] };
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
    cmd.on('error', () => { stale = true; void reconnect(); });
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
      const before = await sprite.listSessions();
      const liveIds = liveShellSessionIds(before);
      const plan = planReconnect({
        knownId: currentSessionId,
        liveSessionIds: liveIds,
        consecutiveFailures,
        maxAttempts: MAX_RECONNECT_ATTEMPTS,
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
