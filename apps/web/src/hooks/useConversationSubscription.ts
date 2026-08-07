'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { CONVERSATION_EVENTS } from '@pagespace/lib/realtime/conversation-event-names';
import type { UIMessage } from 'ai';
import { useSocket } from './useSocket';
import { useSocketStore } from '@/stores/useSocketStore';
import { useChannelStreamSocket, type UseChannelStreamSocketOptions } from './useChannelStreamSocket';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import {
  loadAgentConversationMessages,
  loadGlobalConversationMessages,
  refreshConversationSnapshot,
} from '@/hooks/conversationMessagesLoaders';
import { buildConversationCacheHandlers } from '@/hooks/conversationCacheSocketHandlers';
import {
  decideConversationApply,
  type ConversationApplyDecision,
} from '@/lib/realtime/conversation-apply';
import {
  healConversationToRev,
  registerConversationWatch,
  syncWatchedConversationRevs,
  unregisterConversationWatch,
} from '@/lib/realtime/conversation-rev-sync';
import { shouldRefreshOnReconnect, type ConnectionStatus } from '@/lib/ai/streams/shouldRefreshOnReconnect';
import type {
  ConversationMessagePayload,
  ConversationMessageDeletedPayload,
  ConversationUndoAppliedPayload,
} from '@/lib/websocket/conversation-events';

/**
 * `useConversationSubscription` — a surface's subscription to ONE conversation
 * (Agent-Session Single Source of Truth epic, Phase 2 / plan PR 3; spec
 * `docs/2.0-architecture/agent-sessions.md` §3 clause 3).
 *
 * This is the client half of "every surface is a subscriber that can prove it is
 * current", and it replaces the conversation half of `useChannelStreamSocket`'s
 * channel-wide subscription. Four things happen, in this order, and the order is
 * the whole design:
 *
 *  1. ENSURE A CACHE ENTRY. The loader is kicked before anything else when the
 *     conversation has none. `startLoad` materializes the entry synchronously, so
 *     from the very next line onward "subscribed" implies "cached". That is what
 *     lets the `hasEntry` gates in `conversationCacheSocketHandlers` be DELETED
 *     rather than merely relaxed: subscribe-on-open replaces them by construction.
 *     The old gate's hole was exactly the window this closes — an event landing
 *     between mount and the first fetch committing had no entry to write to and
 *     was dropped with nothing to re-deliver it.
 *
 *  2. JOIN `conv:<conversationId>`. Room membership IS the authorization: the
 *     realtime `join_conversation` handler runs `canAccessConversation` (owner OR
 *     shared + page access) and denies quietly. Re-emitted on every reconnect,
 *     because socket.io rejoins nothing for you.
 *
 *  3. BOOTSTRAP the conversation's in-flight streams. Same DB replay
 *     `useChannelStreamSocket` has always done, re-keyed by conversation via the
 *     new `?conversationId=` narrowing on `/api/ai/chat/active-streams`. The SSE
 *     token machinery underneath is untouched — `consumeStreamJoin`, the poll
 *     fallback, `claimBootstrapConsumer`, `shouldAttachStream`, `isOwnStream`, the
 *     `pendingStreams` mirror and `commitConfirmedReply` all keep working exactly
 *     as before. Streaming is still how tokens arrive; the events below are the
 *     DURABLE signal that also covers the case where both stream signals are lost.
 *
 *  4. APPLY `conversation:*` EVENTS THROUGH THE REV RULE. Every handler asks
 *     `decideConversationApply` (pure, exhaustively tested, no IO) and does one of
 *     three things: drop, apply, or refetch. Nothing here decides currency for
 *     itself.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * - No self-echo skip. `triggeredBy.browserSessionId` is carried on every event
 *   and this hook ignores it on purpose: the epic's canonical bug is a user's own
 *   dispatch, made from another surface, being invisible to their own open pane.
 *   Every cache action it calls is idempotent (upsert-by-id), so the originating
 *   pane applying its own echo on top of its optimistic send is a no-op with a
 *   reconciliation attached — `applyConfirmedMessage` drops the matching
 *   `optimisticSends` entry as it commits.
 * - No message rendering decisions. The cache is merge-at-render
 *   (`selectRenderedMessages`), so a `message_created` for a streaming placeholder
 *   coexists with the live stream rather than fighting it, and no write here can
 *   blank a stream mid-flight.
 * - No `useChat` transport writes. Never replace a transport array from a socket
 *   handler; the surfaces re-seed it only at the actions that need it.
 */

export interface ConversationSubscriptionContext {
  /**
   * The STREAM channel this conversation's streams broadcast on: the agent page
   * id, or the user's global channel id.
   *
   * Pass `undefined`/`null` to skip mounting a channel stream socket entirely —
   * what the global-assistant panes do, since `GlobalChatProvider` already
   * subscribes the user's one global channel app-wide and a second subscriber
   * would only duplicate its bootstrap. The conversation plane (join, events, rev
   * check) still runs; only the stream-lifecycle attach is skipped.
   */
  channelId?: string | null;
  /**
   * The agent page hosting the conversation, or `null` for a global-assistant
   * conversation. Selects the load/refetch endpoint — NOT the same thing as
   * `channelId`, which for the global case is a derived channel id and for a
   * pane may be present while this is null.
   */
  agentPageId: string | null;
  /**
   * Extra channel-socket options merged into the shared cache handlers (undo
   * refresh, conversation-added, ...). Ignored when `channelId` is absent.
   */
  streamOptions?: UseChannelStreamSocketOptions;
}

export interface ConversationSubscription {
  /** Re-runs the stream bootstrap — the recovery hook the send handoff needs. */
  rejoinActiveStreams: () => void;
}

export function useConversationSubscription(
  conversationId: string | null | undefined,
  ctx: ConversationSubscriptionContext,
): ConversationSubscription {
  const socket = useSocket();
  const { channelId, agentPageId, streamOptions } = ctx;

  // Refetch endpoint selector, stable per (agentPageId) so handlers registered
  // once don't need re-registering when unrelated props move.
  const agentPageIdRef = useRef(agentPageId);
  agentPageIdRef.current = agentPageId;

  const loadConversation = useCallback(
    (id: string): Promise<void> =>
      agentPageIdRef.current
        ? loadAgentConversationMessages(agentPageIdRef.current, id)
        : loadGlobalConversationMessages(id),
    [],
  );

  // ── 1. Ensure a cache entry (subscribe-on-open) ───────────────────────────
  // Runs BEFORE the join effect below by declaration order, and `startLoad`
  // materializes the entry synchronously, so no event can arrive at a
  // conversation this cache has never heard of.
  useEffect(() => {
    if (!conversationId) return;
    if (conversationMessagesActions.hasEntry(conversationId)) return;
    void loadConversation(conversationId);
  }, [conversationId, loadConversation]);

  // ── 2. Join the conversation's content room ───────────────────────────────
  useEffect(() => {
    if (!socket || !conversationId) return;
    const join = () => socket.emit('join_conversation', conversationId);
    join();
    // socket.io rejoins no rooms on reconnect — the server's socket is brand new.
    socket.on('connect', join);
    return () => {
      socket.off('connect', join);
      // Best-effort: on a disconnected socket this is a no-op, which is correct —
      // the server already dropped every room for that socket.
      socket.emit('leave_conversation', conversationId);
    };
  }, [socket, conversationId]);

  // ── 4. Rev-gated conversation events ──────────────────────────────────────
  useEffect(() => {
    if (!socket || !conversationId) return;

    /**
     * The one decision point. Reads the watermark straight off the store at event
     * time (never a ref snapshot — a burst of events must each see the previous
     * one's advance) and returns what to do.
     */
    const decide = (rev: number, truncated?: boolean): ConversationApplyDecision =>
      decideConversationApply(
        { rev, truncated },
        conversationMessagesActions.getRev(conversationId),
      );

    const heal = (rev: number) => {
      void healConversationToRev(conversationId, agentPageIdRef.current, Number.isFinite(rev) ? rev : null);
    };

    const applyMessage = (payload: ConversationMessagePayload) => {
      if (payload.conversationId !== conversationId) return;
      const truncated = 'truncated' in payload ? payload.truncated === true : false;
      const decision = decide(payload.rev, truncated);
      if (decision === 'drop') return;
      if (decision === 'refetch') {
        heal(payload.rev);
        return;
      }
      // `apply` implies a non-truncated payload (the pure rule guarantees it), so
      // the message is here. Upsert-by-id: idempotent against this pane's own
      // optimistic send, against the SSE commit that may already have written the
      // same id, and against a bootstrap load that raced this event.
      const message = (payload as { message: UIMessage }).message;
      if (!message || typeof message.id !== 'string') {
        // A payload shaped neither way (a rolling-deploy emitter we don't know) —
        // ask the server rather than guess.
        heal(payload.rev);
        return;
      }
      // The rev rides along onto the recorded pending mutation, so a snapshot
      // fetched by a concurrent gap-heal can tell whether it already contains
      // this write rather than replaying it over newer truth.
      conversationMessagesActions.applyConfirmedMessage(conversationId, message, payload.rev);
      conversationMessagesActions.advanceRev(conversationId, payload.rev);
    };

    const handleMessageDeleted = (payload: ConversationMessageDeletedPayload) => {
      if (payload.conversationId !== conversationId) return;
      const decision = decide(payload.rev);
      if (decision === 'drop') return;
      if (decision === 'refetch') {
        heal(payload.rev);
        return;
      }
      conversationMessagesActions.applyDelete(conversationId, payload.messageId, payload.rev);
      conversationMessagesActions.advanceRev(conversationId, payload.rev);
    };

    const handleUndoApplied = (payload: ConversationUndoAppliedPayload) => {
      if (payload.conversationId !== conversationId) return;
      // An undo restructures the conversation wholesale — there is no patch to
      // apply, only a truth to re-read. Rev-gated all the same so a redelivered
      // undo doesn't cost a fetch.
      if (decide(payload.rev) === 'drop') return;
      heal(payload.rev);
    };

    socket.on(CONVERSATION_EVENTS.messageCreated, applyMessage);
    socket.on(CONVERSATION_EVENTS.messageUpdated, applyMessage);
    socket.on(CONVERSATION_EVENTS.messageDeleted, handleMessageDeleted);
    socket.on(CONVERSATION_EVENTS.undoApplied, handleUndoApplied);

    return () => {
      socket.off(CONVERSATION_EVENTS.messageCreated, applyMessage);
      socket.off(CONVERSATION_EVENTS.messageUpdated, applyMessage);
      socket.off(CONVERSATION_EVENTS.messageDeleted, handleMessageDeleted);
      socket.off(CONVERSATION_EVENTS.undoApplied, handleUndoApplied);
    };
  }, [socket, conversationId]);

  // ── Reconnect: rejoin happened above; now prove currency in ONE request ───
  useEffect(() => {
    if (!conversationId) return;
    registerConversationWatch(conversationId, agentPageId);
    return () => unregisterConversationWatch(conversationId);
  }, [conversationId, agentPageId]);

  const connectionStatus = useSocketStore((s) => s.connectionStatus);
  const prevConnectionStatusRef = useRef<ConnectionStatus | null>(null);
  const hasInitialConnectRef = useRef(false);
  useEffect(() => {
    if (!conversationId) return;
    const prev = prevConnectionStatusRef.current;
    prevConnectionStatusRef.current = connectionStatus;
    // One batched revs call for EVERY watched conversation, not one per hook —
    // that is why the registry is module-level. Co-mounted subscriptions all
    // observe this same transition and join the one in-flight request.
    if (shouldRefreshOnReconnect(prev, connectionStatus, hasInitialConnectRef.current)) {
      void syncWatchedConversationRevs();
    }
    if (prev !== 'connected' && connectionStatus === 'connected') {
      hasInitialConnectRef.current = true;
    }
  }, [conversationId, connectionStatus]);

  // ── 3. Stream plane: the preserved SSE machinery, conversation-scoped ─────
  // The shared socket-events → cache protocol (commit / promote-own-sends /
  // snapshot heal). Its `hasEntry` gates are gone — see that module — because
  // step 1 above makes them unnecessary rather than merely optional.
  const cacheHandlers = useMemo<UseChannelStreamSocketOptions>(
    () => ({
      ...buildConversationCacheHandlers({
        reloadConversation: (id) => loadConversation(id),
        refreshSnapshot: (id) => refreshConversationSnapshot(agentPageIdRef.current, id),
      }),
      ...streamOptions,
    }),
    [loadConversation, streamOptions],
  );

  // A `undefined` channelId makes this a no-op by the hook's own contract (and
  // its returned rejoin a no-op with it) — the global-assistant pane case.
  const { rejoinActiveStreams } = useChannelStreamSocket(
    channelId ?? undefined,
    cacheHandlers,
    conversationId ?? null,
  );

  return { rejoinActiveStreams };
}
