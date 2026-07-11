import type {
  SpriteInstanceLike,
  SpriteCommandLike,
  SpriteSessionInfo,
} from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import { readSessionInfoId } from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import { SANDBOX_ROOT } from '@pagespace/lib/services/sandbox/sandbox-paths';

/**
 * The ids of the Sprite's live shell (tty) sessions. This is a MEMBERSHIP SET,
 * not a ranking: its only job is to answer "is the id I already hold still
 * live?" for `planReconnect`. Nothing picks a session out of it, so the order is
 * irrelevant and `isActive` — whose API semantics (process-alive vs
 * client-attached) the docs never specify — is not consulted at all.
 *
 * A session's id is never DISCOVERED here; it is announced on that session's own
 * socket (`readSessionInfoId`). That is what makes a Sprite hosting several
 * concurrent terminals safe: we verify our own id rather than guessing which of
 * N live shells is ours.
 */
export function liveShellSessionIds(sessions: SpriteSessionInfo[]): string[] {
  return sessions.filter((s) => s.tty).map((s) => s.id);
}

export type ReconnectPlan =
  | { action: 'attach'; id: string }
  | { action: 'create' };

/**
 * Decide how a dropped shell should reconnect. Exec sessions do NOT survive a
 * Sprite pause (docs.sprites.dev/concepts/lifecycle — "open network connections"
 * are "lost on any pause"), so a persisted `streamSessionId` can be dangling: it
 * MUST be verified against the sessions the Sprite currently reports live before
 * any retry. Pure by construction so every branch is unit-testable:
 *
 * - Known id still live → `attach` it (reattach + replay scrollback).
 * - Known id absent from the live list → `create` a fresh session (the stale id
 *   is dead; the shell overwrites the persisted streamSessionId).
 * - NO known id → `create`, even when live shells exist. A Sprite hosts every
 *   agent terminal on its machine, so a live tty session may well be a SIBLING
 *   terminal's — attaching to it would drop this user into another terminal's
 *   PTY. We only ever attach to an id we obtained authoritatively (the create
 *   socket's `session_info` frame), never to one we inferred; an unidentified
 *   session is abandoned in favour of a fresh, identifiable one.
 *
 * There is deliberately no `fatal` verdict: giving up is a property of the retry
 * BUDGET, not of the session state, and the budget is enforced by the caller
 * before it ever gets here (see `reconnect`). Every reachable state now has a
 * recovery — with an id we verify it, without one we create.
 */
export function planReconnect({
  knownId,
  liveSessionIds,
}: {
  knownId: string | undefined;
  liveSessionIds: string[];
}): ReconnectPlan {
  if (knownId === undefined) return { action: 'create' };
  return liveSessionIds.includes(knownId)
    ? { action: 'attach', id: knownId }
    : { action: 'create' };
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
   * Called with the session id of EVERY shell this PTY freshly creates — the
   * terminal's first session, and any fresh session that later replaces a
   * dangling one after a pause. The id is the one the session announced on its
   * own socket, so it is authoritative rather than inferred. The handler writes
   * it to `machine_agent_terminals.streamSessionId` so the next reconnect (even
   * after a realtime-process restart) targets THIS session and not a dead id or
   * a sibling terminal's shell. Never fired when attaching to a session whose id
   * the caller already supplied — there is nothing new to persist.
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
  // The live session id to reattach to. Known immediately when attaching; for a
  // freshly created session it lands as soon as that session's socket announces
  // it (`session_info`), which is typically before the first keystroke and always
  // before any drop it could matter for.
  let currentSessionId: string | undefined = sessionId;
  let lastCols = cols;
  let lastRows = rows;
  let closed = false; // a real exit (or exhausted reconnects) — stop everything
  let reconnecting = false;
  let consecutiveFailures = 0;
  // Bumped on every session (re)establishment (attach or fresh-create). A fresh
  // session's id arrives asynchronously on its own socket; if a LATER
  // establishment supersedes it before that frame lands, the stale announcement
  // must not clobber currentSessionId / persist a now-dead id, so its listener
  // checks the generation it captured against this counter.
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
    cmd.on('error', () => { stale = true; void reconnect(); });
  }

  // Start a brand-new shell for the SAME command and take its id straight off the
  // create handle: the server announces the new session on that session's OWN
  // socket (`{"type":"session_info","session_id":…}` — see `readSessionInfoId`),
  // which the SDK surfaces as the command's `message` event. Because the frame
  // arrives on the socket we just opened, the id is OURS by construction — N
  // terminals creating shells concurrently on one Sprite each learn their own,
  // with no list snapshot, no diff, and no window in which the answer is
  // ambiguous. Reported via `onSessionId` so the caller persists THIS session's
  // id (whether this is the terminal's first shell or a reconnect fallback
  // replacing a dangling one).
  function launchFreshSession(): void {
    currentSessionId = undefined;
    const gen = (sessionGeneration += 1);
    current = sprite.createSession(command, args, {
      tty: true,
      cols: lastCols,
      rows: lastRows,
      cwd,
      env: TERMINAL_ENV,
    });
    current.on('message', (message) => {
      const id = readSessionInfoId(message);
      if (id === undefined) return;
      // A later establishment (another reconnect) superseded this session, or the
      // shell was killed, before its frame landed — a late announcement must not
      // clobber currentSessionId or persist an id that no longer names the shell
      // the user is attached to.
      if (closed || gen !== sessionGeneration) return;
      currentSessionId = id;
      onSessionId?.(id);
    });
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

      // Verify the known id against what the Sprite reports live BEFORE any retry
      // — exec sessions don't survive a pause, so a known id can be dangling.
      // Skipping this re-query is exactly the stale-id-retry bug that loops a dead
      // id to fatal(-1) instead of falling back to a fresh shell. The listing is
      // ONLY ever used to verify an id we already hold; with no id in hand there
      // is nothing to verify, so we skip the call entirely and create fresh (a
      // live shell we cannot prove is ours may be a sibling terminal's).
      let liveSessions: SpriteSessionInfo[] = [];
      if (currentSessionId !== undefined) {
        let listed: SpriteSessionInfo[] | undefined;
        try {
          listed = await sprite.listSessions();
        } catch {
          listed = undefined;
        }
        // kill() may have fired while listSessions was in flight — never (re)open a
        // session for a terminal the user already closed (that would leak a running,
        // billable Sprite shell with no client attached).
        if (closed) { reconnecting = false; return; }
        if (listed === undefined) {
          // The control-plane listSessions is transiently unavailable (rate-limited
          // / cold-waking). Don't burn the retry budget killing a shell that's fine:
          // we hold a known id, so optimistically reattach to it (the pre-verify
          // behavior) — a dead id just errors and re-enters reconnect once listing
          // recovers.
          sessionGeneration += 1;
          current = sprite.attachSession(currentSessionId, { cols: lastCols, rows: lastRows });
          wire(current);
          reconnecting = false;
          return;
        }
        liveSessions = listed;
      }
      const plan = planReconnect({
        knownId: currentSessionId,
        liveSessionIds: liveShellSessionIds(liveSessions),
      });

      if (plan.action === 'create') {
        // Either the known id is dead (Sprite paused then cold-woke) or we never
        // learned one. Start a fresh shell transparently; its own session_info
        // frame names it, overwriting any dangling streamSessionId, so the user
        // sees a new prompt rather than exit -1.
        launchFreshSession();
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
    launchFreshSession();
  }
  wire(current);

  return {
    write: (data) => { if (!closed) current.stdin?.write(data); },
    resize: (c, r) => { lastCols = c; lastRows = r; if (!closed) current.resize?.(c, r); },
    kill: () => { closed = true; current.kill('SIGKILL'); },
  };
}
