import type { UIMessage } from 'ai';

type AnyPart = UIMessage['parts'][number];

interface ToolPart {
  type: `tool-${string}`;
  toolCallId: string;
  toolName: string;
  state: 'input-available' | 'output-available' | 'output-error';
  input: unknown;
  output?: unknown;
  errorText?: string;
}

interface AISDKChunk {
  type: string;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

const errorTextFor = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return 'Tool execution failed';
  }
};

const toolPart = (
  state: ToolPart['state'],
  chunk: AISDKChunk & { toolName: string; toolCallId: string },
): ToolPart => ({
  type: `tool-${chunk.toolName}`,
  toolCallId: chunk.toolCallId,
  toolName: chunk.toolName,
  state,
  input: chunk.input,
  ...(state === 'output-available' ? { output: chunk.output } : {}),
  ...(state === 'output-error' ? { errorText: errorTextFor(chunk.error) } : {}),
});

/**
 * Convert an AI SDK v5 streamText `onChunk` chunk into a `UIMessagePart`
 * suitable for multicast. Returns `null` for chunk types we don't forward
 * (step boundaries, raw, reasoning, tool-input-streaming, source/file —
 * minimal v1 scope; later waves can extend without a wire change).
 *
 * Pure — never reads or writes external state.
 */
export const chunkToPart = (chunk: AISDKChunk): AnyPart | null => {
  if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
    return { type: 'text', text: chunk.text };
  }
  if (
    (chunk.type === 'tool-call' || chunk.type === 'tool-result' || chunk.type === 'tool-error') &&
    typeof chunk.toolName === 'string' &&
    typeof chunk.toolCallId === 'string'
  ) {
    const state =
      chunk.type === 'tool-call'
        ? 'input-available'
        : chunk.type === 'tool-result'
        ? 'output-available'
        : 'output-error';
    return toolPart(state, { ...chunk, toolName: chunk.toolName, toolCallId: chunk.toolCallId }) as unknown as AnyPart;
  }
  return null;
};
