import type { UIMessageChunk } from 'ai';

export type AdaptOptions = {
  id: string;
  model: string;
  created: number;
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

    case 'finish':
      return [
        toSSE(makeChunk(options, {}, 'stop')),
        'data: [DONE]',
      ].join('\n\n');

    default:
      return null;
  }
};
