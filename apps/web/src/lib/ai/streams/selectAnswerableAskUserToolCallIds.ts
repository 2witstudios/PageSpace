import type { RenderedMessage } from './selectRenderedMessages';
import { isPausingToolPartType } from '@/lib/ai/tools/pausing-tools';

export interface AskUserAnswerabilityInput {
  /** Selector output (selectRenderedMessages) — the rendered list, never useChat's local array. */
  renderedMessages: readonly RenderedMessage[];
  /** Shared in-flight set (useAskUserAnsweringStore) — both co-mounted surfaces disable together. */
  answeringToolCallIds: ReadonlySet<string>;
  /** Active stream or optimistic/pending send for THIS conversation — replaces status==='ready'. */
  isConversationBusy: boolean;
}

/**
 * Pure answerability predicate (epic leaf 6.3): a pausing-tool part (`tool-ask_user`,
 * `tool-request_env_approval`) is
 * answerable iff it sits on the LAST message, that message is a settled
 * (non-streaming) assistant reply, its state is `input-available`, no other
 * surface already claimed it (answeringToolCallIds), and nothing is busy for
 * the conversation on screen.
 */
export const selectAnswerableAskUserToolCallIds = (
  input: AskUserAnswerabilityInput,
): ReadonlySet<string> => {
  const ids = new Set<string>();
  if (input.isConversationBusy) return ids;

  const settled = input.renderedMessages.filter((r) => r.mode !== 'streaming');
  const last = settled[settled.length - 1]?.message;
  if (!last || last.role !== 'assistant') return ids;

  for (const part of last.parts ?? []) {
    if (!isPausingToolPartType(part.type)) continue;
    const p = part as { toolCallId: string; state?: string };
    if (p.state !== 'input-available') continue;
    if (input.answeringToolCallIds.has(p.toolCallId)) continue;
    ids.add(p.toolCallId);
  }
  return ids;
};
