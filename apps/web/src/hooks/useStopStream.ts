import { useCallback } from 'react';
import {
  abortActiveStreamByConversation,
  abortActiveStreamByMessageId,
  reportAbortOutcome,
} from '@/lib/ai/core/client';
import { decideStopAction } from '@/lib/ai/streams/decideStopAction';
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
 * `rawStop` runs unconditionally and FIRST — see `decideStopAction`'s docblock for why (instant
 * local feedback; the server abort can wait seconds on a cross-instance owner; and it is a no-op
 * on an idle chat, which is every case where it isn't wanted).
 */
export const useStopStream = ({
  activeStream,
  pendingSendConversationId,
  rawStop,
}: {
  /** `useConversationActiveStream(...)` for the conversation on screen. */
  activeStream: ActiveStream | undefined;
  /** `useSendHandoff`'s in-flight pendingSend key — the conversation captured AT SEND. */
  pendingSendConversationId: string | null;
  /** The mode-selected `useChat.stop` for the surface's own local fetch. */
  rawStop: () => void;
}): (() => Promise<void>) =>
  useCallback(async () => {
    // Stops this client reading. Stops NOTHING on the server — streams are server-owned and
    // survive a client disconnect.
    rawStop();

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
  }, [activeStream, pendingSendConversationId, rawStop]);
