/**
 * Tests for ai-context-calculator.ts
 * Pure functions - no DB mocking needed.
 */

import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  estimateSystemPromptTokens,
  estimateToolDefinitionTokens,
  estimateMessageTokens,
  getContextWindowSize,
  calculateTotalContextSize,
  determineMessagesToInclude,
  type UIMessage,
  type ContextConfig,
} from '../ai-context-calculator';

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------
describe('estimateTokens', () => {
  it('should return 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('should return 0 for falsy value', () => {
    // @ts-expect-error - testing runtime behaviour with null
    expect(estimateTokens(null)).toBe(0);
  });

  it('should return ceil(length / 4)', () => {
    // 4 chars → 1 token
    expect(estimateTokens('abcd')).toBe(1);
    // 5 chars → ceil(5/4) = 2
    expect(estimateTokens('abcde')).toBe(2);
    // 8 chars → 2 tokens
    expect(estimateTokens('abcdefgh')).toBe(2);
    // 9 chars → 3 tokens
    expect(estimateTokens('abcdefghi')).toBe(3);
  });

  it('should handle a longer text', () => {
    const text = 'a'.repeat(100);
    expect(estimateTokens(text)).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// estimateSystemPromptTokens
// ---------------------------------------------------------------------------
describe('estimateSystemPromptTokens', () => {
  it('should return 0 when prompt is undefined', () => {
    expect(estimateSystemPromptTokens(undefined)).toBe(0);
  });

  it('should return 0 when prompt is empty string', () => {
    expect(estimateSystemPromptTokens('')).toBe(0);
  });

  it('should delegate to estimateTokens', () => {
    const prompt = 'Hello world!'; // 12 chars → ceil(12/4) = 3
    expect(estimateSystemPromptTokens(prompt)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// estimateToolDefinitionTokens
// ---------------------------------------------------------------------------
describe('estimateToolDefinitionTokens', () => {
  it('should return 0 when tools is undefined', () => {
    expect(estimateToolDefinitionTokens(undefined)).toBe(0);
  });

  it('should return 0 when tools is empty object', () => {
    expect(estimateToolDefinitionTokens({})).toBe(0);
  });

  it('should estimate tokens from JSON stringified tools', () => {
    const tools = { myTool: { description: 'does something' } };
    const json = JSON.stringify(tools);
    const expected = Math.ceil(json.length / 4);
    expect(estimateToolDefinitionTokens(tools)).toBe(expected);
  });

  it('should handle multiple tools', () => {
    const tools = {
      toolA: { name: 'toolA', description: 'alpha' },
      toolB: { name: 'toolB', description: 'beta' },
    };
    const json = JSON.stringify(tools);
    const expected = Math.ceil(json.length / 4);
    expect(estimateToolDefinitionTokens(tools)).toBe(expected);
  });

  it('should fall back to count * 150 for non-serialisable tools', () => {
    // Create a tool object that throws during JSON.stringify via circular reference
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    // Override tools object to have 2 keys
    const tools: Record<string, unknown> = { a: circular, b: circular };
    // JSON.stringify will throw, so we expect 2 * 150 = 300
    expect(estimateToolDefinitionTokens(tools)).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// estimateMessageTokens
// ---------------------------------------------------------------------------
describe('estimateMessageTokens', () => {
  it('should add 5 (role) + 10 (overhead) for a message with no parts', () => {
    const msg: UIMessage = { role: 'user', parts: [] };
    expect(estimateMessageTokens(msg)).toBe(15);
  });

  it('should add text part tokens', () => {
    const text = 'Hello world'; // 11 chars → ceil(11/4) = 3
    const msg: UIMessage = {
      role: 'user',
      parts: [{ type: 'text', text }],
    };
    // 5 + 3 + 10 = 18
    expect(estimateMessageTokens(msg)).toBe(18);
  });

  it('should handle tool-call part with toolCallId and toolName and args', () => {
    const msg: UIMessage = {
      role: 'assistant',
      parts: [
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'myTool', // 6 chars → ceil(6/4) = 2
          args: { key: 'value' }, // '{"key":"value"}' = 15 chars → ceil(15/4) = 4
        },
      ],
    };
    // 5 + 10 (call id) + 2 (toolName) + 4 (args) + 10 (overhead) = 31
    expect(estimateMessageTokens(msg)).toBe(31);
  });

  it('should handle tool-call part with toolCallId but no toolName or args', () => {
    const msg: UIMessage = {
      role: 'assistant',
      parts: [
        {
          type: 'tool-call',
          toolCallId: 'call-1',
        },
      ],
    };
    // 5 + 10 (call id) + 10 (overhead) = 25
    expect(estimateMessageTokens(msg)).toBe(25);
  });

  it('should handle tool-result part with string result', () => {
    const msg: UIMessage = {
      role: 'user',
      parts: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          result: 'done', // 4 chars → 1 token
        },
      ],
    };
    // 5 + 10 (call id) + 1 (result) + 10 = 26
    expect(estimateMessageTokens(msg)).toBe(26);
  });

  it('should handle tool-result part with object result', () => {
    const msg: UIMessage = {
      role: 'user',
      parts: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          result: { status: 'ok' }, // '{"status":"ok"}' = 15 chars → 4 tokens
        },
      ],
    };
    // 5 + 10 + 4 + 10 = 29
    expect(estimateMessageTokens(msg)).toBe(29);
  });

  it('should handle tool-result part with no result', () => {
    const msg: UIMessage = {
      role: 'user',
      parts: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
        },
      ],
    };
    // 5 + 10 (call id) + 10 = 25
    expect(estimateMessageTokens(msg)).toBe(25);
  });

  it('should handle unknown part type (no text tokens added)', () => {
    const msg: UIMessage = {
      role: 'user',
      parts: [{ type: 'image' }],
    };
    // 5 + 10 = 15
    expect(estimateMessageTokens(msg)).toBe(15);
  });

  it('should return 15 when parts is undefined', () => {
    const msg: UIMessage = { role: 'user' };
    expect(estimateMessageTokens(msg)).toBe(15);
  });

  it('should handle text part with no text (empty/undefined)', () => {
    const msg: UIMessage = {
      role: 'user',
      parts: [{ type: 'text' }],
    };
    // text is undefined → estimateTokens(undefined) = 0
    // 5 + 0 + 10 = 15
    expect(estimateMessageTokens(msg)).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// getContextWindowSize
// ---------------------------------------------------------------------------
describe('getContextWindowSize', () => {
  describe('OpenAI family', () => {
    it('should match via provider=openai', () => {
      expect(getContextWindowSize('some-model', 'openai')).toBe(200_000);
    });

    it('should match gpt-5.2 mini/nano variant → 256k', () => {
      expect(getContextWindowSize('gpt-5.2-mini')).toBe(256_000);
      expect(getContextWindowSize('gpt-5.2-nano')).toBe(256_000);
    });

    it('should match gpt-5.2 standard variant → 400k', () => {
      expect(getContextWindowSize('gpt-5.2')).toBe(400_000);
    });

    it('should match gpt-5.1 → 400k', () => {
      expect(getContextWindowSize('gpt-5.1')).toBe(400_000);
    });

    it('should match gpt-5 mini/nano → 128k', () => {
      expect(getContextWindowSize('gpt-5-mini')).toBe(128_000);
      expect(getContextWindowSize('gpt-5-nano')).toBe(128_000);
    });

    it('should match gpt-5 standard → 272k', () => {
      expect(getContextWindowSize('gpt-5')).toBe(272_000);
    });

    it('should match gpt-4o → 128k', () => {
      expect(getContextWindowSize('gpt-4o')).toBe(128_000);
    });

    it('should match gpt-4-turbo → 128k', () => {
      expect(getContextWindowSize('gpt-4-turbo')).toBe(128_000);
    });

    it('should match gpt-4 → 8192', () => {
      expect(getContextWindowSize('gpt-4')).toBe(8_192);
    });

    it('should match gpt-3.5 → 16385', () => {
      expect(getContextWindowSize('gpt-3.5-turbo')).toBe(16_385);
    });

    it('should return 200k default for unknown openai model', () => {
      // provider=openai but unknown model hits default 200k return
      expect(getContextWindowSize('new-openai-model', 'openai')).toBe(200_000);
    });
  });

  describe('Anthropic family', () => {
    it('should return 200k for claude-sonnet-4', () => {
      expect(getContextWindowSize('claude-sonnet-4-5-20250929')).toBe(200_000);
    });

    it('should return 200k for claude-4 model', () => {
      expect(getContextWindowSize('claude-4-turbo')).toBe(200_000);
    });

    it('should return 200k for claude-3-5', () => {
      expect(getContextWindowSize('claude-3-5-sonnet-20241022')).toBe(200_000);
    });

    it('should return 200k for claude-3', () => {
      expect(getContextWindowSize('claude-3-opus-20240229')).toBe(200_000);
    });

    it('should return 200k for generic claude model', () => {
      expect(getContextWindowSize('claude-future')).toBe(200_000);
    });

    it('should match via provider=anthropic', () => {
      expect(getContextWindowSize('some-model', 'anthropic')).toBe(200_000);
    });
  });

  describe('Google family', () => {
    it('should return 2M for gemini-2.5-pro', () => {
      expect(getContextWindowSize('gemini-2.5-pro')).toBe(2_000_000);
    });

    it('should return 1M for gemini-2.5-flash', () => {
      expect(getContextWindowSize('gemini-2.5-flash')).toBe(1_000_000);
    });

    it('should return 2M for gemini-2.0-pro / gemini-2-pro variant', () => {
      expect(getContextWindowSize('gemini-2.0-pro')).toBe(2_000_000);
      expect(getContextWindowSize('gemini-2-pro')).toBe(2_000_000);
    });

    it('should return 1M for gemini-2.0-flash / gemini-2-flash variant', () => {
      expect(getContextWindowSize('gemini-2.0-flash')).toBe(1_000_000);
      expect(getContextWindowSize('gemini-2-flash')).toBe(1_000_000);
    });

    it('should return 2M for gemini-1.5-pro', () => {
      expect(getContextWindowSize('gemini-1.5-pro')).toBe(2_000_000);
    });

    it('should return 1M for gemini-1.5-flash', () => {
      expect(getContextWindowSize('gemini-1.5-flash')).toBe(1_000_000);
    });

    it('should return 32k for gemini-pro (legacy)', () => {
      expect(getContextWindowSize('gemini-pro')).toBe(32_000);
    });

    it('should return 1M default for unknown google model', () => {
      expect(getContextWindowSize('gemini-future', 'google')).toBe(1_000_000);
    });
  });

  describe('xAI family', () => {
    it('should return 2M for grok-4-fast', () => {
      expect(getContextWindowSize('grok-4-fast')).toBe(2_000_000);
    });

    it('should return 128k for generic grok model', () => {
      expect(getContextWindowSize('grok-3')).toBe(128_000);
    });

    it('should return 128k for unknown xai model via provider', () => {
      expect(getContextWindowSize('unknown-xai', 'xai')).toBe(128_000);
    });
  });

  describe('PageSpace / GLM family', () => {
    it('should return 200k for glm-5', () => {
      expect(getContextWindowSize('glm-5')).toBe(200_000);
    });

    it('should return 200k for glm-4.7', () => {
      expect(getContextWindowSize('glm-4.7')).toBe(200_000);
    });

    it('should return 200k for glm-4.6', () => {
      expect(getContextWindowSize('glm-4.6')).toBe(200_000);
    });

    it('should return 128k for glm-4.5', () => {
      expect(getContextWindowSize('glm-4.5')).toBe(128_000);
    });

    it('should return 200k default for unknown glm model', () => {
      expect(getContextWindowSize('glm-99')).toBe(200_000);
    });

    it('should match via provider=pagespace', () => {
      expect(getContextWindowSize('some-model', 'pagespace')).toBe(200_000);
    });
  });

  describe('MiniMax family', () => {
    it('should return 1M for m2.5 model', () => {
      expect(getContextWindowSize('minimax-m2.5')).toBe(1_000_000);
    });

    it('should return 128k for other minimax models', () => {
      expect(getContextWindowSize('minimax-m1')).toBe(128_000);
    });

    it('should match via provider=minimax', () => {
      expect(getContextWindowSize('any-model', 'minimax')).toBe(128_000);
    });
  });

  describe('Unknown / default', () => {
    it('should return 200k for completely unknown model and no provider', () => {
      expect(getContextWindowSize('some-totally-unknown-model')).toBe(200_000);
    });
  });
});

// ---------------------------------------------------------------------------
// calculateTotalContextSize
// ---------------------------------------------------------------------------
describe('calculateTotalContextSize', () => {
  it('should handle empty messages list', () => {
    const config: ContextConfig = {
      messages: [],
      model: 'gpt-4o',
    };
    const result = calculateTotalContextSize(config);
    expect(result.messageCount).toBe(0);
    expect(result.conversationTokens).toBe(0);
    expect(result.totalTokens).toBe(0);
    expect(result.wasTruncated).toBe(false);
    expect(result.truncationStrategy).toBe('none');
    expect(result.messageIds).toEqual([]);
  });

  it('should include system prompt tokens', () => {
    const config: ContextConfig = {
      messages: [],
      model: 'gpt-4o',
      systemPrompt: 'You are a helpful assistant.', // 27 chars → 7 tokens
    };
    const result = calculateTotalContextSize(config);
    expect(result.systemPromptTokens).toBe(7);
    expect(result.totalTokens).toBe(7);
  });

  it('should include tool definition tokens', () => {
    const tools = { myTool: { name: 'myTool' } };
    const toolTokens = Math.ceil(JSON.stringify(tools).length / 4);
    const config: ContextConfig = {
      messages: [],
      model: 'gpt-4o',
      tools,
    };
    const result = calculateTotalContextSize(config);
    expect(result.toolDefinitionTokens).toBe(toolTokens);
  });

  it('should collect message IDs', () => {
    const messages: UIMessage[] = [
      { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
      { id: 'msg-2', role: 'assistant', parts: [{ type: 'text', text: 'Hi' }] },
    ];
    const config: ContextConfig = { messages, model: 'gpt-4o' };
    const result = calculateTotalContextSize(config);
    expect(result.messageIds).toEqual(['msg-1', 'msg-2']);
  });

  it('should not add ID for messages without an id field', () => {
    const messages: UIMessage[] = [
      { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
    ];
    const config: ContextConfig = { messages, model: 'gpt-4o' };
    const result = calculateTotalContextSize(config);
    expect(result.messageIds).toEqual([]);
  });

  it('should set wasTruncated=true when total tokens exceed context window', () => {
    // gpt-4 has 8192 token window
    const bigText = 'a'.repeat(8192 * 4 * 4); // way beyond 8192 tokens
    const messages: UIMessage[] = [
      { id: 'big', role: 'user', parts: [{ type: 'text', text: bigText }] },
    ];
    const config: ContextConfig = { messages, model: 'gpt-4' };
    const result = calculateTotalContextSize(config);
    expect(result.wasTruncated).toBe(true);
    expect(result.truncationStrategy).toBe('oldest_first');
  });

  it('should set wasTruncated=false when total tokens fit in context window', () => {
    const messages: UIMessage[] = [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
    ];
    const config: ContextConfig = { messages, model: 'gpt-4o' }; // 128k window
    const result = calculateTotalContextSize(config);
    expect(result.wasTruncated).toBe(false);
    expect(result.truncationStrategy).toBe('none');
  });

  it('should sum conversationTokens across all messages', () => {
    const messages: UIMessage[] = [
      { role: 'user', parts: [{ type: 'text', text: 'abcd' }] }, // 5 + 1 + 10 = 16
      { role: 'assistant', parts: [{ type: 'text', text: 'efgh' }] }, // 5 + 1 + 10 = 16
    ];
    const config: ContextConfig = { messages, model: 'gpt-4o' };
    const result = calculateTotalContextSize(config);
    expect(result.conversationTokens).toBe(32);
    expect(result.messageCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// determineMessagesToInclude
// ---------------------------------------------------------------------------
describe('determineMessagesToInclude', () => {
  it('should return empty when budget is zero or negative', () => {
    const messages: UIMessage[] = [
      { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
    ];
    const result = determineMessagesToInclude(messages, 0, 100, 0);
    expect(result.includedMessages).toEqual([]);
    expect(result.wasTruncated).toBe(true);
  });

  it('should return empty when systemPrompt and tools consume all budget', () => {
    const messages: UIMessage[] = [
      { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
    ];
    const result = determineMessagesToInclude(messages, 100, 60, 60);
    expect(result.includedMessages).toEqual([]);
    expect(result.wasTruncated).toBe(true);
    expect(result.totalTokens).toBe(120); // systemPromptTokens + toolTokens
  });

  it('should include all messages when they all fit', () => {
    const messages: UIMessage[] = [
      { role: 'user', parts: [{ type: 'text', text: 'a' }] }, // 5+1+10=16
      { role: 'assistant', parts: [{ type: 'text', text: 'b' }] }, // 16
    ];
    // maxTokens=1000, systemPromptTokens=0, toolTokens=0
    const result = determineMessagesToInclude(messages, 1000, 0, 0);
    expect(result.includedMessages).toHaveLength(2);
    expect(result.wasTruncated).toBe(false);
  });

  it('should drop oldest messages when budget is exceeded', () => {
    // Each message costs ~16 tokens (5 + ceil(1/4)=1 + 10)
    const messages: UIMessage[] = [
      { role: 'user', parts: [{ type: 'text', text: 'a' }] },   // 16 tokens
      { role: 'assistant', parts: [{ type: 'text', text: 'b' }] }, // 16 tokens
      { role: 'user', parts: [{ type: 'text', text: 'c' }] },   // 16 tokens
    ];
    // Budget for messages = 20 tokens (only one 16-token message fits)
    // maxTokens=20, no system/tool overhead
    const result = determineMessagesToInclude(messages, 20, 0, 0);
    // Should include only the last message (most recent)
    expect(result.includedMessages).toHaveLength(1);
    expect(result.wasTruncated).toBe(true);
  });

  it('should maintain order (most recent last in result)', () => {
    const messages: UIMessage[] = [
      { id: 'first', role: 'user', parts: [{ type: 'text', text: 'first' }] },
      { id: 'second', role: 'assistant', parts: [{ type: 'text', text: 'second' }] },
      { id: 'third', role: 'user', parts: [{ type: 'text', text: 'third' }] },
    ];
    const result = determineMessagesToInclude(messages, 10000, 0, 0);
    expect(result.includedMessages[0]?.id).toBe('first');
    expect(result.includedMessages[2]?.id).toBe('third');
  });

  it('should account for systemPromptTokens and toolTokens in budget', () => {
    const messages: UIMessage[] = [
      { role: 'user', parts: [{ type: 'text', text: 'hello' }] }, // 5+2+10=17
    ];
    // maxTokens=100, systemPromptTokens=50, toolTokens=30, budget=20
    // 20 > 17, so the message fits
    const result = determineMessagesToInclude(messages, 100, 50, 30);
    expect(result.includedMessages).toHaveLength(1);
    expect(result.wasTruncated).toBe(false);
    expect(result.totalTokens).toBe(50 + 30 + 17);
  });

  it('should handle empty messages array', () => {
    const result = determineMessagesToInclude([], 1000, 0, 0);
    expect(result.includedMessages).toEqual([]);
    expect(result.wasTruncated).toBe(false);
    expect(result.totalTokens).toBe(0);
  });

  it('should use default values for systemPromptTokens and toolTokens', () => {
    const messages: UIMessage[] = [
      { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    ];
    // No third/fourth arg - defaults are 0
    const result = determineMessagesToInclude(messages, 1000);
    expect(result.includedMessages).toHaveLength(1);
    expect(result.wasTruncated).toBe(false);
  });
});
