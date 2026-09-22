import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import {
  extractMessageContent,
  extractToolCalls,
  extractToolResults,
  convertDbMessageToUIMessage,
  sanitizeMessagesForModel,
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
  it('given a persisted message whose toolResults state is output-error, should reconstruct a tool part with state=output-error and the original errorText', async () => {
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

    const reconstructed = await convertDbMessageToUIMessage(dbMessage);

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

  it('given a persisted message whose toolResults state is output-available, should reconstruct a tool part with state=output-available (no regression)', async () => {
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

    const reconstructed = await convertDbMessageToUIMessage(dbMessage);

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

describe('sanitizeMessagesForModel', () => {
  it('drops system-role messages (system prompt belongs in the system: option)', () => {
    const messages: UIMessage[] = [
      { id: 's1', role: 'system', parts: [{ type: 'text' as const, text: 'You are a helpful assistant' }] },
      makeMessage([{ type: 'text' as const, text: 'Hi' }], 'user'),
      makeMessage([{ type: 'text' as const, text: 'Hello!' }], 'assistant'),
    ];

    const result = sanitizeMessagesForModel(messages);

    expect(result.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(result.some(m => m.role === 'system')).toBe(false);
  });

  it('preserves user/assistant messages while still filtering tool parts without results', () => {
    const messages: UIMessage[] = [
      makeMessage(
        [
          { type: 'text' as const, text: 'done' },
          // tool part lacking output should be dropped
          {
            type: 'tool-list_pages',
            toolCallId: 'tc1',
            input: { driveId: 'd1' },
            state: 'input-available',
          },
        ],
        'assistant'
      ),
    ];

    const result = sanitizeMessagesForModel(messages);

    expect(result).toHaveLength(1);
    expect(result[0].parts).toEqual([{ type: 'text', text: 'done' }]);
  });
});

/**
 * The transport a row was authored over has to survive the trip to the UI, or
 * the mic glyph has nothing to read. `unifiedColumns` already SELECTs
 * `messages.source`; this is the step where it either reaches the renderer or
 * is silently dropped on the floor.
 */
describe('convertDbMessageToUIMessage — the authoring transport', () => {
  const row = (source: string | null, content: string) => ({
    id: 'm1',
    pageId: 'p1',
    userId: 'u1',
    role: 'user',
    content,
    toolCalls: null,
    toolResults: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    isActive: true,
    source,
  });

  it('should carry a spoken turn\'s source through to the UI message', async () => {
    const converted = await convertDbMessageToUIMessage(row('voice', 'what is on this page'));
    expect((converted as { source?: string | null }).source).toBe('voice');
  });

  it('should carry it through the STRUCTURED-content path too', async () => {
    // Two code paths reconstruct a message; a field added to only one of them
    // makes the glyph appear or vanish depending on whether the turn happened
    // to have attachments or tool calls.
    const structured = JSON.stringify({
      textParts: ['what is on this page'],
      partsOrder: [{ index: 0, type: 'text' }],
      originalContent: 'what is on this page',
    });
    const converted = await convertDbMessageToUIMessage(row('voice', structured));
    expect((converted as { source?: string | null }).source).toBe('voice');
  });

  it('should report a typed turn as null rather than undefined', async () => {
    const converted = await convertDbMessageToUIMessage(row(null, 'typed'));
    expect((converted as { source?: string | null }).source).toBeNull();
  });
});

// ─── Tool approval states (human-in-the-loop) ─────────────────────────────────

describe('tool approval states — extract', () => {
  it('given a tool part carrying an approval record, extractToolCalls should persist it on the call row', () => {
    const msg = makeMessage([
      {
        type: 'tool-trash_page',
        toolCallId: 'tc1',
        toolName: 'trash_page',
        input: { pageId: 'p1' },
        state: 'approval-requested',
        approval: { id: 'ap1' },
      } as unknown as UIMessage['parts'][number],
    ]);
    expect(extractToolCalls(msg)).toEqual([
      { toolCallId: 'tc1', toolName: 'trash_page', input: { pageId: 'p1' }, state: 'approval-requested', approval: { id: 'ap1' } },
    ]);
  });

  it('given an output-denied part, extractToolResults should keep it as a result with no output', () => {
    const msg = makeMessage([
      {
        type: 'tool-trash_page',
        toolCallId: 'tc1',
        toolName: 'trash_page',
        input: { pageId: 'p1' },
        state: 'output-denied',
        approval: { id: 'ap1', approved: false, reason: 'no' },
      } as unknown as UIMessage['parts'][number],
    ]);
    expect(extractToolResults(msg)).toEqual([
      { toolCallId: 'tc1', toolName: 'trash_page', output: undefined, state: 'output-denied' },
    ]);
  });

  it('given approval-requested / approval-responded parts, extractToolResults should produce no result row (they are not terminal)', () => {
    const msg = makeMessage([
      { type: 'tool-a', toolCallId: 'tc1', toolName: 'a', input: {}, state: 'approval-requested', approval: { id: 'ap1' } },
      { type: 'tool-b', toolCallId: 'tc2', toolName: 'b', input: {}, state: 'approval-responded', approval: { id: 'ap2', approved: true } },
    ] as unknown as UIMessage['parts']);
    expect(extractToolResults(msg)).toEqual([]);
  });
});

describe('tool approval states — round trip through the DB shape', () => {
  const row = (calls: unknown[], results: unknown[]) => ({
    id: 'msg-ap',
    pageId: 'page-1',
    userId: 'user-1',
    role: 'assistant',
    content: JSON.stringify({ textParts: [], partsOrder: [{ index: 0, type: 'tool-trash_page', toolCallId: 'tc1' }], originalContent: '' }),
    toolCalls: JSON.stringify(calls),
    toolResults: JSON.stringify(results),
    createdAt: new Date('2026-01-01T00:00:00Z'),
    isActive: true,
  });

  it('given a call row in approval-requested with no result row, should reconstruct approval-requested with its approval id (not input-available)', async () => {
    const msg = makeMessage([
      { type: 'tool-trash_page', toolCallId: 'tc1', toolName: 'trash_page', input: { pageId: 'p1' }, state: 'approval-requested', approval: { id: 'ap1' } },
    ] as unknown as UIMessage['parts']);
    const reconstructed = await convertDbMessageToUIMessage(row(extractToolCalls(msg), extractToolResults(msg)));
    expect(reconstructed.parts).toEqual([
      { type: 'tool-trash_page', toolCallId: 'tc1', toolName: 'trash_page', input: { pageId: 'p1' }, state: 'approval-requested', approval: { id: 'ap1' } },
    ]);
  });

  it('given a call row in approval-responded, should reconstruct approval-responded with the answer', async () => {
    const msg = makeMessage([
      { type: 'tool-trash_page', toolCallId: 'tc1', toolName: 'trash_page', input: { pageId: 'p1' }, state: 'approval-responded', approval: { id: 'ap1', approved: true } },
    ] as unknown as UIMessage['parts']);
    const reconstructed = await convertDbMessageToUIMessage(row(extractToolCalls(msg), extractToolResults(msg)));
    expect(reconstructed.parts).toEqual([
      { type: 'tool-trash_page', toolCallId: 'tc1', toolName: 'trash_page', input: { pageId: 'p1' }, state: 'approval-responded', approval: { id: 'ap1', approved: true } },
    ]);
  });

  it('given an output-denied part, should reconstruct output-denied with the approval reason and no output', async () => {
    const msg = makeMessage([
      { type: 'tool-trash_page', toolCallId: 'tc1', toolName: 'trash_page', input: { pageId: 'p1' }, state: 'output-denied', approval: { id: 'ap1', approved: false, reason: 'nope' } },
    ] as unknown as UIMessage['parts']);
    const reconstructed = await convertDbMessageToUIMessage(row(extractToolCalls(msg), extractToolResults(msg)));
    expect(reconstructed.parts).toEqual([
      { type: 'tool-trash_page', toolCallId: 'tc1', toolName: 'trash_page', input: { pageId: 'p1' }, state: 'output-denied', approval: { id: 'ap1', approved: false, reason: 'nope' } },
    ]);
  });

  it('given an approved call that was then executed (output-available + approval), should reconstruct both the output and the approval', async () => {
    const msg = makeMessage([
      { type: 'tool-trash_page', toolCallId: 'tc1', toolName: 'trash_page', input: { pageId: 'p1' }, state: 'output-available', output: { ok: true }, approval: { id: 'ap1', approved: true } },
    ] as unknown as UIMessage['parts']);
    const reconstructed = await convertDbMessageToUIMessage(row(extractToolCalls(msg), extractToolResults(msg)));
    expect(reconstructed.parts).toEqual([
      { type: 'tool-trash_page', toolCallId: 'tc1', toolName: 'trash_page', input: { pageId: 'p1' }, state: 'output-available', output: { ok: true }, approval: { id: 'ap1', approved: true } },
    ]);
  });

  it('given an approved call that then FAILED (output-error + approval), should reconstruct the error AND the approval, and the sanitizer should keep it for the model', async () => {
    const msg = makeMessage([
      { type: 'tool-trash_page', toolCallId: 'tc1', toolName: 'trash_page', input: { pageId: 'p1' }, state: 'output-error', errorText: 'refused at execution time', approval: { id: 'ap1', approved: true } },
    ] as unknown as UIMessage['parts']);
    const reconstructed = await convertDbMessageToUIMessage(row(extractToolCalls(msg), extractToolResults(msg)));
    expect(reconstructed.parts).toEqual([
      { type: 'tool-trash_page', toolCallId: 'tc1', toolName: 'trash_page', input: { pageId: 'p1' }, state: 'output-error', errorText: 'refused at execution time', approval: { id: 'ap1', approved: true } },
    ]);
    const [sanitized] = sanitizeMessagesForModel([reconstructed]);
    expect(sanitized.parts.map((p) => (p as { state?: string }).state)).toEqual(['output-error']);
  });

  it('given a malformed approval record on the call row, should drop it rather than reconstruct garbage', async () => {
    const reconstructed = await convertDbMessageToUIMessage(
      row([{ toolCallId: 'tc1', toolName: 'trash_page', input: {}, state: 'approval-requested', approval: { nope: 1 } }], []),
    );
    expect(reconstructed.parts).toEqual([
      { type: 'tool-trash_page', toolCallId: 'tc1', toolName: 'trash_page', input: {}, state: 'approval-requested' },
    ]);
  });
});

describe('sanitizeMessagesForModel — approval states', () => {
  const part = (state: string, extra: Record<string, unknown> = {}) =>
    ({ type: 'tool-trash_page', toolCallId: `tc-${state}`, toolName: 'trash_page', input: {}, state, ...extra }) as unknown as UIMessage['parts'][number];

  it('keeps output-denied (a result the model can read) and drops approval-requested / approval-responded (no result yet)', () => {
    const [out] = sanitizeMessagesForModel([
      makeMessage([
        part('output-denied', { approval: { id: 'a', approved: false } }),
        part('approval-requested', { approval: { id: 'b' } }),
        part('approval-responded', { approval: { id: 'c', approved: true } }),
        part('output-available', { output: { ok: true } }),
      ]),
    ]);
    expect(out.parts.map((p) => (p as { state?: string }).state)).toEqual(['output-denied', 'output-available']);
  });

  it('keeps an output-error that carries an approval (an approved call that failed) so the model sees the failure instead of retrying under a grant; a plain output-error is dropped as before', () => {
    const [out] = sanitizeMessagesForModel([
      makeMessage([
        { ...part('output-error', { errorText: 'refused at execution time', approval: { id: 'a', approved: true } }), toolCallId: 'tc-approved-error' } as unknown as UIMessage['parts'][number],
        { ...part('output-error', { errorText: 'ordinary failure' }), toolCallId: 'tc-plain-error' } as unknown as UIMessage['parts'][number],
      ]),
    ]);
    expect(out.parts.map((p) => (p as { toolCallId?: string }).toolCallId)).toEqual(['tc-approved-error']);
  });
});
