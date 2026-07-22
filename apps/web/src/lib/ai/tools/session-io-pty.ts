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
 * a shell session is RESERVED until a viewer first connects (its PTY has never
 * run), so an empty scrollback is a genuinely possible, genuinely different
 * answer from "no live PTY" and from "the realtime service did not answer".
 * Each of the three gets its own answer, and a transport failure NEVER
 * degrades into "cold".
 */

import { createSignedBroadcastHeaders } from '@pagespace/lib/auth/broadcast-auth';
import { annotateToolOutput } from '@pagespace/lib/services/sandbox/injection-seam';
import { loggers } from '@pagespace/lib/logging/logger-config';
import type { MachineNodeHandle } from '@pagespace/lib/services/machines/machine-pane-binding';
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
}

export interface RealtimeSessionReadResponse {
  success: boolean;
  sessions: RealtimeSessionReadEntry[];
}

export interface RealtimeSessionReadPayload {
  machineId: string;
  projectName?: string;
  branchName?: string;
  names: string[];
  limit: number;
}

/**
 * The signed HTTP hop, injected so the tool logic is unit-tested without a
 * network. `null` means the call did not produce an answer (unreachable,
 * timed out, non-2xx, unparseable) — deliberately distinct from an answer
 * saying the session is not live.
 */
export interface RealtimeSessionIoTransport {
  read: (payload: RealtimeSessionReadPayload) => Promise<RealtimeSessionReadResponse | null>;
}

/** The `{projectName?, branchName?}` half of a node, as the endpoints take it. */
function nodeNames(node: { project?: string; branch?: string }): { projectName?: string; branchName?: string } {
  return {
    ...(node.project ? { projectName: node.project } : {}),
    ...(node.branch ? { branchName: node.branch } : {}),
  };
}

const UNREACHABLE_READ =
  'Could not reach the terminal service to read this session, so its output is unknown — this does NOT mean the session produced nothing or has stopped. Try again.';

/**
 * The IO pair over an injected transport. `liveness` is the third caller: the
 * `list_sessions` sweep, which asks the same endpoint for every shell session
 * at a node with `limit: 0` (no scrollback shipped, just the flags).
 */
export function createPtySessionIo(transport: RealtimeSessionIoTransport): {
  read: (input: SessionReadInput) => Promise<SessionIoResult>;
  liveness: (node: MachineNodeHandle, names: string[]) => Promise<Set<string> | undefined>;
} {
  return {
    read: async ({ identity, limit }) => {
      const { machineId, projectName, branchName, name } = identity.address;
      const answer = await transport.read({
        machineId,
        ...(projectName ? { projectName } : {}),
        ...(branchName ? { branchName } : {}),
        names: [name],
        limit: limit ?? DEFAULT_TAIL_LINES,
      });

      const entry = answer?.success ? answer.sessions.find((session) => session.name === name) : undefined;
      if (!entry) return { success: false, error: UNREACHABLE_READ };

      if (!entry.live) {
        return {
          success: true,
          name,
          live: false,
          hasOutput: false,
          watchers: 0,
          output: '',
          note: 'This shell session has no running terminal right now — either its PTY has never started (it starts when a human first opens it) or it has since ended. This is NOT the same as it having produced no output.',
        };
      }

      return {
        success: true,
        name,
        live: true,
        hasOutput: entry.hasOutput,
        watchers: entry.viewers,
        // Terminal output is written by whatever is running in that shell — a
        // build log, a remote file, another agent. It is data about the world,
        // never instruction, and the frame says so INSIDE the payload where a
        // later truncation cannot strip it.
        output: annotateToolOutput({ text: entry.output, response: 'annotate' }),
        ...(entry.hasOutput && entry.output.length === 0
          ? {
              note: 'This session has produced output, but none of it is still in the scrollback ring (a large burst pushed it out).',
            }
          : {}),
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
};

const ptySessionIo = createPtySessionIo(realtimeSessionIoTransport);

export const readPtySession = ptySessionIo.read;

/**
 * `send_session`'s PTY half — the stdin endpoint is the next leaf. Until then
 * this refuses honestly rather than claiming a keystroke landed.
 */
export async function sendPtySession(_input: SessionSendInput): Promise<SessionIoResult> {
  return {
    success: false,
    error:
      'Sending keystrokes to a shell session is not available yet. Use bash (with target) to run a command at that node instead.',
  };
}
/** The `list_sessions` liveness sweep — wired in as `SessionToolsDeps.ptyLiveness`. */
export const readPtyLiveness = ptySessionIo.liveness;
