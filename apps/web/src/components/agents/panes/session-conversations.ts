/**
 * One of a session's OPEN (not-yet-closed) conversation listings — the shape
 * shared by the pane bar's pure decisions:
 *
 * - `select-pane-agent.ts`'s SWITCH decision — which of THIS PANE's own tabs
 *   already has a thread for the picked agent, to focus rather than mint a
 *   duplicate.
 * - `open-pane-tab.ts`'s "+" decision — the same focus-or-mint question, for
 *   deliberately opening a new tab instead of replacing the active one.
 * - `close-pane-tab.ts`'s CLOSE decision — telling "the only pane left
 *   showing this conversation" apart from "the session's only OPEN
 *   conversation".
 *
 * These branches declared this independently before they met; hoisted here
 * so there is one declaration instead of several structurally-identical ones.
 */
export interface SessionConversationSummary {
  conversationId: string;
  agentPageId: string | null;
  /** ISO timestamp, or null for a conversation with no messages yet. */
  lastMessageAt: string | null;
}

/** One session's row in the `/api/agent-sessions**` listing response. */
export interface SessionListEntry {
  sessionId: string;
  conversations: SessionConversationSummary[];
}

/**
 * The `/api/agent-sessions**` SWR key for a given drive scope — shared so
 * every reader/writer of this cache (the grid's own hook, an optimistic
 * local insert from elsewhere) targets the identical key. A hand-recomputed
 * copy that drifts from this would silently target the wrong cache entry.
 */
export function agentSessionsKey(driveId: string | null): string {
  return driveId !== null ? `/api/agent-sessions?driveId=${encodeURIComponent(driveId)}` : '/api/agent-sessions';
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

/**
 * The most-recently-active listing among `listings` for `agentPageId`, or
 * `undefined` when none is open — the focus-or-mint question `select-pane-
 * agent.ts` and `open-pane-tab.ts` both ask, differing only in what they do
 * with a `mint` answer (replace the active tab vs. append a new one).
 */
export function findOpenForAgent<T extends { agentPageId: string | null; lastMessageAt: string | null }>(
  listings: readonly T[],
  agentPageId: string | null,
): T | undefined {
  const matches = listings.filter((listing) => listing.agentPageId === agentPageId);
  return matches.length === 0 ? undefined : mostRecentlyActive(matches);
}

/**
 * Every `/api/agent-sessions**` SWR entry — an `useSWR`/`mutate` key
 * predicate, not a fetch. Any action that mutates session-listing membership
 * (mint, close, end-session) revalidates through this so every consumer of
 * the shared listing (the sidebar, other panes, `AgentPageView`'s own
 * replacement mint) sees it before its own poll interval, not after.
 */
export function isAgentSessionsKey(key: unknown): boolean {
  return typeof key === 'string' && key.startsWith('/api/agent-sessions');
}
