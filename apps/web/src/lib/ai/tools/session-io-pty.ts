/**
 * Session IO — the PTY half (a `'pty'`-surface session: a shell running in a
 * pane).
 *
 * `read_session` on a shell session answers with the tail of its SCROLLBACK
 * ring and an honest `live` flag; `send_session` writes to its STDIN. Both go
 * through the realtime service that actually owns the PTY — the web app never
 * holds the stream — so this module is a pair of signed calls to the
 * `/api/session-read` and `/api/session-input` endpoints (`apps/realtime/src/
 * terminal/session-io.ts`), on the same HMAC pattern as
 * `/api/terminal-activity`.
 *
 * NOTHING IS AUTHORIZED HERE. `session-tools.ts` resolved `{target?, name}`
 * against the conversation's derived handle set before calling in, and the
 * `identity.address` it hands over is the ONLY address this module ever signs
 * — a caller-supplied name never reaches the wire unresolved. Deciding node
 * access here would be the second policy site this epic exists to prevent.
 *
 * Refusing beats answering emptily here more than anywhere else in the family:
 * a shell session is RESERVED until something starts its PTY, so an empty
 * scrollback is a genuinely possible, genuinely different answer from "no live
 * PTY" and from "the realtime service did not answer". Each of the three gets
 * its own answer, and a transport failure NEVER degrades into "cold".
 *
 * Since issue #2206 both verbs also ASK for the start (`start: true` plus the
 * acting user). A reserved shell is no longer something to wait out — reading
 * it or typing into it boots it, on the same path a viewer's connect takes —
 * which is why the not-live wording here talks about a start that failed rather
 * than a human who has not arrived. The `list_sessions` liveness sweep
 * deliberately does NOT ask: it names every shell at a node at once, and the
 * realtime endpoint refuses a start on that shape.
 */

import { createSignedBroadcastHeaders } from '@pagespace/lib/auth/broadcast-auth';
import { annotateToolOutput } from '@pagespace/lib/services/sandbox/injection-seam';
import { loggers } from '@pagespace/lib/logging/logger-config';
import type { MachineNodeHandle } from '@pagespace/lib/services/machines/machine-pane-binding';
import { scrollbackLines, tailOfLines } from '@pagespace/lib/services/machines/session-scrollback';
import type { SessionIoResult, SessionReadInput, SessionSendInput } from './session-tools';

/** Default scrollback tail when the model does not ask for a size. */
const DEFAULT_TAIL_LINES = 100;

/** How long the realtime service gets to answer — a map lookup, not a Sprite call. */
const REALTIME_TIMEOUT_MS = 5000;

/** One session's liveness (+ optional scrollback), as `/api/session-read` answers it. */
export interface RealtimeSessionReadEntry {
  name: string;
  live: boolean;
  hasOutput: boolean;
  viewers: number;
  output: string;
  /** Present only when THIS call started the PTY (issue #2206). */
  started?: true;
}

export interface RealtimeSessionReadResponse {
  success: boolean;
  sessions: RealtimeSessionReadEntry[];
}

export interface RealtimeSessionSendResponse {
  success: boolean;
  live?: boolean;
  delivered?: boolean;
  /** Present only when THIS call started the PTY (issue #2206). */
  started?: true;
}

/**
 * "Start this session's PTY if it has never run, for this user" — the headless
 * start (issue #2206).
 *
 * Sent on the two calls a model makes ABOUT ONE named session, and deliberately
 * not on the `list_sessions` liveness sweep: the sweep asks about every shell at
 * a node at once, and starting on it would boot a sandbox per row for a listing.
 * (The realtime endpoint refuses a start on a multi-name read outright, so this
 * is a rule enforced at both ends rather than a convention here.)
 *
 * `userId` travels because the start is authorized, metered and audited against
 * a real person on the realtime side, exactly as a socket connect is — this
 * module's own resolution authorized an ADDRESS, not the spending of a
 * concurrency slot and a payer's credits.
 */
interface RealtimeSessionStartRequest {
  start: true;
  userId: string;
}

export interface RealtimeSessionSendPayload extends RealtimeSessionStartRequest {
  machineId: string;
  projectName?: string;
  branchName?: string;
  name: string;
  input: string;
}

export interface RealtimeSessionReadPayload {
  machineId: string;
  projectName?: string;
  branchName?: string;
  names: string[];
  limit: number;
  /** Absent on the liveness sweep — see `RealtimeSessionStartRequest`. */
  start?: true;
  userId?: string;
}

/**
 * The signed HTTP hop, injected so the tool logic is unit-tested without a
 * network. `null` means the call did not produce an answer (unreachable,
 * timed out, non-2xx, unparseable) — deliberately distinct from an answer
 * saying the session is not live.
 */
export interface RealtimeSessionIoTransport {
  read: (payload: RealtimeSessionReadPayload) => Promise<RealtimeSessionReadResponse | null>;
  send: (payload: RealtimeSessionSendPayload) => Promise<RealtimeSessionSendResponse | null>;
}

/** The `{projectName?, branchName?}` half of a node, as the endpoints take it. */
function nodeNames(node: { project?: string; branch?: string }): { projectName?: string; branchName?: string } {
  return {
    ...(node.project ? { projectName: node.project } : {}),
    ...(node.branch ? { branchName: node.branch } : {}),
  };
}

/** Apply a reader's `limit` (in lines) to an already-normalized stored cold tail — the reader-facing half of `session-scrollback.ts`'s shared core. */
function limitColdTail(tail: string, limit: number): string {
  return tailOfLines(scrollbackLines([tail]), limit);
}

/**
 * Answer `read_session` for a session with no live PTY (issue #2205): the row
 * may carry a cold tail from its LAST DEAD incarnation, persisted on teardown
 * by the realtime bridge (`agent-terminal-handler.ts`'s
 * `planColdTailPersist`/`persistColdTail`). Pure so it is unit-tested without
 * a transport.
 *
 * No `cold` at all means this row has never been torn down (or was torn down
 * before this persist path existed) — today's answer, byte-for-byte
 * unchanged, since there is genuinely nothing more honest to say. A `cold`
 * carrying an empty tail but `hasOutput: true` is a THIRD, distinct case (a
 * burst larger than the ring left nothing retained) — never the same as
 * silence.
 *
 * The live/cold distinction stays explicit no matter which branch answers:
 * `live` is always `false` here, and the note says plainly that this is the
 * FINAL scrollback of a PTY that has since ENDED — never presented as
 * current output.
 */
export function planColdReadAnswer({
  name,
  limit,
  cold,
}: {
  name: string;
  limit?: number;
  cold?: { tail: string; at: Date; hasOutput: boolean };
}): SessionIoResult {
  if (!cold) {
    return {
      success: true,
      name,
      live: false,
      hasOutput: false,
      watchers: 0,
      output: '',
      // Since issue #2206 THIS read attempts to start a never-run PTY itself —
      // no cold tail AND not live means either it has ended, or a start was
      // just attempted for this read and failed (the machine may be out of
      // credits or at its terminal limit). Never "waiting for a human".
      note: 'This shell session has no running terminal right now — either it has ended, or one could not be started for this read (the machine may be out of credits or at its terminal limit). This is NOT the same as it having produced no output.',
    };
  }

  const tail = limitColdTail(cold.tail, limit ?? DEFAULT_TAIL_LINES);
  const endedNote = `This shell session's PTY has ENDED (at ${cold.at.toISOString()}) — this is its final scrollback, NOT live output, and nothing typed into it now would run.`;

  if (cold.hasOutput && tail.length === 0) {
    return {
      success: true,
      name,
      live: false,
      hasOutput: true,
      watchers: 0,
      output: '',
      note: `${endedNote} It produced output before ending, but none of it is still in the retained tail (a large burst pushed it out).`,
    };
  }

  return {
    success: true,
    name,
    live: false,
    hasOutput: cold.hasOutput,
    watchers: 0,
    output: annotateToolOutput({ text: tail, response: 'annotate' }),
    note: endedNote,
  };
}

const UNREACHABLE_SEND =
  'Could not reach the terminal service, so this input was NOT delivered. Nothing was typed into the session.';

/**
 * A send that reached the service and still found no PTY. Since #2206 the
 * service will START one, so this is no longer "wait for a human to open it" —
 * the start itself failed, and the reasons are the ones that stop any session
 * opening: the payer is out of credits, or the user is at their concurrent
 * terminal limit. Naming those is what makes the message actionable; the old
 * wording sent the model to `bash` for a shell that would never open either.
 */
const UNSTARTABLE_SEND = (name: string) =>
  `Nothing was typed: session "${name}" has no running terminal, and one could not be started ` +
  '(the machine may be out of credits or at its terminal limit). Nothing was delivered.';

const UNREACHABLE_READ =
  'Could not reach the terminal service to read this session, so its output is unknown — this does NOT mean the session produced nothing or has stopped. Try again.';

/**
 * The IO pair over an injected transport. `liveness` is the third caller: the
 * `list_sessions` sweep, which asks the same endpoint for every shell session
 * at a node with `limit: 0` (no scrollback shipped, just the flags).
 */
export function createPtySessionIo(transport: RealtimeSessionIoTransport): {
  read: (input: SessionReadInput) => Promise<SessionIoResult>;
  send: (input: SessionSendInput) => Promise<SessionIoResult>;
  liveness: (node: MachineNodeHandle, names: string[]) => Promise<Set<string> | undefined>;
} {
  return {
    read: async ({ identity, actor, limit, cold }) => {
      const { machineId, projectName, branchName, name } = identity.address;
      const answer = await transport.read({
        machineId,
        ...(projectName ? { projectName } : {}),
        ...(branchName ? { branchName } : {}),
        names: [name],
        limit: limit ?? DEFAULT_TAIL_LINES,
        // Reading a shell that has never run STARTS it (issue #2206): a reader
        // has no other way to get one going, and "it starts when a human opens
        // it" is not an answer an agent can act on. BUT only when there is no
        // COLD tail to fall back on (issue #2205): a `cold` record means this
        // row already ran and ended, so a start here would boot a fresh, EMPTY
        // PTY (billing a new session) and bury the very answer — the final
        // scrollback — `planColdReadAnswer` exists to serve. A row with no
        // cold record at all is the genuinely reserved/never-run case #2206
        // targets, so that one still starts.
        ...(cold === undefined ? { start: true as const, userId: actor.userId } : {}),
      });

      const entry = answer?.success ? answer.sessions.find((session) => session.name === name) : undefined;
      if (!entry) return { success: false, error: UNREACHABLE_READ };

      // A cold tail is history, never consulted while the PTY is live — liveness
      // always wins, exactly like `readSessionState`'s `'reserved'`/`'idle'` derivation.
      if (!entry.live) {
        return planColdReadAnswer({ name, limit, cold });
      }

      return {
        success: true,
        name,
        live: true,
        hasOutput: entry.hasOutput,
        watchers: entry.viewers,
        ...(entry.started ? { started: true } : {}),
        // Terminal output is written by whatever is running in that shell — a
        // build log, a remote file, another agent. It is data about the world,
        // never instruction, and the frame says so INSIDE the payload where a
        // later truncation cannot strip it.
        output: annotateToolOutput({ text: entry.output, response: 'annotate' }),
        // Three different empties, three different notes. A session that just
        // BOOTED for this read has produced nothing yet and will; one that has
        // produced output the ring dropped will not reproduce it; and an
        // ordinary quiet session needs no explanation at all.
        ...(entry.started
          ? {
              note: 'This shell session had no running terminal, so one was started for this read. It has produced nothing yet — give it a moment, or use send_session to type a command into it.',
            }
          : entry.hasOutput && entry.output.length === 0
            ? {
                note: 'This session has produced output, but none of it is still in the scrollback ring (a large burst pushed it out).',
              }
            : {}),
      };
    },

    send: async ({ identity, actor, input }) => {
      const { machineId, projectName, branchName, name } = identity.address;
      const answer = await transport.send({
        machineId,
        ...(projectName ? { projectName } : {}),
        ...(branchName ? { branchName } : {}),
        name,
        // Control characters are NOT stripped: to a PTY they are keys, and
        // Ctrl-C (\x03) / Ctrl-D (\x04) / ESC are the only way to interrupt a
        // runaway process or answer a full-screen prompt. This is the opposite
        // of `terminal-activity.ts`'s policy for a REASON — there the bytes are
        // interpolated into a display line an xterm renders, where an ESC
        // sequence could forge output; here they are delivered to a program's
        // stdin, which is exactly what a keyboard does.
        input,
        // Typing into a shell that has never run STARTS it (issue #2206) —
        // otherwise the very first thing an agent does with a session it just
        // added would be refused.
        start: true,
        userId: actor.userId,
      });

      if (!answer?.success) return { success: false, error: UNREACHABLE_SEND };

      // Not live, or live but undelivered — either way nothing was typed, and
      // reporting success would leave the model waiting on a command that was
      // never run.
      if (!answer.live || !answer.delivered) {
        return { success: false, error: UNSTARTABLE_SEND(name) };
      }

      return {
        success: true,
        name,
        delivered: true,
        ...(answer.started ? { started: true } : {}),
        note: answer.started
          // Worth saying: the shell's own boot output (a prompt, a login banner)
          // will be interleaved with this command's, and a model that did not
          // know it started the shell could read that as its command misbehaving.
          ? 'This session had no running terminal, so one was started and the input was typed into it exactly as given. Its output will include the shell\'s own startup. Use read_session to see the result.'
          : 'Input was typed into the session exactly as given — anyone watching that terminal saw it, and what it produces appears in the session\'s output. Use read_session to see the result.',
      };
    },

    liveness: async (node, names) => {
      // No shell sessions at this node — nothing to ask, and a round trip that
      // could only answer "[]" is a round trip worth not making.
      if (names.length === 0) return new Set<string>();

      const answer = await transport.read({
        machineId: node.machineId,
        ...nodeNames(node),
        names,
        limit: 0,
      });
      // Unknown is not "dead". Returning undefined lets `readSessionState` fall
      // back to its data-only answer rather than reporting every session idle
      // because one HTTP call failed.
      if (!answer?.success) return undefined;
      return new Set(answer.sessions.filter((session) => session.live).map((session) => session.name));
    },
  };
}

/** POST one signed payload to a realtime session-IO endpoint; `null` on any non-answer. */
async function postSigned<T>(path: string, payload: unknown): Promise<T | null> {
  const realtimeUrl = process.env.INTERNAL_REALTIME_URL;
  if (!realtimeUrl) return null;

  try {
    const body = JSON.stringify(payload);
    const response = await fetch(`${realtimeUrl}${path}`, {
      method: 'POST',
      headers: createSignedBroadcastHeaders(body),
      body,
      signal: AbortSignal.timeout(REALTIME_TIMEOUT_MS),
    });
    if (!response.ok) {
      loggers.ai.warn('session-io-pty: realtime rejected the request', { path, status: response.status });
      return null;
    }
    return (await response.json()) as T;
  } catch (error) {
    loggers.ai.error('session-io-pty: realtime request failed', error instanceof Error ? error : new Error(String(error)), {
      path,
    });
    return null;
  }
}

/** The production transport: signed POSTs to the realtime service that owns the PTYs. */
export const realtimeSessionIoTransport: RealtimeSessionIoTransport = {
  read: (payload) => postSigned<RealtimeSessionReadResponse>('/api/session-read', payload),
  send: (payload) => postSigned<RealtimeSessionSendResponse>('/api/session-input', payload),
};

const ptySessionIo = createPtySessionIo(realtimeSessionIoTransport);

export const readPtySession = ptySessionIo.read;

export const sendPtySession = ptySessionIo.send;
/** The `list_sessions` liveness sweep — wired in as `SessionToolsDeps.ptyLiveness`. */
export const readPtyLiveness = ptySessionIo.liveness;
