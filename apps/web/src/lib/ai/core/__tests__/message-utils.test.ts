import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import {
  extractMessageContent,
  extractToolCalls,
  extractToolResults,
  convertDbMessageToUIMessage,
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

  it('given an output-error tool part with errorText, should preserve errorText in the extracted result so a refresh can re-render the error', () => {
    const errorPart = {
      type: 'tool-list_pages',
      toolCallId: 'tc1',
      toolName: 'list_pages',
      state: 'output-error',
      input: { driveId: 'd1' },
      errorText: 'drive permission denied',
    } as unknown as UIMessage['parts'][number];
    const msg = makeMessage([errorPart]);

    expect(extractToolResults(msg)).toEqual([
      {
        toolCallId: 'tc1',
        toolName: 'list_pages',
        state: 'output-error',
        output: undefined,
        errorText: 'drive permission denied',
      },
    ]);
  });
});

describe('convertDbMessageToUIMessage — output-error round-trip', () => {
  it('given a persisted message whose toolResults state is output-error, should reconstruct a tool part with state=output-error and the original errorText', () => {
    const partsOrder = [{ index: 0, type: 'tool-list_pages', toolCallId: 'tc1' }];
    const dbMessage = {
      id: 'msg-err',
      pageId: 'page-1',
      userId: 'user-1',
      role: 'assistant',
      content: JSON.stringify({
        textParts: [],
        partsOrder,
        originalContent: '',
      }),
      toolCalls: JSON.stringify([
        {
          toolCallId: 'tc1',
          toolName: 'list_pages',
          input: { driveId: 'd1' },
          state: 'output-error',
        },
      ]),
      toolResults: JSON.stringify([
        {
          toolCallId: 'tc1',
          toolName: 'list_pages',
          output: undefined,
          state: 'output-error',
          errorText: 'drive permission denied',
        },
      ]),
      createdAt: new Date('2026-01-01T00:00:00Z'),
      isActive: true,
    };

    const reconstructed = convertDbMessageToUIMessage(dbMessage);

    expect(reconstructed.parts).toEqual([
      {
        type: 'tool-list_pages',
        toolCallId: 'tc1',
        toolName: 'list_pages',
        input: { driveId: 'd1' },
        state: 'output-error',
        errorText: 'drive permission denied',
      },
    ]);
  });

  it('given a persisted message whose toolResults state is output-available, should reconstruct a tool part with state=output-available (no regression)', () => {
    const partsOrder = [{ index: 0, type: 'tool-list_pages', toolCallId: 'tc1' }];
    const dbMessage = {
      id: 'msg-ok',
      pageId: 'page-1',
      userId: 'user-1',
      role: 'assistant',
      content: JSON.stringify({ textParts: [], partsOrder, originalContent: '' }),
      toolCalls: JSON.stringify([
        { toolCallId: 'tc1', toolName: 'list_pages', input: { driveId: 'd1' }, state: 'output-available' },
      ]),
      toolResults: JSON.stringify([
        { toolCallId: 'tc1', toolName: 'list_pages', output: { pages: [] }, state: 'output-available' },
      ]),
      createdAt: new Date('2026-01-01T00:00:00Z'),
      isActive: true,
    };

    const reconstructed = convertDbMessageToUIMessage(dbMessage);

    expect(reconstructed.parts).toEqual([
      {
        type: 'tool-list_pages',
        toolCallId: 'tc1',
        toolName: 'list_pages',
        input: { driveId: 'd1' },
        output: { pages: [] },
        state: 'output-available',
      },
    ]);
  });
});
