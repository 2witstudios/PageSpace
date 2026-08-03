import type { ScopedMutator } from 'swr';

/**
 * One of a session's OPEN (not-yet-closed) conversation listings — the shape
 * shared by the pane grid's pure decisions:
 *
 * - `select-pane-agent.ts`'s SWITCH decision — whether the picked agent
 *   already has a thread open elsewhere in the session, to focus rather than
 *   mint a duplicate.
 * - `close-pane.ts`'s CLOSE decision — telling "another pane still shows
 *   this conversation" apart from "the session's only OPEN conversation".
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
 * `undefined` when none is open — the focus-or-mint question
 * `select-pane-agent.ts` asks before deciding to mint a fresh conversation.
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
 *
 * Deliberately broad — this is safe for a bare revalidate (no data, no
 * updater): each matched key just refetches through its OWN registered
 * fetcher, so a per-session sub-resource cached under this same prefix (the
 * shells listing, the singular session record) refreshes correctly too. It
 * is NOT safe to pair with a `{sessions: [...]}`-shaped updater — see
 * `isSessionListingKey` for that narrower, updater-safe predicate.
 */
export function isAgentSessionsKey(key: unknown): boolean {
  return typeof key === 'string' && key.startsWith('/api/agent-sessions');
}

/**
 * The two BULK session-listing keys specifically — `agentSessionsKey(null)`
 * ('/api/agent-sessions') and any drive-scoped `agentSessionsKey(driveId)`
 * ('/api/agent-sessions?driveId=...') — never a per-session sub-resource path
 * like `/api/agent-sessions/{id}/shells` or the singular session record,
 * which `isAgentSessionsKey`'s broader prefix match also catches. Those
 * cache entries hold no `sessions` array at all, so an updater written
 * against `{sessions: [...]}` (`forgetSessionInCache`,
 * `forgetConversationInCache`) must only ever run against keys THIS
 * predicate matches, or it throws on the mismatched shape (review finding —
 * chatgpt-codex-connector on PR #2318).
 */
export function isSessionListingKey(key: unknown): boolean {
  return typeof key === 'string' && (key === '/api/agent-sessions' || key.startsWith('/api/agent-sessions?'));
}

/**
 * Drop `sessionId`'s row from every open session-listing SWR entry, locally,
 * without waiting on revalidation — used by both `AgentPanes.tsx`'s
 * `confirmEndSession` and `AgentsSidebar.tsx`'s `endSession`, each passing
 * its own scoped `mutate`, so ending a session drops its row everywhere the
 * instant the client decides to end it, not after the sandbox-kill DELETE
 * (or a follow-up revalidate) resolves.
 *
 * Takes `mutate` as a parameter rather than importing the bare top-level one
 * from `swr` — that top-level import only targets SWR's default cache, not a
 * caller-specific `SWRConfig` provider (a custom-cache test harness, say).
 * The caller supplies whatever `mutate` is actually bound to its own cache
 * (`useSWRConfig()`'s, or a hook-bound one), so this keeps working regardless.
 */
export function forgetSessionInCache(mutate: ScopedMutator, sessionId: string): void {
  void mutate(
    isSessionListingKey,
    (current: { sessions: SessionListEntry[] } | undefined) =>
      current ? { ...current, sessions: current.sessions.filter((session) => session.sessionId !== sessionId) } : current,
    { revalidate: false },
  );
}

/**
 * The mirror of `forgetSessionInCache`: put a previously-removed session row
 * back into every open session-listing SWR entry, locally — the rollback
 * half of the optimistic pair. A real revalidate (`mutate(isSessionListingKey)`
 * with no data) is NOT a substitute for this: if the network is down (the
 * same reason the DELETE that triggered this rollback failed), the
 * revalidate fails too and the row stays missing until a later successful
 * poll — this restores it unconditionally, from the caller's own
 * already-in-hand snapshot, independent of the network (review finding —
 * chatgpt-codex-connector on PR #2318). Generic over the caller's own row
 * shape (`AgentPanes.tsx`'s minimal one vs. `AgentsSidebar.tsx`'s richer
 * one) — this only ever needs `sessionId` to place it back correctly.
 */
export function restoreSessionInCache<T extends { sessionId: string }>(mutate: ScopedMutator, entry: T): void {
  void mutate(
    isSessionListingKey,
    (current: { sessions: T[] } | undefined) =>
      current && !current.sessions.some((session) => session.sessionId === entry.sessionId)
        ? { ...current, sessions: [...current.sessions, entry] }
        : current,
    { revalidate: false },
  );
}

/**
 * Drop one conversation listing from `sessionId`'s row, everywhere — the
 * cross-file mirror of `AgentPanes.tsx`'s own `recordClosedConversation`,
 * for a caller (the sidebar) with no local SWR binding of its own. See
 * `forgetSessionInCache` for why `mutate` is a parameter, not an import.
 */
export function forgetConversationInCache(mutate: ScopedMutator, sessionId: string, conversationId: string): void {
  void mutate(
    isSessionListingKey,
    (current: { sessions: SessionListEntry[] } | undefined) =>
      current
        ? {
            ...current,
            sessions: current.sessions.map((session) =>
              session.sessionId === sessionId
                ? { ...session, conversations: session.conversations.filter((c) => c.conversationId !== conversationId) }
                : session,
            ),
          }
        : current,
    { revalidate: false },
  );
}
