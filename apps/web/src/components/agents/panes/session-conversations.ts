/**
 * One of a session's OPEN (not-yet-closed) conversation listings — the shape
 * shared by the pane bar's two independent pure decisions:
 *
 * - `select-pane-agent.ts`'s SWITCH decision (`pu/pane-agent-selector`) —
 *   which of the session's agents already has a thread, to focus rather than
 *   mint a duplicate.
 * - `close-pane.ts`'s CLOSE decision — telling "the only pane left showing
 *   this conversation" apart from "the session's only OPEN conversation".
 *
 * Both branches declared this independently before they met; hoisted here so
 * there is one declaration instead of two structurally-identical ones.
 */
export interface SessionConversationSummary {
  conversationId: string;
  agentPageId: string | null;
  /** ISO timestamp, or null for a conversation with no messages yet. */
  lastMessageAt: string | null;
}
