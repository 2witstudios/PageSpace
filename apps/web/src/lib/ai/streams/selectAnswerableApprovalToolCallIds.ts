import type { RenderedMessage } from './selectRenderedMessages';
import { isPendingApprovalPart } from '@/lib/ai/shared/approval-client';

export interface ApprovalAnswerabilityInput {
  /** Selector output (selectRenderedMessages) — the rendered list, never useChat's local array. */
  renderedMessages: readonly RenderedMessage[];
  /** Shared in-flight set (useAskUserAnsweringStore) — co-mounted surfaces disable together. */
  answeringToolCallIds: ReadonlySet<string>;
  /** Active stream or optimistic/pending send for THIS conversation. */
  isConversationBusy: boolean;
}

/**
 * Pure answerability predicate for the tool-approval gate — the approval twin
 * of `selectAnswerableAskUserToolCallIds`. A paused tool part is answerable iff
 * it sits on the LAST settled assistant message, its state is
 * `approval-requested`, no surface already claimed it, and nothing is busy for
 * the conversation on screen. Any `tool-*` part can be paused, so the type is
 * not pinned.
 */
export const selectAnswerableApprovalToolCallIds = (
  input: ApprovalAnswerabilityInput,
): ReadonlySet<string> => {
  const ids = new Set<string>();
  if (input.isConversationBusy) return ids;

  const settled = input.renderedMessages.filter((r) => r.mode !== 'streaming');
  const last = settled[settled.length - 1]?.message;
  if (!last || last.role !== 'assistant') return ids;

  for (const part of last.parts ?? []) {
    if (!isPendingApprovalPart(part)) continue;
    const { toolCallId } = part as { toolCallId: string };
    if (input.answeringToolCallIds.has(toolCallId)) continue;
    ids.add(toolCallId);
  }
  return ids;
};
