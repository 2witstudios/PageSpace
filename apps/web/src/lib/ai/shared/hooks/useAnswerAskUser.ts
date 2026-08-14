import { useCallback, useMemo } from 'react';
import { ASK_USER_TOOL_NAME, type AskUserOutput } from '@/lib/ai/tools/ask-user-tools';
import { selectAnswerableAskUserToolCallIds } from '@/lib/ai/streams/selectAnswerableAskUserToolCallIds';
import type { RenderedMessage } from '@/lib/ai/streams/selectRenderedMessages';
import { useAskUserAnsweringStore } from '@/stores/useAskUserAnsweringStore';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';

type AddToolResultFn = (args: {
  tool: string;
  toolCallId: string;
  output: unknown;
  conversationId: string;
  options?: { body?: Record<string, unknown> };
}) => PromiseLike<{ dispatched: boolean }>;

export interface UseAnswerAskUserOptions {
  conversationId: string | null;
  /** Full rendered list (selectRenderedMessages output, mode included) — never useChat's local array. */
  renderedMessages: RenderedMessage[];
  /** Active stream or optimistic/pending send for THIS conversation — replaces status==='ready'. */
  isConversationBusy: boolean;
  addToolResult: AddToolResultFn;
  wrapSend: <T>(sendFn: () => T) => T | undefined;
  /**
   * `useSendHandoff.releasePendingSend`. Called on every path that registers a pendingSend and
   * then does NOT send — answering one of several questions on a turn, or losing the
   * `claimAnswering` race. Without it the name is never cleared, and the conversation wedges:
   * composer stuck on Stop, and the remaining question unanswerable because
   * `isConversationBusy` stays true.
   */
  releasePendingSend: () => void;
  /** Builds the per-request body (chatId/conversationId/provider/etc) for this surface. */
  buildBody: () => Record<string, unknown> | Promise<Record<string, unknown>>;
}

/**
 * NO PRE-SEND HANDOFF ANY MORE, and nothing replaced it.
 *
 * Answering a question re-invokes the chat, and under the shared-`Chat` design that was a
 * second concurrent send on one instance — illegal, so `useConversationSendHandoff` had to
 * stop the other conversation's read first and could refuse outright when its status would
 * not settle. A refused answer meant the user's click did nothing but raise a toast.
 *
 * `useChatSession` has no shared instance and no single-body limit, so a resume for THIS
 * conversation is simply a `fetch` alongside whatever else is in flight. There is nothing to
 * hand off, nothing to wait for, and nothing to refuse.
 */

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
    addToolResult,
    wrapSend,
    releasePendingSend,
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
        if (!useAskUserAnsweringStore.getState().claimAnswering(toolCallId)) {
          // Lost the race to a co-mounted surface (or a double-click). `wrapSend` has already
          // registered a pendingSend for a send that will not happen.
          releasePendingSend();
          return;
        }

        const messageId = stableMessages[stableMessages.length - 1]?.id;
        if (conversationId && messageId) {
          conversationMessagesActions.applyAskUserAnswer(conversationId, { messageId, toolCallId, output });
        }

        try {
          // No transport hydration step. `useChatSession` composes its outbound messages from
          // the store's settled view at CALL time, so the persisted assistant message carrying
          // this question IS the base — which is what makes answering work after a reload,
          // where useChat's internal array was empty and `hydrateTransportBeforeReinvoke` had
          // to copy the snapshot in before every re-invocation.
          const body = await buildBody();
          const { dispatched } = await addToolResult({
            tool: ASK_USER_TOOL_NAME,
            toolCallId,
            output,
            conversationId: conversationId!,
            options: { body },
          });
          // A turn with several questions resumes only once every one is answered, so this
          // answer may have recorded a patch and sent nothing. The pendingSend must go either
          // way, or the REMAINING question becomes unanswerable.
          if (!dispatched) releasePendingSend();
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
      releasePendingSend,
      buildBody,
      addToolResult,
    ],
  );

  return { answerableToolCallIds, submitAnswers };
}
