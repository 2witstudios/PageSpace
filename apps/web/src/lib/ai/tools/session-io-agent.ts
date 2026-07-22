/**
 * Session IO — the AGENT half (a `'chat'`-surface session: a PageSpace Agent
 * running in a pane).
 *
 * `read_session` on an agent session answers with its recent TRANSCRIPT;
 * `send_session` APPENDS a message and dispatches the target's own agent loop
 * — asynchronously, under a run-claim, with the TARGET node's binding, so a
 * dispatch never double-runs against a live client stream and never escapes
 * the target's own node scope.
 *
 * That engine is the next phase's work. This module ships as its SEAM: the
 * shells in `session-tools.ts` already resolve the target, authorize it
 * against the derived handle set, and dispatch here by surface, so landing the
 * engine is a change to these two function bodies and nothing else. Nothing
 * outside this file is touched by it — and this file shares no code with the
 * PTY half (`session-io-pty.ts`), so the two can land in either order.
 *
 * Both functions REFUSE rather than answer emptily. An agent session that
 * reports "no transcript" reads as a session that has said nothing; one that
 * says the capability isn't wired yet cannot be mistaken for that.
 */

import type { SessionIoResult, SessionReadInput, SessionSendInput } from './session-tools';

const NOT_IMPLEMENTED_READ =
  'Reading an agent session\'s transcript is not available yet. You can still see that the session exists, and what state it is in, with list_sessions.';

const NOT_IMPLEMENTED_SEND =
  'Sending work to an agent session is not available yet. You can start agent sessions with add_session, but they cannot be given instructions from here.';

export async function readAgentSession(_input: SessionReadInput): Promise<SessionIoResult> {
  return { success: false, error: NOT_IMPLEMENTED_READ };
}

export async function sendAgentSession(_input: SessionSendInput): Promise<SessionIoResult> {
  return { success: false, error: NOT_IMPLEMENTED_SEND };
}
