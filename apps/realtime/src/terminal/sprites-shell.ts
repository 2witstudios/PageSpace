import type {
  SpriteInstanceLike,
  SpriteCommandLike,
  SpriteSessionInfo,
} from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import { readSessionInfoId } from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import { SANDBOX_ROOT } from '@pagespace/lib/services/sandbox/sandbox-paths';

/**
 * The ids of the Sprite's live exec sessions. This is a MEMBERSHIP SET, not a
 * ranking: its only job is to answer "is the id I already hold still live?" for
 * `planReconnect`. Nothing is picked out of it, so the order is irrelevant.
 *
 * Deliberately reads NOTHING but `id`. The id we are checking came from our own
 * create socket (`readSessionInfoId`), so it is by construction our session, and
 * a tty one — re-deriving either fact from the listing's own fields would be
 * both redundant and fragile:
 *
 * - `isActive` maps the API's `is_active`, whose meaning (process-alive vs
 *   client-attached) the docs never specify.
 * - `tty` is not even reported consistently: the pinned `@fly/sprites` rc37 maps
 *   it, but the published 0.0.1 build DROPPED `tty` (and `workdir`) from its
 *   `listSessions()` mapping, though the raw API still returns it. Filtering on
 *   it would therefore match ZERO sessions after a routine SDK bump — no
 *   persisted id would ever verify, every reconnect would create a fresh shell,
 *   and the shell it replaced would be orphaned but still running (and billed).
 *   Verified against the live API on both builds; see the PR.
 *
 * Matching on the id alone is immune to all of that.
 */
export function sessionIds(sessions: SpriteSessionInfo[]): string[] {
  return sessions.map((s) => s.id);
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
 * This also SUBSUMES the `preOpenDrop` flag leaf 1-4 added here. A Sprite has no
 * wake API — an incoming request wakes it (docs.sprites.dev/concepts/lifecycle) —
 * so the first `createSession` against a hibernated VM IS its wake, and Fly's
 * wake-on-request can drop that connection before it ever opens. That left no
 * known id and nothing live, which used to read as `fatal`, handing the user
 * `exit -1` instead of a prompt; 1-4 special-cased it. With no-id now meaning
 * `create` unconditionally, the cold wake simply retries — no flag required. The
 * distinction 1-4 drew still matters, but one level up: `openPtyShell` uses it
 * (structurally, via the absence of an open — never by matching the error text)
 * to tell a connection that never started from a session that was left running,
 * which is what `abandonedUnnamedSessions` bounds.
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

/**
 * How many CONSECUTIVE unnamed sessions this shell may abandon (see
 * `abandonedUnnamedSessions`) before it stops replacing them. One is tolerance
 * for the genuinely transient case — a socket that dies in the sliver between
 * 'spawn' and `session_info`. A second CONSECUTIVE one means ids are not
 * arriving at all, which no amount of retrying fixes. The count resets the
 * moment a session does announce itself, so a long-lived terminal is never torn
 * down over two unrelated blips.
 *
 * Honest worst case: TWO stranded sessions, not one. The session we give up on
 * is itself unnamed, so it is stranded too — `kill()` signals over its own dead
 * socket and there is no id to kill it by. This bound stops the bleeding; it
 * cannot undo it. (Reaping such orphans needs a kill-by-id call against the
 * Sprite — leaf 2-3's territory, not this one's.) For the same reason a `kill()`
 * that lands while an unnamed session is mid-reconnect strands that one too,
 * uncounted: there is nothing the counter could do about it.
 */
const MAX_UNNAMED_ABANDONS = 1;

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
  // it (`session_info`), normally well before the first keystroke — but NOT
  // guaranteed: a socket that dies in the sliver between 'spawn' and the frame
  // leaves it unknown, and the session it named unreachable. That is the case
  // `abandonedUnnamedSessions` exists to bound.
  let currentSessionId: string | undefined = sessionId;
  let lastCols = cols;
  let lastRows = rows;
  let closed = false; // a real exit (or exhausted reconnects) — stop everything
  let reconnecting = false;
  let consecutiveFailures = 0;
  // Whether the failure that triggered the pending reconnect was a cold-start
  // pre-open drop (the Sprite wake handshake) rather than a post-open death.
  // Set structurally, from the absence of an open — see the 'error' handler.
  let lastErrorWasPreOpenDrop = false;
  // How many sessions this shell has created but had to ABANDON without ever
  // learning their id. Such a session is unreachable in every direction: we
  // can't reattach to it (no id), and we can't kill it (`kill()` signals over
  // the command's own socket, which is exactly the socket that just died) — yet
  // a tty session is detachable and keeps running, and billing, regardless. So
  // each one is an orphan, and creating its replacement is what strands it.
  //
  // Only counted when the dead socket had actually OPENED (`!lastErrorWasPreOpenDrop`):
  // a connection that never came up started nothing server-side, so there is
  // nothing out there to strand — that is the cold-wake retry, not an orphan.
  //
  // Tracked SEPARATELY from `consecutiveFailures` because that budget is reset
  // by 'spawn'/stdout — a replacement whose socket opens fine (and it does; the
  // shell is healthy, we merely never heard its name) zeroes it. Without its own
  // counter, an id we never learn produces a fresh orphan on every keepalive
  // cycle, forever.
  let abandonedUnnamedSessions = 0;
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
    // Whether THIS command's socket ever opened. The SDK emits 'spawn' exactly
    // when `start()` resolves, and any inbound byte proves the same thing. This is
    // the structural boundary the reconnect keys on — see the 'error' handler.
    let opened = false;
    cmd.stdout.on('data', (chunk) => {
      // Any inbound data proves the connection recovered; reset the failure budget.
      opened = true;
      consecutiveFailures = 0;
      onOutput(toStr(chunk));
    });
    cmd.stderr.on('data', (chunk) => {
      opened = true;
      onOutput(toStr(chunk));
    });
    // The SDK emits 'spawn' only AFTER the WebSocket actually opens. A confirmed
    // open is the authoritative signal the connection is healthy — reset the
    // bounded reconnect budget here so an idle shell that reattaches cleanly but
    // stays quiet (no stdout) doesn't slowly exhaust the budget and get killed.
    cmd.on('spawn', () => {
      opened = true;
      consecutiveFailures = 0;
      // A confirmed open retires the previous failure's classification. Without
      // this, a later reconnect entered WITHOUT a fresh error (listSessions
      // unavailable, or the catch-all retry) would consult a stale verdict from
      // whatever failed last.
      lastErrorWasPreOpenDrop = false;
    });
    cmd.on('exit', (code) => {
      // Ignore the stale exit that trails a keepalive 'error' on the same dead
      // command — only an exit WITHOUT a preceding error is a real shell exit.
      if (stale) return;
      fatal(code ?? -1);
    });
    // A single failed open emits 'error' more than once on the SAME command — the
    // SDK fires it from the ws `error` listener, from a close-before-open, AND
    // again from `spawn()`'s catch on the rejected `start()`. Only the FIRST is a
    // real drop; the rest are echoes of it. `reconnecting` happens to absorb them
    // today (it is set before reconnect's first await), but that is an incidental,
    // load-bearing invariant: shorten the backoff or add an await ahead of it and
    // the echoes would each count as a fresh drop — burning the retry budget and,
    // worse, charging `abandonedUnnamedSessions` for a session that never dropped.
    // Marking the command stale makes it structural, exactly as it already is for
    // the trailing 'exit'.
    cmd.on('error', () => {
      if (stale) return;
      stale = true;
      // Remember WHY this command died, STRUCTURALLY: if it never reported an open
      // (no 'spawn', no byte of output), its socket never came up, so the session
      // was never started — re-creating it is safe (that is the cold Sprite wake)
      // and nothing was stranded by doing so.
      //
      // Deliberately not inferred from the error's text. `@fly/sprites` drives the
      // global (undici) WebSocket and registers its 'error' listener before its
      // 'close' one, so a failed handshake surfaces an opaque `WebSocket error: …`
      // FIRST — the SDK's own `closed before open` string is only emitted
      // afterwards, and a substring test would miss the real cold-start drop.
      lastErrorWasPreOpenDrop = !opened;
      void reconnect();
    });
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
      // Ids ARE arriving. Clear the strand budget for the same reason 'spawn' and
      // stdout clear the reconnect budget: it exists to catch a session identity
      // that has stopped working, not to tally unrelated blips over a long-lived
      // terminal. Without this the counter is a LIFETIME total, so two rare
      // pre-announce drops hours apart — with perfectly healthy sessions in
      // between — would tear down a working shell.
      abandonedUnnamedSessions = 0;
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

      // No id in hand means the session we are about to replace never announced
      // itself, so replacing it STRANDS it (see `abandonedUnnamedSessions`). The
      // shell it left behind is healthy, detached, and billable, and nothing can
      // ever reach it again. That is survivable once — the socket can die in the
      // sliver between 'spawn' (WebSocket open) and the `session_info` frame — but
      // it must never become a steady state: if ids stop arriving at all (a server
      // or SDK regression), every keepalive cycle would mint another orphan. Fail
      // loudly after a bounded number instead, so the user sees a dead terminal and
      // we see it in the logs, rather than quietly burning a Sprite forever.
      if (currentSessionId === undefined && !lastErrorWasPreOpenDrop) {
        abandonedUnnamedSessions += 1;
        if (abandonedUnnamedSessions > MAX_UNNAMED_ABANDONS) {
          reconnecting = false;
          fatal(-1, 'shell session could not be identified — refusing to strand another Sprite session');
          return;
        }
      }

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
        liveSessionIds: sessionIds(liveSessions),
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
      // The SDK threw while (re)opening — no socket came up, so no session was
      // started and nothing is stranded. Say so explicitly: this path re-enters
      // reconnect WITHOUT a fresh 'error' event, so it would otherwise inherit the
      // classification the last real drop left behind and could charge
      // `abandonedUnnamedSessions` for a session that never existed.
      lastErrorWasPreOpenDrop = true;
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
