import { describe, test, beforeEach, vi } from 'vitest';
import { assert } from '@/lib/ai/core/__tests__/riteway';

const saveMessageToDatabase = vi.fn();
const trackUsage = vi.fn();

vi.mock('@/lib/ai/core/message-utils', () => ({
  saveMessageToDatabase: (...a: unknown[]) => saveMessageToDatabase(...a),
}));
vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({
  AIMonitoring: { trackUsage: (...a: unknown[]) => trackUsage(...a) },
}));

import { persistApiExchange } from '../persistence';

const input = {
  userId: 'u1',
  pageId: 'p1',
  conversationId: 'conv-1',
  userText: 'hello',
  assistantText: 'hi there',
  provider: 'pagespace',
  model: 'glm-4',
  usage: { inputTokens: 7, outputTokens: 4, totalTokens: 11 },
};

describe('persistApiExchange', () => {
  beforeEach(() => {
    saveMessageToDatabase.mockReset();
    trackUsage.mockReset();
  });

  test('persists the user and assistant turns under the agent page', async () => {
    await persistApiExchange(input);

    const calls = saveMessageToDatabase.mock.calls.map((c) => ({
      role: c[0].role,
      content: c[0].content,
      pageId: c[0].pageId,
      conversationId: c[0].conversationId,
    }));

    assert({
      given: 'a completed API inference',
      should: 'persist the user then assistant turn under the agent page conversation',
      actual: calls,
      expected: [
        { role: 'user', content: 'hello', pageId: 'p1', conversationId: 'conv-1' },
        { role: 'assistant', content: 'hi there', pageId: 'p1', conversationId: 'conv-1' },
      ],
    });
  });

  test('records token usage with provider and model', async () => {
    await persistApiExchange(input);

    const usageArg = trackUsage.mock.calls[0]?.[0] ?? {};

    assert({
      given: 'a completed API inference',
      should: 'record token usage with provider, model and the agent page through monitoring',
      actual: {
        userId: usageArg.userId,
        provider: usageArg.provider,
        model: usageArg.model,
        inputTokens: usageArg.inputTokens,
        outputTokens: usageArg.outputTokens,
        pageId: usageArg.pageId,
        success: usageArg.success,
      },
      expected: {
        userId: 'u1',
        provider: 'pagespace',
        model: 'glm-4',
        inputTokens: 7,
        outputTokens: 4,
        pageId: 'p1',
        success: true,
      },
    });
  });
});
