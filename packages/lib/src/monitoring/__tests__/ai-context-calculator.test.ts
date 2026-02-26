import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  estimateMessageTokens,
  getContextWindowSize,
  determineMessagesToInclude,
  type UIMessage,
} from '../ai-context-calculator';
import { MODEL_CONTEXT_WINDOWS } from '../model-context-windows';

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('returns 0 for null/undefined', () => {
    expect(estimateTokens(null as unknown as string)).toBe(0);
    expect(estimateTokens(undefined as unknown as string)).toBe(0);
  });

  it('uses ~4 chars/token for ASCII text', () => {
    const text = 'Hello, world!'; // 13 chars => ceil(13/4) = 4
    expect(estimateTokens(text)).toBe(4);
  });

  it('uses ~2 chars/token for CJK-heavy text', () => {
    // 100% CJK: each char should use ~2 chars/token ratio
    const text = '这是一段中文测试文本'; // 9 chars => ceil(9/2) = 5
    expect(estimateTokens(text)).toBe(5);
  });

  it('uses ~2 chars/token when non-ASCII ratio exceeds 20%', () => {
    // Mix: ~50% CJK
    const text = 'ab中文cd'; // 6 chars, 2 non-ASCII => 33% => 2 chars/token => ceil(6/2) = 3
    expect(estimateTokens(text)).toBe(3);
  });

  it('uses ~4 chars/token when non-ASCII ratio is below 20%', () => {
    // 1 non-ASCII out of 10 chars = 10% < 20%
    const text = 'abcdefghi中'; // 10 chars, 1 non-ASCII => 10% => 4 chars/token => ceil(10/4) = 3
    expect(estimateTokens(text)).toBe(3);
  });

  it('handles emoji as non-ASCII', () => {
    // Emoji characters have charCode > 127
    const text = '😀😀😀😀😀'; // 5 emoji (10 UTF-16 chars for surrogate pairs), all non-ASCII
    const result = estimateTokens(text);
    // Should use 2 chars/token path since all chars are non-ASCII
    expect(result).toBeGreaterThan(0);
  });
});

describe('estimateMessageTokens', () => {
  it('handles text-only messages', () => {
    const msg: UIMessage = {
      id: 'test',
      role: 'user',
      parts: [{ type: 'text', text: 'Hello world' }],
    };
    const tokens = estimateMessageTokens(msg);
    // 5 (role) + estimateTokens('Hello world') + 10 (overhead)
    expect(tokens).toBe(5 + estimateTokens('Hello world') + 10);
  });

  it('handles AI SDK tool-call parts', () => {
    const msg: UIMessage = {
      id: 'test',
      role: 'assistant',
      parts: [{
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'searchPages',
        args: { query: 'test' },
      }],
    };
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBeGreaterThan(15); // role + overhead + tool content
  });

  it('handles AI SDK tool-result parts', () => {
    const msg: UIMessage = {
      id: 'test',
      role: 'assistant',
      parts: [{
        type: 'tool-result',
        toolCallId: 'call-1',
        result: { pages: [{ id: '1', title: 'Test' }] },
      }],
    };
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBeGreaterThan(15);
  });

  it('handles PageSpace tool-{toolName} parts with input/output', () => {
    const msg: UIMessage = {
      id: 'test',
      role: 'assistant',
      parts: [{
        type: 'tool-searchPages',
        toolCallId: 'call-1',
        toolName: 'searchPages',
        input: { query: 'test search' },
        output: { results: [{ id: '1', title: 'Found page' }] },
        state: 'output-available',
      }],
    };
    const tokens = estimateMessageTokens(msg);
    // Should count input and output, not just skip the part
    expect(tokens).toBeGreaterThan(15);
  });

  it('handles empty parts array', () => {
    const msg: UIMessage = {
      id: 'test',
      role: 'user',
      parts: [],
    };
    // 5 (role) + 10 (overhead) = 15
    expect(estimateMessageTokens(msg)).toBe(15);
  });
});

describe('getContextWindowSize', () => {
  it('returns canonical value for exact model match', () => {
    expect(getContextWindowSize('gpt-4')).toBe(8192);
  });

  it('returns canonical value for OpenRouter model key via provider/model', () => {
    // minimax/minimax-m2.5 is 204800 in MODEL_CONTEXT_WINDOWS
    expect(getContextWindowSize('minimax-m2.5', 'minimax')).toBe(
      MODEL_CONTEXT_WINDOWS['minimax/minimax-m2.5']
    );
  });

  it('returns correct value for direct MiniMax-M2.5 model', () => {
    expect(getContextWindowSize('MiniMax-M2.5')).toBe(
      MODEL_CONTEXT_WINDOWS['MiniMax-M2.5']
    );
  });

  it('canonical map values differ for OpenRouter vs direct MiniMax', () => {
    // Verifies the divergence fix — OpenRouter has 204800, direct has 1000000
    expect(MODEL_CONTEXT_WINDOWS['minimax/minimax-m2.5']).toBe(204800);
    expect(MODEL_CONTEXT_WINDOWS['MiniMax-M2.5']).toBe(1000000);
  });

  it('falls back to heuristic matching for unknown models', () => {
    expect(getContextWindowSize('gpt-4o-2099-99-99', 'openai')).toBe(128_000);
  });

  it('returns default for completely unknown model', () => {
    expect(getContextWindowSize('totally-unknown-model')).toBe(200_000);
  });
});

describe('determineMessagesToInclude', () => {
  const makeMsg = (id: string, textLength: number): UIMessage => ({
    id,
    role: 'user',
    parts: [{ type: 'text', text: 'x'.repeat(textLength) }],
  });

  it('returns empty array when budget is zero or negative', () => {
    const msgs = [makeMsg('1', 100)];
    const result = determineMessagesToInclude(msgs, 100, 100, 100);
    expect(result.includedMessages).toHaveLength(0);
    expect(result.wasTruncated).toBe(true);
  });

  it('includes all messages when they fit', () => {
    const msgs = [makeMsg('1', 10), makeMsg('2', 10)];
    const result = determineMessagesToInclude(msgs, 100_000, 0, 0);
    expect(result.includedMessages).toHaveLength(2);
    expect(result.wasTruncated).toBe(false);
  });

  it('keeps most recent messages when truncating', () => {
    // Each message with 400 chars of text => ~100 tokens + 15 overhead = ~115 tokens
    const msgs = [makeMsg('old', 400), makeMsg('mid', 400), makeMsg('new', 400)];
    // Budget that fits ~2 messages
    const result = determineMessagesToInclude(msgs, 300, 0, 0);
    expect(result.wasTruncated).toBe(true);
    expect(result.includedMessages.length).toBeLessThan(3);
    // Most recent should be preserved
    const ids = result.includedMessages.map(m => m.id);
    expect(ids).toContain('new');
  });
});
