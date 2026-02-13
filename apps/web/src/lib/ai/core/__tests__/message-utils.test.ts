import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import {
  extractMessageContent,
  extractToolCalls,
  extractToolResults,
} from '../message-utils';

/** Helper to build a UIMessage with typed parts */
function makeMessage(
  parts: UIMessage['parts'],
  role: 'user' | 'assistant' = 'assistant'
): UIMessage {
  return {
    id: 'test-id',
    role,
    parts,
  };
}

describe('extractMessageContent', () => {
  it('returns empty string when parts is empty', () => {
    const msg = makeMessage([]);
    expect(extractMessageContent(msg)).toBe('');
  });

  it('extracts text from a single text part', () => {
    const msg = makeMessage([{ type: 'text' as const, text: 'Hello world' }]);
    expect(extractMessageContent(msg)).toBe('Hello world');
  });

  it('concatenates multiple text parts', () => {
    const msg = makeMessage([
      { type: 'text' as const, text: 'Hello ' },
      { type: 'text' as const, text: 'world' },
    ]);
    expect(extractMessageContent(msg)).toBe('Hello world');
  });

  it('ignores non-text parts', () => {
    const msg = makeMessage([
      { type: 'text' as const, text: 'content' },
      { type: 'step-start' as const },
    ]);
    expect(extractMessageContent(msg)).toBe('content');
  });

  it('skips whitespace-only text parts', () => {
    const msg = makeMessage([
      { type: 'text' as const, text: 'content' },
      { type: 'text' as const, text: '   ' },
    ]);
    expect(extractMessageContent(msg)).toBe('content');
  });
});

describe('extractToolCalls', () => {
  it('returns empty array when no tool parts', () => {
    const msg = makeMessage([{ type: 'text' as const, text: 'no tools' }]);
    expect(extractToolCalls(msg)).toEqual([]);
  });

  it('returns empty array when parts is missing', () => {
    // @ts-expect-error testing missing parts
    const msg: UIMessage = { id: 'x', role: 'assistant' };
    expect(extractToolCalls(msg)).toEqual([]);
  });
});

describe('extractToolResults', () => {
  it('returns empty array when no tool parts with output', () => {
    const msg = makeMessage([{ type: 'text' as const, text: 'no tools' }]);
    expect(extractToolResults(msg)).toEqual([]);
  });

  it('returns empty array when parts is missing', () => {
    // @ts-expect-error testing missing parts
    const msg: UIMessage = { id: 'x', role: 'assistant' };
    expect(extractToolResults(msg)).toEqual([]);
  });
});
