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
 * LAST message (addToolOutput only patches the last message) and the chat is
 * idle — otherwise it renders read-only (historical, mid-stream, or a later
 * message already exists).
 */
export function useAskUserAnswering(params: UseAskUserAnsweringParams): AskUserAnsweringApi {
  const { messages, status, addToolResult, wrapSend, buildBody } = params;

  const answerableToolCallIds = useMemo(() => {
    const ids = new Set<string>();
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant' || status !== 'ready' || !last.parts) return ids;

    for (const part of last.parts) {
      if (part.type !== ASK_USER_PART_TYPE) continue;
      const p = part as { toolCallId: string; state?: string };
      if (p.state === 'input-available') ids.add(p.toolCallId);
    }
    return ids;
  }, [messages, status]);

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
