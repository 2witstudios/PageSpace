import type { UIMessage } from 'ai';
import { synthesizeAssistantMessage } from './synthesizeAssistantMessage';

export interface PlanOwnStreamCommitInput {
  /** useChat's finished assistant message (its id IS the persisted DB row id — both stream routes generate the SDK message id server-side). */
  message: { id: string; role: string; parts: UIMessage['parts'] };
  /** The request was stopped locally (useChat `stop()`). */
  isAbort: boolean;
  /** The request ended on a network error mid-stream. */
  isDisconnect: boolean;
  /** The request ended on an error. */
  isError: boolean;
  /** The pending-stream mirror entry's startedAt, when still present at finish time. */
  startedAt: string | undefined;
}

/**
 * Decides whether a finished own-chat request should be committed into the
 * conversation message cache, and builds the message to commit (null = no
 * commit).
 *
 * WHY THIS EXISTS: the sender's live bubble is only a pending-streams mirror
 * entry, removed on the falling edge (planOwnStreamMirror). The completed
 * reply otherwise reaches the cache only via the best-effort
 * `chat:stream_complete` socket broadcast — which panes can miss entirely
 * (subscriber gated on a different "active" conversation) and which the
 * sender's own tab can only service via a full reload (its stream entry is
 * already removed when the handler runs). Committing locally from the drained
 * response body makes the sender independent of that broadcast.
 *
 * Rules:
 * - error/disconnect → no commit: persistence of the full reply is not
 *   proven, and the error UI / socket reload paths own recovery.
 * - abort → commit as 'interrupted': a Stop on a pane's own chat is always a
 *   genuine local abort (pane sends are always same-conversation, so the
 *   pre-send handoff can never stop this chat on another conversation's
 *   behalf), and the route persists the partial with the same status.
 * - non-assistant or zero parts → no commit: nothing renderable; the socket
 *   reload path owns the zero-parts completion (same contract as
 *   shouldReloadOnComountComplete).
 */
export const planOwnStreamCommit = (input: PlanOwnStreamCommitInput): UIMessage | null => {
  if (input.isDisconnect || input.isError) return null;
  if (input.message.role !== 'assistant') return null;
  if (input.message.parts.length === 0) return null;
  return synthesizeAssistantMessage(
    input.message.id,
    input.message.parts,
    input.startedAt,
    input.isAbort ? 'interrupted' : 'complete',
  );
};
