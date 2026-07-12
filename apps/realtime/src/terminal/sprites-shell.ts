import type {
  SpriteInstanceLike,
  SpriteCommandLike,
  SpriteSessionInfo,
} from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import { readSessionInfoId, spawnWithSelfHealingCwd } from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import { SANDBOX_ROOT } from '@pagespace/lib/services/sandbox/sandbox-paths';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  EMPTY_SEEN,
  flushReplay,
  freshReplayState,
  materializeSeen,
  planReplayEmission,
  rememberDelivered,
  type ReplayState,
  type SeenTail,
} from './replay-dedupe';

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

/**
 * How long a replay may stay QUIET before we give up on aligning it and emit what
 * we buffered (see `replay-dedupe`). The scrollback is sent "immediately" on
 * attach and arrives as one burst, so a gap this long means the replay is over
 * and its bytes never matched what we had forwarded. Generous enough that a slow
 * multi-frame replay is not cut in half.
 */
const REPLAY_SETTLE_MS = 500;

/**
 * The hard bound on the replay burst, measured from its first byte — the quiet
 * gap alone is not one. A shell that is CHATTY across the reconnect (a running
 * build, a repainting TUI) never goes quiet, so a gap timer would be re-armed by
 * every chunk and the buffered bytes would be withheld until MAX_PENDING_BYTES:
 * a megabyte of dead terminal.
 *
 * This deadline is also what keeps the suppression SAFE. The dedupe may only
 * search bytes that are actually the replay; searching live output risks matching
 * the anchor past the true boundary and dropping output the client never saw (see
 * `replay-dedupe`'s module doc). Closing the window on a deadline bounds how much
 * live output can ever enter the search region, and after it closes nothing is
 * searched at all.
 */
const REPLAY_WINDOW_MS = 1000;

/**
 * The cap on the two side buffers — a superseded socket's drain, and stderr held behind a
 * replay. `replay.pending` is bounded by MAX_PENDING_BYTES for a reason that applies here
 * too: these are bytes the SANDBOX chose, buffered on the process every terminal shares.
 * Neither can grow without limit just because a socket died mid-flood. Overflow is
 * released immediately rather than dropped — the bytes still reach the client, they just
 * stop waiting for an ordering they can no longer be given.
 */
const MAX_HELD_SIDE_BYTES = 256 * 1024;

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
  const toBuf = (chunk: unknown): Buffer => (typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer));

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
  // The tail of what this client has actually been shown — what each attach matches
  // its replayed scrollback against, so a transparent reconnect delivers only the
  // part the client is missing (see `replay-dedupe`). Empty means "nothing to dedupe
  // against": a fresh viewer, or a brand-new shell — either way every replayed byte
  // is new to this xterm and passes straight through, which is what keeps the
  // cold-attach scrollback UX intact.
  let seenTail: SeenTail = EMPTY_SEEN;
  // Cancels the replay-window timers of whichever command is currently wired, so a
  // teardown doesn't leave one armed against a shell nobody is watching any more.
  let cancelReplayTimers: () => void = () => {};
  // Whether the WIRED command has taken its history snapshot yet — i.e. whether its replay
  // has begun. It decides whether a late drain may be RECORDED as history, and getting it
  // wrong breaks the one invariant everything here rests on: `seen` must be a contiguous
  // run of the session's stream.
  //
  // Before the snapshot: record. The bytes join the anchor, so the replay that also carries
  // them recognises them, suppresses them, and records nothing further. One copy, one entry.
  // After it: do NOT record. The anchor is already frozen without them, so the replay will
  // emit them itself and record them itself — recording them here too would put the same
  // bytes in the history twice, and a history that repeats itself is no longer a run of the
  // stream. The anchor would then match nothing, forever.
  let wiredReplayStarted = false;
  // Emits bytes that must NOT be deduped and must NOT jump whatever the live command is
  // holding — stderr, and the last words of a dead socket that nothing will replay.
  // Hoisted because a DEAD command has to queue behind the LIVE command's replay, and
  // its own per-wire state is the wrong window entirely.
  let emitOutOfBand: (bytes: Buffer) => void = () => {};
  // Which SESSION each command drives. A drain from a dying socket is only carried by
  // the wired command's replay if that command is REATTACHED TO THE SAME SESSION: a
  // session's scrollback holds its own output and nothing else. Asking merely "is an
  // attach wired?" loses bytes — sess-A dies, a fresh sess-B is created, B's socket then
  // drops and is reattached, and now A's late drain looks to a mere boolean like it has a
  // replay coming. It does not: B's scrollback has never held a byte of A's. So the
  // question is asked of the session, not of the wire.
  //
  // A binding is an object, not an id, because a freshly CREATED session does not know
  // its id until its socket announces it — the binding is filled in then, and every
  // command holding it sees the update.
  type SessionBinding = { id: string | undefined };
  let wiredBinding: SessionBinding = { id: sessionId };

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

    // Every attach REPLAYS the session's scrollback (sprites.dev/api). The history is
    // materialized on this command's FIRST inbound byte and frozen from then on: frozen,
    // so it cannot shift underneath a replay that is still being classified — but not
    // before, because the dying socket's last bytes usually arrive in the gap between the
    // reconnect wiring this command and its replay landing (a socket drains its buffer at
    // once; a new one has a backoff and a handshake to get through). Taking the snapshot
    // late is what lets those bytes be part of the anchor, so the replay that carries them
    // recognises and suppresses them instead of showing them twice.
    let seen: Buffer | undefined;
    wiredReplayStarted = false;
    // The session THIS command drives. Compared against the wired one at drain time.
    const myBinding = wiredBinding;
    let replay: ReplayState = freshReplayState();
    // The replay window closes on whichever comes first: a quiet gap (`settleTimer`,
    // re-armed per chunk) or the hard deadline (`windowTimer`, armed at the first
    // chunk we have to hold and never extended) — see the two constants.
    // MAX_PENDING_BYTES closes it from the byte side.
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let windowTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelTimers = () => {
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      if (windowTimer !== undefined) clearTimeout(windowTimer);
      settleTimer = undefined;
      windowTimer = undefined;
    };
    cancelReplayTimers = cancelTimers;
    /**
     * Hand bytes to the client, and record them as history — `seen` is exactly "what this
     * client has been shown", and it is what the next reconnect's replay is matched
     * against.
     *
     * `restart` is for an UNALIGNED emission: a replay we could not place, re-emitted
     * verbatim. Those bytes are (mostly) a duplicate of history we already hold, so
     * APPENDING them would leave `seen` no longer a contiguous run of the session's stream
     * — and the anchor is nothing but a bet on that run. For an idle terminal, where the
     * whole history is smaller than the anchor bound, a broken run matches no replay ever
     * again and the banner reprints on every 45s cycle from then on: this module's own bug,
     * latched permanently by one blip. Replacing the history with the replayed bytes
     * restores the invariant, because a replay IS a contiguous run of that stream.
     */
    const deliver = (bytes: Buffer, mode: 'append' | 'restart' = 'append') => {
      if (bytes.length === 0) return;
      if (mode === 'restart') seenTail = EMPTY_SEEN;
      seenTail = rememberDelivered(seenTail, bytes);
      onOutput(bytes.toString('utf8'));
    };
    // Bytes that arrived while a replay was being held, and that must not be deduped:
    // stderr, and a superseded command's drain. They are released once the window
    // closes, so they cannot render ahead of the older stdout it is holding.
    let heldOutOfBand: Buffer[] = [];
    let heldOutOfBandBytes = 0;
    const releaseOutOfBand = () => {
      if (heldOutOfBand.length === 0) return;
      const out = Buffer.concat(heldOutOfBand);
      heldOutOfBand = [];
      heldOutOfBandBytes = 0;
      // Never recorded into `seenTail`: the server replays stdout, so these bytes in
      // the history would be bytes no replay can contain, and the anchor would stop
      // matching.
      onOutput(out.toString('utf8'));
    };
    // Queue behind a replay we are still assembling; otherwise speak now. Never
    // force-close the window to make room: that would flush a HALF-received replay
    // verbatim, tearing the very banner we are suppressing AND splicing these bytes
    // into `seen`, which leaves the anchor unmatchable for the life of the terminal.
    emitOutOfBand = (bytes: Buffer) => {
      // (Both call sites already refuse to run once `closed`.)
      if (bytes.length === 0) return;
      if (replay.pending.length > 0 && heldOutOfBandBytes + bytes.length <= MAX_HELD_SIDE_BYTES) {
        heldOutOfBand.push(bytes);
        heldOutOfBandBytes += bytes.length;
        return;
      }
      // Either nothing is being held, or the queue has grown past what waiting for an
      // ordering is worth. Speak now — bytes are never dropped for want of a queue.
      releaseOutOfBand();
      onOutput(bytes.toString('utf8'));
    };
    /** Close the replay window: hand over whatever we were still holding. */
    const closeReplayWindow = () => {
      cancelTimers();
      if (closed) return;
      const held = replay.pending.length;
      const { emit, state, aligned } = flushReplay(replay);
      replay = state;
      if (held > 0) {
        // The replay could not be aligned against what this client has already seen,
        // so it goes out verbatim — correct, but it means the scrollback reprints.
        // The likeliest cause is a server-side scrollback ring smaller than the anchor
        // we search for, which no documentation pins down: log it, because otherwise
        // this feature can degrade to a silent no-op and the bug report comes back
        // looking identical to the one it fixed.
        loggers.realtime.info('Agent terminal replay window closed unaligned (scrollback may reprint)', {
          heldBytes: held,
          seenBytes: seenTail.bytes,
        });
      }
      // A give-up: these bytes RESTART the history rather than extending it — see `deliver`.
      deliver(emit, aligned ? 'append' : 'restart');
      releaseOutOfBand();
    };

    cmd.stdout.on('data', (chunk) => {
      // The terminal is gone (killed, or a real exit): nothing may reach the client after
      // that, and nothing may re-arm a timer against a shell nobody is watching.
      if (closed) return;

      // A dead socket can still drain bytes its stream had buffered — the shell's last
      // words, its panic. They are never dropped, and they are never held: holding them
      // for a replay that "will carry them" needs a proof nothing can actually give (the
      // replay may be partial, the socket may die, the session may be gone), and every
      // attempt at that proof has cost bytes. Deliver them now, and let the ONE mechanism
      // this module already has for not showing a byte twice do its job:
      //
      // - Same session as the wired command? RECORD them. The wired command's replay
      //   carries them too, and because the history is snapshotted on that command's first
      //   inbound byte (see `seen`), these bytes are in its anchor — so the replay
      //   recognises them and suppresses them. Delivered exactly once, in order, with no
      //   bookkeeping to get wrong.
      // - A different session (a fresh shell replaced the dead one)? Its scrollback has
      //   never held a byte of this output, so nothing will replay it — and recording it
      //   would splice bytes into the history that no replay can contain, leaving the
      //   anchor unmatchable. Show it, do not record it.
      if (stale) {
        // No successor is wired yet, so no history snapshot has been taken: record. Whatever
        // the reconnect does next, its snapshot will contain these bytes — an attach's replay
        // will recognise them and suppress them, and a fresh session clears the history
        // anyway. This is the ordinary case: a dying socket flushes its buffer at once, while
        // the new one still has a backoff and a handshake ahead of it.
        if (cmd === current) { deliver(toBuf(chunk)); return; }
        // A successor is wired. Record only if it is attached to THIS session and has not yet
        // taken its snapshot — then these bytes still join its anchor and its replay will
        // recognise them. Delivered exactly once.
        const sameSession = myBinding.id !== undefined && myBinding.id === wiredBinding.id;
        if (sameSession && !wiredReplayStarted) { deliver(toBuf(chunk)); return; }
        // Otherwise: show them, record nothing. Either they belong to a session nothing will
        // replay, or the replay is already classifying against a history that lacks them and
        // will emit AND record them itself — recording here as well would put the same bytes
        // in the history twice, and a history that repeats itself is no longer a run of the
        // stream. The anchor would match nothing, forever. A repeated line is survivable.
        //
        // Known residual: `wiredReplayStarted` is per-COMMAND, so a drain that arrives two
        // generations late (its session reattached, replayed these bytes, and dropped again)
        // is recorded a second time and the run breaks. It costs ONE reprint — the next
        // unaligned flush restarts the history from the replay — and it needs a dead socket
        // still pushing frames a whole reconnect cycle later, which a closed WebSocket does
        // not do. Closing it properly would mean tracking which bytes were already recorded:
        // exactly the bookkeeping whose every previous incarnation cost us bytes.
        emitOutOfBand(toBuf(chunk));
        return;
      }
      // Any inbound data proves the connection recovered; reset the failure budget.
      opened = true;
      consecutiveFailures = 0;
      // The first byte of this attach freezes the history it will be matched against.
      if (seen === undefined) {
        seen = materializeSeen(seenTail);
        wiredReplayStarted = true;
      }

      const { emit, state, aligned } = planReplayEmission({ seen, chunk: toBuf(chunk), state: replay });
      replay = state;
      // An unaligned emission is a give-up: it re-emits bytes the history may already hold,
      // so it RESTARTS that history instead of extending it (see `deliver`).
      deliver(emit, aligned ? 'append' : 'restart');
      if (replay.resolved) { cancelTimers(); releaseOutOfBand(); return; }
      // Boundary still unknown. Hold these bytes — but bound the hold twice over: on the
      // next quiet gap, and on a deadline a chatty shell cannot push out by talking.
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      settleTimer = setTimeout(closeReplayWindow, REPLAY_SETTLE_MS);
      if (windowTimer === undefined) windowTimer = setTimeout(closeReplayWindow, REPLAY_WINDOW_MS);
    });
    cmd.stderr.on('data', (chunk) => {
      if (closed) return;
      opened = true;
      // Never deduped (the replay is a stdout stream) and never allowed to JUMP the
      // stdout we are still holding — that would render it out of order. Force-closing
      // the window here would be worse still: it would flush a HALF-RECEIVED replay,
      // tearing the very banner we are trying to suppress. So it queues behind the
      // held bytes and goes out when the window closes. On a tty the shell's stderr is
      // folded into stdout anyway, so this listener is defensive rather than hot.
      // Whether this command is the live one or a superseded one still draining, the
      // rule is the same: never dedupe stderr, and never let it jump the stdout a
      // replay window is holding.
      //
      // A SUPERSEDED command's stderr can still land after the live replay resolved, and
      // is then rendered after stdout that replay already delivered — the same seam the
      // create-path drain has, for the same reason (the bytes physically arrived late).
      // Cold in practice: every session here is a tty, which folds stderr into stdout.
      emitOutOfBand(toBuf(chunk));
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
      // The shell's last words may still be sitting in the replay buffer: there is no
      // reconnect coming to re-deliver them, so hand them over before the exit.
      closeReplayWindow();
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
      // Hand over anything this socket was still holding unclassified, BEFORE
      // marking it stale. Discarding it would be safe only if a reattach were
      // guaranteed to replay it — and it isn't: when `planReconnect` says `create`
      // (the session died with the Sprite), those bytes, typically the dying
      // shell's last words, are gone from the client and from the app-side
      // scrollback for good. Emitting them cannot lose anything, and cannot
      // duplicate anything either: they join `seen`, so if a reattach DOES replay
      // them, that replay dedupes against them.
      closeReplayWindow();
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
    const binding: SessionBinding = { id: undefined };
    wiredBinding = binding;
    // A brand-new shell shares no history with the one the client was watching, so
    // there is nothing of ITS output on the client's screen: clear the history, or
    // the replacement's opening banner would be mistaken for a replay of the dead
    // session's and suppressed.
    //
    // Cleared BEFORE the drain below is handed over, deliberately: doing it after would
    // erase any mistake that flush made, which is exactly what let a bug hide here. With
    // this order, recording those bytes into `seen` poisons it visibly — and a test says
    // so.
    seenTail = EMPTY_SEEN;
    const gen = (sessionGeneration += 1);
    // The cwd is NOT passed as a createSession option: the server chdirs into it
    // and fails the open outright if it is gone, and a sandbox command can delete
    // /workspace. The wrapper recreates + enters it, then execs the real command —
    // which is why the egress lockdown's mkdir no longer has to run on every
    // hand-back. See `spawnWithSelfHealingCwd`.
    current = sprite.createSession(...spawnWithSelfHealingCwd({ command, args, cwd }), {
      tty: true,
      cols: lastCols,
      rows: lastRows,
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
      binding.id = id;
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
          wiredBinding = { id: currentSessionId };
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
      wiredBinding = { id: plan.id };
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
    // Anything still held (an unresolved replay, queued stderr) is dropped with it: the
    // viewer is gone, and `closed` stops every listener from speaking after this point.
    kill: () => { closed = true; cancelReplayTimers(); current.kill('SIGKILL'); },
  };
}
