import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { createId } from '@paralleldrive/cuid2';
import type { UIMessage } from 'ai';
import { useConversationMessagesStore, MAX_QUEUED_SENDS } from '@/stores/useConversationMessagesStore';
import { onStreamSessionEnd } from '@/lib/ai/streams/streamSessionRegistry';
import { usePendingStreamsStore } from '@/stores/usePendingStreamsStore';
import { buildUserMessage } from '@/lib/ai/streams/buildUserMessage';
import { readPersistedQueuedSends } from '@/stores/conversationMessages/queuedSendsPersistence';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import { isThenable } from '@/lib/ai/streams/isThenable';
import type { ChatSessionStatus } from './useChatSession';

const EMPTY_QUEUED: UIMessage[] = [];

/**
 * End events within this window of a drain dispatch are the SAME transition,
 * not a new one: the `notifyEnd` fan-out is synchronous, so co-mounted
 * surfaces' listeners observe one end event within microseconds of each
 * other, and a generation cannot go from dispatch to terminal in
 * single-digit milliseconds. A claim this fresh must not be released by the
 * second listener — that release is what would license a second, take-over
 * dispatch.
 */
const CLAIM_FANOUT_WINDOW_MS = 5;

/**
 * ── THE SEND QUEUE (issue #2676) ──────────────────────────────────────────────
 *
 * Messages typed while a response is streaming, held client-side and
 * dispatched ONE PER TURN, oldest first, after the stream's terminal event.
 * The composer never POSTs a queued message early: a second POST to a
 * conversation whose stream is live takes the turn over server-side
 * (`takeOverConversationStreams`) and aborts the live generation, so "enqueue
 * instead of send" is the whole feature. The server's takeover semantics
 * remain the safety valve for pathological cases (a stale tab), not a path
 * this hook may ever walk into deliberately.
 *
 * ── THE DRAIN TRIGGER IS AN OBSERVED STREAM END, NEVER A TIMER ────────────────
 *
 * The one lawful trigger is `onStreamSessionEnd` — the app-wide notification
 * the stream session registry fires on EVERY terminal path: a completion
 * frame, `chat:stream_complete` (aborted or not), and the join-failure /
 * poll-fallback ends. `aborted` and `joinFailed` are terminal states like any
 * other — a drain after the user's ESC is the feature, and a drain after an
 * error is what gets the queued text on its way. Streams are server-owned and
 * survive client disconnect, so the end will be observed (or the registry's
 * expiry sweep drops the entry silently — the one end this hook, like every
 * consumer, does not see; the queue simply waits for the next turn, which is
 * the same stance the whole registry takes toward that event class).
 *
 * ── THE GUARDS, IN THE ORDER THE DRAIN EVALUATES THEM ─────────────────────────
 *
 * 1. SUPPRESSION (double-ESC): a second ESC inside `ChatInput`'s window is a
 *    STRONGER interrupt — clear the queue AND cancel the drain the pending
 *    abort's terminal event would otherwise fire. One-shot, consumed by the
 *    next end event for the conversation, so later turns drain normally.
 *
 * 2. CLAIM: at most one drained POST per turn, across co-mounted surfaces.
 *    Sidebar + page view can render the same conversation and both mount
 *    this hook; their listeners fire in the same synchronous `notifyEnd`
 *    fan-out, and without a module-level claim each would dispatch — the
 *    second POST taking the first's turn over. The claim taken at dispatch
 *    is released by the DRAINED TURN'S OWN terminal event — recognized as
 *    any end event for the conversation arriving after the fan-out window —
 *    and the same event then drains the next entry. A dispatch that rejects
 *    (a failed admission starts no turn) or a taker that unmounts releases
 *    it too, so the queue cannot wedge waiting for a terminal that will
 *    never come.
 *
 * 3. ANY OTHER LIVE STREAM for the conversation — own or remote — blocks the
 *    drain. The end event proves THE ENDED session is over, nothing about a
 *    second session; and the server's takeover is per CONVERSATION, so a
 *    drain dispatch here would abort a remote user's generation the local
 *    user never touched. Read fresh from `usePendingStreamsStore` at listener
 *    time — a render mirror would still say "live" here, because the registry
 *    removes the ended entry only AFTER the listeners run.
 *
 * 4. `status === 'submitted'` — the TTFB window of a MANUAL send or retry.
 *    Manual actions take precedence and the queue waits behind them: their
 *    turn's end event is the next drain trigger. This is also the
 *    stopRequests interplay, by construction: `recordStopRequest` bumps the
 *    epoch when the user stops a stream, and `useMessageActions`' retry path
 *    treats a moved epoch as a cancel. A queued message is the OPPOSITE of
 *    what that guard prevents — a deliberate, not-yet-sent request — and the
 *    drain dispatches through `sendMessage` directly, which never consults
 *    the stop epoch. Nothing in this file reads `readStopEpoch`, and the
 *    tripwire test pins that.
 *
 * The drained message flows through the surface's OWN send path —
 * `addOptimisticSend` → `rollback(wrapSend(sendMessage(...)))` — so rollback,
 * handoff and promotion work unchanged, and `getOutboundMessages` composes it
 * into the POST body with zero changes. A queued entry is NEVER placed in
 * `optimisticSends` before its dispatch (the `promoteOptimisticSends` trap):
 * it lives in `queuedSendsByConversationId` until the shift below.
 *
 * ── PERSISTENCE ───────────────────────────────────────────────────────────────
 *
 * The queue survives reloads (streams do — the queue must too). Every
 * mutation persists via the facade; on mount the persisted entries are
 * restored with the ids they were minted with, so the post-reload dispatch is
 * idempotent against the server's upsert-by-id.
 */
export function useQueuedSends({
  conversationId,
  status,
  dispatch,
}: {
  /** The conversation this surface is showing — null while identity resolves. */
  conversationId: string | null;
  /** `useChatSession`'s status for this conversation — 'submitted' is a manual send/retry's TTFB window. */
  status: ChatSessionStatus;
  /**
   * The surface's own send path for one user message: `addOptimisticSend` →
   * `rollbackOptimisticSendOnFailure(() => wrapSend(() => sendMessage(...)))`.
   * Returning a promise lets the hook release its claim when the dispatch
   * rejects (a failed admission starts no turn).
   */
  dispatch: (message: UIMessage) => unknown;
}): {
  queuedSends: UIMessage[];
  queueCount: number;
  isQueueFull: boolean;
  /** Mints the stable id at enqueue time. False when the queue is full (or no conversation). */
  enqueue: (text: string) => boolean;
  remove: (messageId: string) => void;
  clear: () => void;
  /** Double-ESC: clear the queue AND suppress the drain the pending abort's terminal event would fire. */
  cancelPendingDrain: () => void;
} {
  const queuedSends = useConversationMessagesStore(
    useShallow((state) =>
      conversationId ? state.queuedSendsByConversationId[conversationId] ?? EMPTY_QUEUED : EMPTY_QUEUED,
    ),
  );

  // Ref mirrors for the end listener, which fires from a socket/SSE callback
  // and must never act on a render-captured snapshot (same discipline as
  // useChatSession's refs).
  const statusRef = useRef(status);
  statusRef.current = status;
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  // The claim token THIS instance set, if any — only the taker's unmount
  // releases it; a co-mounted instance's mount must not.
  const tookClaimTokenRef = useRef<number | null>(null);

  const tryDrain = useCallback((endedConversationId: string, endedMessageId: string): void => {
    // 1. Suppression (double-ESC): the pending drain is CANCELLED — consume
    //    the latch, release any claim (the ended stream is over regardless)
    //    and dispatch nothing.
    if (drainSuppressions.has(endedConversationId)) {
      drainSuppressions.delete(endedConversationId);
      drainClaims.delete(endedConversationId);
      return;
    }

    // 2. Claim. A fresh claim is THIS event's own fan-out — a co-mounted
    //    surface just dispatched from it; return without touching anything.
    //    An old claim is the previously-drained turn's terminal arriving:
    //    release it, and this same event may drain the next entry.
    const claim = drainClaims.get(endedConversationId);
    if (claim) {
      if (Date.now() - claim.at < CLAIM_FANOUT_WINDOW_MS) return;
      drainClaims.delete(endedConversationId);
    }

    // 3. Any OTHER live stream (own or remote) for this conversation.
    if (hasOtherLiveStream(endedConversationId, endedMessageId)) return;

    // 4. A manual send/retry's TTFB window — the queue waits behind it.
    if (statusRef.current === 'submitted') return;

    const next = conversationMessagesActions.shiftQueuedSend(endedConversationId);
    if (!next) return;

    const token = ++drainClaimToken;
    drainClaims.set(endedConversationId, { token, at: Date.now() });
    tookClaimTokenRef.current = token;
    try {
      const result = dispatchRef.current(next);
      if (isThenable(result)) {
        Promise.resolve(result).catch(() => {
          // A failed admission started no turn; release so the queue is not
          // wedged waiting for a terminal event that will never come. Only
          // OUR claim — a newer dispatch's is not ours to release.
          if (drainClaims.get(endedConversationId)?.token === token) {
            drainClaims.delete(endedConversationId);
          }
        });
      }
    } catch {
      // Same, for a synchronous throw — the dispatch implementations surface
      // their own errors (rollback + toast); nothing to rethrow.
      if (drainClaims.get(endedConversationId)?.token === token) {
        drainClaims.delete(endedConversationId);
      }
    }
  }, []);

  // THE trigger — and only this. No timer anywhere in this file.
  useEffect(() => {
    if (!conversationId) return;
    return onStreamSessionEnd((end) => {
      if (end.conversationId !== conversationId) return;
      tryDrain(end.conversationId, end.messageId);
    });
  }, [conversationId, tryDrain]);

  // Restore on mount / conversation change, preserving persisted ids.
  useEffect(() => {
    if (!conversationId) return;
    conversationMessagesActions.setQueuedSends(conversationId, readPersistedQueuedSends(conversationId));
  }, [conversationId]);

  // Unmount: release only the claim THIS instance took, so a remount starts
  // clean and a surface gone mid-turn cannot leave the drain wedged.
  useEffect(() => {
    const mountedConversationId = conversationId;
    return () => {
      if (mountedConversationId) {
        if (
          tookClaimTokenRef.current !== null &&
          drainClaims.get(mountedConversationId)?.token === tookClaimTokenRef.current
        ) {
          drainClaims.delete(mountedConversationId);
        }
        tookClaimTokenRef.current = null;
        drainSuppressions.delete(mountedConversationId);
      }
    };
  }, [conversationId]);

  const enqueue = useCallback(
    (text: string): boolean => {
      if (!conversationId) return false;
      const trimmed = text.trim();
      if (!trimmed) return false;
      return conversationMessagesActions.enqueueQueuedSend(
        conversationId,
        buildUserMessage({ id: createId(), text: trimmed }) as UIMessage,
      );
    },
    [conversationId],
  );

  const remove = useCallback(
    (messageId: string): void => {
      if (!conversationId) return;
      conversationMessagesActions.removeQueuedSend(conversationId, messageId);
    },
    [conversationId],
  );

  const clear = useCallback((): void => {
    if (!conversationId) return;
    conversationMessagesActions.clearQueuedSends(conversationId);
  }, [conversationId]);

  const cancelPendingDrain = useCallback((): void => {
    if (!conversationId) return;
    conversationMessagesActions.clearQueuedSends(conversationId);
    drainSuppressions.add(conversationId);
  }, [conversationId]);

  const queueCount = queuedSends.length;

  return useMemo(
    () => ({
      queuedSends,
      queueCount,
      isQueueFull: queueCount >= MAX_QUEUED_SENDS,
      enqueue,
      remove,
      clear,
      cancelPendingDrain,
    }),
    [queuedSends, queueCount, enqueue, remove, clear, cancelPendingDrain],
  );
}

/**
 * Module-level shared state. Keys are conversationIds; entries die with the
 * page. Per-hook instances could not arbitrate between co-mounted surfaces.
 */
let drainClaimToken = 0;
const drainClaims = new Map<string, { token: number; at: number }>();
const drainSuppressions = new Set<string>();

/**
 * Whether ANY other stream — own or remote — is still live for the
 * conversation, excluding the one that just ended. Read fresh from the store
 * at listener time; see the docblock for why a render mirror is wrong here.
 */
const hasOtherLiveStream = (conversationId: string, endedMessageId: string): boolean => {
  for (const stream of usePendingStreamsStore.getState().streams.values()) {
    if (stream.conversationId !== conversationId) continue;
    if (stream.messageId === endedMessageId) continue;
    return true;
  }
  return false;
};
