/**
 * The IO wrapper around the ONE agent-session access decision.
 *
 * Its whole job is to GATHER — the session row, whether the requester owns or
 * was shared the conversation, what page permission they hold, whether they may
 * run code — and hand all four to `decideAgentSessionAccess`. It contains no
 * decision of its own, and that is enforceable by reading it: the only `if`s
 * below turn a null into another null (there is no page, so there is no page
 * permission to fetch; there is no session, so there is nothing to decide
 * about). Anything that WEIGHS these facts belongs in the pure decider, where
 * both enforcement points share it.
 *
 * Both enforcement points being one function is the concrete mitigation for the
 * "web and realtime must not diverge" risk: the API routes and the realtime
 * shell-connect handler call THIS, so a change to who may reach a session cannot
 * land on one surface and miss the other.
 */

import {
  decideAgentSessionAccess,
  decideAgentSessionEndAccess,
  type AgentSessionAccessDecision,
  type AgentSessionAccessSubject,
  type AgentSessionPagePermission,
  type ConversationOwnership,
} from '../../agent-sessions/decide-session-access';

export interface AgentSessionAccessDeps {
  /** The session row, reduced to the three identity columns the decision needs. `null` = no such session. */
  findSession: (sessionId: string) => Promise<AgentSessionAccessSubject | null>;
  /**
   * The requester's relationship to the CONVERSATION: they own it, it was shared
   * with them, or neither. Injected because "shared" is a conversations-table
   * fact the app repository owns; the decider cross-checks the `owner` answer
   * against the row's `ownerId` rather than trusting it.
   */
  resolveConversationOwnership: (input: {
    conversationId: string;
    requesterId: string;
  }) => Promise<ConversationOwnership>;
  /**
   * The requester's permission on the agent page. Called ONLY for a
   * page-anchored session; a `null` answer (unresolved, or no access) denies —
   * unknown is never a grant.
   */
  resolvePagePermission: (input: {
    userId: string;
    agentPageId: string;
  }) => Promise<AgentSessionPagePermission | null>;
  /** The centralized `canRunCode` capability check, already reduced to a boolean by the caller's wiring. Must never throw (it is fail-closed by construction). */
  canRunCode: (input: { userId: string; agentPageId: string | null }) => Promise<boolean>;
}

/**
 * The decision, widened with the one outcome the pure decider cannot express:
 * there is no such session to decide about. Kept OUT of the decider because a
 * missing row is a lookup fact, not an access rule — and because collapsing it
 * into a denial reason would make "denied" and "does not exist" indistinguishable
 * to callers that must answer 404 vs 403 differently.
 */
export type AgentSessionAccessCheck =
  | AgentSessionAccessDecision
  | { allowed: false; reason: 'session_not_found' };

export async function checkAgentSessionAccess({
  requesterId,
  sessionId,
  deps,
}: {
  requesterId: string;
  sessionId: string;
  deps: AgentSessionAccessDeps;
}): Promise<AgentSessionAccessCheck> {
  const session = await deps.findSession(sessionId);
  if (!session) return { allowed: false, reason: 'session_not_found' };

  const [conversationOwnership, pagePermission, canRunCode] = await Promise.all([
    deps.resolveConversationOwnership({ conversationId: session.sessionId, requesterId }),
    // No page means no page permission to hold — a global-assistant session is
    // owner-only by construction, which the decider states and enforces.
    session.agentPageId === null
      ? Promise.resolve(null)
      : deps.resolvePagePermission({ userId: requesterId, agentPageId: session.agentPageId }),
    deps.canRunCode({ userId: requesterId, agentPageId: session.agentPageId }),
  ]);

  return decideAgentSessionAccess({ requesterId, session, conversationOwnership, pagePermission, canRunCode });
}

/**
 * The END-SESSION gather, wrapping {@link decideAgentSessionEndAccess}: same
 * facts minus the capability check, because ending a session is release of
 * compute and must survive a lost `canRunCode` (see the pure decider's doc).
 * The `canRunCode` dep is deliberately not in this function's `Pick` — an end
 * check that could consult it would be one refactor away from gating on it.
 */
export async function checkAgentSessionEndAccess({
  requesterId,
  sessionId,
  deps,
}: {
  requesterId: string;
  sessionId: string;
  deps: Omit<AgentSessionAccessDeps, 'canRunCode'>;
}): Promise<AgentSessionAccessCheck> {
  const session = await deps.findSession(sessionId);
  if (!session) return { allowed: false, reason: 'session_not_found' };

  const [conversationOwnership, pagePermission] = await Promise.all([
    deps.resolveConversationOwnership({ conversationId: session.sessionId, requesterId }),
    session.agentPageId === null
      ? Promise.resolve(null)
      : deps.resolvePagePermission({ userId: requesterId, agentPageId: session.agentPageId }),
  ]);

  return decideAgentSessionEndAccess({ requesterId, session, conversationOwnership, pagePermission });
}
