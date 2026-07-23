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
 * human closed the tab; the process kept going), so liveness is map membership
 * and nothing else. And a session that is NOT in the map answers `live: false`
 * rather than an empty scrollback: to a reader, "" means "the command printed
 * nothing", which is a different — and actionable — fact from "this PTY has
 * never started" (a shell session is reserved until a viewer first connects).
 */

import type { TerminalSession, TerminalSessionMap } from './terminal-session-map';
import { resumeBillingClock } from './agent-terminal-handler';
import {
  MAX_SCROLLBACK_TAIL_BYTES,
  scrollbackLines,
  tailOfLines,
} from '@pagespace/lib/services/machines/session-scrollback';

/**
 * How much scrollback one read may ship back. The ring itself holds 64 KiB;
 * this is a per-ANSWER cap, because the answer is going into a model's context
 * window rather than an xterm pane. Re-exported (not just used) so existing
 * importers of this module keep working unchanged — the pure implementation
 * now lives in `session-scrollback.ts`, shared with the cold-tail persist path.
 */
export { MAX_SCROLLBACK_TAIL_BYTES };

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
}

export interface SessionReadPayload {
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
}

export interface SessionReadResult {
  success: boolean;
  sessions?: SessionReadEntry[];
  error?: string;
}

export interface SessionSendPayload {
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

  const session = deps.sessionMap.getByKey(
    deps.sessionKeyFor({
      machineId: payload.machineId,
      projectName: payload.projectName,
      branchName: payload.branchName,
      name: payload.name,
    }),
  );
  // Nothing running: say so. Swallowing the keystrokes with a 200 would let the
  // caller believe a command it never ran is running.
  if (!session) return { status: 200, body: { success: true, live: false, delivered: false } };

  session.lastInputAt = now();
  // A keystroke also RESUMES a quiesced shell (and with it the Sprite), so the
  // billing window has to restart at the instant of the write — the same call
  // the socket input path makes, for the same reason.
  resumeBillingClock(session);
  session.command.write(payload.input);

  return { status: 200, body: { success: true, live: true, delivered: true } };
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
  return tailOfLines(scrollbackLines(session.scrollback), limit);
}

/**
 * Answer liveness (+ optional scrollback) for every named session at one node.
 * Pure composition over injected deps — no HTTP or socket types — so it is unit
 * tested directly, exactly like `handleTerminalActivityRequest`.
 */
export async function handleSessionReadRequest(
  deps: SessionIoDeps,
  body: string,
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

  const sessions = names.map((name): SessionReadEntry => {
    const session = deps.sessionMap.getByKey(
      deps.sessionKeyFor({
        machineId: payload.machineId,
        projectName: payload.projectName,
        branchName: payload.branchName,
        name,
      }),
    );
    if (!session) return { name, live: false, hasOutput: false, viewers: 0, output: '' };
    return {
      name,
      live: true,
      hasOutput: session.hasOutput === true,
      viewers: session.viewers.size,
      output: scrollbackTail(session, limit),
    };
  });

  return { status: 200, body: { success: true, sessions } };
}
