import type {
  SpriteInstanceLike,
  SpriteCommandLike,
  SpriteSessionInfo,
} from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import { readSessionInfoId, spawnWithSelfHealingCwd } from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import { isAgentActive } from '@pagespace/lib/services/sandbox/sandbox-client/sprite-tasks';
import { SANDBOX_ROOT } from '@pagespace/lib/services/sandbox/sandbox-paths';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  EMPTY_SEEN,
  flushReplay,
  freshReplayState,
  materializeSeen,
  planReplayEmission,
  rememberDelivered,
  resolveGiveUpAction,
  type AttachKind,
  type GiveUpCause,
  type ReplayEmission,
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
  /**
   * Tear this shell down, per `trigger` — see `planTeardown` for exactly what
   * each one does and why. The ONE teardown entry point every caller goes
   * through, so `trigger` is what lets a genuine termination
   * (`forced-teardown`, `idle-reap`) be told apart from a mere viewer detach
   * that must survive it.
   * Best-effort and idempotent: a second `kill()` after the shell is already
   * closed is a no-op, and the underlying REST kill call
   * (`SpriteInstanceLike.killSession`) itself succeeds against an
   * already-dead session id rather than throwing.
   */
  kill(trigger: TeardownTrigger): void;
  /**
   * Tell this shell whether a viewer is currently attached — see
   * `planWatchdogResponse`. `false` on a detach stops the watchdog from
   * reconnecting an idle shell nobody is watching; `true` on a return
   * reattaches lazily if a reconnect was swallowed while detached.
   *
   * Scope, stated explicitly: this only gates whether WE reconnect after the
   * SDK's own keepalive declares the socket dead — it never closes a
   * currently-healthy exec connection on our own initiative. A detached shell
   * whose process keeps producing output (an agent actively working) never
   * trips the 45s no-inbound-frame watchdog in the first place, so it stays
   * connected — and correctly so: an actively-producing session is doing real
   * work regardless of whether a viewer is watching, and the Sprite's own
   * activity-based pause decision should govern that case, not viewer
   * presence. Only a genuinely IDLE detached shell — the wasteful case this
   * leaf targets, an idle prompt reconnecting every ~45s for nobody —
   * benefits from (and needs) this gate. A chatty detached shell is bounded
   * only by the existing 30-min idle reap (`disconnectConnection`), same as
   * before this leaf.
   */
  setViewerAttached(attached: boolean): void;
  /**
   * Is this shell's exec connection currently DOWN ON PURPOSE — a watchdog trip
   * the shell swallowed (`detach-quiet` or `attach-quiet`) rather than
   * reconnected, and has not yet paid back?
   *
   * The Sprites Tasks API hold reads this (`startTaskHoldHeartbeat`), and it is
   * the difference between the hold's two very different meanings of "attached":
   * a viewer bound to this session, versus a LIVE EXEC CONNECTION on the Sprite.
   * Only the second is a reason to keep a Sprite resident — a quiesced socket
   * gives the platform nothing to hold the sandbox up FOR.
   *
   * NOT true during an ordinary reconnect's sub-second backoff: that socket is
   * coming straight back, and the hold heartbeat only ticks once a minute
   * anyway. This is specifically "we have decided not to reconnect until
   * something happens" (a viewer returns, or a keystroke arrives).
   */
  isQuiesced(): boolean;
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
  /**
   * A cheap, synchronous read of the caller's ALREADY-MAINTAINED activity clock
   * — the epoch-ms of this session's last output, keystroke, or launch
   * (`agent-terminal-handler.ts`'s `latestActivityAt`). Consulted on every
   * watchdog trip, and only there, so it must not do work: no I/O, no
   * allocation of note.
   *
   * This is the SAME clock the Sprites Tasks API hold ticks on (leaf 5-1), read
   * through the SAME `isAgentActive` predicate and idle window — deliberately,
   * so the two answers to "is this sprite allowed to pause?" can never disagree.
   * A shell whose hold has been dropped for idleness must not still be poking
   * the Sprite every ~45s to keep a socket alive for it.
   *
   * OMITTED — or returning `undefined` — means the watchdog behaves exactly as
   * it did before `attach-quiet` existed: an attached shell is always
   * reattached, never quieted. `undefined` is the caller's way of saying "I have
   * no TRUSTWORTHY idleness signal for this session", which covers both a caller
   * with no clock at all and a caller whose clock it would be unsafe to age out
   * (the handler returns `undefined` for a resumed agent that has not yet
   * spoken). Guessing "idle" from the absence of information would silence
   * output for a viewer sitting right there — and, since the hold heartbeat
   * keys off the same quiescence, would pause the Sprite under a live agent.
   *
   * Read ONLY on a watchdog trip, never on a resume: a viewer returning or a
   * keystroke arriving is itself the activity the quiet verdict was waiting for,
   * so `resumeIfLazyReattachNeeded` reconnects regardless of what this says (see
   * `planWatchdogResponse`'s `resumeRequested`). Callers therefore do NOT have
   * to race a stamp into this clock ahead of `write()` for their input to land.
   */
  getLastActivityAt?(): number | undefined;
  /**
   * The idle window the caller's Sprites Tasks API hold is ACTUALLY using
   * (`TaskHoldController.agentIdleMs`) — a getter, not a value, because the hold
   * controller is constructed after the shell is opened. `undefined` (or
   * omitted) falls back to `TASK_HOLD_AGENT_IDLE_MS`.
   *
   * Exists so the watchdog cannot drift from the hold: both must answer "may
   * this sprite pause?" on the same window, and that window is configurable.
   * See `planWatchdogResponse`'s `idleMs`.
   */
  getIdleMs?(): number | undefined;
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

export type WatchdogAction = 'reattach' | 'attach-quiet' | 'detach-quiet' | 'fatal';

/**
 * What the watchdog should do about a dropped socket, given whether anyone is
 * actually watching. Pure so every branch is unit-testable without a fake SDK.
 *
 * A detached shell is bytes for nobody: the client socket is gone (dropped by
 * `agent-terminal-handler.ts`'s `disconnectConnection`), so reattaching now
 * would only place a fresh exec connection on the Sprite to relay output no
 * one will see — exactly the connection docs.sprites.dev/keeping-sprites-running
 * says prevents the Sprite from pausing ("open TCP connections drop on the
 * pause, even on warm"). `detach-quiet` lets the drop stand instead: no
 * `listSessions`/`attachSession` call, so nothing keeps the Sprite awake.
 *
 * `detach-quiet` wins over the reconnect BUDGET too, deliberately — a
 * detached shell must never go `fatal`. `fatal` calls `onExit`, which
 * `disconnectConnection` has already pointed at a no-op, so the call itself
 * is harmless — but it also latches `closed = true` on the `PtyShell`
 * PERMANENTLY, and every one of its methods (`write`/`resize`, and the
 * lazy reattach `setViewerAttached` triggers) is a no-op once `closed`. A
 * later viewer returning would then find a shell that can never reattach —
 * worse than the churn this leaf removes. Only an ATTACHED shell may ever
 * exhaust the budget and go fatal; a detached one simply stays quiet
 * indefinitely; until either a viewer returns (lazy reattach) or the 30-min
 * idle reap kills it outright (see the CAUTION in the module doc: an agent
 * running inside survives a quiet socket exactly as it already survives the
 * reap today — leaf 5-1's Tasks API hold is the sanctioned protection, not this).
 *
 * `closed` is checked for the same reason: once the shell is already torn
 * down there is nothing left to reconnect, and treating it as an ordinary
 * `reattach`/`fatal` case would just repeat a decision that has already been
 * made.
 *
 * `viewersAttached` is boolean, deliberately, even though a session holds a
 * SET of viewers (issue #2093 — `terminal-session-map.ts`'s `bySocket` is
 * many-to-one and every attached viewer has its own registry entry): the shell
 * only needs to answer "does at least one live viewer exist". The handler
 * derives it from `viewers.size > 0`, flipping it true on any join and false
 * only when the LAST viewer leaves.
 *
 * `attach-quiet` is the same trade, one step further in: an ATTACHED viewer
 * whose session has been idle past `TASK_HOLD_AGENT_IDLE_MS` (no output, no
 * keystroke — `isAgentActive`, the very predicate the Sprites Tasks API hold
 * ticks on) is watching a prompt that is producing nothing. Reattaching for
 * them places a real exec connection on the Sprite every ~45s, indefinitely,
 * for as long as a browser tab sits open — and per
 * docs.sprites.dev/keeping-sprites-running an open TTY connection is itself
 * activity that stops the Sprite from ever pausing, so the churn doesn't merely
 * cost the round-trip: it holds the whole sandbox resident (the RAM-to-CPU cost
 * skew this leaf exists to close). We let the drop stand and reattach lazily on
 * the next keystroke instead — `write()` resumes it exactly as
 * `setViewerAttached(true)` resumes a `detach-quiet` (both go through
 * `resumeIfLazyReattachNeeded`), and the keystroke itself is queued in
 * `pendingInput` and flushed the moment the replacement command opens, so the
 * reattach is invisible.
 *
 * The trade-off, stated plainly (mirroring `detach-quiet`'s): while
 * `attach-quiet` is in effect, output from a BACKGROUND process — one nobody
 * triggered with a keystroke — will not reach the client until the next
 * keystroke. That is bounded by exactly the same idle window the Tasks API hold
 * already uses, which is the point of reusing `isAgentActive` rather than
 * inventing a second threshold: a session that has produced no byte and taken
 * no input for `TASK_HOLD_AGENT_IDLE_MS` has ALREADY had its platform hold
 * deleted and is already free to be paused by the Sprite. Nothing here newly
 * exposes a legitimately-running background job to an earlier pause than it was
 * exposed to before — a job that is actually running keeps `lastActivityAt`
 * fresh with its own output, which keeps both the hold and this reattach alive.
 *
 * `lastActivityAt` of `undefined` means the caller keeps no activity clock (the
 * `getLastActivityAt` arg was omitted), NOT "never active": with no information
 * we cannot claim idleness, so an attached shell reattaches, exactly as it did
 * before this verdict existed. This is why the check is not a bare
 * `!isAgentActive(...)`, which treats an unknown clock as idle.
 *
 * A RESUME is not a watchdog trip and must never be re-vetoed by the idle gate
 * (`resumeRequested`). The trigger for a resume is a human — a viewer tabbing
 * back, or a keystroke — and a viewer who returns to a shell that went quiet
 * two hours ago necessarily brings a stale activity clock with them. Asking
 * "has this session been idle?" at that moment answers "yes" and quiets the
 * shell straight back down, so the socket never comes up, the viewer stares at
 * stale scrollback, and (since the hold heartbeat keys off the same quiescence)
 * the Sprite stays paused underneath them. The clock describes the SESSION's
 * activity; the resume is the VIEWER's. Only the first is what `attach-quiet`
 * is about.
 *
 * Both quiet verdicts are decided BEFORE the failure budget, for the reason
 * spelled out above: a quiet verdict means no attempt runs, and an attempt that
 * never ran is not evidence the shell is dead. Going `fatal` here would latch
 * `closed` on a perfectly healthy idle shell. `fatal` stays reachable — a
 * keystroke resets the budget and re-arms real attempts (`write()` →
 * `resumeIfLazyReattachNeeded`), and those failing repeatedly still exhausts it.
 *
 * `consecutiveFailures` must be the count AFTER `reconnect()`'s own increment
 * — this is the single place that decision is made (the error handler, the
 * internal retry recursion, and the lazy `setViewerAttached(true)` reattach
 * all funnel through `reconnect()`, which consults this function once, right
 * after incrementing). Passing the pre-increment count would let this
 * function's `'fatal'` verdict disagree with the actual budget it exists to
 * enforce.
 */
export function planWatchdogResponse({
  viewersAttached,
  closed,
  consecutiveFailures,
  lastActivityAt,
  now,
  resumeRequested = false,
  idleMs,
}: {
  viewersAttached: boolean;
  closed: boolean;
  consecutiveFailures: number;
  /** Epoch-ms of the session's last output/keystroke/launch; `undefined` = the caller offers no trustworthy idleness signal. */
  lastActivityAt: number | undefined;
  now: number;
  /**
   * This call is paying back a swallowed trip on a HUMAN's request — a viewer
   * returned, or a keystroke arrived (`resumeIfLazyReattachNeeded`) — rather
   * than reacting to a fresh watchdog trip. The activity clock is then beside
   * the point: the human interaction IS the activity, and it is the very thing
   * the quiet verdict was waiting for. Defaults to false — an ordinary trip.
   */
  resumeRequested?: boolean;
  /**
   * The idle window to judge `lastActivityAt` against. This is NOT a knob of the
   * watchdog's own: it must be the EFFECTIVE window the Sprites Tasks API hold
   * is using (`TaskHoldController.agentIdleMs`), which is configurable and so is
   * not always the `TASK_HOLD_AGENT_IDLE_MS` default. `undefined` falls back to
   * that default — correct when no hold controller is wired at all.
   *
   * Passing the default blindly would be a separate threshold in disguise, and
   * the two would disagree the moment `SPRITE_TASK_HOLD_REFRESH_MS` is set: a
   * shell quieting on 2 minutes while its hold is still held on 4 would be
   * quiet, blind, AND still pinning the sprite — the worst of every world.
   */
  idleMs?: number;
}): WatchdogAction {
  if (closed) return 'detach-quiet';
  if (!viewersAttached) return 'detach-quiet';
  if (!resumeRequested && lastActivityAt !== undefined && !isAgentActive({ lastActivityAt, now, idleMs })) return 'attach-quiet';
  return consecutiveFailures > MAX_RECONNECT_ATTEMPTS ? 'fatal' : 'reattach';
}

/**
 * Why a PTY shell is being torn down. `PtyShell.kill(trigger)` is the ONE
 * teardown entry point every caller goes through (see `PtyShell`'s doc) — the
 * trigger is what lets `planTeardown` tell a genuine termination from a mere
 * detach, both of which currently reach the same call.
 *
 * Deliberately NOT named `user-kill`/`user-*`: an explicit, human-initiated
 * "kill this terminal" request never reaches this type at all — that flow is
 * `killAgentTerminal` (`packages/lib/src/services/machines/agent-terminals.ts`),
 * which calls `MachineHandle.killSession` directly, bypassing `PtyShell` and
 * this enum entirely. `forced-teardown`'s only real callers
 * (`agent-terminal-handler.ts`'s `teardownAgentTerminalSession`) are the
 * PLATFORM ending a session on the user's behalf — revoked access, or an
 * insolvent payer — never a click. A `user-kill`-style label here would read,
 * in an incident review, as "the user did this," inverting the actual cause.
 *
 * `detach` and `shell-exit` are part of the complete decision matrix
 * `planTeardown` is unit-tested against (every trigger this shell could ever
 * face must have a defined, safe answer), but neither has a real call site
 * today: a plain detach never calls `kill()` at all (see `disconnectConnection`
 * in `agent-terminal-handler.ts` — it only flips `setViewerAttached(false)`),
 * and a real shell exit is handled entirely by `fatal()`, which also never
 * calls `kill()` (the process already ended; there is nothing to close or
 * kill). Both branches exist so the function's answer is defined and tested
 * BEFORE a future caller needs it, not because one is wired today.
 */
export type TeardownTrigger = 'forced-teardown' | 'detach' | 'idle-reap' | 'shell-exit';

/** What a teardown should actually DO, decided by `planTeardown`. */
export interface TeardownPlan {
  /**
   * Call the REST kill-session endpoint (`sprite.killSession`, sprites.ts) for
   * the bound session id. This is the ONLY mechanism that reaches a session
   * whose exec WebSocket is not currently open — exactly the state a
   * detached-then-reaped shell is almost always in (see `killSession`'s doc on
   * `SpriteInstanceLike`) — so it is the one that must fire for a trigger that
   * means genuine, permanent termination.
   */
  killSession: boolean;
  /**
   * Signal the currently-wired exec command via `SpriteCommandLike.kill()`.
   * The SDK exposes no side-effect-free way to drop only OUR side of the
   * connection — `kill()` IS `signal()`, delivered to the REMOTE PROCESS
   * whenever the socket happens to be open (see `sprite-machine-host.ts`'s
   * note on the private, unreachable `WSCommand.close()`) — so this is only
   * ever true alongside `killSession`. For a trigger that must NOT terminate
   * the remote (a mere detach), signalling would be exactly the bug this leaf
   * closes in reverse: a socket that is STILL open at the instant of detach
   * would take the very session down that "detachable" promises survives a
   * client drop.
   */
  closeSocket: boolean;
}

/**
 * Pure: what tearing this shell down should actually do, by INTENT — not by
 * whatever the exec socket's current state happens to be.
 *
 * - `forced-teardown` (the platform forcibly ending a session whose access
 *   was revoked or whose payer ran out of credits) and `idle-reap` (the
 *   30-min detached-idle timer — ending the session IS the reap's whole
 *   point) both terminate for real: kill the session by id, which works no
 *   matter whether our own socket to it is still open, and signal the local
 *   command too as a redundant, harmless courtesy.
 * - `detach` (a viewer merely navigating away) must NEVER terminate — the
 *   entire point of a detachable session is that it survives exactly this.
 *   Nothing is signalled or killed; the exec connection is simply abandoned
 *   to the shell's own reconnect/keepalive policy (`planWatchdogResponse`'s
 *   `detach-quiet`), and the 30-min idle reap is the only thing that will
 *   ever end it from here.
 * - `shell-exit` (the remote process already ended on its own — the user
 *   typed `exit`) has nothing left to tear down either way: the exit already
 *   happened server-side, so there is no session left to kill and no live
 *   socket left to signal.
 */
export function planTeardown({ trigger }: { trigger: TeardownTrigger }): TeardownPlan {
  switch (trigger) {
    case 'forced-teardown':
    case 'idle-reap':
      return { killSession: true, closeSocket: true };
    case 'detach':
    case 'shell-exit':
      return { killSession: false, closeSocket: false };
  }
}

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
 * several megabytes of dead terminal.
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
  getLastActivityAt,
  getIdleMs,
}: OpenPtyShellArgs): PtyShell {
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
  // Whether a viewer is currently attached — see `planWatchdogResponse` and
  // `setViewerAttached`. Starts true: a shell is only ever opened in direct
  // response to a connecting viewer (agent-terminal-handler's cold-create path).
  let viewerAttached = true;
  // Set when a watchdog trip was swallowed while detached (`planWatchdogResponse`
  // returned 'detach-quiet') instead of reattached. Nothing is wired up any more
  // to trip a FUTURE keepalive on that dead command, so the next
  // `setViewerAttached(true)` has to trigger the reattach itself rather than wait
  // for one that will never come.
  //
  // Distinct from `wire()`'s per-command `stale` flag, not a duplicate of it:
  // `stale` is closure-private to ONE wired command and resets to false the
  // moment a new one is wired, so it cannot outlive a single `wire()` call.
  // This has to survive across the WHOLE detached window — however long that
  // is — until a viewer actually returns, which is exactly the span `stale`
  // was never built to cover.
  let needsLazyReattach = false;
  // Whether the CURRENTLY WIRED command is known to actually accept stdin right
  // now. `false` from the instant that command goes `stale` (its socket errored;
  // see the 'error' handler below) until its replacement confirms open (`spawn`,
  // or — for parity with how `opened`/the reconnect budget already treat the
  // two as equivalent evidence — its first stdout byte). Needed because
  // `@fly/sprites`' `writeStdin` THROWS on a closed socket, and `SpriteCommand`
  // catches that throw and re-emits it as an 'error' on the SAME command — which
  // is already `stale`, so `wire()`'s `error` listener drops it silently
  // (`if (stale) return;`). Without this flag `write()` would hand bytes straight
  // to `current.stdin`, which is still the DEAD command for the whole reconnect
  // window (attached-reconnect's ~200ms-1s backoff, or this leaf's lazy
  // reattach — which can follow a detached gap of up to 30 minutes) — and every
  // one of those bytes is lost with no error surfaced anywhere.
  let inputReady = true;
  // Input written while `!inputReady`, held in order and flushed to the
  // replacement command's stdin the moment it opens.
  //
  // Never drained on a `fatal()` exit — an accepted, bounded exception, not an
  // oversight. A fatal tears the whole PTY down (`onExit` fires, the client
  // sees an explicit "lost connection" error), so there is no replacement
  // command left to flush these bytes to; unlike the bug this queue fixes,
  // this loss is never SILENT — the user is told the shell is gone.
  let pendingInput: string[] = [];
  const flushPendingInput = () => {
    if (pendingInput.length === 0) return;
    const queued = pendingInput;
    pendingInput = [];
    for (const chunk of queued) current.stdin?.write(chunk);
  };
  // The tail of the REPLAYABLE stream this client has been shown — the bound session's
  // stdout, and only that (stderr and a foreign session's drain are shown but never
  // recorded; see `deliver`). It is what each attach matches its replayed scrollback
  // against, so a transparent reconnect delivers only the part the client is missing
  // (see `replay-dedupe`). Empty means "nothing to dedupe
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

  function wire(cmd: SpriteCommandLike, attachKind: AttachKind): void {
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
    // materialized on this command's first STDOUT byte (stderr never snapshots) and frozen
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
     * Hand bytes to the client, and record them as history. `seen` is what the next
     * reconnect's replay is matched against, so it holds the REPLAYABLE stream — the bound
     * session's stdout, and only that. Bytes shown to the client out of band (stderr, a
     * foreign session's drain) go out through `emitOutOfBand` and are never recorded: no
     * replay contains them, and splicing them in would break the run the anchor bets on.
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
    const recordHistory = (bytes: Buffer, mode: 'append' | 'restart') => {
      if (bytes.length === 0) return;
      if (mode === 'restart') seenTail = EMPTY_SEEN;
      seenTail = rememberDelivered(seenTail, bytes);
    };
    const deliver = (bytes: Buffer, mode: 'append' | 'restart' = 'append') => {
      if (bytes.length === 0) return;
      recordHistory(bytes, mode);
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
    /**
     * A replay we could not place. Both give-up paths report here, because a give-up means
     * this terminal is not deduping — it is reprinting its scrollback — and the two causes
     * are the two constants that bracket a server value nobody has measured:
     *
     * - `window-closed`: the anchor never appeared before the window shut. A scrollback ring
     *   smaller than the anchor — which is `min(seenBytes, MAX_ANCHOR_BYTES)`, so this only
     *   bites a terminal whose history has outgrown the ring — can never contain it. A socket
     *   dying mid-replay reaches here too (the 'error' and 'exit' handlers close the window),
     *   and that one is a one-off, not a standing condition. `seenBytes` in the log tells them
     *   apart: at the MAX_ANCHOR_BYTES bound, suspect the ring; well below it, suspect the socket.
     * - `pending-cap`: the held bytes outgrew MAX_PENDING_BYTES before the anchor arrived.
     *   A ring BIGGER than the cap gets here and never heals — the anchor sits at a replay's
     *   end, so the cap always trips first, and it will reprint on every reconnect until the
     *   cap is raised past the ring. But that is not the only way in, because what is held is
     *   not just the ring: every chunk that lands while the window is open is held, live output
     *   included. A merely UNALIGNABLE ring plus a shell chatty enough to push past the cap
     *   inside REPLAY_WINDOW_MS (a `cat` of something big; a verbose build) reaches the same
     *   line with a ring orders of magnitude under it. Read this as "the terminal is reprinting
     *   its scrollback", not as "raise the cap" — a ring over the cap is the diagnosis only if
     *   the shell was quiet, and neither field here can tell you that.
     */
    const reportUnaligned = (cause: GiveUpCause, bytes: number, action: 'emit' | 'discard') => {
      // WARN, not info: this is the whole safety net under two constants that bracket a
      // server value nobody has measured, and `.env.example` tells operators to run
      // production at LOG_LEVEL=warn. At info, the one signal that this feature has
      // silently reverted to the bug it exists to fix is filtered out of production.
      loggers.realtime.warn('Agent terminal replay unaligned (scrollback may reprint)', {
        cause,
        unalignedBytes: bytes,
        seenBytes: seenTail.bytes,
        outcome: action === 'discard' ? 'discarded' : 'reprinted',
      });
    };

    /**
     * A give-up's terminal action, resolved by `attachKind` AND burst size (see
     * `resolveGiveUpAction`): shown (today's baseline — a fresh session, this shell's first
     * attach, or a burst too large to plausibly be a mere redraw), or discarded (a small give-up
     * on a transparent in-place reconnect).
     *
     * Discarding means these bytes never reach `onOutput` at all — not "shown to someone else
     * instead." `onOutput` is the ONE sink this shell has (the caller wires it to both the live
     * viewer and whatever app-level scrollback buffer a later viewer catches up from — see
     * `agent-terminal-handler.ts`'s `attachToLiveSession`), so a discard is total loss from every
     * consumer of it, not just the connection whose reconnect triggered the give-up. That is the
     * bet `resolveGiveUpAction`'s size bound is deliberately scoped around — see its own doc.
     *
     * Either way the history RESTARTS to these bytes: a give-up's bytes ARE a contiguous run
     * of the stream regardless of whether they are shown, and recording them (via
     * `recordHistory`, not `deliver`, on the discard path) is what keeps the NEXT reconnect's
     * dedupe working instead of latching an empty-then-broken history.
     */
    const settleGiveUp = (emit: Buffer, cause: GiveUpCause) => {
      const action = resolveGiveUpAction({ attachKind, burstBytes: emit.length });
      reportUnaligned(cause, emit.length, action);
      if (action === 'discard') recordHistory(emit, 'restart');
      else deliver(emit, 'restart');
    };

    /**
     * The dispatch every `ReplayEmission` (from either `planReplayEmission` or `flushReplay`)
     * goes through: a give-up is SETTLED (shown or discarded, by `settleGiveUp`); anything else
     * — the aligned/suppress-nothing case, and the "nothing to dedupe" pass-through — is just
     * delivered. Shared by both call sites (the live `stdout` handler and `closeReplayWindow`)
     * so the two can't drift out of sync on what counts as a give-up.
     */
    const resolveEmission = ({ emit, history, giveUp }: Pick<ReplayEmission, 'emit' | 'history' | 'giveUp'>) => {
      if (giveUp !== undefined) settleGiveUp(emit, giveUp);
      else deliver(emit, history);
    };

    /** Close the replay window: hand over whatever we were still holding. */
    const closeReplayWindow = () => {
      cancelTimers();
      if (closed) return;
      const { emit, state, history, giveUp } = flushReplay(replay);
      replay = state;
      resolveEmission({ emit, history, giveUp });
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
        // Otherwise: show them, record nothing. TWO ways in, and the don't-record verdict is the
        // same for both. A DIFFERENT session (see `SessionBinding`): its scrollback never held
        // these bytes, so no replay will ever carry them — recording them would splice bytes
        // into the history that no replay contains. Or the SAME session past its snapshot (see
        // `wiredReplayStarted`): its replay will emit AND record them itself, so recording here
        // too would enter them twice. Either way a repeated entry breaks the run, and a history
        // that repeats itself matches no anchor, ever again.
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
      // Confirms this command accepts stdin now (see `inputReady`'s doc) — for a
      // silent shell that never gets a distinct 'spawn' in some SDK/test doubles,
      // this is the same evidence `opened` already treats it as.
      if (cmd === current) { inputReady = true; flushPendingInput(); }
      // The first byte of this attach freezes the history it will be matched against.
      if (seen === undefined) {
        seen = materializeSeen(seenTail);
        wiredReplayStarted = true;
      }

      const { emit, state, history, giveUp } = planReplayEmission({ seen, chunk: toBuf(chunk), state: replay });
      replay = state;
      // A give-up has to be SETTLED here rather than just delivered: the byte-cap give-up
      // resolves the window inside the pure core, so `closeReplayWindow` — and its report —
      // never runs. Without this the one failure the cap exists to catch would be the only one
      // that happens silently. `settleGiveUp` (via `resolveEmission`) also decides
      // show-vs-discard by `attachKind` and burst size.
      resolveEmission({ emit, history, giveUp });
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
      // Confirms this command accepts stdin now — see `inputReady`'s doc.
      if (cmd === current) { inputReady = true; flushPendingInput(); }
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
      // From this instant, writing to `current.stdin` would silently lose the
      // bytes: `writeStdin` throws on a closed socket, `SpriteCommand` catches
      // that and re-emits it as 'error' on this SAME (now-stale) command, and
      // this very listener drops it (`if (stale) return;`, above). Queue
      // instead — `flushPendingInput` delivers it once the replacement opens.
      if (cmd === current) inputReady = false;
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
    // A brand-new shell shares no history with the one the client was watching, so there is
    // nothing of ITS output on the client's screen: clear the history, or the replacement's
    // opening banner would be mistaken for a replay of the dead session's and suppressed.
    //
    // Anything the dead socket drains AFTER this point lands on a cleared history, and the
    // `sameSession` check in the stdout handler is what keeps it from being recorded into it:
    // those bytes belong to a session this one's scrollback has never held, so no replay can
    // ever contain them, and splicing them in would leave the anchor unmatchable for the life
    // of the terminal. They are still delivered — just never recorded.
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

  /**
   * `resume` marks a reconnect a HUMAN asked for — a viewer returning, or a
   * keystroke (`resumeIfLazyReattachNeeded`) — rather than the watchdog reacting
   * to a drop. It survives this attempt's internal retries (the `catch` below
   * re-enters with it), because a resume that fails once is still a resume: the
   * viewer is still there, waiting, and abandoning it to a quiet verdict would
   * leave them staring at a dead terminal. It is bounded by the same
   * `MAX_RECONNECT_ATTEMPTS` budget as any other attempt.
   */
  async function reconnect({ resume = false }: { resume?: boolean } = {}): Promise<void> {
    if (closed || reconnecting) return;
    reconnecting = true;
    consecutiveFailures += 1;

    // The SOLE consult of `planWatchdogResponse` — every entry point funnels
    // through here: the error handler's direct call, this function's own
    // recursive retry (the `catch` block below), and the lazy reattach that
    // `resumeIfLazyReattachNeeded` pays back (a viewer returning, or a
    // keystroke). Passing the count AFTER the increment above matches exactly
    // what this decision has always been keyed on (the inline check this
    // replaces compared the same post-increment value), so a 'fatal' verdict
    // here is the real one, not a preview of one `reconnect()` would recompute
    // differently.
    //
    // INVARIANT, load-bearing for the resume path: whenever `needsLazyReattach`
    // is true, `reconnecting` is false. Every quiet verdict below clears
    // `reconnecting` in the same breath that it sets the debt, so the
    // `reconnecting` early-return above can never swallow a resume that has
    // already cleared the flag. Keep it that way — a quiet branch that returned
    // while still `reconnecting` would drop the debt on the floor silently, and
    // the viewer would sit at a dead terminal with nothing left to trigger a
    // reattach.
    const action = planWatchdogResponse({
      viewersAttached: viewerAttached,
      closed,
      consecutiveFailures,
      lastActivityAt: getLastActivityAt?.(),
      now: Date.now(),
      resumeRequested: resume,
      idleMs: getIdleMs?.(),
    });
    if (action === 'detach-quiet' || action === 'attach-quiet') {
      // Nothing worth reconnecting FOR. Either no viewer at all
      // ('detach-quiet'), or a viewer watching a session that has produced and
      // received nothing for the whole Tasks-API idle window ('attach-quiet').
      // Either way, proceeding would only place a fresh exec connection on the
      // Sprite — relaying output nobody is watching, or output nothing is
      // producing — and that connection is itself what keeps the Sprite from
      // pausing. Exactly the churn these gates exist to remove; the two
      // verdicts are handled identically because the remedy is identical.
      //
      // Undo the speculative increment above: no attempt actually ran, so it
      // must not count against the budget. Remember one is owed;
      // `resumeIfLazyReattachNeeded` pays it (with a fresh budget of its own —
      // see there) on the next viewer attach or the next keystroke.
      consecutiveFailures -= 1;
      needsLazyReattach = true;
      reconnecting = false;
      return;
    }
    if (action === 'fatal') {
      reconnecting = false;
      fatal(-1, 'lost connection to shell');
      return;
    }
    try {
      await delay(RECONNECT_BASE_DELAY_MS * consecutiveFailures);
      if (closed) { reconnecting = false; return; }
      if (!viewerAttached) {
        // Detached during the backoff itself — still nothing to reattach for.
        // Same bookkeeping as the entry-gate detach-quiet branch: no attempt
        // actually ran (we never even reached listSessions), so it must not
        // count against the budget.
        consecutiveFailures -= 1;
        needsLazyReattach = true;
        reconnecting = false;
        return;
      }

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
        // Same reasoning, for a detach: listSessions can be slow (a rate-limited or
        // cold-waking control plane), long enough for the viewer to leave mid-await.
        // Attaching or creating now would be exactly the churn this gate exists to
        // remove, just discovered a beat later than the entry check above.
        if (!viewerAttached) {
          // listSessions itself is not free — it counts toward this attempt
          // even though nothing further ran. Undo it, same as the earlier checks.
          consecutiveFailures -= 1;
          needsLazyReattach = true;
          reconnecting = false;
          return;
        }
        if (listed === undefined) {
          // The control-plane listSessions is transiently unavailable (rate-limited
          // / cold-waking). Don't burn the retry budget killing a shell that's fine:
          // we hold a known id, so optimistically reattach to it (the pre-verify
          // behavior) — a dead id just errors and re-enters reconnect once listing
          // recovers.
          sessionGeneration += 1;
          wiredBinding = { id: currentSessionId };
          current = sprite.attachSession(currentSessionId, { cols: lastCols, rows: lastRows });
          // A transparent in-place reconnect: the viewer never left, so a SMALL give-up on
          // THIS attach's replay is discarded rather than shown — see `resolveGiveUpAction`.
          wire(current, 'transparent-attach');
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
        // sees a new prompt rather than exit -1. `launchFreshSession` already clears
        // `seenTail`, so there is nothing a give-up here could be redundant WITH —
        // 'fresh' keeps it shown, matching a brand-new shell's own scrollback.
        launchFreshSession();
        wire(current, 'fresh');
        reconnecting = false;
        return;
      }
      sessionGeneration += 1;
      wiredBinding = { id: plan.id };
      currentSessionId = plan.id;
      current = sprite.attachSession(plan.id, { cols: lastCols, rows: lastRows });
      // Same reasoning as the optimistic-reattach branch above: the viewer has been
      // continuously attached, so a SMALL give-up on this reconnect (if any) is discarded.
      wire(current, 'transparent-attach');
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
      // A resume stays a resume across its own retries — see `reconnect`'s doc.
      void reconnect({ resume });
    }
  }

  /**
   * Pay back a watchdog trip that was swallowed by a quiet verdict. Shared by
   * the two things that can make a quiet shell interesting again: a viewer
   * coming back (`setViewerAttached(true)` — resumes a `detach-quiet`) and a
   * keystroke arriving (`write()` — resumes an `attach-quiet`, whose viewer
   * never left). Both mean the same thing to the socket: someone is going to
   * want bytes now, so re-establish it.
   *
   * A no-op unless a trip was ACTUALLY swallowed: a viewer toggling
   * attach/detach faster than the ~45s keepalive, or typing into a healthy
   * shell, never tripped anything, and output is already flowing.
   */
  function resumeIfLazyReattachNeeded(): void {
    if (!needsLazyReattach || closed) return;
    needsLazyReattach = false;
    // A deliberate resume after a (possibly long) quiet gap is a FRESH attempt,
    // not a continuation of whatever consecutive failures triggered the
    // original quiet-down. Reset both budgets so a shell that happened to be
    // at/near its cap when it went quiet gets a real attempt instead of an
    // instant fatal(-1) with zero retries — "consecutive" is meant to bound
    // rapid retries close together in time, not something spanning a
    // human-timescale idle window.
    consecutiveFailures = 0;
    abandonedUnnamedSessions = 0;
    // `resume: true` — this reconnect is a HUMAN's, not the watchdog's, so the
    // idle gate must not veto it. A viewer returning to a shell that went quiet
    // an hour ago necessarily arrives with a stale clock; re-asking "is this
    // session idle?" here would quiet it straight back down and hand them a dead
    // terminal. See `planWatchdogResponse`'s `resumeRequested`.
    void reconnect({ resume: true });
  }

  if (currentSessionId !== undefined) {
    current = sprite.attachSession(currentSessionId, { cols, rows });
  } else {
    launchFreshSession();
  }
  // This shell's FIRST wire(), whether attaching to a persisted session or creating fresh: a
  // fresh-viewer attach, not a transparent reconnect — nothing has been shown yet in this
  // process (`seenTail` starts empty), so there is nothing a give-up could be redundant with.
  // Discard is scoped to reconnects INSIDE this shell's own lifetime — see `resolveGiveUpAction`.
  wire(current, 'fresh');

  return {
    write: (data) => {
      if (closed) return;
      // A keystroke is precisely the event `attach-quiet` was waiting for: the
      // viewer never left, they simply had nothing to say for a while, and now
      // they do. Re-establish the socket before touching stdin. (Nothing to pay
      // back = nothing happens; a healthy shell's writes are unaffected.)
      resumeIfLazyReattachNeeded();
      // The wired command is known-stale (a reconnect — attached, quiet, or
      // lazy — is in flight) and its replacement hasn't opened yet: queue
      // rather than hand bytes to a socket that would silently swallow them.
      // This is what makes the resume above invisible: `flushPendingInput`
      // delivers these bytes the moment the replacement command opens, so no
      // new UI state (and no lost keystroke) is involved.
      if (!inputReady) { pendingInput.push(data); return; }
      current.stdin?.write(data);
    },
    // Deliberately NOT a resume trigger, unlike `write()`. A resize says "render
    // differently", not "I want output now" — and it is not lost by waiting:
    // `lastCols`/`lastRows` are recorded here and every reconnect path attaches
    // with them, so a quiet shell comes back at the size the viewer last chose.
    // Resuming on it would put a live socket back on the Sprite for someone who
    // merely dragged a pane divider while idle, which is the churn this all
    // exists to remove. (The resize sent to an already-dead command below is
    // swallowed the same way a stale write is — see `inputReady`.)
    resize: (c, r) => { lastCols = c; lastRows = r; if (!closed) current.resize?.(c, r); },
    // Anything still held (an unresolved replay, queued stderr) is dropped with it: the
    // viewer is gone, and `closed` stops every listener from speaking after this point.
    //
    // Idempotent: a repeat call (or a second trigger racing the first) after
    // `closed` is already true is a no-op, so the REST kill below never fires
    // twice for one shell.
    kill: (trigger) => {
      if (closed) return;
      closed = true;
      cancelReplayTimers();
      const plan = planTeardown({ trigger });
      if (plan.closeSocket) current.kill('SIGKILL');
      // Reaches a session regardless of whether OUR socket to it is still
      // open — see `killSession`'s doc on `SpriteInstanceLike`. No id in hand
      // means this shell never learned which session it was driving (the
      // abandoned-unnamed-session edge case `abandonedUnnamedSessions`
      // already bounds) — there is nothing to kill BY, so this is a no-op,
      // not a failure.
      if (plan.killSession && currentSessionId !== undefined) {
        const sessionId = currentSessionId;
        void sprite.killSession(sessionId).catch((error) => {
          loggers.realtime.error(
            'Sprite session kill failed',
            error instanceof Error ? error : new Error(String(error)),
            { sessionId, trigger },
          );
        });
      }
    },
    setViewerAttached: (attached) => {
      viewerAttached = attached;
      // A returning viewer pays back a swallowed trip — see
      // `resumeIfLazyReattachNeeded`, which `write()` also calls (an
      // `attach-quiet` shell's viewer never left, so a keystroke is its only
      // resume trigger). `viewerAttached` is set FIRST so the reconnect this
      // may kick off sees the viewer that is now here.
      if (attached) resumeIfLazyReattachNeeded();
    },
    // `needsLazyReattach` IS the quiesced state: it is set exactly when a
    // watchdog trip was swallowed by a quiet verdict, and cleared exactly when
    // that trip is paid back (`resumeIfLazyReattachNeeded`). Nothing else can
    // leave this shell's socket deliberately down.
    isQuiesced: () => needsLazyReattach,
  };
}
