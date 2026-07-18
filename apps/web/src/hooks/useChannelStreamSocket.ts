import { useCallback, useEffect, useRef } from 'react';
import { useSocket } from './useSocket';
import { useAuth } from './useAuth';
import { useSocketStore } from '@/stores/useSocketStore';
import { usePendingStreamsStore } from '@/stores/usePendingStreamsStore';
import { consumeStreamJoin, StreamJoinError } from '@/lib/ai/core/stream-join-client';
import { startStreamJoinPollFallback } from '@/lib/ai/core/stream-join-poll-fallback';
import { getBrowserSessionId } from '@/lib/ai/core/browser-session-id';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { isOwnStream } from '@/lib/ai/streams/isOwnStream';
import { shouldAttachStream } from '@/lib/ai/streams/shouldAttachStream';
import { isChannelConsuming } from '@/lib/ai/streams/consumingChannels';
import {
  shouldRefreshOnReconnect,
  type ConnectionStatus,
} from '@/lib/ai/streams/shouldRefreshOnReconnect';
import { shouldSkipBootstrappedStream } from '@/lib/ai/streams/shouldSkipBootstrappedStream';
import { claimBootstrapConsumer, releaseBootstrapConsumer } from '@/lib/ai/streams/bootstrapConsumerGuard';
import { isValidPartFrame } from '@/lib/ai/streams/isValidPartFrame';
import { appendPart as appendPartPure } from '@/lib/ai/streams/appendPart';
import type {
  AiStreamStartPayload,
  AiStreamCompletePayload,
  ChatUserMessagePayload,
  ChatMessageEditedPayload,
  ChatMessageDeletedPayload,
  ChatUndoAppliedPayload,
  ChatConversationAddedPayload,
  ChatConversationRenamedPayload,
  ChatConversationDeletedPayload,
  ChatGlobalConversationAddedPayload,
  AccessRevokedPayload,
} from '@/lib/websocket/socket-utils';
import type { UIMessage } from 'ai';
import type { UIMessagePart } from '@/lib/ai/core/stream-multicast-registry';

interface ActiveStreamRow {
  messageId: string;
  conversationId: string;
  /** ISO timestamp of the stream's start; stamps synthesized bubbles with a `createdAt`. */
  startedAt?: string;
  /** Last debounced snapshot persisted server-side — see `rawPartsCount` below. */
  parts?: UIMessagePart[];
  /**
   * See rawPartsCount's docblock on the schema (packages/db/src/schema/ai-streams.ts) for
   * why this, not `parts.length`, is the live-replay skip count (`skipReplayCount` below).
   * Optional here only because an old (pre-rawPartsCount) `active-streams` route build
   * omits the field entirely mid-rollout.
   */
  rawPartsCount?: number;
  triggeredBy: { userId: string; displayName: string; browserSessionId: string };
}

export interface UseChannelStreamSocketOptions {
  /**
   * Fires once per messageId on finalize (SSE resolve, or socket complete).
   *
   * `info.joinFailed` means the SSE join never succeeded — usually because the stream
   * lives on another web instance, whose in-process multicast registry we cannot reach.
   * The stream itself was fine; we just couldn't watch it. Whatever parts the store held
   * are a stale snapshot at best, so the store entry has ALREADY been dropped and the
   * consumer must reload the (durably persisted) message from the DB rather than
   * synthesize a bubble from what it has. Consumers that key on "is there still a store
   * entry?" would otherwise silently do nothing and lose the reply.
   */
  onStreamComplete?: (
    messageId: string,
    conversationId?: string,
    info?: { joinFailed: boolean },
  ) => void;
  /** Fires once per messageId when DB bootstrap finds an in-flight stream from this browser session. */
  onOwnStreamBootstrap?: (event: { messageId: string; conversationId: string }) => void;
  /** Fires once per own-bootstrapped messageId on any finalize path (resolve, complete, or error). */
  onOwnStreamFinalize?: (event: { messageId: string }) => void;
  /**
   * Fires after every bootstrap with the messageIds the server says are STILL live on this
   * channel. The authoritative answer to "is the stream I am holding state for still
   * running?".
   *
   * Consumers hold ownership state (a claimed Stop slot, a streaming flag) that is only
   * ever released by `onOwnStreamFinalize` — and there are paths where that event can
   * never fire. The socket effect tears down and rebuilds on a socket-instance swap (an
   * `auth:refreshed` reconnect builds a brand-new `io()`), and on teardown it deliberately
   * does NOT finalize; if the stream ended during that gap, nothing is left to announce it
   * and the consumer's flag strands `true` forever — a Stop button over a dead stream and,
   * on the surfaces that OR it into `useStreamingRegistration`, permanent SWR suppression.
   *
   * Bootstrap already knows the truth, so it tells you: reconcile your claim against this.
   */
  onActiveStreamsSnapshot?: (liveMessageIds: ReadonlySet<string>) => void;
  /**
   * Fires when a remote user submits a message in this channel.
   *
   * Filters applied before invocation:
   *   1. Stale-room: events for a different `pageId` are dropped.
   *   2. Own-tab dedup: events whose `triggeredBy.browserSessionId` matches
   *      the local session are dropped (the originator's `useChat` already
   *      appended the message locally).
   *
   * Server-side ordering: the broadcast fires AFTER `saveMessageToDatabase`
   * resolves and BEFORE the assistant `chat:stream_start` event, so consumers
   * always see the user message land before the assistant ghost text begins.
   *
   * Consumers must dedup against their existing messages by `message.id`
   * (the bootstrap REST GET may also surface the message if it ran after
   * the save and before the broadcast was processed locally).
   */
  onUserMessage?: (message: UIMessage, payload: ChatUserMessagePayload) => void;
  /**
   * Fires when a remote tab edits a message in this channel. Same stale-room
   * + own-tab dedup as `onUserMessage`. Consumers should still apply a
   * conversation-id guard before mutating their local messages.
   */
  onMessageEdited?: (payload: ChatMessageEditedPayload) => void;
  /**
   * Fires when a remote tab deletes a message in this channel. Same stale-room
   * + own-tab dedup as `onUserMessage`. Consumers should still apply a
   * conversation-id guard before mutating their local messages.
   */
  onMessageDeleted?: (payload: ChatMessageDeletedPayload) => void;
  /**
   * Fires when a remote tab applies an AI undo on this channel. Same stale-room
   * + own-tab dedup as `onUserMessage`. Surfaces typically respond by
   * refreshing the conversation, gated by `shouldRefreshAfterUndo` so a
   * cross-conversation undo doesn't disturb the active surface.
   */
  onUndoApplied?: (payload: ChatUndoAppliedPayload) => void;
  /**
   * Fires when a remote tab creates a new conversation in this agent room.
   * Same stale-room (`agentId !== channelId`) + own-tab dedup as
   * `onUserMessage`. Surfaces typically respond by prepending the
   * conversation to their history list, gated by `shouldPrependConversation`.
   */
  onConversationAdded?: (payload: ChatConversationAddedPayload) => void;
  /**
   * Fires when a remote tab renames a conversation in this agent room.
   * Same stale-room (`agentId !== channelId`) + own-tab dedup as
   * `onConversationAdded`.
   */
  onConversationRenamed?: (payload: ChatConversationRenamedPayload) => void;
  /**
   * Fires when a remote tab deletes a conversation in this agent room.
   * Same stale-room (`agentId !== channelId`) + own-tab dedup as
   * `onConversationAdded`.
   */
  onConversationDeleted?: (payload: ChatConversationDeletedPayload) => void;
  /**
   * Fires when a new global (non-agent) conversation is created on the user's
   * personal channel. No own-tab dedup — the history tab has no other signal
   * and needs to update even when the conversation originated in this tab.
   */
  onGlobalConversationAdded?: (payload: ChatGlobalConversationAddedPayload) => void;
}

/** Subscribes a component to a channel's AI streaming lifecycle: DB-replay on mount, live socket events, SSE join, store cleanup on unmount. Pass `undefined` channelId to no-op. */
export function useChannelStreamSocket(
  channelId: string | undefined,
  options?: UseChannelStreamSocketOptions,
): { rejoinActiveStreams: () => void } {
  const socket = useSocket();
  // The signed-in user's id, so handleStreamStart can tell "my stream in another tab"
  // from "another member's private conversation". Kept in a ref so it never re-registers
  // the socket handlers.
  const { user } = useAuth();
  const localUserIdRef = useRef<string | null>(user?.id ?? null);
  localUserIdRef.current = user?.id ?? null;
  // Holds the latest runBootstrap closure so rejoinActiveStreams can call it without
  // needing to be in the effect's dep array (the effect re-creates this on every run).
  const bootstrapRef = useRef<(() => void) | null>(null);
  // Stable refs so callback identity changes never trigger handler re-registration.
  const onStreamCompleteRef = useRef(options?.onStreamComplete);
  const onOwnStreamBootstrapRef = useRef(options?.onOwnStreamBootstrap);
  const onOwnStreamFinalizeRef = useRef(options?.onOwnStreamFinalize);
  const onActiveStreamsSnapshotRef = useRef(options?.onActiveStreamsSnapshot);
  const onUserMessageRef = useRef(options?.onUserMessage);
  const onMessageEditedRef = useRef(options?.onMessageEdited);
  const onMessageDeletedRef = useRef(options?.onMessageDeleted);
  const onUndoAppliedRef = useRef(options?.onUndoApplied);
  const onConversationAddedRef = useRef(options?.onConversationAdded);
  const onConversationRenamedRef = useRef(options?.onConversationRenamed);
  const onConversationDeletedRef = useRef(options?.onConversationDeleted);
  const onGlobalConversationAddedRef = useRef(options?.onGlobalConversationAdded);
  onStreamCompleteRef.current = options?.onStreamComplete;
  onOwnStreamBootstrapRef.current = options?.onOwnStreamBootstrap;
  onOwnStreamFinalizeRef.current = options?.onOwnStreamFinalize;
  onActiveStreamsSnapshotRef.current = options?.onActiveStreamsSnapshot;
  onUserMessageRef.current = options?.onUserMessage;
  onMessageEditedRef.current = options?.onMessageEdited;
  onMessageDeletedRef.current = options?.onMessageDeleted;
  onUndoAppliedRef.current = options?.onUndoApplied;
  onConversationAddedRef.current = options?.onConversationAdded;
  onConversationRenamedRef.current = options?.onConversationRenamed;
  onConversationDeletedRef.current = options?.onConversationDeleted;
  onGlobalConversationAddedRef.current = options?.onGlobalConversationAdded;

  useEffect(() => {
    if (!socket || !channelId) return;

    let cancelled = false;
    const localBrowserSessionId = getBrowserSessionId();
    const controllers = new Map<string, AbortController>();
    // Leaf 5.4: cross-instance rejoin polling, started when an SSE join 404s. Tracked
    // separately from `controllers` (the SSE join's own AbortController) since the two can be
    // live at different times for the same messageId — the SSE join has already failed and
    // its controller discarded by the time a poll fallback controller exists.
    const pollControllers = new Map<string, AbortController>();
    // Review finding: a per-call `let pollSeq = 0` would reset to 0 every time a poll fallback
    // (re)starts for the same messageId (e.g. a re-entrant chat:stream_start aborts the old one
    // and starts a new one). setStreamParts's seq-gate is monotonic PER messageId in the store,
    // not per poll-fallback instance — a restarted counter's early writes (seq 1, 2, 3...) would
    // be silently dropped against the old instance's already-higher watermark, freezing the UI on
    // stale content for several ticks until the new counter catches back up. Keyed by messageId,
    // outside any single poll-fallback closure, so a restart continues the same monotonic count.
    const pollSeqByMessageId = new Map<string, number>();
    // Simplification-finder review finding: this exact loop was duplicated at both bulk-teardown
    // sites (handleAccessRevoked, unmount cleanup). One shared helper instead of two copies that
    // could drift.
    const abortAllPolls = () => {
      for (const pollController of pollControllers.values()) {
        pollController.abort();
      }
      pollControllers.clear();
    };
    // Tracks which messageIds have had onStreamComplete called to prevent
    // double-firing when both the SSE done sentinel and chat:stream_complete
    // arrive, and to gate post-error stream_complete events.
    const processed = new Set<string>();
    // Bootstrap-discovered own-stream messageIds. Acts as both an "is-own"
    // lookup and a one-shot guard for onOwnStreamFinalize.
    const ownStreamIds = new Set<string>();
    // Streams whose SSE join failed. The common cause is benign but important:
    // the multicast registry is per-process, so a stream owned by another web
    // instance 404s here. Such a stream is still very much alive server-side —
    // we just can't watch its tokens. What we CAN do is wait for its
    // chat:stream_complete and reload the (durably persisted) message from the
    // DB, which is what this set enables in handleStreamComplete below.
    const joinFailed = new Set<string>();
    // Streams whose SSE join actually DELIVERED at least one part.
    //
    // `joinFailed` alone is not enough, because it is populated in an ASYNC `.catch`. A join
    // commonly 404s *because* the stream just ended — and `chat:stream_complete` can land before
    // that rejection settles. In that window the store still holds only the seeded DB snapshot,
    // which is debounced and can be SHORTER than what useChat already has. Consumers would then
    // replace a longer visible reply with a truncated one AND skip the reload-from-DB branch, so
    // the full persisted message was never fetched. Content loss.
    //
    // A join that delivered nothing is not authoritative, whatever the catch has managed to
    // record yet. This is the synchronous fact that says so.
    const joinDelivered = new Set<string>();

    const { addStream, appendPart, setStreamParts, removeStream, clearPageStreams } =
      usePendingStreamsStore.getState();

    const fireComplete = (
      messageId: string,
      conversationId?: string,
      info?: { joinFailed: boolean },
    ) => {
      if (processed.has(messageId)) return;
      processed.add(messageId);
      onStreamCompleteRef.current?.(messageId, conversationId, info);
    };

    const fireOwnFinalize = (messageId: string) => {
      if (!ownStreamIds.has(messageId)) return;
      ownStreamIds.delete(messageId);
      onOwnStreamFinalizeRef.current?.({ messageId });
    };

    const startConsume = (messageId: string, conversationId?: string, skipReplayCount = 0) => {
      if (!claimBootstrapConsumer(messageId)) return;
      const controller = new AbortController();
      controllers.set(messageId, controller);

      // The multicast registry replays its FULL buffer to every new subscriber
      // (see stream-multicast-registry.subscribe). When we've already seeded the
      // store with a persisted-parts snapshot, that snapshot is a prefix of the
      // live buffer, so the first `skipReplayCount` replayed chunks are the same
      // ones we already applied — skip them to avoid duplicating content.
      let chunksToSkip = skipReplayCount;

      consumeStreamJoin(messageId, controller.signal, (part) => {
        if (chunksToSkip > 0) {
          chunksToSkip -= 1;
          return;
        }
        joinDelivered.add(messageId);
        appendPart(messageId, part);
      })
        .then(() => {
          // Cleanup runs synchronously on unmount but the SSE promise resolves
          // asynchronously after controller.abort(); skip post-teardown effects.
          if (cancelled) return;
          controllers.delete(messageId);
          releaseBootstrapConsumer(messageId);
          try {
            fireComplete(messageId, conversationId, { joinFailed: false });
          } finally {
            removeStream(messageId);
            fireOwnFinalize(messageId);
          }
        })
        .catch((err) => {
          if (cancelled) return;
          controllers.delete(messageId);
          releaseBootstrapConsumer(messageId);
          // Deliberately NOT processed.add(messageId) here. A failed join does not
          // mean the stream failed — the usual cause is that it lives on another web
          // instance, where the per-process multicast registry can't see it. It is
          // still generating, and it will still broadcast chat:stream_complete when
          // it finishes. Suppressing that event (which is what processed.add did)
          // left the finished assistant message unloaded: the ghost vanished and
          // nothing replaced it. Marking the join as failed instead lets
          // handleStreamComplete reload the persisted message from the DB.
          //
          // Unless completion already happened: a join commonly 404s *because* the
          // stream just ended and the registry entry was deleted, in which case
          // chat:stream_complete can land before this rejection settles. It has
          // already finalized the stream, so there is nothing left to mark — and
          // adding the id here would leave an entry no later event ever clears.
          const alreadyProcessed = processed.has(messageId);
          if (!alreadyProcessed) {
            joinFailed.add(messageId);
          }
          // Leaf 5.4: a 404 is the common, benign cross-instance case — start polling the
          // channel's periodic DB checkpoint (~1s, matching the server's own cadence) for a
          // near-live view instead of freezing until chat:stream_complete finally arrives.
          // Gated on `!alreadyProcessed` for the same race as joinFailed above (completion
          // may have already landed) and on the SSE controller not already being aborted
          // (unmount/teardown — nothing left to poll for).
          const shouldPollFallback =
            err instanceof StreamJoinError && err.status === 404 && !alreadyProcessed && !controller.signal.aborted;
          if (shouldPollFallback) {
            // Defensive: a stale poll fallback for this messageId (e.g. a re-entrant
            // chat:stream_start on an id that already had one running) must not be
            // orphaned — an overwritten map entry would leak its interval forever.
            pollControllers.get(messageId)?.abort();
            const pollController = new AbortController();
            pollControllers.set(messageId, pollController);
            startStreamJoinPollFallback(
              channelId,
              messageId,
              pollController.signal,
              (parts) => {
                const nextSeq = (pollSeqByMessageId.get(messageId) ?? 0) + 1;
                pollSeqByMessageId.set(messageId, nextSeq);
                setStreamParts(messageId, parts, nextSeq);
              },
              () => {
                // The row is gone from active-streams — the stream finished, or this 404 was
                // never a liveness gap to begin with (e.g. a private conversation). Either way
                // polling further is useless.
                //
                // Review finding: this must fire the SAME reload-from-DB signal
                // chat:stream_complete does, not just drop the store entry. broadcastAiStreamComplete
                // is itself best-effort (fire-and-forget HTTP POST, `.catch(() => {})` in
                // socket-utils.ts) — if that socket event never arrives, this poll noticing the row
                // disappeared is the ONLY remaining signal. Without fireComplete here, a consumer
                // never learns to reload the persisted message: the synthesized bubble would vanish
                // with nothing replacing it, worse than the pre-poll-fallback behavior (a frozen but
                // still-visible stale snapshot). fireComplete's own processed-guard makes this safe
                // to call even if chat:stream_complete ALSO eventually arrives — the later call
                // no-ops.
                pollControllers.delete(messageId);
                pollSeqByMessageId.delete(messageId);
                joinFailed.delete(messageId);
                removeStream(messageId);
                try {
                  fireComplete(messageId, conversationId, { joinFailed: true });
                } finally {
                  fireOwnFinalize(messageId);
                }
              },
            );
          } else if (skipReplayCount === 0) {
            // When the store was seeded from a persisted snapshot (skipReplayCount > 0), a
            // failed join usually means the originator's process died — its in-memory
            // registry is gone and the join 404s. That snapshot is the only surviving copy
            // of the partial content, so keep it rendered; removing it here would undo the
            // restore that just happened. Streams with no seeded snapshot AND no poll
            // fallback starting have nothing to preserve and are removed as before.
            removeStream(messageId);
          }
          fireOwnFinalize(messageId);
          if (!controller.signal.aborted) {
            console.error('[useChannelStreamSocket] SSE join error:', err);
          }
        });
    };

    // Bootstrap: replay in-flight streams from the DB so a refresh mid-stream
    // (or a mobile resume) doesn't lose visibility on what's currently happening
    // in this channel. Re-running is idempotent: claimBootstrapConsumer +
    // shouldSkipBootstrappedStream skip streams already being consumed.
    // runBootstrap can be in flight more than once (mount, the reconnect effect, and
    // rejoinActiveStreams all trigger it independently) and responses are not ordered. A
    // slow older response landing after a newer one would carry a snapshot that predates a
    // claim made in between — and releasing on it would kill the Stop button for a live
    // stream. Only the newest run's snapshot is authoritative.
    let bootstrapGeneration = 0;

    const runBootstrap = async () => {
      const generation = (bootstrapGeneration += 1);
      try {
        const res = await fetchWithAuth(
          `/api/ai/chat/active-streams?channelId=${encodeURIComponent(channelId)}`,
          { credentials: 'include' },
        );
        if (cancelled) return;
        if (!res.ok) return;
        const data = (await res.json()) as { streams?: ActiveStreamRow[] };
        if (cancelled) return;
        for (const stream of data.streams ?? []) {
          if (shouldSkipBootstrappedStream(stream.messageId, processed, controllers)) continue;
          const isOwn = isOwnStream(stream.triggeredBy, localBrowserSessionId);
          // Bootstrap also re-runs on socket reconnect, which can land while this
          // tab's useChat is mid-POST on its own stream — attaching to the multicast
          // as well would render every remaining token twice. `isOwn` alone can't
          // tell us that (it survives a reload; consuming state doesn't). Consuming is
          // scoped per conversation: another conversation's POST on this channel must
          // NOT block attaching this one's own stream (the send handoff depends on it).
          if (!shouldAttachStream({ isOwn, isConsuming: isChannelConsuming(channelId, stream.conversationId) })) continue;
          // Seed the persisted snapshot as the stream's initial parts so the
          // restored mid-stream content renders immediately — without waiting
          // on (or depending on) the live multicast, which is unavailable if
          // the originator's process has died. Seeding through addStream
          // (a no-op when the entry exists) keeps a co-mounted surface that
          // bootstrapped the same channel from appending the snapshot twice.
          // isValidPartFrame applies the same wire-trust gate the live path
          // applies in consumeStreamJoin; appendPartPure then folds the
          // (already server-merged) sequence the way the store's own
          // appendPart does for every live chunk, so a restored snapshot
          // renders identically to a live one (merged text, tool parts
          // converged to their latest state).
          const persistedParts = (stream.parts ?? []).filter(isValidPartFrame);
          const foldedParts = persistedParts.reduce(appendPartPure, [] as UIMessagePart[]);
          addStream({
            messageId: stream.messageId,
            pageId: channelId,
            conversationId: stream.conversationId,
            triggeredBy: stream.triggeredBy,
            isOwn,
            parts: foldedParts,
            startedAt: stream.startedAt,
          });
          if (isOwn) {
            ownStreamIds.add(stream.messageId);
            onOwnStreamBootstrapRef.current?.({
              messageId: stream.messageId,
              conversationId: stream.conversationId,
            });
          }
          // The live SSE replay always delivers the RAW registry buffer (one frame per
          // pushed chunk), but the persisted snapshot above is server-merged/converged —
          // fewer, larger entries — so `persistedParts.length` no longer counts how many
          // raw frames are already reflected in the seed. `rawPartsCount` does (see its
          // docblock on ActiveStreamRow).
          //
          // `||`, deliberately not `??`: the column is NOT NULL DEFAULT 0, so a row
          // written by a not-yet-updated worker mid-rollout (whose code never sets this
          // column) reads back as a real `0`, not null/undefined — `??` would use that 0
          // verbatim and skip nothing, re-delivering the live replay's raw frames on top
          // of the seeded snapshot and reproducing the exact duplicate-text bug this fix
          // exists to close. `0` is only ever the CORRECT value when `parts` is also
          // empty (every write of this column sets it from the same raw buffer snapshot
          // as `parts`, atomically), so falling through to `persistedParts.length` on any
          // falsy value is safe for the legitimate zero case too — both are 0 there.
          startConsume(stream.messageId, stream.conversationId, stream.rawPartsCount || persistedParts.length);
        }

        // The server's word on what is still running. Consumers reconcile any ownership
        // state they are holding against it — see onActiveStreamsSnapshot. Superseded runs
        // stay silent: their answer is stale, and acting on it releases live claims.
        if (generation === bootstrapGeneration) {
          onActiveStreamsSnapshotRef.current?.(
            new Set((data.streams ?? []).map((stream) => stream.messageId)),
          );
        }
      } catch (err) {
        if (cancelled) return;
        console.warn('[useChannelStreamSocket] bootstrap failed', err);
      }
    };

    // Expose runBootstrap so rejoinActiveStreams (returned from the hook) can
    // trigger it on mobile resume — always points at the live closure.
    bootstrapRef.current = runBootstrap;

    void runBootstrap();

    const handleStreamStart = (payload: AiStreamStartPayload) => {
      if (payload.pageId !== channelId) return;
      // Not ours to watch. A page room holds every member of the page, but conversations
      // are private by default (`listConversations` shows you only `userId = you OR
      // isShared`), so most streams on this channel are somebody else's private chat.
      // The server refuses those joins anyway — this just avoids making the request:
      // otherwise every member's client fires a doomed /stream-join per assistant
      // message, each one an authz denial in the audit log.
      //
      // Skip ONLY on certainty, in both directions:
      //
      //   - `isShared` must be an explicit `false`. During a rolling deploy an
      //     originator on the previous build sends no such field, and dropping on
      //     `undefined` would black out multiplayer for shared conversations.
      //   - we must actually KNOW who we are. `useAuth()` returns `user: null` until
      //     auth resolves, and treating "unknown" as "not me" would drop the user's OWN
      //     private stream in that window — the precise failure this whole PR exists to
      //     fix.
      //
      // When in doubt, attach and let the server decide: an unauthorized join is a quiet
      // 404 that the client already handles benignly. The server is the authority here;
      // this check exists only to avoid firing a request that is certain to be refused.
      const localUserId = localUserIdRef.current;
      const startedBySomeoneElse = localUserId !== null && payload.triggeredBy.userId !== localUserId;
      if (startedBySomeoneElse && payload.isShared === false) return;

      const isOwn = isOwnStream(payload.triggeredBy, localBrowserSessionId);
      // The ONLY reason to decline a live stream: this browser context is already
      // reading THIS CONVERSATION's tokens off the POST body, so joining the multicast
      // too would double-render. This used to be a blanket `isOwn` skip, which meant a
      // reloaded tab — still "own" via sessionStorage, but consuming nothing —
      // dropped its own stream forever and showed an empty chat while the server
      // kept generating. And it used to be channel-wide, which meant one conversation's
      // POST blocked attaching a concurrent conversation's own (handed-off) stream on
      // the same channel. See consumingChannels.ts / shouldAttachStream.ts.
      if (!shouldAttachStream({ isOwn, isConsuming: isChannelConsuming(channelId, payload.conversationId) })) return;
      if (controllers.has(payload.messageId)) return;

      addStream({
        messageId: payload.messageId,
        pageId: payload.pageId,
        conversationId: payload.conversationId,
        triggeredBy: payload.triggeredBy,
        isOwn,
        startedAt: payload.startedAt,
      });

      if (isOwn) {
        ownStreamIds.add(payload.messageId);
        onOwnStreamBootstrapRef.current?.({
          messageId: payload.messageId,
          conversationId: payload.conversationId,
        });
      }

      startConsume(payload.messageId, payload.conversationId);
    };

    const handleStreamComplete = (payload: AiStreamCompletePayload) => {
      if (payload.pageId !== channelId) return;
      const controller = controllers.get(payload.messageId);
      if (controller) {
        controller.abort();
        controllers.delete(payload.messageId);
      }
      // Leaf 5.4: the socket already told us the generation is over — stop polling for a
      // "near-live" view that no longer applies. The reload-from-DB branch below (didJoinFail)
      // fetches the final, authoritative content regardless of anything the poll fallback saw.
      const pollController = pollControllers.get(payload.messageId);
      if (pollController) {
        pollController.abort();
        pollControllers.delete(payload.messageId);
        pollSeqByMessageId.delete(payload.messageId);
      }
      // If the SSE join failed, whatever parts we hold are a stale snapshot at best
      // — the authoritative message is in the DB. Dropping the store entry BEFORE
      // firing makes consumers take their reload-from-DB branch
      // (shouldReloadOnComountComplete) instead of synthesizing a truncated bubble.
      // `|| !joinDelivered` closes the race described at joinDelivered: the catch that would have
      // set joinFailed may not have settled yet, but a join that delivered nothing cannot be the
      // authoritative copy either way. Treat both as "reload from the DB".
      const didJoinFail = joinFailed.has(payload.messageId) || !joinDelivered.has(payload.messageId);
      if (didJoinFail) {
        joinFailed.delete(payload.messageId);
        removeStream(payload.messageId);
      }
      joinDelivered.delete(payload.messageId);
      try {
        fireComplete(payload.messageId, payload.conversationId, { joinFailed: didJoinFail });
      } finally {
        removeStream(payload.messageId);
        fireOwnFinalize(payload.messageId);
      }
    };

    const handleUserMessage = (payload: ChatUserMessagePayload) => {
      if (payload.pageId !== channelId) return;
      if (isOwnStream(payload.triggeredBy, localBrowserSessionId)) return;
      onUserMessageRef.current?.(payload.message, payload);
    };

    const handleMessageEdited = (payload: ChatMessageEditedPayload) => {
      if (payload.pageId !== channelId) return;
      if (isOwnStream(payload.triggeredBy, localBrowserSessionId)) return;
      onMessageEditedRef.current?.(payload);
    };

    const handleMessageDeleted = (payload: ChatMessageDeletedPayload) => {
      if (payload.pageId !== channelId) return;
      if (isOwnStream(payload.triggeredBy, localBrowserSessionId)) return;
      onMessageDeletedRef.current?.(payload);
    };

    const handleUndoApplied = (payload: ChatUndoAppliedPayload) => {
      if (payload.pageId !== channelId) return;
      if (isOwnStream(payload.triggeredBy, localBrowserSessionId)) return;
      onUndoAppliedRef.current?.(payload);
    };

    const handleConversationAdded = (payload: ChatConversationAddedPayload) => {
      if (payload.agentId !== channelId) return;
      if (isOwnStream(payload.triggeredBy, localBrowserSessionId)) return;
      onConversationAddedRef.current?.(payload);
    };

    const handleConversationRenamed = (payload: ChatConversationRenamedPayload) => {
      if (payload.agentId !== channelId) return;
      if (isOwnStream(payload.triggeredBy, localBrowserSessionId)) return;
      onConversationRenamedRef.current?.(payload);
    };

    const handleConversationDeleted = (payload: ChatConversationDeletedPayload) => {
      if (payload.agentId !== channelId) return;
      if (isOwnStream(payload.triggeredBy, localBrowserSessionId)) return;
      onConversationDeletedRef.current?.(payload);
    };

    const handleGlobalConversationAdded = (payload: ChatGlobalConversationAddedPayload) => {
      // No own-session filter: the history tab must update even when the conversation
      // was created in the current tab (it has no other signal).
      onGlobalConversationAddedRef.current?.(payload);
    };

    // The realtime server emits this on permission revocation (see kick-handler.ts) using
    // the page/channel room id directly (socket.join(pageId)), so `room` is the channelId.
    const handleAccessRevoked = (payload: AccessRevokedPayload) => {
      if (payload.room !== channelId) return;
      // Set cancelled first, exactly like unmount: consumeStreamJoin resolves (not
      // rejects) on abort, so without this the pending .then()/.catch() would run
      // the "clean finalize" path (onStreamComplete, onOwnStreamFinalize) for a
      // stream that was actually killed by a permission revocation, not completion.
      cancelled = true;
      for (const [msgId, controller] of controllers.entries()) {
        controller.abort();
        releaseBootstrapConsumer(msgId);
      }
      abortAllPolls();
      // Release every own-stream claim we handed out. This is the ONLY chance: `cancelled`
      // is latched on this effect closure, so every future runBootstrap — including the
      // reconnect re-bootstrap and rejoinActiveStreams, which both call through
      // bootstrapRef into THIS closure — returns early. onActiveStreamsSnapshot can
      // therefore never fire again on this channel, and a consumer holding a claim would
      // strand it forever: a Stop button over a stream it can no longer reach, and (on the
      // surfaces that OR the flag into useStreamingRegistration) permanent SWR suppression.
      // The effect only re-arms on a [socket, channelId] change, which may never come —
      // the global channel's id is fixed for the whole session.
      //
      // Deliberately fired AFTER `cancelled` (unlike the SSE path, which must NOT run its
      // clean-finalize here): this is an explicit teardown of ownership, not a completion.
      for (const msgId of [...ownStreamIds]) {
        fireOwnFinalize(msgId);
      }
      clearPageStreams(channelId);
    };

    socket.on('chat:stream_start', handleStreamStart);
    socket.on('chat:stream_complete', handleStreamComplete);
    socket.on('chat:user_message', handleUserMessage);
    socket.on('chat:message_edited', handleMessageEdited);
    socket.on('chat:message_deleted', handleMessageDeleted);
    socket.on('chat:undo_applied', handleUndoApplied);
    socket.on('chat:conversation_added', handleConversationAdded);
    socket.on('chat:conversation_renamed', handleConversationRenamed);
    socket.on('chat:conversation_deleted', handleConversationDeleted);
    socket.on('chat:global_conversation_added', handleGlobalConversationAdded);
    socket.on('access_revoked', handleAccessRevoked);

    return () => {
      cancelled = true;
      socket.off('chat:stream_start', handleStreamStart);
      socket.off('chat:stream_complete', handleStreamComplete);
      socket.off('chat:user_message', handleUserMessage);
      socket.off('chat:message_edited', handleMessageEdited);
      socket.off('chat:message_deleted', handleMessageDeleted);
      socket.off('chat:undo_applied', handleUndoApplied);
      socket.off('chat:conversation_added', handleConversationAdded);
      socket.off('chat:conversation_renamed', handleConversationRenamed);
      socket.off('chat:conversation_deleted', handleConversationDeleted);
      socket.off('chat:global_conversation_added', handleGlobalConversationAdded);
      socket.off('access_revoked', handleAccessRevoked);
      for (const [msgId, controller] of controllers.entries()) {
        controller.abort();
        releaseBootstrapConsumer(msgId);
      }
      abortAllPolls();
      clearPageStreams(channelId);
    };
  }, [socket, channelId]);

  // Stable callback; the ref always points at the latest runBootstrap closure.
  const rejoinActiveStreams = useCallback(() => { bootstrapRef.current?.(); }, []);

  // Re-bootstrap on socket reconnect. The effect above keys on [socket, channelId],
  // and socket.io reconnects the SAME instance in place — so without this, a
  // connection drop silently costs us every chat:stream_start emitted while we were
  // away, and the tab stays blind to a live stream until it is reloaded. Bootstrap
  // is idempotent (claimBootstrapConsumer + shouldSkipBootstrappedStream), so
  // re-running it is safe. Mirrors useAgentChannelMultiplayer's reconnect handler.
  const socketConnectionStatus = useSocketStore((s) => s.connectionStatus);
  const prevConnectionStatusRef = useRef<ConnectionStatus | null>(null);
  const hasInitialConnectRef = useRef(false);
  useEffect(() => {
    if (!channelId) return;
    const prev = prevConnectionStatusRef.current;
    prevConnectionStatusRef.current = socketConnectionStatus;
    if (shouldRefreshOnReconnect(prev, socketConnectionStatus, hasInitialConnectRef.current)) {
      bootstrapRef.current?.();
    }
    if (prev !== 'connected' && socketConnectionStatus === 'connected') {
      hasInitialConnectRef.current = true;
    }
  }, [channelId, socketConnectionStatus]);

  return { rejoinActiveStreams };
}
