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

/** One workspace's row in the `/api/agent-workspaces**` listing response. */
export interface SessionListEntry {
  /**
   * `agent_workspaces.id`. Reads the CANONICAL field, not the `sessionId`
   * compat twin beside it in `agentSessionDtoSchema` — that one is marked
   * "@deprecated ROLLING-DEPLOY COMPAT, one release only ... nothing new may
   * read it", and every reader here was reading it.
   *
   * Worth stating once for the whole module, since the functions below take a
   * parameter spelled `sessionId` and compare it against THIS field: that
   * parameter is a workspace id too. It carries the pre-rename spelling
   * because the sweep has not reached this layer (see
   * `docs/2.0-architecture/agent-sessions.md` §4, "NOT renamed, and NOT frozen
   * either"); it is never the deprecated twin above, and never
   * `conversations.sessionId`.
   */
  workspaceId: string;
  conversations: SessionConversationSummary[];
}

/**
 * The `/api/agent-workspaces**` SWR key for a given drive scope — shared so
 * every reader/writer of this cache (the grid's own hook, an optimistic
 * local insert from elsewhere) targets the identical key. A hand-recomputed
 * copy that drifts from this would silently target the wrong cache entry.
 */
export function agentWorkspacesKey(driveId: string | null): string {
  return driveId !== null ? `/api/agent-workspaces?driveId=${encodeURIComponent(driveId)}` : '/api/agent-workspaces';
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
 * Every `/api/agent-workspaces**` SWR entry — an `useSWR`/`mutate` key
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
 * `isWorkspaceListingKey` for that narrower, updater-safe predicate.
 */
export function isAgentWorkspacesKey(key: unknown): boolean {
  return typeof key === 'string' && key.startsWith('/api/agent-workspaces');
}

/**
 * The two BULK session-listing keys specifically — `agentWorkspacesKey(null)`
 * ('/api/agent-workspaces') and any drive-scoped `agentWorkspacesKey(driveId)`
 * ('/api/agent-workspaces?driveId=...') — never a per-session sub-resource path
 * like `/api/agent-workspaces/{id}/shells` or the singular session record,
 * which `isAgentWorkspacesKey`'s broader prefix match also catches. Those
 * cache entries hold no `sessions` array at all, so an updater written
 * against `{sessions: [...]}` (`forgetWorkspaceInCache`,
 * `forgetConversationInCache`) must only ever run against keys THIS
 * predicate matches, or it throws on the mismatched shape (review finding —
 * chatgpt-codex-connector on PR #2318).
 */
export function isWorkspaceListingKey(key: unknown): boolean {
  return typeof key === 'string' && (key === '/api/agent-workspaces' || key.startsWith('/api/agent-workspaces?'));
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
export function forgetWorkspaceInCache(mutate: ScopedMutator, sessionId: string): void {
  void mutate(
    isWorkspaceListingKey,
    (current: { sessions: SessionListEntry[] } | undefined) =>
      current ? { ...current, sessions: current.sessions.filter((session) => session.workspaceId !== sessionId) } : current,
    { revalidate: false },
  );
}

/**
 * The mirror of `forgetWorkspaceInCache`: put a previously-removed session row
 * back into every open session-listing SWR entry, locally — the rollback
 * half of the optimistic pair. A real revalidate (`mutate(isWorkspaceListingKey)`
 * with no data) is NOT a substitute for this: if the network is down (the
 * same reason the DELETE that triggered this rollback failed), the
 * revalidate fails too and the row stays missing until a later successful
 * poll — this restores it unconditionally, from the caller's own
 * already-in-hand snapshot, independent of the network (review finding —
 * chatgpt-codex-connector on PR #2318). Generic over the caller's own row
 * shape (`AgentPanes.tsx`'s minimal one vs. `AgentsSidebar.tsx`'s richer
 * one) — this only ever needs `workspaceId` to place it back correctly.
 */
export function restoreWorkspaceInCache<T extends { workspaceId: string }>(mutate: ScopedMutator, entry: T): void {
  void mutate(
    isWorkspaceListingKey,
    (current: { sessions: T[] } | undefined) =>
      current && !current.sessions.some((session) => session.workspaceId === entry.workspaceId)
        ? { ...current, sessions: [...current.sessions, entry] }
        : current,
    { revalidate: false },
  );
}

/**
 * Patch one conversation's `lastMessageAt` wherever it appears and re-sort its
 * session's listing — what a `conversation:updated {lastMessageAt}` directory
 * bump means for a most-recent-first list.
 *
 * Searched across every session rather than targeted at one, because the bump
 * event names the conversation and not the workspace holding it. A row that
 * isn't there is
 * simply not patched; nothing is invented (an unknown conversation belongs to
 * the server's next listing, not to a guess made here).
 */
export function touchConversationInCache(
  mutate: ScopedMutator,
  conversationId: string,
  lastMessageAt: string | null,
): void {
  void mutate(
    isWorkspaceListingKey,
    (current: { sessions: Array<{ workspaceId: string; conversations: SessionConversationSummary[] }> } | undefined) => {
      if (!current) return current;
      return {
        ...current,
        sessions: current.sessions.map((session) => {
          if (!session.conversations.some((c) => c.conversationId === conversationId)) return session;
          const patched = session.conversations.map((c) =>
            c.conversationId === conversationId ? { ...c, lastMessageAt } : c,
          );
          return {
            ...session,
            conversations: [...patched].sort((a, b) => {
              const aAt = a.lastMessageAt ? Date.parse(a.lastMessageAt) : -Infinity;
              const bAt = b.lastMessageAt ? Date.parse(b.lastMessageAt) : -Infinity;
              return bAt - aAt;
            }),
          };
        }),
      };
    },
    { revalidate: false },
  );
}

/**
 * Re-read every session listing from the server. The escape hatch for directory
 * events whose payload cannot reconstruct a listing row — a reopen (the row left
 * the cache when it closed, and the event carries no conversation body), a
 * session lifecycle change, a workspace re-binding. Event-DRIVEN, not periodic:
 * this is what makes the polls below it backstops rather than the mechanism.
 */
export function revalidateWorkspaceListings(mutate: ScopedMutator): void {
  void mutate(isAgentWorkspacesKey);
}

/**
 * Drop one conversation listing from `sessionId`'s row, everywhere — the
 * cross-file mirror of `AgentPanes.tsx`'s own `recordClosedConversation`,
 * for a caller (the sidebar) with no local SWR binding of its own. See
 * `forgetWorkspaceInCache` for why `mutate` is a parameter, not an import.
 */
export function forgetConversationInCache(mutate: ScopedMutator, sessionId: string, conversationId: string): void {
  void mutate(
    isWorkspaceListingKey,
    (current: { sessions: SessionListEntry[] } | undefined) =>
      current
        ? {
            ...current,
            sessions: current.sessions.map((session) =>
              session.workspaceId === sessionId
                ? { ...session, conversations: session.conversations.filter((c) => c.conversationId !== conversationId) }
                : session,
            ),
          }
        : current,
    { revalidate: false },
  );
}
