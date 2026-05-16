import { saveMessageToDatabase } from '@/lib/ai/core/message-utils';
import { AIMonitoring } from '@pagespace/lib/monitoring/ai-monitoring';

export interface ApiExchangeInput {
  userId: string;
  pageId: string;
  conversationId: string;
  userText: string;
  assistantText: string;
  provider: string;
  model: string;
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  durationMs?: number;
}

export const persistApiExchange = async ({
  userId,
  pageId,
  conversationId,
  userText,
  assistantText,
  provider,
  model,
  usage,
  durationMs,
}: ApiExchangeInput): Promise<void> => {
  const userMessageId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();

  await saveMessageToDatabase({
    messageId: userMessageId,
    pageId,
    conversationId,
    userId,
    role: 'user',
    content: userText,
  });

  await saveMessageToDatabase({
    messageId: assistantMessageId,
    pageId,
    conversationId,
    userId,
    role: 'assistant',
    content: assistantText,
    sourceAgentId: pageId,
  });

  await AIMonitoring.trackUsage({
    userId,
    provider,
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    duration: durationMs,
    conversationId,
    messageId: assistantMessageId,
    pageId,
    success: true,
    metadata: { source: 'openai_compatible_api' },
  });
};
