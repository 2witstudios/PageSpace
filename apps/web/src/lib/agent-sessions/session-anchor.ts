/**
 * Which session anchor a conversation row implies (pure).
 *
 * sessionId ≡ conversationId, so a session's identity is READ OFF the
 * conversation row, never supplied by a request body — the POST that ensures a
 * session carries no body at all. This is the ONE place the conversation-type →
 * `agentPageId` mapping exists: a `'page'` conversation anchors to its agent
 * page (`contextId`), a `'global'` conversation is a global-assistant session
 * (`agentPageId` null), and anything else (`'drive'`, or a `'page'` row that
 * somehow lost its contextId) cannot host a session at all.
 */

export type SessionAnchorResult =
  | { ok: true; agentPageId: string | null }
  | { ok: false; reason: 'unsupported_conversation_type' };

export function sessionAnchorForConversation(conversation: {
  type: string;
  contextId: string | null;
}): SessionAnchorResult {
  if (conversation.type === 'global') return { ok: true, agentPageId: null };
  if (conversation.type === 'page' && conversation.contextId !== null && conversation.contextId.length > 0) {
    return { ok: true, agentPageId: conversation.contextId };
  }
  return { ok: false, reason: 'unsupported_conversation_type' };
}
