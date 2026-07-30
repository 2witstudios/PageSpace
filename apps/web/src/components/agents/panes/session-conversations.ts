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

/**
 * The listing most recently active, treating never-messaged as older than
 * any messaged one. Shared by both deciders' "which one do I focus/rebind
 * to next" choice — each had reimplemented this reduce independently before
 * they met.
 */
export function mostRecentlyActive<T extends { lastMessageAt: string | null }>(listings: readonly T[]): T {
  return listings.reduce((latest, candidate) => {
    const latestAt = latest.lastMessageAt ? Date.parse(latest.lastMessageAt) : -Infinity;
    const candidateAt = candidate.lastMessageAt ? Date.parse(candidate.lastMessageAt) : -Infinity;
    return candidateAt > latestAt ? candidate : latest;
  });
}
