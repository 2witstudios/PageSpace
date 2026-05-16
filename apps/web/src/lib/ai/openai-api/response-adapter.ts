export interface CompletionMeta {
  id: string;
  model: string;
  created: number;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: 'assistant'; content?: string };
    finish_reason: 'stop' | null;
  }>;
}

export interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string };
    finish_reason: 'stop';
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface ChunkInput {
  delta?: string;
  role?: 'assistant';
  finishReason?: 'stop';
}

export const toChunk = (
  meta: CompletionMeta,
  { delta, role, finishReason }: ChunkInput,
): ChatCompletionChunk => ({
  id: meta.id,
  object: 'chat.completion.chunk',
  created: meta.created,
  model: meta.model,
  choices: [
    {
      index: 0,
      delta: {
        ...(role ? { role } : {}),
        ...(delta !== undefined ? { content: delta } : {}),
      },
      finish_reason: finishReason ?? null,
    },
  ],
});

export const toCompletion = (
  meta: CompletionMeta,
  {
    content,
    usage,
  }: {
    content: string;
    usage: { promptTokens: number; completionTokens: number };
  },
): ChatCompletion => ({
  id: meta.id,
  object: 'chat.completion',
  created: meta.created,
  model: meta.model,
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    },
  ],
  usage: {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.promptTokens + usage.completionTokens,
  },
});

export const sseEvent = (payload: unknown): string =>
  `data: ${JSON.stringify(payload)}\n\n`;

export const SSE_DONE = 'data: [DONE]\n\n';

export const createCompletionMeta = (model: string): CompletionMeta => ({
  id: `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`,
  model,
  created: Math.floor(Date.now() / 1000),
});
