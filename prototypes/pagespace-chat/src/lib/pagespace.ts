export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export interface StreamChatOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  messages: Message[];
  conversationId?: string;
}

export async function streamChat(options: StreamChatOptions): Promise<ReadableStream<Uint8Array>> {
  const { apiKey, baseUrl, model, messages, conversationId } = options;

  // In thread mode, only send the latest user message — server loads history from DB
  const payload = conversationId
    ? { model, messages: [messages[messages.length - 1]], conversation_id: conversationId }
    : { model, messages };

  const response = await fetch(`${baseUrl}/api/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok || !response.body) {
    const errorText = await response.text().catch(() => 'unknown error');
    throw new Error(`PageSpace API error ${response.status}: ${errorText}`);
  }

  return response.body;
}
