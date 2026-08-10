'use client';

import { useEffect } from 'react';
import { CONVERSATION_EVENTS } from '@pagespace/lib/realtime/conversation-event-names';
import { useSWRConfig } from 'swr';
import { useSocket } from '@/hooks/useSocket';
import {
  forgetConversationInCache,
  revalidateWorkspaceListings,
  touchConversationInCache,
} from '@/components/agents/panes/workspace-conversations';
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
 * them into targeted SWR surgery on the `/api/agent-workspaces**` listings.
 *
 * MOUNTED EXACTLY ONCE, from `GlobalChatProvider` (which wraps the whole
 * Layout), for the same reason `DerivedStreamingRegistrations` is: the directory
 * is app-wide state, and N mounted copies would be N identical revalidations per
 * event. Nothing here is per-surface.
 *
 * TARGETED SURGERY WHERE THE PAYLOAD ALLOWS, REVALIDATION WHERE IT DOESN'T. A
 * `lastMessageAt` change names the one row to patch, so it is patched in place;
 * a rename or a share flip changes what a row renders, so the listing re-reads.
 * Both are event-driven; the difference is only whether a network round-trip is
 * needed to know what to draw.
 *
 * **`created` / `deleted` RE-READ, and they used to do surgery.**
 * Each one carried `payload.workspaceId` — "which workspace's listing does this
 * row belong to" — and wrote (or dropped) the row in exactly that session's
 * cache entry. That column is gone: membership is a node in
 * `agent_workspace_nodes`, so the event names the conversation and nothing else,
 * and there is no key left to aim a patch at. Re-reading is what the module
 * already does whenever the payload cannot say where to write
 * (`reopened` has always worked this way) — the same event-driven liveness at
 * the cost of one request.
 *
 * That is a RESTORATION, not a regression. The surgery had already stopped
 * happening for the case it was written for: nothing had written a non-null
 * `workspaceId` since the membership chokepoint landed, so a worker an agent
 * spawned reached `handleCreated` with a null and took the `return` branch —
 * back to waiting for the 120s poll, which is the exact problem this listener
 * exists to solve. A re-read is slower than a patch and far faster than a poll.
 *
 * **`closed` IS THE EXCEPTION, AND IT IS NOT NEGOTIABLE.** It was swept into the
 * re-read group with `created`/`deleted` on the same "the payload no longer says
 * which workspace" reasoning, and that reasoning does not hold for a REMOVAL:
 * dropping a row needs to know the conversation, not the workspace. The listing
 * cache can find it — a thread is a member of at most one workspace (the node
 * table's global chat-target uniqueness), so `forgetConversationInCache` sweeps
 * every session's row and at most one matches. Making this a re-read cost the
 * plane its one event that needs no request at all, and put a closed thread's
 * sidebar row back on the 120s backstop poll whenever the refetch is slow,
 * blocked or failing. `apps/e2e/tests/18-sidebar-directory-live.spec.ts` blocks
 * the listing GET at the network for the whole assertion window precisely so
 * that a re-read cannot pass for a fix.
 *
 * The TREE — which panes a workspace draws — is a different plane and this
 * module deliberately does not touch it: it arrives on
 * `workspace:nodes-updated`, which `workspace-nodes-listener.ts` owns.
 *
 * DEDUPED AGAINST THE LEGACY PATH. `chat:global_conversation_added` still fires
 * in parallel and `SidebarHistoryTab` still consumes it — but into its own local
 * list, not this SWR cache, so the two cannot double-count each other.
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

    // A thread arriving in, or leaving, a workspace changes which rows the
    // listing holds — and the payload no longer names the workspace, so the
    // listing has to say which. See the module doc.
    const handleMembershipChanged = () => revalidateWorkspaceListings(mutate);

    // THE ONE EVENT SERVED WITHOUT A REQUEST. A close names the row to remove
    // and the cache already holds everything else about it, so this is a local,
    // non-revalidating write — see the module doc for why it must stay one.
    const handleClosed = (payload: ConversationDirectoryPayload) =>
      forgetConversationInCache(mutate, null, payload.conversationId);

    const handleUpdated = (payload: ConversationDirectoryPayload) => {
      const changes = payload.changes;
      if (!changes) return;
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

    const handleSessionLifecycle = () => revalidateWorkspaceListings(mutate);

    socket.on(CONVERSATION_EVENTS.created, handleMembershipChanged);
    socket.on(CONVERSATION_EVENTS.updated, handleUpdated);
    socket.on(CONVERSATION_EVENTS.closed, handleClosed);
    socket.on(CONVERSATION_EVENTS.deleted, handleMembershipChanged);
    socket.on(CONVERSATION_EVENTS.reopened, handleMembershipChanged);
    for (const event of SESSION_LIFECYCLE_EVENTS) socket.on(event, handleSessionLifecycle);

    // A reconnect missed whatever was emitted while we were away, and the
    // directory has no watermark of its own to heal against — one re-read on
    // reconnect is the directory plane's equivalent of the message plane's
    // batched rev check.
    socket.on('connect', handleSessionLifecycle);

    return () => {
      socket.off(CONVERSATION_EVENTS.created, handleMembershipChanged);
      socket.off(CONVERSATION_EVENTS.updated, handleUpdated);
      socket.off(CONVERSATION_EVENTS.closed, handleClosed);
      socket.off(CONVERSATION_EVENTS.deleted, handleMembershipChanged);
      socket.off(CONVERSATION_EVENTS.reopened, handleMembershipChanged);
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
