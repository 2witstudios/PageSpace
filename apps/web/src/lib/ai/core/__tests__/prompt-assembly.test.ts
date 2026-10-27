import { describe, it, expect } from 'vitest';
import type { ModelMessage } from 'ai';
import {
  buildVolatileTurnContext,
  appendTurnContextToLastUserMessage,
  withCacheBreakpoints,
} from '../prompt-assembly';

// ─── buildVolatileTurnContext ─────────────────────────────────────────────────

describe('buildVolatileTurnContext', () => {
  describe('given all three sections are non-empty', () => {
    it('joins them with double newlines', () => {
      const result = buildVolatileTurnContext({
        timestampPrompt: 'TIME',
        mentionPrompt: 'MENTION',
        commandPrompt: 'COMMAND',
      });
      expect(result).toBe('TIME\n\nMENTION\n\nCOMMAND');
    });
  });

  describe('given empty sections', () => {
    it('omits empty fragments', () => {
      expect(
        buildVolatileTurnContext({
          timestampPrompt: 'TIME',
          mentionPrompt: '',
          commandPrompt: '',
        }),
      ).toBe('TIME');
    });

    it('returns empty string when all are empty', () => {
      expect(
        buildVolatileTurnContext({
          timestampPrompt: '',
          mentionPrompt: '',
          commandPrompt: '',
        }),
      ).toBe('');
    });

    it('omits whitespace-only fragments', () => {
      expect(
        buildVolatileTurnContext({
          timestampPrompt: '  ',
          mentionPrompt: 'MENTION',
          commandPrompt: '  \n  ',
        }),
      ).toBe('MENTION');
    });
  });

  describe('determinism', () => {
    it('produces identical output for identical inputs', () => {
      const input = {
        timestampPrompt: 'T',
        mentionPrompt: 'M',
        commandPrompt: 'C',
      };
      expect(buildVolatileTurnContext(input)).toBe(buildVolatileTurnContext(input));
    });
  });

  describe('given locationPrompt', () => {
    it('is included between timestamp and mention when present', () => {
      const result = buildVolatileTurnContext({
        timestampPrompt: 'TIME',
        locationPrompt: 'LOCATION',
        mentionPrompt: 'MENTION',
        commandPrompt: 'COMMAND',
      });
      expect(result).toBe('TIME\n\nLOCATION\n\nMENTION\n\nCOMMAND');
    });

    it('is omitted when undefined (backward compatible — optional field)', () => {
      const result = buildVolatileTurnContext({
        timestampPrompt: 'TIME',
        mentionPrompt: 'MENTION',
        commandPrompt: 'COMMAND',
      });
      expect(result).toBe('TIME\n\nMENTION\n\nCOMMAND');
    });

    it('is omitted when empty/whitespace-only', () => {
      const result = buildVolatileTurnContext({
        timestampPrompt: 'TIME',
        locationPrompt: '   ',
        mentionPrompt: 'MENTION',
        commandPrompt: '',
      });
      expect(result).toBe('TIME\n\nMENTION');
    });
  });
});

// ─── appendTurnContextToLastUserMessage ──────────────────────────────────────

describe('appendTurnContextToLastUserMessage', () => {
  const userMsg = (content: string): ModelMessage => ({
    role: 'user',
    content,
  });

  const assistantMsg = (): ModelMessage => ({
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
  });

  describe('given a non-empty turn context', () => {
    it('appends to string-content user message', () => {
      const messages: ModelMessage[] = [userMsg('hello')];
      const result = appendTurnContextToLastUserMessage(messages, 'CONTEXT');
      expect((result[0] as { content: string }).content).toBe('hello\n\nCONTEXT');
    });

    it('appends as a new text part on parts-content user message', () => {
      const messages: ModelMessage[] = [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
        },
      ];
      const result = appendTurnContextToLastUserMessage(messages, 'CONTEXT');
      const content = (result[0] as { content: unknown[] }).content as Array<{ type: string; text: string }>;
      expect(content).toHaveLength(2);
      expect(content[1]).toEqual({ type: 'text', text: '\n\nCONTEXT' });
    });

    it('targets the LAST user message in a multi-message array', () => {
      const messages: ModelMessage[] = [
        userMsg('first user'),
        assistantMsg(),
        userMsg('last user'),
      ];
      const result = appendTurnContextToLastUserMessage(messages, 'CONTEXT');
      expect((result[0] as { content: string }).content).toBe('first user'); // unchanged
      expect((result[2] as { content: string }).content).toBe('last user\n\nCONTEXT');
    });

    it('returns unchanged array when no user message exists', () => {
      const messages: ModelMessage[] = [assistantMsg()];
      const result = appendTurnContextToLastUserMessage(messages, 'CONTEXT');
      expect(result).toBe(messages); // same reference
    });
  });

  describe('given an empty turn context', () => {
    it('returns the original array unchanged (same reference)', () => {
      const messages: ModelMessage[] = [userMsg('hello')];
      const result = appendTurnContextToLastUserMessage(messages, '');
      expect(result).toBe(messages);
    });

    it('returns unchanged on whitespace-only context', () => {
      const messages: ModelMessage[] = [userMsg('hello')];
      const result = appendTurnContextToLastUserMessage(messages, '   ');
      expect(result).toBe(messages);
    });
  });

  describe('immutability', () => {
    it('does not mutate the original messages array', () => {
      const original: ModelMessage[] = [userMsg('hello')];
      appendTurnContextToLastUserMessage(original, 'CONTEXT');
      expect((original[0] as { content: string }).content).toBe('hello');
    });

    it('returns a new array reference when modified', () => {
      const messages: ModelMessage[] = [userMsg('hello')];
      const result = appendTurnContextToLastUserMessage(messages, 'CONTEXT');
      expect(result).not.toBe(messages);
    });
  });

  describe('volatile block must not be present before last user message', () => {
    it('only modifies the last user message, not earlier ones', () => {
      const messages: ModelMessage[] = [
        userMsg('turn 1'),
        assistantMsg(),
        userMsg('turn 2'),
        assistantMsg(),
        userMsg('turn 3'),
      ];
      const result = appendTurnContextToLastUserMessage(messages, 'CONTEXT');
      expect((result[0] as { content: string }).content).toBe('turn 1');
      expect((result[2] as { content: string }).content).toBe('turn 2');
      expect((result[4] as { content: string }).content).toBe('turn 3\n\nCONTEXT');
    });
  });
});

// ─── withCacheBreakpoints ────────────────────────────────────────────────────

type MsgWithOptions = ModelMessage & {
  providerOptions?: { openrouter?: { cacheControl?: { type: string } } };
};

function getCache(msg: ModelMessage): { type: string } | undefined {
  return (msg as MsgWithOptions).providerOptions?.openrouter?.cacheControl;
}

describe('withCacheBreakpoints', () => {
  const msg = (role: ModelMessage['role']): ModelMessage => ({ role, content: 'x' } as ModelMessage);

  describe('given a non-empty messages array', () => {
    it('marks the last message with ephemeral cache', () => {
      const messages: ModelMessage[] = [msg('user'), msg('assistant'), msg('user')];
      const result = withCacheBreakpoints(messages, 0);
      expect(getCache(result[2])).toEqual({ type: 'ephemeral' });
    });

    it('marks the stable boundary message when stableBoundaryIndex >= 1', () => {
      const messages: ModelMessage[] = [
        msg('user'),
        msg('assistant'),
        msg('user'),
        msg('assistant'),
        msg('user'),
      ];
      const result = withCacheBreakpoints(messages, 2);
      expect(getCache(result[2])).toEqual({ type: 'ephemeral' });
      expect(getCache(result[4])).toEqual({ type: 'ephemeral' }); // last
    });

    it('does not mark boundary when stableBoundaryIndex is 0', () => {
      const messages: ModelMessage[] = [msg('user'), msg('assistant'), msg('user')];
      const result = withCacheBreakpoints(messages, 0);
      expect(getCache(result[0])).toBeUndefined();
    });

    it('does not mark boundary when stableBoundaryIndex equals last index', () => {
      const messages: ModelMessage[] = [msg('user'), msg('assistant'), msg('user')];
      // boundary = 2 = lastIdx → no separate B mark (already marked as A)
      const result = withCacheBreakpoints(messages, 2);
      expect(getCache(result[2])).toEqual({ type: 'ephemeral' });
      // only one breakpoint added (no duplicate)
      const markedCount = result.filter(m => getCache(m) !== undefined).length;
      expect(markedCount).toBe(1);
    });
  });

  describe('given an empty messages array', () => {
    it('returns empty array unchanged', () => {
      const result = withCacheBreakpoints([], 0);
      expect(result).toHaveLength(0);
    });
  });

  describe('immutability', () => {
    it('does not mutate the original messages array', () => {
      const messages: ModelMessage[] = [msg('user'), msg('assistant')];
      withCacheBreakpoints(messages, 0);
      expect(getCache(messages[1])).toBeUndefined();
    });

    it('returns a new array reference', () => {
      const messages: ModelMessage[] = [msg('user')];
      const result = withCacheBreakpoints(messages, 0);
      expect(result).not.toBe(messages);
    });
  });

  describe('preserves existing providerOptions', () => {
    it('merges with existing openrouter options', () => {
      const msgWithOptions: ModelMessage = {
        role: 'user',
        content: 'x',
        providerOptions: { openrouter: { user: 'u123' } },
      } as ModelMessage;
      const result = withCacheBreakpoints([msgWithOptions], 0);
      const opts = (result[0] as MsgWithOptions).providerOptions?.openrouter;
      expect(opts?.cacheControl).toEqual({ type: 'ephemeral' });
      expect((opts as Record<string, unknown>)?.user).toBe('u123');
    });
  });
});

// ─── Non-persistence assertion ────────────────────────────────────────────────

describe('volatile block persistence guard', () => {
  it('appendTurnContextToLastUserMessage must not return a message with "persisted" in content (sentinel)', () => {
    // This test documents the contract that the volatile block must never be
    // called before DB persistence — it is assembly-time only.
    const messages: ModelMessage[] = [{ role: 'user', content: 'hello' }];
    const result = appendTurnContextToLastUserMessage(messages, 'VOLATILE');
    // result has the volatile block — if persisted, DB would see it.
    // This test asserts the calling convention: result contains the block
    // and MUST be passed only to streamText, never to saveMessageToDatabase.
    const content = (result[0] as { content: string }).content;
    expect(content).toContain('VOLATILE');
    // The original (pre-assembly) message does NOT contain the block
    expect((messages[0] as { content: string }).content).not.toContain('VOLATILE');
  });
});
