import type { UIMessageChunk } from 'ai';
import { adaptToolInputPart } from './adapt-tool-input-part';
import { adaptToolResultPart } from './adapt-tool-result-part';
import { resolveFinishReason } from './resolve-finish-reason';

export type AdaptOptions = {
  id: string;
  model: string;
  created: number;
  /** 0-based index of this tool call within the current step (for tool-input-available chunks) */
  toolCallIndex?: number;
  /** Whether the current step has had any tool calls (for finish-step chunks) */
  hadToolCallsInStep?: boolean;
  /** Override the finish_reason emitted on the 'finish' chunk (e.g. 'tool_calls' for client-tool stops) */
  overrideFinishReason?: string;
};

const makeChunk = (options: AdaptOptions, delta: Record<string, unknown>, finishReason: string | null) => ({
  id: options.id,
  object: 'chat.completion.chunk' as const,
  created: options.created,
  model: options.model,
  choices: [{ index: 0, delta, finish_reason: finishReason }],
});

const toSSE = (payload: unknown) => `data: ${JSON.stringify(payload)}`;

export const adaptToOpenAIChunk = (chunk: UIMessageChunk, options: AdaptOptions): string | null => {
  switch (chunk.type) {
    case 'start':
      return toSSE(makeChunk(options, { role: 'assistant', content: '' }, null));

    case 'text-delta':
      return toSSE(makeChunk(options, { content: chunk.delta }, null));

    case 'tool-input-available':
      return toSSE(
        adaptToolInputPart(chunk, options.id, options.model, options.created, options.toolCallIndex ?? 0),
      );

    case 'tool-output-available':
      return toSSE(adaptToolResultPart(chunk, options.id, options.model, options.created));

    case 'finish-step': {
      const finishReason = resolveFinishReason(options.hadToolCallsInStep ?? false, false);
      return finishReason === 'tool_calls'
        ? toSSE(makeChunk(options, {}, 'tool_calls'))
        : null;
    }

    case 'finish':
      // [DONE] is emitted by the route after buildToolSummaryEvent
      return toSSE(makeChunk(options, {}, options.overrideFinishReason ?? 'stop'));

    default:
      return null;
  }
};
