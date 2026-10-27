import { describe, it, expect } from 'vitest';
import { normalizeMessageParts } from '../normalize-parts';

// Fixtures matching real persisted shapes from reconstructFromStructuredContent
// (message-utils.ts) — each tool call is a single part carrying state+input+output.

const userMsg = (text: string) => ({
  role: 'user' as const,
  parts: [{ type: 'text', text }],
});

const sdkCallPart = (toolName: string, id: string, input: unknown) => ({
  type: `tool-${toolName}`,
  toolCallId: id,
  toolName,
  input,
  state: 'input-available',
});

const sdkResultPart = (toolName: string, id: string, input: unknown, output: unknown) => ({
  type: `tool-${toolName}`,
  toolCallId: id,
  toolName,
  input,
  output,
  state: 'output-available',
});

const sdkErrorPart = (toolName: string, id: string, input: unknown, errorText: string) => ({
  type: `tool-${toolName}`,
  toolCallId: id,
  toolName,
  input,
  errorText,
  state: 'output-error',
});

describe('normalizeMessageParts — pass-through cases', () => {
  it('returns empty messages unchanged', () => {
    const msgs = [{ role: 'user', parts: [] }];
    expect(normalizeMessageParts(msgs)).toBe(msgs);
  });

  it('passes text parts through unchanged', () => {
    const msgs = [userMsg('hello')];
    expect(normalizeMessageParts(msgs)).toBe(msgs);
  });

  it('passes already-canonical tool-call parts through', () => {
    const msgs = [
      {
        role: 'assistant' as const,
        parts: [
          { type: 'tool-call', toolCallId: 'tc1', toolName: 'read_page', args: { pageId: 'p1' } },
          { type: 'tool-result', toolCallId: 'tc1', toolName: 'read_page', result: 'page content' },
        ],
      },
    ];
    expect(normalizeMessageParts(msgs)).toBe(msgs);
  });

  it('passes step-start, file, and non-tool parts through', () => {
    const msgs = [
      {
        role: 'assistant' as const,
        parts: [
          { type: 'step-start' },
          { type: 'file', url: 'https://example.com/f' },
          { type: 'text', text: 'answer' },
        ],
      },
    ];
    expect(normalizeMessageParts(msgs)).toBe(msgs);
  });
});

describe('normalizeMessageParts — SDK-dialect conversion', () => {
  it('converts input-available SDK part to a single tool-call', () => {
    const msgs = [
      {
        role: 'assistant' as const,
        parts: [sdkCallPart('read_page', 'tc1', { pageId: 'p1' })],
      },
    ];
    const result = normalizeMessageParts(msgs);
    expect(result[0].parts).toHaveLength(1);
    expect(result[0].parts![0]).toMatchObject({
      type: 'tool-call',
      toolCallId: 'tc1',
      toolName: 'read_page',
      args: { pageId: 'p1' },
    });
  });

  it('converts output-available SDK part to tool-call + tool-result pair', () => {
    const msgs = [
      {
        role: 'assistant' as const,
        parts: [sdkResultPart('read_page', 'tc1', { pageId: 'p1' }, 'page body text')],
      },
    ];
    const result = normalizeMessageParts(msgs);
    expect(result[0].parts).toHaveLength(2);
    expect(result[0].parts![0]).toMatchObject({ type: 'tool-call', toolName: 'read_page', args: { pageId: 'p1' } });
    expect(result[0].parts![1]).toMatchObject({ type: 'tool-result', toolName: 'read_page', result: 'page body text' });
  });

  it('converts output-error SDK part to tool-call + tool-result (errorText as result)', () => {
    const msgs = [
      {
        role: 'assistant' as const,
        parts: [sdkErrorPart('read_page', 'tc1', { pageId: 'p1' }, 'Not found')],
      },
    ];
    const result = normalizeMessageParts(msgs);
    expect(result[0].parts).toHaveLength(2);
    expect(result[0].parts![0]).toMatchObject({ type: 'tool-call', toolName: 'read_page' });
    expect(result[0].parts![1]).toMatchObject({ type: 'tool-result', result: 'Not found' });
  });

  it('drops input-streaming parts (incomplete tool call)', () => {
    const msgs = [
      {
        role: 'assistant' as const,
        parts: [
          { type: 'tool-read_page', toolCallId: 'tc1', toolName: 'read_page', state: 'input-streaming' },
          { type: 'text', text: 'answer' },
        ],
      },
    ];
    const result = normalizeMessageParts(msgs);
    expect(result[0].parts).toHaveLength(1);
    expect(result[0].parts![0].type).toBe('text');
  });

  it('extracts tool name from type when toolName field is absent', () => {
    const msgs = [
      {
        role: 'assistant' as const,
        parts: [
          {
            type: 'tool-regex_search',
            toolCallId: 'tc1',
            input: { query: 'test' },
            output: 'results',
            state: 'output-available',
          },
        ],
      },
    ];
    const result = normalizeMessageParts(msgs);
    expect(result[0].parts![0]).toMatchObject({ type: 'tool-call', toolName: 'regex_search' });
    expect(result[0].parts![1]).toMatchObject({ type: 'tool-result', toolName: 'regex_search' });
  });

  it('preserves toolCallId on both emitted parts', () => {
    const msgs = [
      {
        role: 'assistant' as const,
        parts: [sdkResultPart('list_pages', 'unique-id-99', {}, ['page1', 'page2'])],
      },
    ];
    const result = normalizeMessageParts(msgs);
    expect(result[0].parts![0].toolCallId).toBe('unique-id-99');
    expect(result[0].parts![1].toolCallId).toBe('unique-id-99');
  });
});

describe('normalizeMessageParts — mixed message arrays', () => {
  it('normalizes only assistant messages; user messages pass through', () => {
    const msgs = [
      userMsg('call read_page for me'),
      {
        role: 'assistant' as const,
        parts: [sdkResultPart('read_page', 'tc1', { pageId: 'p1' }, 'content'), { type: 'text', text: 'done' }],
      },
    ];
    const result = normalizeMessageParts(msgs);
    expect(result[0]).toBe(msgs[0]); // unchanged reference
    expect(result[1].parts).toHaveLength(3); // tool-call + tool-result + text
    expect(result[1].parts![0].type).toBe('tool-call');
    expect(result[1].parts![1].type).toBe('tool-result');
    expect(result[1].parts![2].type).toBe('text');
  });

  it('handles multiple tool invocations in one assistant message', () => {
    const msgs = [
      {
        role: 'assistant' as const,
        parts: [
          sdkResultPart('read_page', 'tc1', { pageId: 'p1' }, 'page1 content'),
          sdkResultPart('list_pages', 'tc2', { driveId: 'd1' }, ['a', 'b']),
          { type: 'text', text: 'here is what I found' },
        ],
      },
    ];
    const result = normalizeMessageParts(msgs);
    expect(result[0].parts).toHaveLength(5); // 2×(call+result) + text
    expect(result[0].parts![0]).toMatchObject({ type: 'tool-call', toolName: 'read_page' });
    expect(result[0].parts![1]).toMatchObject({ type: 'tool-result', toolName: 'read_page' });
    expect(result[0].parts![2]).toMatchObject({ type: 'tool-call', toolName: 'list_pages' });
    expect(result[0].parts![3]).toMatchObject({ type: 'tool-result', toolName: 'list_pages' });
    expect(result[0].parts![4]).toMatchObject({ type: 'text' });
  });

  it('leaves messages without tool parts as same reference', () => {
    const msgs = [userMsg('no tools here')];
    expect(normalizeMessageParts(msgs)[0]).toBe(msgs[0]);
  });
});
