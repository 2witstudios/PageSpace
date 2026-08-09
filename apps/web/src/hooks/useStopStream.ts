import { useCallback } from 'react';
import {
  abortActiveStreamByConversation,
  abortActiveStreamByMessageId,
  reportAbortOutcome,
} from '@/lib/ai/core/client';
import { decideStopAction, shouldRunLocalStop } from '@/lib/ai/streams/decideStopAction';
import type { ActiveStream } from '@/lib/ai/streams/selectActiveStream';

/**
 * Facade — THE Stop action, for every surface (AiChatView, GlobalAssistantView, SidebarChatTab).
 *
 * Replaces `useChatStop`, `useGlobalEffectiveStream`, the GlobalChatContext stop-slot claim
 * protocol, and the dashboard store's `agentStops` slots — all four of which existed to answer
 * "which stop function is the right one to call", a question that only had to be asked because
 * the answer was a slot somebody had to claim. `activeStream` is a READ, so there is nothing to
 * claim and nothing to release.
 *
 * All decision logic is in the pure, exhaustively tested `decideStopAction`; this hook is the
 * imperative shell that runs it.
 *
 * `rawStop` runs FIRST (instant local feedback; the server abort can wait seconds on a
 * cross-instance owner) — but no longer unconditionally. With conversation-scoped consuming
 * (the dual-stream fix), one chat instance can be locally consuming conversation B's stream
 * while conversation A's own handed-off stream renders via the socket on the SAME surface. A
 * Stop pressed on A must not abort B's live local fetch — that would send B dark mid-token
 * (its generation continues server-side, unwatched). The mirror's latch says which conversation
 * the local fetch belongs to: skip `rawStop` exactly when it names a DIFFERENT conversation
 * than the one being stopped. An undefined latch means the chat is idle, where `rawStop` is a
 * harmless no-op — so absence never suppresses a wanted local stop.
 */
export const useStopStream = ({
  activeStream,
  pendingSendConversationId,
  rawStop,
  getLocalSendConversationId,
  targetConversationId,
}: {
  /** `useConversationActiveStream(...)` for the conversation on screen. */
  activeStream: ActiveStream | undefined;
  /** `useSendHandoff`'s in-flight pendingSend key — the conversation captured AT SEND. */
  pendingSendConversationId: string | null;
  /** The mode-selected `useChat.stop` for the surface's own local fetch. */
  rawStop: () => void;
  /**
   * The mode-selected mirror's `getLatchedConversationId` — which conversation the surface's
   * local fetch is consuming for, if any.
   */
  getLocalSendConversationId: () => string | undefined;
  /** The conversation on screen — the one this Stop is stopping. */
  targetConversationId: string | null;
}): (() => Promise<void>) =>
  useCallback(async () => {
    // Stops this client reading. Stops NOTHING on the server — streams are server-owned and
    // survive a client disconnect. Skipped only when the local fetch belongs to a DIFFERENT
    // conversation than the one being stopped — see `shouldRunLocalStop` (pure, tested) for the
    // rules, including the empty-string-latch placeholder.
    if (
      shouldRunLocalStop({
        localSendConversationId: getLocalSendConversationId(),
        targetConversationId,
      })
    ) {
      rawStop();
    }

    const action = decideStopAction({ activeStream, pendingSendConversationId });

    if (action.type === 'abortByMessageId') {
      reportAbortOutcome(await abortActiveStreamByMessageId({ messageId: action.messageId }));
      return;
    }
    if (action.type === 'abortByConversation') {
      reportAbortOutcome(await abortActiveStreamByConversation({ conversationId: action.conversationId }));
      return;
    }
    // 'none' — nothing live and nothing sent. Deliberately silent: there is nothing to report
    // and nothing to name.
  }, [activeStream, pendingSendConversationId, rawStop, getLocalSendConversationId, targetConversationId]);
