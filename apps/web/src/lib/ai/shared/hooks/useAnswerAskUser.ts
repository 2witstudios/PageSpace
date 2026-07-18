import { useCallback, useMemo } from 'react';
import type { UIMessage } from 'ai';
import { ASK_USER_TOOL_NAME, type AskUserOutput } from '@/lib/ai/tools/ask-user-tools';
import { selectAnswerableAskUserToolCallIds } from '@/lib/ai/streams/selectAnswerableAskUserToolCallIds';
import type { RenderedMessage } from '@/lib/ai/streams/selectRenderedMessages';
import { useAskUserAnsweringStore } from '@/stores/useAskUserAnsweringStore';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import { hydrateTransportBeforeReinvoke } from './hydrateTransportBeforeReinvoke';

type AddToolResultFn = (args: {
  tool: string;
  toolCallId: string;
  output: unknown;
  options?: { body?: object };
}) => void | PromiseLike<void>;

export interface UseAnswerAskUserOptions {
  conversationId: string | null;
  /** Full rendered list (selectRenderedMessages output, mode included) — never useChat's local array. */
  renderedMessages: RenderedMessage[];
  /** Active stream or optimistic/pending send for THIS conversation — replaces status==='ready'. */
  isConversationBusy: boolean;
  /** This surface's useChat setter (transport bookkeeping only — never renders). */
  setMessages: (messages: UIMessage[]) => void;
  addToolResult: AddToolResultFn;
  wrapSend: <T>(sendFn: () => T) => T | undefined;
  /** Builds the per-request body (chatId/conversationId/provider/etc) for this surface. */
  buildBody: () => object | Promise<object>;
}

export interface UseAnswerAskUserResult {
  /** toolCallIds of ask_user parts currently answerable on THIS surface. */
  answerableToolCallIds: ReadonlySet<string>;
  submitAnswers: (toolCallId: string, output: AskUserOutput) => void;
}

/**
 * Shared answer plumbing for the ask_user interactive question tool (epic
 * leaf 6.3), replacing `useAskUserAnswering`. Answerability is a pure
 * predicate over the SELECTOR output (never useChat's local array), gated by
 * a shared in-flight set so co-mounted surfaces (sidebar + dashboard on the
 * same conversation) disable together and cannot both resume the run.
 *
 * `useAskUserAnsweringStore.claimAnswering`'s return value IS the mutex for
 * the double-click / co-mounted-race case (M6): whichever caller's claim
 * actually flips the store wins and proceeds through the optimistic patch,
 * hydrate, and addToolResult; the loser's claim returns false and no-ops —
 * the render-time `answerableToolCallIds` check alone cannot arbitrate this,
 * since two callers can both read it before either one's store update lands.
 */
export function useAnswerAskUser(options: UseAnswerAskUserOptions): UseAnswerAskUserResult {
  const {
    conversationId,
    renderedMessages,
    isConversationBusy,
    setMessages,
    addToolResult,
    wrapSend,
    buildBody,
  } = options;

  const answeringToolCallIds = useAskUserAnsweringStore((s) => s.answeringToolCallIds);

  const stableMessages = useMemo(
    () => renderedMessages.filter((r) => r.mode !== 'streaming').map((r) => r.message),
    [renderedMessages],
  );

  const answerableToolCallIds = useMemo(
    () => selectAnswerableAskUserToolCallIds({ renderedMessages, answeringToolCallIds, isConversationBusy }),
    [renderedMessages, answeringToolCallIds, isConversationBusy],
  );

  const submitAnswers = useCallback(
    (toolCallId: string, output: AskUserOutput) => {
      // Guard: still answerable on THIS render. Cheap and correct for the ordinary
      // single-surface case; claimAnswering below is what actually arbitrates a race.
      if (!answerableToolCallIds.has(toolCallId)) return;

      // The claim and the optimistic patch live INSIDE wrapSend's callback, not before it:
      // wrapSend can drop the request without ever invoking this callback (e.g. no
      // conversationId), and if the claim/patch happened before that guard, both would leak
      // indefinitely — nothing would ever reach the try/finally that clears them (PR 6 review,
      // CodeRabbit, Critical).
      wrapSend(async () => {
        if (!useAskUserAnsweringStore.getState().claimAnswering(toolCallId)) return;

        const messageId = stableMessages[stableMessages.length - 1]?.id;
        if (conversationId && messageId) {
          conversationMessagesActions.applyAskUserAnswer(conversationId, { messageId, toolCallId, output });
        }

        try {
          hydrateTransportBeforeReinvoke(setMessages, stableMessages, isConversationBusy);
          const body = await buildBody();
          await addToolResult({ tool: ASK_USER_TOOL_NAME, toolCallId, output, options: { body } });
        } catch (err) {
          if (conversationId && messageId) {
            conversationMessagesActions.revertAskUserAnswer(conversationId, { messageId, toolCallId });
          }
          console.error('Failed to submit ask_user answer:', err);
        } finally {
          useAskUserAnsweringStore.getState().clearAnswering(toolCallId);
        }
      });
    },
    [
      answerableToolCallIds,
      stableMessages,
      conversationId,
      wrapSend,
      setMessages,
      isConversationBusy,
      buildBody,
      addToolResult,
    ],
  );

  return { answerableToolCallIds, submitAnswers };
}
