import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UIMessage } from 'ai';

// Passthrough sanitize: the seam's step-1 behavior is owned by message-utils'
// own tests; here we isolate the seam logic (summary split, boundary, elision).
vi.mock('@/lib/ai/core/message-utils', () => ({
  sanitizeMessagesForModel: vi.fn((msgs: unknown[]) => msgs),
}));
vi.mock('@/lib/ai/core/compaction/prepare-context', () => ({
  prepareConversationContext: vi.fn(),
}));
// Avoid dragging the full tool registry into the test graph.
vi.mock('@/lib/ai/core/tool-filtering', () => ({
  filterToolsForAgentAllowlist: vi.fn((tools: unknown) => tools),
  WRITE_TOOLS: new Set(['create_page', 'replace_lines']),
}));
// convertToModelMessages: identity — returns the messages array unchanged so tests
// can assert on the shape without pulling in the real AI SDK conversion.
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    convertToModelMessages: vi.fn((msgs: unknown) => msgs),
  };
});

import { prepareConversationContext } from '@/lib/ai/core/compaction/prepare-context';
import { prepareHistoryForModel, finishModelRequest } from '../context-assembly';

const mockPrepare = vi.mocked(prepareConversationContext);

const BIG_OUTPUT = 'r'.repeat(2000); // above the 1000-char elision floor

function userMsg(id: string, text: string): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] } as unknown as UIMessage;
}

function assistantReadMsg(id: string): UIMessage {
  return {
    id,
    role: 'assistant',
    parts: [
      {
        type: 'tool-read_page',
        toolCallId: `call-${id}`,
        input: { pageId: 'p1' },
        output: BIG_OUTPUT,
        state: 'output-available',
      },
      { type: 'text', text: `answer ${id}` },
    ],
  } as unknown as UIMessage;
}

function summaryMsg(): UIMessage {
  return {
    role: 'user',
    parts: [
      {
        type: 'text',
        text: '<conversation_summary>\nold turns condensed\n</conversation_summary>\n\nEarlier conversation history has been condensed above.',
      },
    ],
  } as unknown as UIMessage;
}

/** N user/assistant pairs; every assistant turn carries a big elidable read_page output. */
function pairs(n: number): UIMessage[] {
  const out: UIMessage[] = [];
  for (let i = 0; i < n; i++) {
    out.push(userMsg(`u${i}`, `question ${i}`), assistantReadMsg(`a${i}`));
  }
  return out;
}

function toolOutputOf(msg: UIMessage): unknown {
  const part = (msg as unknown as { parts: Array<{ type: string; output?: unknown }> }).parts.find(
    (p) => p.type === 'tool-read_page'
  );
  return part?.output;
}

const baseParams = {
  conversationId: 'conv-1',
  source: 'page' as const,
  pageId: 'page-1',
  model: 'm',
  provider: 'openrouter',
  user: { id: 'u1', role: 'admin' as string | null },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPrepare.mockImplementation(async ({ messages }) => ({
    messages,
    scheduleCompaction: vi.fn(),
    pendingCompaction: null,
  }));
});

describe('prepareHistoryForModel — summary detection', () => {
  it('splits a synthetic summary into summaryText and sets stableBoundaryIndex=1', async () => {
    const tail = pairs(2);
    mockPrepare.mockResolvedValueOnce({
      messages: [summaryMsg(), ...tail] as never,
      scheduleCompaction: vi.fn(),
      pendingCompaction: null,
    });

    const result = await prepareHistoryForModel({ ...baseParams, history: tail });

    expect(result.summaryText).toContain('<conversation_summary>');
    expect(result.stableBoundaryIndex).toBe(1);
    expect(result.messages.map((m) => m.id)).toEqual(tail.map((m) => m.id));
  });

  it('does NOT treat an id-less ordinary first message as a summary (v1 false-positive guard)', async () => {
    const clientMsg = { role: 'user', parts: [{ type: 'text', text: 'hello from v1 client' }] } as unknown as UIMessage;
    mockPrepare.mockResolvedValueOnce({
      messages: [clientMsg, ...pairs(1)] as never,
      scheduleCompaction: vi.fn(),
      pendingCompaction: null,
    });

    const result = await prepareHistoryForModel({ ...baseParams, history: pairs(1) });

    expect(result.summaryText).toBe('');
    expect(result.stableBoundaryIndex).toBe(0);
    expect(result.messages).toHaveLength(3); // client msg retained as tail
  });
});

describe('prepareHistoryForModel — elision/compaction coincidence', () => {
  it('elides stale outputs on the tail even when a summary exists', async () => {
    // 20 assistant turns: chunkSize=8, keepLastTurns=4 → boundary = floor(20/8)*8 - 4 = 12.
    // Turns 0-11 must be elided; turns 12-19 must remain intact.
    // The summary covers the HEAD — the tail still needs elision.
    const tail = pairs(20);
    mockPrepare.mockResolvedValueOnce({
      messages: [summaryMsg(), ...tail] as never,
      scheduleCompaction: vi.fn(),
      pendingCompaction: null,
    });

    const result = await prepareHistoryForModel({ ...baseParams, history: tail });

    const assistants = result.messages.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(20);
    // First 12 assistant turns must be elided
    for (let i = 0; i < 12; i++) {
      expect(toolOutputOf(assistants[i])).toContain('[output elided to save context');
    }
    // Last 8 assistant turns must be intact
    for (let i = 12; i < 20; i++) {
      expect(toolOutputOf(assistants[i])).toBe(BIG_OUTPUT);
    }
  });

  it('applies chunk-aligned elision when no summary exists', async () => {
    // 13 assistant turns, chunkSize 8, keepLastTurns 4 → boundary floor(13/8)*8-4 = 4:
    // assistant turns 0–3 elided, 4+ intact.
    const history = pairs(13);

    const result = await prepareHistoryForModel({ ...baseParams, history });

    const assistants = result.messages.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(13);
    for (let i = 0; i < 4; i++) {
      expect(toolOutputOf(assistants[i])).toContain('[output elided to save context');
    }
    for (let i = 4; i < 13; i++) {
      expect(toolOutputOf(assistants[i])).toBe(BIG_OUTPUT);
    }
    expect(result.stableBoundaryIndex).toBe(0);
  });

  it('elides nothing for short conversations (below one chunk)', async () => {
    const history = pairs(7); // floor(7/8)*8 = 0 → boundary 0

    const result = await prepareHistoryForModel({ ...baseParams, history });

    for (const m of result.messages.filter((m) => m.role === 'assistant')) {
      expect(toolOutputOf(m)).toBe(BIG_OUTPUT);
    }
  });
});

describe('prepareHistoryForModel — metadata passthrough', () => {
  it('forwards scheduleCompaction and pendingCompaction from the compaction step', async () => {
    const scheduleCompaction = vi.fn();
    const pendingCompaction = { conversationId: 'conv-1' } as never;
    mockPrepare.mockResolvedValueOnce({
      messages: pairs(1) as never,
      scheduleCompaction,
      pendingCompaction,
    });

    const result = await prepareHistoryForModel({ ...baseParams, history: pairs(1) });

    expect(result.scheduleCompaction).toBe(scheduleCompaction);
    expect(result.pendingCompaction).toBe(pendingCompaction);
  });
});

describe('finishModelRequest', () => {
  const tail = [userMsg('u0', 'hello'), assistantReadMsg('a0')];

  it('no summary — returns tail as modelMessages, stableBoundaryIndex=0', async () => {
    const prepared = { summaryText: '', messages: tail, stableBoundaryIndex: 0 };
    const { modelMessages, stableBoundaryIndex } = await finishModelRequest({ prepared, tools: {} as never });

    expect(stableBoundaryIndex).toBe(0);
    // convertToModelMessages is mocked as identity — messages flow through unchanged
    expect(modelMessages).toEqual(tail);
  });

  it('with summary — prepends summary message and stableBoundaryIndex=1', async () => {
    const prepared = {
      summaryText: 'summary text here',
      messages: tail,
      stableBoundaryIndex: 1,
    };
    const { modelMessages, stableBoundaryIndex } = await finishModelRequest({ prepared, tools: {} as never });

    expect(stableBoundaryIndex).toBe(1);
    expect(modelMessages[0]).toEqual({ role: 'user', content: 'summary text here' });
    expect(modelMessages.slice(1)).toEqual(tail);
    expect(modelMessages).toHaveLength(tail.length + 1);
  });

  it('tail override — converts the provided tail instead of prepared.messages', async () => {
    const overrideTail = [userMsg('u99', 'override')] as unknown as Parameters<typeof import('ai').convertToModelMessages>[0];
    const prepared = { summaryText: '', messages: tail, stableBoundaryIndex: 0 };
    const { modelMessages } = await finishModelRequest({ prepared, tail: overrideTail, tools: {} as never });

    expect(modelMessages).toEqual(overrideTail);
  });

  it('tools identity — the tools param is passed through to convertToModelMessages', async () => {
    const { convertToModelMessages } = await import('ai');
    const mockConvert = vi.mocked(convertToModelMessages);
    const myTools = { tool_a: {} } as never;
    const prepared = { summaryText: '', messages: tail, stableBoundaryIndex: 0 };

    await finishModelRequest({ prepared, tools: myTools });

    expect(mockConvert).toHaveBeenCalledWith(
      expect.anything(),
      { tools: myTools }
    );
  });

  it('empty tools — convertToModelMessages called with { tools: {} }', async () => {
    const { convertToModelMessages } = await import('ai');
    const mockConvert = vi.mocked(convertToModelMessages);
    mockConvert.mockClear();
    const prepared = { summaryText: '', messages: tail, stableBoundaryIndex: 0 };

    await finishModelRequest({ prepared, tools: {} as never });

    expect(mockConvert).toHaveBeenCalledWith(expect.anything(), { tools: {} });
  });
});
