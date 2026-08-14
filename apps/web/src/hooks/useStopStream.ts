import { useCallback } from 'react';
import {
  abortActiveStreamByConversation,
  abortActiveStreamByMessageId,
  reportAbortOutcome,
} from '@/lib/ai/core/client';
import { decideStopAction } from '@/lib/ai/streams/decideStopAction';
import type { ActiveStream } from '@/lib/ai/streams/selectActiveStream';

/**
 * THE Stop action, for every surface — and now the ONLY thing anywhere in the client that
 * stops a generation.
 *
 * All decision logic is in the pure, exhaustively tested `decideStopAction`; this hook is the
 * imperative shell that runs it. It names the stream by assistant `messageId` when one is
 * live, and falls back to the `conversationId` captured at send for the TTFB window, where the
 * server has not yet issued a messageId for the client to name.
 *
 * ── WHAT WAS REMOVED, AND WHY ITS ABSENCE IS THE FEATURE ──────────────────────────────────
 *
 * This used to run `rawStop()` FIRST — `useChat.stop()`, for "instant local feedback" while
 * the server abort round-tripped. It also had to decide WHETHER to run it, via
 * `shouldRunLocalStop` and the own-stream mirror's latch: with one `Chat` serving every
 * conversation, a Stop pressed on conversation A could otherwise abort conversation B's live
 * local fetch and send B dark mid-token while its generation carried on unwatched.
 *
 * Both are gone, and neither was replaced:
 *
 *   - `rawStop` itself. Cancelling a local read stops NOTHING. Streams are server-owned and
 *     survive client disconnect by design, so the only thing a local abort achieves is ending
 *     the run's VISIBLE life while it keeps generating, keeps calling write tools, and keeps
 *     billing. As "instant feedback" it was actively dishonest: the button flipped to Send
 *     over a generation that had not stopped. The store entry is what the button reads now,
 *     and it clears when the server actually confirms the stream is over.
 *   - `shouldRunLocalStop` and the latch it consulted. There is no shared `Chat` and no local
 *     read to protect, so the question "does this Stop belong to the fetch currently being
 *     read?" no longer has a referent.
 *
 * `only-a-deliberate-stop.test.ts` is the source-level tripwire that keeps a local stop from
 * being reintroduced, and it asserts that this path REACHES `/api/ai/abort` — because a Stop
 * that only cancels locally is indistinguishable, from the user's side, from one that works.
 */
export const useStopStream = ({
  activeStream,
  pendingSendConversationId,
}: {
  /** `useConversationActiveStream(...)` for the conversation on screen. */
  activeStream: ActiveStream | undefined;
  /** `useSendHandoff`'s in-flight pendingSend key — the conversation captured AT SEND. */
  pendingSendConversationId: string | null;
}): (() => Promise<void>) =>
  useCallback(async () => {
    const action = decideStopAction({ activeStream, pendingSendConversationId });

    if (action.type === 'abortByMessageId') {
      reportAbortOutcome(await abortActiveStreamByMessageId({ messageId: action.messageId }));
      return;
    }
    if (action.type === 'abortByConversation') {
      reportAbortOutcome(
        await abortActiveStreamByConversation({ conversationId: action.conversationId }),
      );
      return;
    }
    // 'none' — nothing live and nothing sent. Deliberately silent: there is nothing to report
    // and nothing to name.
  }, [activeStream, pendingSendConversationId]);
