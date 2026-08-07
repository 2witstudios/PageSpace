'use client';

import { useEffect } from 'react';
import { useSWRConfig } from 'swr';
import { useSocket } from '@/hooks/useSocket';
import {
  forgetConversationInCache,
  revalidateSessionListings,
  touchConversationInCache,
  upsertConversationInCache,
} from '@/components/agents/panes/session-conversations';
import type { ConversationDirectoryPayload } from '@/lib/websocket/conversation-events';

/**
 * `useSessionDirectoryListener` — the DIRECTORY plane (Agent-Session Single
 * Source of Truth epic, Phase 2 / plan PR 4).
 *
 * Every session listing in the app used to learn about new, closed and renamed
 * conversations the same way: by asking again in fifteen or twenty seconds. That
 * is why a worker an agent spawned on your behalf took up to a poll interval to
 * appear in your sidebar, and why "did that actually work?" was a question at
 * all. The server now emits `conversation:created/updated/closed/reopened/
 * deleted` and `session:*` to the owner's own `user:<id>:sessions` room — joined
 * automatically at connect, no subscription call needed — and this translates
 * them into targeted SWR surgery on the `/api/agent-sessions**` listings.
 *
 * MOUNTED EXACTLY ONCE, from `GlobalChatProvider` (which wraps the whole
 * Layout), for the same reason `DerivedStreamingRegistrations` is: the directory
 * is app-wide state, and N mounted copies would be N identical revalidations per
 * event. Nothing here is per-surface.
 *
 * TARGETED SURGERY WHERE THE PAYLOAD ALLOWS, REVALIDATION WHERE IT DOESN'T. A
 * `created` event carries the whole conversation, so the row is written straight
 * into the cache and the sidebar updates with no request at all. A `reopened`
 * does not (the row left the cache when it closed, and the event is id-level),
 * so it re-reads. Both are event-driven; the difference is only whether a
 * network round-trip is needed to know what to draw.
 *
 * DEDUPED AGAINST THE LEGACY PATH. `chat:global_conversation_added` still fires
 * in parallel during the migration window and `SidebarHistoryTab` still consumes
 * it — but into its own local list, not this SWR cache, so the two cannot
 * double-count each other. Within this cache, `upsertConversationInCache` is
 * idempotent by conversation id, so a redelivery (or a race with the
 * originating surface's own optimistic `recordMintedConversation`) merges
 * instead of prepending a second row.
 *
 * BEST-EFFORT, like every other broadcast. A missed directory event costs at
 * most one stale listing until the 120s backstop poll (or the next event) — the
 * message plane's rev watermark is what carries correctness, not this.
 */

/** The `session:*` lifecycle events; all of them mean "re-read the listing". */
const SESSION_LIFECYCLE_EVENTS = ['session:created', 'session:updated', 'session:ended'] as const;

export function useSessionDirectoryListener(): void {
  const socket = useSocket();
  const { mutate } = useSWRConfig();

  useEffect(() => {
    if (!socket) return;

    const handleCreated = (payload: ConversationDirectoryPayload) => {
      const { workspaceId, conversation } = payload;
      // A conversation with no workspace is not in any session listing — nothing
      // to insert it into. (Its own surfaces learn about it through their own
      // paths; this listener owns session listings only.)
      if (!workspaceId || !conversation) {
        if (workspaceId) revalidateSessionListings(mutate);
        return;
      }
      upsertConversationInCache(mutate, workspaceId, {
        conversationId: conversation.id,
        // The listing's `agentPageId` IS the conversation's `contextId` for a
        // page-anchored thread; a global-assistant thread has no agent page.
        agentPageId: conversation.type === 'page' ? conversation.contextId : null,
        lastMessageAt: conversation.lastMessageAt,
        title: conversation.title,
        type: conversation.type,
        contextId: conversation.contextId,
        isShared: conversation.isShared,
      });
    };

    const handleUpdated = (payload: ConversationDirectoryPayload) => {
      const changes = payload.changes;
      if (!changes) return;
      // A workspace re-binding moves the row between sessions — which row lives
      // where is exactly what this cache holds, so re-read rather than guess.
      if (changes.workspaceId !== undefined) {
        revalidateSessionListings(mutate);
        return;
      }
      // `closedInSessionAt` moving is a listing membership change in either
      // direction; the listing query owns that predicate, so re-read.
      if (changes.closedInSessionAt !== undefined) {
        revalidateSessionListings(mutate);
        return;
      }
      if (changes.lastMessageAt !== undefined) {
        touchConversationInCache(mutate, payload.conversationId, changes.lastMessageAt);
      }
      // A rename or a share-state flip changes what a row RENDERS, and the
      // listing rows carry those fields — but only for a row already present,
      // so a plain re-read is both correct and cheap enough at this frequency.
      if (changes.title !== undefined || changes.isShared !== undefined) {
        revalidateSessionListings(mutate);
      }
    };

    const handleRemoved = (payload: ConversationDirectoryPayload) => {
      if (!payload.workspaceId) return;
      forgetConversationInCache(mutate, payload.workspaceId, payload.conversationId);
    };

    // Reopen restores a row this cache dropped, and the event is id-level — the
    // conversation body has to come from the server.
    const handleReopened = () => revalidateSessionListings(mutate);
    const handleSessionLifecycle = () => revalidateSessionListings(mutate);

    socket.on('conversation:created', handleCreated);
    socket.on('conversation:updated', handleUpdated);
    socket.on('conversation:closed', handleRemoved);
    socket.on('conversation:deleted', handleRemoved);
    socket.on('conversation:reopened', handleReopened);
    for (const event of SESSION_LIFECYCLE_EVENTS) socket.on(event, handleSessionLifecycle);

    // A reconnect missed whatever was emitted while we were away, and the
    // directory has no watermark of its own to heal against — one re-read on
    // reconnect is the directory plane's equivalent of the message plane's
    // batched rev check.
    socket.on('connect', handleSessionLifecycle);

    return () => {
      socket.off('conversation:created', handleCreated);
      socket.off('conversation:updated', handleUpdated);
      socket.off('conversation:closed', handleRemoved);
      socket.off('conversation:deleted', handleRemoved);
      socket.off('conversation:reopened', handleReopened);
      for (const event of SESSION_LIFECYCLE_EVENTS) socket.off(event, handleSessionLifecycle);
      socket.off('connect', handleSessionLifecycle);
    };
  }, [socket, mutate]);
}

/**
 * Component wrapper, so the one mount site can be a JSX line next to
 * `DerivedStreamingRegistrations` rather than a hook call buried in the
 * provider's body. Renders nothing.
 */
export function SessionDirectoryListener(): null {
  useSessionDirectoryListener();
  return null;
}
