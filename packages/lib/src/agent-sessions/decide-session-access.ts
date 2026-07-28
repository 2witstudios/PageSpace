/**
 * The ONE agent-session access decision.
 *
 * Both enforcement points — the web API routes and the realtime shell-connect
 * handler — call this function. That is the concrete mitigation for the risk
 * that the two surfaces drift apart: they cannot, because there is only one
 * decision, and its input shape is constructible from either side (a requester
 * id, the session row's own two identity columns, and three facts the caller
 * looks up: is the conversation shared, what page permission does the requester
 * hold, may they run code at all).
 *
 * Three gates, all of which must pass, evaluated in a fixed order so a denial
 * always names the FIRST thing wrong:
 *
 *  1. **Identity** — the requester owns the conversation, or it is shared with
 *     them. This is the "is this yours" question and it is asked first.
 *  2. **Page** — for a session anchored to an agent page, view access to that
 *     page. For a global-assistant session (`agentPageId` null) there is no page
 *     to share through, so it is owner-only by construction.
 *  3. **Capability** — `canRunCode` (app-admin + the CODE_EXECUTION flag,
 *     computed by the centralized checker). A distinct reason, because it is a
 *     distinct condition: the requester may legitimately see this conversation
 *     and still not be allowed a sandbox.
 *
 * Everything fails closed: an unresolved page permission denies, a caller that
 * mis-derives ownership denies, and an empty requester denies.
 */

/** The session columns the decision needs — no more, so both surfaces can build it from a single row read. */
export interface AgentSessionAccessSubject {
  /** ≡ the conversation id. */
  sessionId: string;
  ownerId: string;
  /** null = a global-assistant session: no agent page, so no page to derive access from. */
  agentPageId: string | null;
}

/**
 * What the caller determined about the requester's relationship to the
 * CONVERSATION. `'owner'` is cross-checked against `session.ownerId` rather than
 * trusted — a caller that computes it wrongly is a bug we want to fail closed on,
 * not honor.
 */
export type ConversationOwnership = 'owner' | 'shared' | 'none';

/** The requester's permission on `agentPageId`. `null` = no page, or not resolved (denied). */
export type AgentSessionPagePermission = 'view' | 'edit' | 'none';

export type AgentSessionDenialReason =
  | 'invalid_requester'
  | 'not_shared'
  | 'ownership_mismatch'
  | 'page_access_denied'
  | 'global_assistant_not_owner'
  | 'code_execution_denied';

export type AgentSessionAccessDecision =
  | { allowed: true }
  | { allowed: false; reason: AgentSessionDenialReason };

export interface DecideAgentSessionAccessInput {
  requesterId: string;
  session: AgentSessionAccessSubject;
  conversationOwnership: ConversationOwnership;
  pagePermission: AgentSessionPagePermission | null;
  canRunCode: boolean;
}

export function decideAgentSessionAccess({
  requesterId,
  session,
  conversationOwnership,
  pagePermission,
  canRunCode,
}: DecideAgentSessionAccessInput): AgentSessionAccessDecision {
  if (requesterId.length === 0) {
    return { allowed: false, reason: 'invalid_requester' };
  }

  // Ownership is derived from ids, not taken on the caller's word: the id
  // comparison is the fact, `conversationOwnership` only adds what ids cannot say
  // (whether a non-owner was shared in).
  const isOwner = requesterId === session.ownerId;

  if (!isOwner) {
    if (conversationOwnership === 'owner') {
      // The caller says "owner" about someone who is not the owner — a mis-derived
      // input, never a grant.
      return { allowed: false, reason: 'ownership_mismatch' };
    }
    if (conversationOwnership !== 'shared') {
      return { allowed: false, reason: 'not_shared' };
    }
  }

  if (session.agentPageId === null) {
    // A global-assistant session has no page to share through — sharing the
    // conversation cannot widen it, so it stays private to its owner.
    if (!isOwner) return { allowed: false, reason: 'global_assistant_not_owner' };
  } else if (pagePermission !== 'view' && pagePermission !== 'edit') {
    // Includes an unresolved permission (`null`): unknown is denied.
    return { allowed: false, reason: 'page_access_denied' };
  }

  if (!canRunCode) {
    return { allowed: false, reason: 'code_execution_denied' };
  }

  return { allowed: true };
}
