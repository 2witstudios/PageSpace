import { useCallback, useMemo } from 'react';
import { selectAnswerableApprovalToolCallIds } from '@/lib/ai/streams/selectAnswerableApprovalToolCallIds';
import type { RenderedMessage } from '@/lib/ai/streams/selectRenderedMessages';
import { useAskUserAnsweringStore } from '@/stores/useAskUserAnsweringStore';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';

export type ToolApprovalScope = 'once' | 'conversation' | 'always';

export interface ToolApprovalDecision {
  approvalId: string;
  approved: boolean;
  reason?: string;
  /** Only meaningful with `approved: true`; defaults to `once`. */
  scope?: ToolApprovalScope;
}

type AddToolApprovalResponseFn = (args: {
  toolCallId: string;
  approvalId: string;
  approved: boolean;
  reason?: string;
  scope?: ToolApprovalScope;
  conversationId: string;
  options?: { body?: Record<string, unknown> };
}) => PromiseLike<{ dispatched: boolean }>;

export interface UseRespondToApprovalOptions {
  conversationId: string | null;
  /** Full rendered list (selectRenderedMessages output, mode included) — never useChat's local array. */
  renderedMessages: RenderedMessage[];
  /** Active stream or optimistic/pending send for THIS conversation. */
  isConversationBusy: boolean;
  addToolApprovalResponse: AddToolApprovalResponseFn;
  wrapSend: <T>(sendFn: () => T) => T | undefined;
  /** `useSendHandoff.releasePendingSend` — see useAnswerAskUser for why every non-sending path must call it. */
  releasePendingSend: () => void;
  /** Builds the per-request body (chatId/conversationId/provider/etc) for this surface. */
  buildBody: () => Record<string, unknown> | Promise<Record<string, unknown>>;
}

export interface UseRespondToApprovalResult {
  /** toolCallIds of paused tool parts currently answerable on THIS surface. */
  approvableToolCallIds: ReadonlySet<string>;
  respond: (toolCallId: string, decision: ToolApprovalDecision) => void;
}

/**
 * Answer plumbing for the tool-approval gate — the approval twin of
 * `useAnswerAskUser`, and deliberately the same shape: answerability is a pure
 * predicate over the SELECTOR output, the shared in-flight set is the mutex
 * between co-mounted surfaces (`useAskUserAnsweringStore.claimAnswering`'s
 * return value arbitrates a double-click or a sidebar/dashboard race — ask_user
 * and approvals never share a toolCallId, so one set serves both), the patch is
 * optimistic and reverted on failure, and a resume that sent nothing releases
 * its pendingSend.
 *
 * A 409 from the server (`approval_already_resolved` / `approval_stale`) means
 * another tab, or the user typing past the card, decided first. The revert puts
 * the card back for a moment; the realtime `message_updated` for the row the
 * winner persisted then brings the real state. Nothing to refetch by hand.
 */
export function useRespondToApproval(options: UseRespondToApprovalOptions): UseRespondToApprovalResult {
  const {
    conversationId,
    renderedMessages,
    isConversationBusy,
    addToolApprovalResponse,
    wrapSend,
    releasePendingSend,
    buildBody,
  } = options;

  const answeringToolCallIds = useAskUserAnsweringStore((s) => s.answeringToolCallIds);

  const stableMessages = useMemo(
    () => renderedMessages.filter((r) => r.mode !== 'streaming').map((r) => r.message),
    [renderedMessages],
  );

  const approvableToolCallIds = useMemo(
    () => selectAnswerableApprovalToolCallIds({ renderedMessages, answeringToolCallIds, isConversationBusy }),
    [renderedMessages, answeringToolCallIds, isConversationBusy],
  );

  const respond = useCallback(
    (toolCallId: string, decision: ToolApprovalDecision) => {
      if (!approvableToolCallIds.has(toolCallId)) return;

      // Claim + patch live INSIDE wrapSend's callback: wrapSend may drop the request without
      // invoking it, and a claim taken before that guard would leak forever.
      wrapSend(async () => {
        if (!useAskUserAnsweringStore.getState().claimAnswering(toolCallId)) {
          releasePendingSend();
          return;
        }

        const messageId = stableMessages[stableMessages.length - 1]?.id;
        const approval = {
          id: decision.approvalId,
          approved: decision.approved,
          ...(decision.reason ? { reason: decision.reason } : {}),
        };
        if (conversationId && messageId) {
          conversationMessagesActions.applyToolApprovalResponse(conversationId, { messageId, toolCallId, approval });
        }

        try {
          const body = await buildBody();
          const { dispatched } = await addToolApprovalResponse({
            toolCallId,
            approvalId: decision.approvalId,
            approved: decision.approved,
            reason: decision.reason,
            scope: decision.approved ? decision.scope : undefined,
            conversationId: conversationId!,
            options: { body },
          });
          // Several paused calls on one turn resume only once every one is answered, so
          // this answer may have recorded a patch and sent nothing.
          if (!dispatched) releasePendingSend();
        } catch (err) {
          if (conversationId && messageId) {
            conversationMessagesActions.revertToolApprovalResponse(conversationId, { messageId, toolCallId });
          }
          console.error('Failed to submit tool approval:', err);
        } finally {
          useAskUserAnsweringStore.getState().clearAnswering(toolCallId);
        }
      });
    },
    [approvableToolCallIds, stableMessages, conversationId, wrapSend, releasePendingSend, buildBody, addToolApprovalResponse],
  );

  return { approvableToolCallIds, respond };
}
