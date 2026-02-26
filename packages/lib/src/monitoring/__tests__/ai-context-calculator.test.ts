import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  estimateMessageTokens,
  estimateSystemPromptTokens,
  estimateToolDefinitionTokens,
  getContextWindowSize,
  determineMessagesToInclude,
  type UIMessage,
} from '../ai-context-calculator';

describe('estimateTokens', () => {
  it('returns 0 for empty/falsy input', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(null as unknown as string)).toBe(0);
    expect(estimateTokens(undefined as unknown as string)).toBe(0);
  });

  it('estimates ~4 chars/token for ASCII text', () => {
    const text = 'Hello, world! This is a test.';
    const tokens = estimateTokens(text);
    // 28 chars / 4 = 7
    expect(tokens).toBe(Math.ceil(text.length / 4));
  });

  it('uses ~2 chars/token for CJK-heavy text (>20% non-ASCII)', () => {
    const text = '这是一个测试消息'; // 8 CJK characters, 100% non-ASCII
    const tokens = estimateTokens(text);
    expect(tokens).toBe(Math.ceil(text.length / 2));
  });

  it('uses 4 chars/token for mostly-ASCII text with minor non-ASCII', () => {
    // 80 ASCII chars + 5 non-ASCII = 5/85 ≈ 5.9% non-ASCII → use 4 chars/token
    const text = 'a'.repeat(80) + '你好世界呢';
    const tokens = estimateTokens(text);
    expect(tokens).toBe(Math.ceil(text.length / 4));
  });

  it('switches to 2 chars/token at >20% non-ASCII threshold', () => {
    // 3 ASCII + 1 CJK = 25% non-ASCII (above 20% threshold)
    const text = 'abc你';
    const tokens = estimateTokens(text);
    expect(tokens).toBe(Math.ceil(text.length / 2));
  });

  it('handles emoji as non-ASCII', () => {
    // Emoji are multi-byte, charCodeAt > 127 for surrogate pairs
    const text = 'Hello 🌍🌍🌍🌍🌍'; // mixed with emoji
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
  });
});

describe('estimateMessageTokens', () => {
  it('returns overhead tokens for empty message', () => {
    const msg: UIMessage = { role: 'user', parts: [] };
    // 5 (role) + 10 (overhead) = 15
    expect(estimateMessageTokens(msg)).toBe(15);
  });

  it('counts text parts', () => {
    const msg: UIMessage = {
      role: 'user',
      parts: [{ type: 'text', text: 'Hello, world!' }],
    };
    const tokens = estimateMessageTokens(msg);
    // 5 (role) + estimateTokens('Hello, world!') + 10 (overhead)
    expect(tokens).toBe(5 + estimateTokens('Hello, world!') + 10);
  });

  it('counts tool invocation parts (tool-{name} format)', () => {
    const msg: UIMessage = {
      role: 'assistant',
      parts: [
        {
          type: 'tool-search',
          toolCallId: 'call_123',
          toolName: 'search',
          input: { query: 'test' },
          output: { results: ['a', 'b'] },
          state: 'output-available',
        },
      ],
    };
    const tokens = estimateMessageTokens(msg);
    // Should include: 5 (role) + 10 (tool overhead) + toolName + input + output + 10 (msg overhead)
    expect(tokens).toBeGreaterThan(25);
  });

  it('handles legacy tool-call/tool-result format via startsWith("tool-")', () => {
    const msg: UIMessage = {
      role: 'assistant',
      parts: [
        {
          type: 'tool-myTool',
          toolCallId: 'call_456',
          toolName: 'myTool',
          args: { param: 'value' },
          result: 'done',
        },
      ],
    };
    const tokens = estimateMessageTokens(msg);
    // args falls through to input ?? args path
    expect(tokens).toBeGreaterThan(15);
  });

  it('handles message with no parts', () => {
    const msg: UIMessage = { role: 'user' };
    expect(estimateMessageTokens(msg)).toBe(15);
  });
});

describe('estimateSystemPromptTokens', () => {
  it('returns 0 for empty prompt', () => {
    expect(estimateSystemPromptTokens(undefined)).toBe(0);
    expect(estimateSystemPromptTokens('')).toBe(0);
  });

  it('estimates tokens for a prompt', () => {
    const prompt = 'You are a helpful assistant.';
    expect(estimateSystemPromptTokens(prompt)).toBe(estimateTokens(prompt));
  });
});

describe('estimateToolDefinitionTokens', () => {
  it('returns 0 for empty tools', () => {
    expect(estimateToolDefinitionTokens(undefined)).toBe(0);
    expect(estimateToolDefinitionTokens({})).toBe(0);
  });

  it('estimates tokens from JSON serialization', () => {
    const tools = { search: { description: 'Search the web', parameters: { query: 'string' } } };
    const tokens = estimateToolDefinitionTokens(tools);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBe(estimateTokens(JSON.stringify(tools)));
  });
});

describe('getContextWindowSize', () => {
  it('returns correct size for known direct models', () => {
    expect(getContextWindowSize('gpt-4o', 'openai')).toBe(128_000);
    expect(getContextWindowSize('gpt-4', 'openai')).toBe(8_192);
  });

  it('returns correct size for Anthropic models', () => {
    const size = getContextWindowSize('claude-3-5-sonnet-20241022', 'anthropic');
    expect(size).toBe(200_000);
  });

  it('returns correct size for Google models', () => {
    expect(getContextWindowSize('gemini-2.5-pro', 'google')).toBe(2_000_000);
    expect(getContextWindowSize('gemini-2.5-flash', 'google')).toBe(1_000_000);
  });

  it('returns conservative default for unknown models', () => {
    expect(getContextWindowSize('unknown-model', 'unknown-provider')).toBe(200_000);
  });

  it('handles OpenRouter models', () => {
    const size = getContextWindowSize('anthropic/claude-3.5-sonnet', 'openrouter');
    expect(size).toBe(200_000);
  });
});

describe('determineMessagesToInclude', () => {
  const makeMsg = (text: string, role: 'user' | 'assistant' = 'user'): UIMessage => ({
    id: text,
    role,
    parts: [{ type: 'text', text }],
  });

  it('includes all messages when they fit in budget', () => {
    const messages = [makeMsg('Hello'), makeMsg('World')];
    const result = determineMessagesToInclude(messages, 10_000, 100, 100);
    expect(result.includedMessages).toHaveLength(2);
    expect(result.wasTruncated).toBe(false);
  });

  it('truncates oldest messages first when budget is tight', () => {
    const messages = [
      makeMsg('a'.repeat(1000)), // ~250 tokens + overhead
      makeMsg('b'.repeat(1000)), // ~250 tokens + overhead
      makeMsg('c'.repeat(100)),  // ~25 tokens + overhead
    ];
    // Budget of 100 tokens for messages (after system/tool subtracted)
    const result = determineMessagesToInclude(messages, 200, 50, 50);
    expect(result.wasTruncated).toBe(true);
    expect(result.includedMessages.length).toBeLessThan(3);
    // Most recent message should be included
    if (result.includedMessages.length > 0) {
      expect(result.includedMessages[result.includedMessages.length - 1].id).toBe('c'.repeat(100));
    }
  });

  it('returns empty array when budget is zero or negative', () => {
    const messages = [makeMsg('test')];
    const result = determineMessagesToInclude(messages, 100, 60, 60);
    expect(result.includedMessages).toHaveLength(0);
    expect(result.wasTruncated).toBe(true);
  });

  it('preserves message order', () => {
    const messages = [makeMsg('first'), makeMsg('second'), makeMsg('third')];
    const result = determineMessagesToInclude(messages, 50_000, 0, 0);
    expect(result.includedMessages.map(m => m.id)).toEqual(['first', 'second', 'third']);
  });
});
