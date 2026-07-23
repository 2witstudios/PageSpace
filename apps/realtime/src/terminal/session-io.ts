/**
 * Session IO over HTTP — the realtime half of `read_session`/`send_session`
 * for a PTY session (the session family, Node Sandboxes epic).
 *
 * A machine-bound agent's shell sessions run as PTYs owned by THIS process:
 * the bytes live in `agentTerminalSessionMap`, not in the database, and the web
 * app has no way to reach them. So the web tier resolves + AUTHORIZES the
 * session against its derived handle set, then posts here HMAC-signed —
 * exactly the shape `terminal-activity.ts` already uses (`/api/broadcast`,
 * `/api/kick`, `/api/terminal-activity`). The signature proves the SENDER is
 * the web backend; node access was decided there, at the one policy site, and
 * is deliberately not re-decided here.
 *
 * Read is the `list_sessions` liveness sweep AND the scrollback tail in one
 * request shape: name the sessions you care about, pass `limit: 0` when all you
 * want is whether they are live.
 *
 * LIVE IS NOT ATTACHED. A session with zero viewers is still a running PTY (a
 * human closed the tab; the process kept going — or nobody ever opened it, see
 * below), so liveness is map membership and nothing else. And a session that is
 * NOT in the map answers `live: false` rather than an empty scrollback: to a
 * reader, "" means "the command printed nothing", which is a different — and
 * actionable — fact from "this PTY has never started".
 *
 * A shell that has never started is no longer a dead end, though (issue #2206).
 * `add_session` reserves a row; the PTY used to begin only when a human opened
 * the pane, so an agent that added a shell and typed into it was told nothing
 * was delivered until someone came along. Now the first read/send STARTS it,
 * through the same create the socket path runs (`startSession` -> the handler's
 * `ensureAgentTerminalSession`): zero viewers, billing from PTY start, and the
 * idle reap armed at creation because no viewer will ever leave to arm it.
 * `live: false` now means what it says — no PTY, and none could be started.
 */

import type { TerminalSession, TerminalSessionMap } from './terminal-session-map';
import { resumeBillingClock } from './agent-terminal-handler';

/**
 * How much scrollback one read may ship back. The ring itself holds 64 KiB;
 * this is a per-ANSWER cap, because the answer is going into a model's context
 * window rather than an xterm pane.
 */
export const MAX_SCROLLBACK_TAIL_BYTES = 16 * 1024;

/** Tail size when the caller does not ask for one. */
export const DEFAULT_SCROLLBACK_TAIL_LINES = 100;

/** Upper bound on a single stdin write — mirrors the socket path's `MAX_INPUT_BYTES`. */
export const MAX_SESSION_INPUT_BYTES = 4096;

/** The (node, name) address of one session — the same tuple the socket handler keys on. */
export interface SessionAddress {
  machineId: string;
  projectName?: string;
  branchName?: string;
  name: string;
}

export interface SessionIoDeps {
  sessionMap: Pick<TerminalSessionMap, 'getByKey'>;
  /** The pure `deriveAgentTerminalSessionKey` composition the socket handler uses. */
  sessionKeyFor: (address: SessionAddress) => string;
  /**
   * Start a PTY that has never run — the headless half of issue #2206.
   *
   * The SAME create the socket path runs (`ensureAgentTerminalSession`), with
   * no viewer: it re-decides authorization for `userId`, reserves the
   * concurrency slot, gates and starts the billing window, and arms the reap
   * that will collect a session nobody attaches to. `undefined` back means it
   * did not start — denied, insolvent, or the sprite would not give us a shell
   * — and the caller answers exactly as it always did for a session with no
   * PTY.
   *
   * `abandoned` is threaded straight through to `ensureAgentTerminalSession`'s
   * own check, the same one the socket path uses at the last await before the
   * PTY exists. It matters here for a reason the socket path does not have: the
   * web tier's `fetch` to this endpoint gives up after a FIXED timeout
   * (`REALTIME_TIMEOUT_MS`), shorter than a cold Sprite wake can take, and a
   * caller that saw that timeout as "nothing happened" may retry the same
   * input. Without this, the original request would keep starting the PTY and
   * writing the input after the caller had already moved on — a retry would
   * then run that input twice. Checking it costs nothing when the caller is
   * still there (`abandoned()` stays false the whole time).
   *
   * Optional, and absent in every existing test: a realtime deployment without
   * this seam degrades to the pre-#2206 behavior (a reserved shell stays
   * reserved until a human opens it) rather than failing.
   */
  startSession?: (
    address: SessionAddress & { userId: string },
    abandoned: () => boolean,
  ) => Promise<TerminalSession | undefined>;
  /**
   * Push a viewer-less session's idle reap back, because an agent just used it.
   *
   * Injected rather than called directly: the reap belongs to the handler
   * module (it owns the billing settle and slot release behind it), and this
   * module deliberately knows about neither. Absent -> no re-arm, which is the
   * pre-#2206 behavior.
   */
  rearmIdleReap?: (session: TerminalSession) => void;
}

/**
 * The two fields a caller adds when it wants a never-started shell STARTED.
 *
 * Both are required together and neither is inferred. `start` is opt-in because
 * starting a PTY reserves a concurrency slot and begins billing a payer — an
 * effect no caller should get by accident — and `userId` because that start is
 * authorized, metered and audited against a real person, exactly as a socket
 * connect is. A caller that omits them gets the pre-#2206 answer.
 */
interface SessionStartRequest {
  start?: boolean;
  userId?: string;
}

export interface SessionReadPayload extends SessionStartRequest {
  machineId: string;
  projectName?: string;
  branchName?: string;
  names: string[];
  /** Lines of scrollback tail; `0` asks for liveness only. */
  limit?: number;
}

export interface SessionReadEntry {
  name: string;
  live: boolean;
  /**
   * Has this PTY ever emitted a byte? Reported separately from `output` because
   * a single chunk bigger than the ring is pushed and trimmed straight back off
   * (see `TerminalSession.hasOutput`) — an empty tail from a loud session is
   * possible, and must not read as silence.
   */
  hasOutput: boolean;
  /** How many humans are watching right now. Zero does not mean not running. */
  viewers: number;
  output: string;
  /**
   * Did THIS read start the PTY? Present only when it did. The reader needs it:
   * an empty tail from a shell that booted a moment ago is the boot, not the
   * silence of a command that produced nothing.
   */
  started?: true;
}

export interface SessionReadResult {
  success: boolean;
  sessions?: SessionReadEntry[];
  error?: string;
}

export interface SessionSendPayload extends SessionStartRequest {
  machineId: string;
  projectName?: string;
  branchName?: string;
  name: string;
  input: string;
}

export interface SessionSendResult {
  success: boolean;
  live?: boolean;
  delivered?: boolean;
  /** Did THIS send start the PTY? Present only when it did. */
  started?: true;
  error?: string;
}

/**
 * Type stdin into a live PTY on behalf of a machine-bound agent.
 *
 * The write goes through `session.command.write` — the SAME call a human
 * viewer's keystroke makes — for two reasons. The shell echoes what it
 * receives, so everyone attached sees the agent type exactly as they would see
 * a teammate type (nothing is injected into their feed here, which would double
 * the echo); and the input counts as ACTIVITY (`lastInputAt`), so a long silent
 * run an agent kicks off is not mistaken for an idle session and reaped out
 * from under itself by the platform task hold.
 *
 * Control characters are delivered VERBATIM. To a terminal they are keys, and
 * Ctrl-C is the only way to interrupt a runaway process — the opposite of the
 * stripping `terminal-activity.ts` does, which is right there because those
 * bytes are interpolated into a display line an xterm renders (an ESC sequence
 * could forge output) rather than delivered to a program's stdin.
 */
export async function handleSessionSendRequest(
  deps: SessionIoDeps,
  body: string,
  now: () => number = Date.now,
  /** Has the caller given up on this request? See `SessionIoDeps.startSession`. */
  abandoned: () => boolean = () => false,
): Promise<{ status: number; body: SessionSendResult }> {
  const payload = parseBody<SessionSendPayload>(body);
  if (!payload || typeof payload !== 'object') {
    return { status: 400, body: { success: false, error: 'Invalid JSON' } };
  }

  const nodeError = invalidNode(payload);
  if (nodeError) return { status: 400, body: { success: false, error: nodeError } };
  if (!isNonEmptyString(payload.name)) {
    return { status: 400, body: { success: false, error: 'Missing or invalid name' } };
  }
  // Refused, never truncated: half a command typed into a live shell is a
  // command the caller never wrote, and the PTY would run it.
  if (
    !isNonEmptyString(payload.input) ||
    Buffer.byteLength(payload.input, 'utf8') > MAX_SESSION_INPUT_BYTES
  ) {
    return { status: 400, body: { success: false, error: 'Missing or invalid input' } };
  }

  const startPlan = planSessionStart(payload, { addressable: true, hasStarter: deps.startSession !== undefined });
  if (!startPlan.ok) return { status: 400, body: { success: false, error: startPlan.error } };

  const address: SessionAddress = {
    machineId: payload.machineId,
    projectName: payload.projectName,
    branchName: payload.branchName,
    name: payload.name,
  };
  const live = deps.sessionMap.getByKey(deps.sessionKeyFor(address));
  // A shell that has never run is not a refusal — it is a shell to START, so
  // long as the caller asked for one. This is the whole of issue #2206: the PTY
  // begins at the first agent IO, not at the first human to open the pane.
  const started = live === undefined && startPlan.start
    ? await deps.startSession?.({ ...address, userId: startPlan.userId }, abandoned)
    : undefined;
  const session = live ?? started;
  // Nothing running, and nothing we could start: say so. Swallowing the
  // keystrokes with a 200 would let the caller believe a command it never ran
  // is running. This also covers the caller having ABANDONED the request
  // mid-start (see `startSession`'s doc) — `started` comes back `undefined`
  // exactly as it would for a denied or insolvent start, and nothing is
  // written on their behalf.
  if (!session) return { status: 200, body: { success: true, live: false, delivered: false } };

  session.lastInputAt = now();
  // A keystroke also RESUMES a quiesced shell (and with it the Sprite), so the
  // billing window has to restart at the instant of the write — the same call
  // the socket input path makes, for the same reason.
  resumeBillingClock(session);
  session.command.write(payload.input);

  // Nobody is watching this session, so its reap is already ticking — armed
  // either by the last viewer leaving or by a headless start. An agent typing
  // into it is USE, and a command killed at the thirty-minute mark because the
  // clock started when the shell did would be exactly the surprise this whole
  // family exists to remove. Attached sessions have no armed reap to move.
  if (session.viewers.size === 0) deps.rearmIdleReap?.(session);

  return {
    status: 200,
    body: { success: true, live: true, delivered: true, ...(started ? { started: true as const } : {}) },
  };
}

/** How many sessions one read may ask about — a node's listing, not a crawl. */
const MAX_NAMES_PER_READ = 100;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseBody<T>(body: string): T | undefined {
  try {
    return JSON.parse(body) as T;
  } catch {
    return undefined;
  }
}

/** The (node names) half of an address, validated once for both verbs. */
function invalidNode(payload: { machineId?: unknown; projectName?: unknown; branchName?: unknown }): string | undefined {
  if (!isNonEmptyString(payload.machineId)) return 'Missing or invalid machineId';
  if (payload.projectName !== undefined && !isNonEmptyString(payload.projectName)) return 'Invalid projectName';
  if (payload.branchName !== undefined && !isNonEmptyString(payload.branchName)) return 'Invalid branchName';
  return undefined;
}

/**
 * Pure: validate the start half of a payload, and say whether a start is
 * actually to be attempted.
 *
 * `addressable` is what makes the liveness sweep structurally incapable of
 * starting anything: a read naming SEVERAL sessions is the sweep's shape, and a
 * start on it would boot one sandbox per row for a listing nobody asked to run.
 * That is REFUSED rather than quietly ignored — a caller asking for something
 * this endpoint will not do should learn it, not be told "not live" and left to
 * conclude the shell is broken.
 *
 * `hasStarter` folds in "this deployment can start sessions at all", so the
 * no-seam case answers exactly as it did before #2206 instead of erroring.
 */
export function planSessionStart(
  payload: { start?: unknown; userId?: unknown },
  { addressable, hasStarter }: { addressable: boolean; hasStarter: boolean },
): { ok: true; start: false } | { ok: true; start: true; userId: string } | { ok: false; error: string } {
  if (payload.start !== undefined && typeof payload.start !== 'boolean') return { ok: false, error: 'Invalid start' };
  if (payload.userId !== undefined && !isNonEmptyString(payload.userId)) return { ok: false, error: 'Missing or invalid userId' };
  if (payload.start !== true) return { ok: true, start: false };
  if (!addressable) return { ok: false, error: 'Invalid start' };
  // A PTY is started FOR someone: the start re-decides authorization, reserves
  // that user's concurrency slot, bills their machine's payer and writes an
  // audit row. There is no anonymous shape of any of that.
  if (!isNonEmptyString(payload.userId)) return { ok: false, error: 'Missing or invalid userId' };
  if (!hasStarter) return { ok: true, start: false };
  return { ok: true, start: true, userId: payload.userId };
}

/**
 * The most recent `limit` lines of a session's ring, byte-capped.
 *
 * The ring holds raw PTY CHUNKS, not lines — a single line routinely arrives
 * across several writes, and one write routinely carries many lines — so the
 * chunks are joined before anything is counted. CR/LF is normalized to LF: the
 * consumer is a model reading text, not a terminal emulator rendering one.
 *
 * The byte cap drops WHOLE leading lines rather than slicing mid-line: a cut in
 * the middle of a line (or worse, a multi-byte character) hands the reader a
 * truncated fragment that looks like real output.
 */
export function scrollbackTail(
  session: Pick<TerminalSession, 'scrollback'>,
  limit: number,
): string {
  if (limit <= 0) return '';
  const lines = session.scrollback.join('').replace(/\r\n?/g, '\n').split('\n');
  // A ring ending in a newline yields a trailing empty element that is not a
  // line of output — dropping it keeps `limit` counting real lines.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  let tail = lines.slice(-limit);
  while (tail.length > 1 && Buffer.byteLength(tail.join('\n'), 'utf8') > MAX_SCROLLBACK_TAIL_BYTES) {
    tail = tail.slice(1);
  }
  const joined = tail.join('\n');
  if (Buffer.byteLength(joined, 'utf8') <= MAX_SCROLLBACK_TAIL_BYTES) return joined;

  // One newline-free line wider than the whole cap (a minified bundle, a
  // base64 blob) — there is no line boundary left to drop at, so the cap has
  // to cut mid-line after all: keep the most RECENT bytes (the end is where a
  // long line's news is), on a UTF-8 boundary, and say so with a leading
  // marker so the cut never reads as complete output.
  const bytes = Buffer.from(joined, 'utf8');
  const MARKER = '…';
  let start = bytes.length - MAX_SCROLLBACK_TAIL_BYTES + Buffer.byteLength(MARKER, 'utf8');
  // 0b10xxxxxx marks a UTF-8 continuation byte — step forward off any
  // mid-character cut.
  while (start < bytes.length && (bytes[start] & 0b1100_0000) === 0b1000_0000) start += 1;
  return `${MARKER}${bytes.subarray(start).toString('utf8')}`;
}

/**
 * Answer liveness (+ optional scrollback) for every named session at one node.
 * Pure composition over injected deps — no HTTP or socket types — so it is unit
 * tested directly, exactly like `handleTerminalActivityRequest`.
 */
export async function handleSessionReadRequest(
  deps: SessionIoDeps,
  body: string,
  /** Has the caller given up on this request? See `SessionIoDeps.startSession`. */
  abandoned: () => boolean = () => false,
): Promise<{ status: number; body: SessionReadResult }> {
  const payload = parseBody<SessionReadPayload>(body);
  if (!payload || typeof payload !== 'object') {
    return { status: 400, body: { success: false, error: 'Invalid JSON' } };
  }

  const nodeError = invalidNode(payload);
  if (nodeError) return { status: 400, body: { success: false, error: nodeError } };

  const { names } = payload;
  if (!Array.isArray(names) || names.length === 0 || names.length > MAX_NAMES_PER_READ || !names.every(isNonEmptyString)) {
    return { status: 400, body: { success: false, error: 'Missing or invalid names' } };
  }

  const limit =
    payload.limit === undefined
      ? DEFAULT_SCROLLBACK_TAIL_LINES
      : typeof payload.limit === 'number' && Number.isInteger(payload.limit) && payload.limit >= 0
        ? payload.limit
        : undefined;
  if (limit === undefined) return { status: 400, body: { success: false, error: 'Invalid limit' } };

  // A start is only ever addressable when the read names ONE session — see
  // `planSessionStart`. The `list_sessions` sweep names many, so it cannot
  // start anything no matter what it sends.
  const startPlan = planSessionStart(payload, {
    addressable: names.length === 1,
    hasStarter: deps.startSession !== undefined,
  });
  if (!startPlan.ok) return { status: 400, body: { success: false, error: startPlan.error } };

  const sessions = await Promise.all(names.map(async (name): Promise<SessionReadEntry> => {
    const address: SessionAddress = {
      machineId: payload.machineId,
      projectName: payload.projectName,
      branchName: payload.branchName,
      name,
    };
    const live = deps.sessionMap.getByKey(deps.sessionKeyFor(address));
    // Reading a shell that has never run STARTS it (issue #2206). A reader has
    // no other way to get one going, and answering "never started" to a caller
    // that just asked to read it is the dead end this removes. Only ever
    // reached for a single-name read.
    const started = live === undefined && startPlan.start
      ? await deps.startSession?.({ ...address, userId: startPlan.userId }, abandoned)
      : undefined;
    const session = live ?? started;
    if (!session) return { name, live: false, hasOutput: false, viewers: 0, output: '' };
    // A deliberate single-session read is USE, exactly like a delivered send
    // (see `armIdleReap`) — an agent polling `read_session` on a long build is
    // as real a consumer of this session as one typing into it, and letting
    // its reap run unmoved would kill the build out from under the very agent
    // reading it. Gated on `payload.start`, not `started`: this must fire on
    // every read of an already-live session too, not only the one that boots
    // it. The `list_sessions` liveness sweep never sets `start`, so a sweep
    // over many viewer-less sessions can never touch any of their reaps.
    if (payload.start === true && session.viewers.size === 0) deps.rearmIdleReap?.(session);
    return {
      name,
      live: true,
      hasOutput: session.hasOutput === true,
      viewers: session.viewers.size,
      output: scrollbackTail(session, limit),
      ...(started ? { started: true as const } : {}),
    };
  }));

  return { status: 200, body: { success: true, sessions } };
}
