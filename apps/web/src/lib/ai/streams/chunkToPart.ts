import type { UIMessage } from 'ai';

type AnyPart = UIMessage['parts'][number];

/**
 * Convert an AI SDK v5 streamText `onChunk` chunk into a `UIMessagePart`
 * suitable for multicast. Returns `null` for chunk types we don't forward
 * (step-start/finish, raw, reasoning-delta, tool-input-delta — minimal v1
 * scope; later waves can extend).
 *
 * Pure — never reads or writes external state.
 */
export const chunkToPart = (chunk: { type: string } & Record<string, unknown>): AnyPart | null => {
  if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
    return { type: 'text', text: chunk.text };
  }
  if (chunk.type === 'tool-call' && typeof chunk.toolName === 'string') {
    return {
      type: `tool-${chunk.toolName}`,
      toolCallId: chunk.toolCallId as string,
      toolName: chunk.toolName,
      state: 'input-available',
      input: chunk.input,
    } as unknown as AnyPart;
  }
  if (chunk.type === 'tool-result' && typeof chunk.toolName === 'string') {
    return {
      type: `tool-${chunk.toolName}`,
      toolCallId: chunk.toolCallId as string,
      toolName: chunk.toolName,
      state: 'output-available',
      input: chunk.input,
      output: chunk.output,
    } as unknown as AnyPart;
  }
  return null;
};
