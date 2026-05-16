export type CompletionRole = 'system' | 'user' | 'assistant';

export interface ModelMessage {
  role: CompletionRole;
  content: string;
}

export interface OpenAIErrorBody {
  message: string;
  type: string;
  code: string;
  param?: string;
}

export type ParsedCompletionRequest =
  | { ok: true; model: string; messages: ModelMessage[]; stream: boolean }
  | { ok: false; status: number; error: OpenAIErrorBody };

const badRequest = (message: string, param: string): ParsedCompletionRequest => ({
  ok: false,
  status: 400,
  error: { message, type: 'invalid_request_error', code: 'invalid_request', param },
});

const extractText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type: string; text: string } =>
          !!part &&
          typeof part === 'object' &&
          (part as { type?: unknown }).type === 'text' &&
          typeof (part as { text?: unknown }).text === 'string',
      )
      .map((part) => part.text)
      .join('');
  }
  return '';
};

export const parseCompletionRequest = (body: unknown): ParsedCompletionRequest => {
  if (!body || typeof body !== 'object') {
    return badRequest('Request body must be a JSON object.', 'body');
  }

  const { model, messages, stream } = body as {
    model?: unknown;
    messages?: unknown;
    stream?: unknown;
  };

  if (typeof model !== 'string' || model.length === 0) {
    return badRequest('Missing required parameter: model.', 'model');
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return badRequest('Missing required parameter: messages.', 'messages');
  }

  const modelMessages: ModelMessage[] = [];
  for (const message of messages) {
    const role = (message as { role?: unknown })?.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      return badRequest(`Unsupported message role: ${String(role)}.`, 'messages');
    }
    modelMessages.push({
      role,
      content: extractText((message as { content?: unknown }).content),
    });
  }

  return {
    ok: true,
    model,
    messages: modelMessages,
    stream: stream === undefined ? true : stream === true,
  };
};
