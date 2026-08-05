/**
 * Claim a NEVER-BOUND conversation into a session — the only place
 * `conversations.sessionId` is ever written, whether for a conversation
 * being created fresh (insert sessionless, then claim —
 * `create-conversation-in-session.ts` composes this) or one that has
 * existed unbound for years (a page-agent or global-assistant chat opened
 * outside any session, later opened into one from the Agents console).
 *
 * The binding is write-once. It never re-points an already-bound row: a
 * bound thread moving to another session is still a fork, never a rebind
 * (contract invariant 1). What makes this safe despite writing
 * `sessionId` at all — where the old design forbade any UPDATE of it — is
 * that this only ever moves a row FROM null, and only for its own owner:
 * `conversationRepository.claimConversation`'s guarded UPDATE carries both
 * `sessionId IS NULL` and `userId = :caller` in its WHERE, so neither an
 * already-bound row nor someone else's row can ever match. That is the
 * exact gap the old H1 finding needed (an unconditional UPDATE with no
 * ownership/state check letting a caller re-point an existing, possibly
 * foreign, conversation) — this primitive can't reproduce it, because a
 * "yes" here always means "this was MY row, and it had never been claimed
 * by anyone, ever, before this call."
 *
 * Pure decision logic over injected deps, per the repo rule that branching
 * which decides lifecycle/access lives in a testable module —
 * `agent-sessions-runtime.ts` only wires the production deps, wrapping the
 * whole decision in the same per-session advisory lock
 * create/close/reopen already use, so a claim can never race those for the
 * session's last cap slot.
 */

import { MAX_SESSION_CONVERSATIONS } from '@pagespace/lib/agent-sessions/plan-spawn-session';

export type ClaimConversationOutcome =
  | 'claimed'
  | 'already_in_session'
  | 'not_found'
  | 'cross_drive_denied'
  | 'session_full';

export interface ClaimConversationInSessionDeps {
  /** Row facts for the ownership/state gates. `conversationRepository.getConversation`, narrowed. */
  findConversation: (conversationId: string) => Promise<{
    userId: string;
    type: string;
    contextId: string | null;
    sessionId: string | null;
    isActive: boolean;
  } | null>;
  /** The agent page's drive, or null when the page is missing/trashed/not an agent. */
  findAgentDriveId: (agentPageId: string) => Promise<string | null>;
  /** The target session's drive and liveness, or null when the session is missing. */
  findSession: (sessionId: string) => Promise<{ driveId: string | null; endedAt: Date | null } | null>;
  /** ACTIVE, OPEN conversations already bound to this session — the cap's input. */
  countActiveConversations: (sessionId: string) => Promise<number>;
  /** The guarded UPDATE. `'noop'` means the world changed since the read above — a race, never a silent success. */
  claimConversation: (input: {
    conversationId: string;
    userId: string;
    sessionId: string;
  }) => Promise<'claimed' | 'noop'>;
}

export async function claimConversationInSessionWith(
  deps: ClaimConversationInSessionDeps,
  { conversationId, userId, sessionId }: { conversationId: string; userId: string; sessionId: string },
): Promise<ClaimConversationOutcome> {
  const row = await deps.findConversation(conversationId);
  if (row === null) return 'not_found';
  // The H1 gate — checked before anything else, so no later branch can
  // answer for a foreign row.
  if (row.userId !== userId) return 'not_found';
  if (!row.isActive) return 'not_found';

  // Idempotent retry: a double-click, a retried POST after a timeout, or two
  // panes racing the same claim must not error. No cap check either — this
  // request did not just consume a NEW slot.
  if (row.sessionId === sessionId) return 'already_in_session';

  // Any OTHER session — including one the caller owns — is refused. This is
  // the line that keeps H1 fixed: only a truly-never-bound row proceeds.
  if (row.sessionId !== null) return 'not_found';

  // `'client'` rows are API-managed and have no in-app viewer
  // (`resolveNavigationTarget` already calls them `unavailable`); binding one
  // would hand an API-managed thread a sandbox nothing can display.
  if (row.type !== 'page' && row.type !== 'global') return 'not_found';

  const sessionRow = await deps.findSession(sessionId);
  if (sessionRow === null) return 'not_found';
  // An ENDED session is a valid claim target, not a tombstone: the lifecycle
  // treats ended rows as resumable ("a torn-down session re-provisions under
  // the SAME key" — plan-session-lifecycle's ensure intent), and the claim
  // wiring reopens the listing (`planSessionReopen`) when a claim lands in
  // one. Refusing here contradicted that and permanently dead-ended every
  // thread bound to an ended workspace (issue #2335). Session lifecycle
  // state never gates a permitted claim; only ownership and drive rules do.

  if (row.type === 'page') {
    if (row.contextId === null) return 'not_found';
    const agentDriveId = await deps.findAgentDriveId(row.contextId);
    if (agentDriveId === null) return 'not_found';
    // A GLOBAL session (driveId null) is exempt — see
    // `AgentNotInSessionDriveError`'s doc comment in the create module for
    // the full rationale; the same exemption applies here.
    if (sessionRow.driveId !== null && sessionRow.driveId !== agentDriveId) return 'cross_drive_denied';
  }

  if ((await deps.countActiveConversations(sessionId)) >= MAX_SESSION_CONVERSATIONS) return 'session_full';

  const outcome = await deps.claimConversation({ conversationId, userId, sessionId });
  // 'noop' means the world changed between the read above and this write (a
  // concurrent claim from another tab won, a soft-delete landed, the row got
  // bound elsewhere) — the same answer a stale read would have produced.
  return outcome === 'claimed' ? 'claimed' : 'not_found';
}
