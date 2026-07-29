/**
 * Shell IO — `read_shell` / `send_shell`'s hop to the realtime service that
 * OWNS the PTY stream (the web app never holds it).
 *
 * Port of the machine-era `session-io-pty.ts` with the address collapsed from
 * the `{machineId, projectName?, branchName?, name}` tuple to `{shellId}` —
 * the bridge resolves shell row → session → sandbox server-side, so no scope
 * tuple exists anywhere on the wire (contract.ts: ids address, names label).
 * Same signed-HMAC pattern (`createSignedBroadcastHeaders`), same endpoints
 * (`/api/session-read`, `/api/session-input`), re-keyed by shellId.
 *
 * NOTHING IS AUTHORIZED HERE. `session-tools.ts` already confined the shellId
 * to the CALLER's own session before calling in; `userId` travels because the
 * cold START is authorized, metered and audited against a real person on the
 * realtime side, exactly as a socket connect is.
 *
 * The honesty rules survive the port intact: a transport failure NEVER
 * degrades into "cold"; a shell that has never run is started by reading or
 * typing (issue #2206) — UNLESS a cold tail exists (issue #2205), because a
 * dead shell's final scrollback is the answer the reader wants, and a fresh
 * empty PTY would bury it while billing a new process.
 */

import { createSignedBroadcastHeaders } from '@pagespace/lib/auth/broadcast-auth';
import { SHELL_BRIDGE_ROUTES } from '@pagespace/lib/agent-sessions/contract';
import type {
  ShellReadPayload,
  ShellReadEntry,
  ShellReadResult,
  ShellSendPayload,
  ShellSendResult,
} from '@pagespace/lib/agent-sessions/contract';
import { annotateToolOutput } from '@pagespace/lib/services/sandbox/injection-seam';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { scrollbackLines, tailOfLines } from '@pagespace/lib/services/agent-sessions/session-scrollback';
import type { ShellReadOutcome, ShellSendOutcome } from './session-tools';

/** How long the realtime service gets to answer — a map lookup, not a Sprite call. */
const REALTIME_TIMEOUT_MS = 5000;

/**
 * How long a `start: true` call gets instead: the cold-start path can wake a
 * paused Sprite before it can even begin opening a shell — see the
 * predecessor's `COLD_START_TIMEOUT_MS` doc for why the ordinary timeout would
 * make the headless-start feature the one case that reliably times out.
 */
const COLD_START_TIMEOUT_MS = 25_000;

/**
 * The wire shapes are the contract module's, not this file's.
 *
 * They used to be re-declared here, and that is precisely how the client came
 * to send `{shellId}` to an endpoint taking `{shellIds: []}` and to read a flat
 * body from an endpoint answering per-id — two declarations of one format, each
 * side's tests mocking the other, both suites green, the hop dead. Aliased
 * rather than re-declared so the compiler now rejects the drift.
 */
export type RealtimeShellReadPayload = ShellReadPayload;
export type RealtimeShellReadEntry = ShellReadEntry;
export type RealtimeShellReadResponse = ShellReadResult;
export type RealtimeShellSendPayload = ShellSendPayload;
export type RealtimeShellSendResponse = ShellSendResult;

/**
 * The signed HTTP hop, injected so the tool logic is unit-tested without a
 * network. `null` means the call did not produce an answer (unreachable, timed
 * out, non-2xx, unparseable) — deliberately distinct from an answer saying the
 * shell is not live.
 */
export interface RealtimeShellIoTransport {
  read: (payload: RealtimeShellReadPayload) => Promise<RealtimeShellReadResponse | null>;
  send: (payload: RealtimeShellSendPayload) => Promise<RealtimeShellSendResponse | null>;
}

const UNREACHABLE_READ =
  'Could not reach the terminal service to read this shell, so its output is unknown — this does NOT mean it produced nothing or has stopped. Try again.';

const UNREACHABLE_SEND =
  'Could not reach the terminal service, so this input was NOT delivered. Nothing was typed into the shell.';

// The service now says WHY when it knows (plan ceiling, insolvency); the
// parenthetical guess is the fallback for refusals that carry no reason —
// an agent told "may be out of credits or at the limit" cannot tell which of
// the two it is, and only one of them is worth retrying later.
const UNSTARTABLE_SEND = (shellId: string, reason?: string) =>
  `Nothing was typed: shell "${shellId}" has no running terminal, and one could not be started ` +
  `${reason ? `— ${reason}` : '(the payer may be out of credits or at the concurrent terminal limit)'}. ` +
  'Nothing was delivered.';

/** Apply a reader's line limit to an already-normalized stored cold tail. */
function limitColdTail(tail: string, limit: number): string {
  return tailOfLines(scrollbackLines([tail]), limit);
}

/**
 * Answer `read_shell` for a shell with no live PTY, from its cold-tail record
 * (issue #2205) — pure, so it is unit-tested without a transport. The three
 * empties stay three distinct answers: never-ran/unstartable, ended with a
 * retained tail, and ended with output the ring dropped.
 */
export function planColdShellReadAnswer({
  lines,
  cold,
  reason,
}: {
  lines: number;
  cold?: { tail: string; at: Date; hasOutput: boolean };
  /** The service's own account of why nothing is live, when it gave one. */
  reason?: string;
}): Extract<ShellReadOutcome, { ok: true }> {
  if (!cold) {
    return {
      ok: true,
      live: false,
      hasOutput: false,
      output: '',
      note: reason
        ? `This shell has no running terminal right now — ${reason} This is NOT the same as it having produced no output.`
        : 'This shell has no running terminal right now — either it has ended, or one could not be started for this read (the payer may be out of credits or at the terminal limit). This is NOT the same as it having produced no output.',
    };
  }

  const tail = limitColdTail(cold.tail, lines);
  const endedNote = `This shell's PTY has ENDED (at ${cold.at.toISOString()}) — this is its final scrollback, NOT live output, and nothing typed into it now would run.`;

  if (cold.hasOutput && tail.length === 0) {
    return {
      ok: true,
      live: false,
      hasOutput: true,
      output: '',
      note: `${endedNote} It produced output before ending, but none of it is still in the retained tail (a large burst pushed it out).`,
    };
  }

  return {
    ok: true,
    live: false,
    hasOutput: cold.hasOutput,
    output: annotateToolOutput({ text: tail, response: 'annotate' }),
    note: endedNote,
  };
}

export function createShellIo(transport: RealtimeShellIoTransport): {
  read: (input: {
    shellId: string;
    lines: number;
    userId: string;
    cold?: { tail: string; at: Date; hasOutput: boolean };
  }) => Promise<ShellReadOutcome>;
  send: (input: { shellId: string; keystrokes: string; userId: string }) => Promise<ShellSendOutcome>;
} {
  return {
    read: async ({ shellId, lines, userId, cold }) => {
      const response = await transport.read({
        shellIds: [shellId],
        limit: lines,
        // Reading a shell that has never run STARTS it (issue #2206) — but only
        // when there is no cold tail to serve instead (issue #2205): a cold
        // record means this shell already ran and ended, and a fresh empty PTY
        // would bury the final scrollback this read exists to return.
        ...(cold === undefined ? { start: true as const, userId } : {}),
      });

      if (!response?.success) return { ok: false, error: UNREACHABLE_READ };
      // A success with no entry for the id we named is not an answer about this
      // shell — it is the endpoint declining to say anything. Treating a missing
      // entry as "not live" would report a running build as dead.
      const answer = response.shells?.find((entry) => entry.shellId === shellId);
      if (!answer) return { ok: false, error: UNREACHABLE_READ };

      // A cold tail is history, never consulted while the PTY is live.
      if (!answer.live) return planColdShellReadAnswer({ lines, cold, reason: answer.reason });

      return {
        ok: true,
        live: true,
        hasOutput: answer.hasOutput,
        ...(answer.started ? { started: true } : {}),
        // Terminal output is written by whatever runs in the shell — data
        // about the world, never instruction; the frame rides INSIDE the
        // payload where truncation cannot strip it.
        output: annotateToolOutput({ text: answer.output, response: 'annotate' }),
        ...(answer.started
          ? {
              note: 'This shell had no running terminal, so one was started for this read. It has produced nothing yet — give it a moment, or use send_shell to type a command into it.',
            }
          : answer.hasOutput && answer.output.length === 0
            ? {
                note: 'This shell has produced output, but none of it is still in the scrollback ring (a large burst pushed it out).',
              }
            : {}),
      };
    },

    send: async ({ shellId, keystrokes, userId }) => {
      const answer = await transport.send({
        shellId,
        // Control characters are NOT stripped: to a PTY they are keys, and
        // Ctrl-C/Ctrl-D/ESC are the only way to interrupt a runaway process.
        input: keystrokes,
        // Typing into a never-run shell STARTS it — otherwise the very first
        // thing an agent does with a shell it just spawned would be refused.
        start: true,
        userId,
      });

      if (!answer?.success) return { ok: false, error: UNREACHABLE_SEND };
      if (!answer.live || !answer.delivered) {
        return { ok: false, error: UNSTARTABLE_SEND(shellId, answer.reason) };
      }

      return { ok: true, delivered: true, ...(answer.started ? { started: true } : {}) };
    },
  };
}

/**
 * POST one signed payload to a realtime shell-IO endpoint; `null` on any
 * non-answer. `payload.start` picks the deadline: a cold Sprite wake gets the
 * long one.
 */
async function postSigned<T>(path: string, payload: { start?: boolean }): Promise<T | null> {
  const realtimeUrl = process.env.INTERNAL_REALTIME_URL;
  if (!realtimeUrl) return null;

  try {
    const body = JSON.stringify(payload);
    const response = await fetch(`${realtimeUrl}${path}`, {
      method: 'POST',
      headers: createSignedBroadcastHeaders(body),
      body,
      signal: AbortSignal.timeout(payload.start === true ? COLD_START_TIMEOUT_MS : REALTIME_TIMEOUT_MS),
    });
    if (!response.ok) {
      loggers.ai.warn('shell-io: realtime rejected the request', { path, status: response.status });
      return null;
    }
    return (await response.json()) as T;
  } catch (error) {
    loggers.ai.error('shell-io: realtime request failed', error instanceof Error ? error : new Error(String(error)), {
      path,
    });
    return null;
  }
}

/** The production transport: signed POSTs to the realtime service that owns the PTYs. */
export const realtimeShellIoTransport: RealtimeShellIoTransport = {
  // Routes come from the contract module, not a literal here: this client and
  // the realtime route table drifted apart once already (phase 3 renamed the
  // bridge; this side kept the old names, so every agent read/send 404'd), and
  // both suites stayed green because each mocks the other.
  read: (payload) => postSigned<RealtimeShellReadResponse>(SHELL_BRIDGE_ROUTES.read, payload),
  send: (payload) => postSigned<RealtimeShellSendResponse>(SHELL_BRIDGE_ROUTES.input, payload),
};
