import { useCallback, useMemo } from 'react';
import type { UIMessage } from 'ai';
import { ASK_USER_TOOL_NAME, type AskUserOutput } from '@/lib/ai/tools/ask-user-tools';

const ASK_USER_PART_TYPE = `tool-${ASK_USER_TOOL_NAME}`;

type AddToolResultFn = (args: {
  tool: string;
  toolCallId: string;
  output: unknown;
  options?: { body?: object };
}) => void | PromiseLike<void>;

export interface UseAskUserAnsweringParams {
  messages: UIMessage[];
  status: 'ready' | 'submitted' | 'streaming' | 'error';
  addToolResult: AddToolResultFn;
  wrapSend: <T>(sendFn: () => T) => T | undefined;
  /** Builds the per-request body (chatId/conversationId/provider/etc) for this surface. */
  buildBody: () => object | Promise<object>;
}

export interface AskUserAnsweringApi {
  /** toolCallIds of ask_user parts on the LAST message that are currently answerable. */
  answerableToolCallIds: ReadonlySet<string>;
  submitAnswers: (toolCallId: string, output: AskUserOutput) => void;
}

/**
 * Shared answer plumbing for the ask_user interactive question tool.
 *
 * A question is only answerable when its part sits on the conversation's
 * LAST message (addToolOutput only patches the last message) and the part is
 * still pending input. We intentionally do NOT gate on transport status here:
 * status is surface-local and can be stale/non-conversation-scoped on complex
 * surfaces (machines/sidebar mode switches), which can incorrectly lock a
 * valid ask_user card behind disabled options.
 */
export function getAnswerableAskUserToolCallIds(messages: UIMessage[]): ReadonlySet<string> {
  const ids = new Set<string>();
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant' || !last.parts) return ids;

  for (const part of last.parts) {
    if (part.type !== ASK_USER_PART_TYPE) continue;
    const p = part as { toolCallId: string; state?: string };
    if (p.state === 'input-available') ids.add(p.toolCallId);
  }

  return ids;
}

export function useAskUserAnswering(params: UseAskUserAnsweringParams): AskUserAnsweringApi {
  const { messages, addToolResult, wrapSend, buildBody } = params;

  const answerableToolCallIds = useMemo(() => getAnswerableAskUserToolCallIds(messages), [messages]);

  const submitAnswers = useCallback(
    (toolCallId: string, output: AskUserOutput) => {
      wrapSend(async () => {
        const body = await buildBody();
        await addToolResult({
          tool: ASK_USER_TOOL_NAME,
          toolCallId,
          output,
          options: { body },
        });
      });
    },
    [addToolResult, buildBody, wrapSend]
  );

  return { answerableToolCallIds, submitAnswers };
}
