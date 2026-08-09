'use client';

import { useEffect } from 'react';
import { CONVERSATION_EVENTS } from '@pagespace/lib/realtime/conversation-event-names';
import { useSWRConfig } from 'swr';
import { useSocket } from '@/hooks/useSocket';
import {
  forgetConversationInCache,
  revalidateWorkspaceListings,
  touchConversationInCache,
  upsertConversationInCache,
} from '@/components/agents/panes/workspace-conversations';
import type { ConversationDirectoryPayload } from '@/lib/websocket/conversation-events';
import { conversationPageId } from '@pagespace/lib/conversations/conversation-page';

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
 * them into targeted SWR surgery on the `/api/agent-workspaces**` listings.
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
        if (workspaceId) revalidateWorkspaceListings(mutate);
        return;
      }
      upsertConversationInCache(mutate, workspaceId, {
        conversationId: conversation.id,
        // The listing's `agentPageId` IS the conversation's `contextId` for a
        // page-anchored thread; a global-assistant thread has no agent page.
        agentPageId: conversationPageId(conversation),
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
        revalidateWorkspaceListings(mutate);
        return;
      }
      // A `closedInWorkspaceAt` branch used to sit here, re-reading the listing
      // whenever that column moved in either direction. It is GONE, handed over
      // by the runtime cluster that deletes the three repository writers which
      // were its only emitters — a handler for an event nothing fires is worse
      // than no handler, because the next reader takes it as evidence the path
      // is live.
      //
      // Both directions are still covered, and by more specific handlers than
      // the one removed: `CONVERSATION_EVENTS.closed` drops the row from the
      // cache outright, and `reopened` re-reads to bring it back. What that
      // branch uniquely carried — "this thread's membership of the workspace
      // moved" — is now carried structurally, by the node's own location on the
      // `workspace:nodes-updated` broadcast, which is a plane this module
      // deliberately does not touch (`workspace-nodes-listener.ts` owns it).
      if (changes.lastMessageAt !== undefined) {
        touchConversationInCache(mutate, payload.conversationId, changes.lastMessageAt);
      }
      // The plan binding is not a listing field, so there is no row to patch —
      // but it IS rendered, by the plan chip on every pane open on this
      // conversation, from its own `/plan` key. Without this the chip only
      // refreshes when a `set_plan`/`clear_plan` TOOL CALL lands in the message
      // stream, so the one path that writes no message — the user clicking the
      // chip's X, which goes straight to DELETE /plan — left every other pane
      // showing a plan that is no longer bound.
      if (changes.planPageId !== undefined) {
        void mutate(`/api/ai/conversations/${payload.conversationId}/plan`);
      }
      // A rename or a share-state flip changes what a row RENDERS, and the
      // listing rows carry those fields — but only for a row already present,
      // so a plain re-read is both correct and cheap enough at this frequency.
      if (changes.title !== undefined || changes.isShared !== undefined) {
        revalidateWorkspaceListings(mutate);
      }
    };

    const handleRemoved = (payload: ConversationDirectoryPayload) => {
      if (!payload.workspaceId) return;
      forgetConversationInCache(mutate, payload.workspaceId, payload.conversationId);
    };

    // Reopen restores a row this cache dropped, and the event is id-level — the
    // conversation body has to come from the server.
    const handleReopened = () => revalidateWorkspaceListings(mutate);
    const handleSessionLifecycle = () => revalidateWorkspaceListings(mutate);

    socket.on(CONVERSATION_EVENTS.created, handleCreated);
    socket.on(CONVERSATION_EVENTS.updated, handleUpdated);
    socket.on(CONVERSATION_EVENTS.closed, handleRemoved);
    socket.on(CONVERSATION_EVENTS.deleted, handleRemoved);
    socket.on(CONVERSATION_EVENTS.reopened, handleReopened);
    for (const event of SESSION_LIFECYCLE_EVENTS) socket.on(event, handleSessionLifecycle);

    // A reconnect missed whatever was emitted while we were away, and the
    // directory has no watermark of its own to heal against — one re-read on
    // reconnect is the directory plane's equivalent of the message plane's
    // batched rev check.
    socket.on('connect', handleSessionLifecycle);

    return () => {
      socket.off(CONVERSATION_EVENTS.created, handleCreated);
      socket.off(CONVERSATION_EVENTS.updated, handleUpdated);
      socket.off(CONVERSATION_EVENTS.closed, handleRemoved);
      socket.off(CONVERSATION_EVENTS.deleted, handleRemoved);
      socket.off(CONVERSATION_EVENTS.reopened, handleReopened);
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
