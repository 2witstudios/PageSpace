/**
 * Session IO — the PTY half (a `'pty'`-surface session: a shell running in a
 * pane).
 *
 * `read_session` on a shell session answers with the tail of its SCROLLBACK
 * ring and an honest `live` flag; `send_session` writes to its STDIN. Both go
 * through the realtime service that actually owns the PTY — the web app never
 * holds the stream — which is why this module's real implementation is a pair
 * of signed calls to endpoints on the existing terminal-activity pattern,
 * signed only AFTER the shells in `session-tools.ts` have resolved and
 * authorized the target against the derived handle set.
 *
 * Those endpoints are the next phase's work. This module ships as their SEAM
 * and shares no code with the agent half (`session-io-agent.ts`), so the two
 * land independently.
 *
 * Refusing beats answering emptily here more than anywhere else in the family:
 * a shell session is RESERVED until a viewer first connects (its PTY has never
 * run), so an empty scrollback is a genuinely possible, genuinely different
 * answer from "not wired yet". Fabricating one would read as "the command
 * produced nothing".
 */

import type { SessionIoResult, SessionReadInput, SessionSendInput } from './session-tools';

const NOT_IMPLEMENTED_READ =
  'Reading a shell session\'s terminal output is not available yet — this is not the same as the session having produced nothing. Use list_sessions to see whether it has started at all.';

const NOT_IMPLEMENTED_SEND =
  'Sending keystrokes to a shell session is not available yet. Use bash (with target) to run a command at that node instead.';

export async function readPtySession(_input: SessionReadInput): Promise<SessionIoResult> {
  return { success: false, error: NOT_IMPLEMENTED_READ };
}

export async function sendPtySession(_input: SessionSendInput): Promise<SessionIoResult> {
  return { success: false, error: NOT_IMPLEMENTED_SEND };
}
