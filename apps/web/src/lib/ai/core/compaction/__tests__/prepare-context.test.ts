import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../compaction-repository', () => ({
  getState: vi.fn(),
}));
vi.mock('../compaction-service', () => ({
  runCompaction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('next/server', () => ({
  after: vi.fn(),
}));

import { after } from 'next/server';
import { getState } from '../compaction-repository';
import { runCompaction } from '../compaction-service';
import { prepareConversationContext } from '../prepare-context';
import { isSyntheticSummaryMessage, type CompactionMessage } from '@pagespace/lib/ai/context-window';

const mockGetState = vi.mocked(getState);
const mockAfter = vi.mocked(after);

function msg(id: string, role: 'user' | 'assistant', text: string, at: string): CompactionMessage {
  return { id, role, parts: [{ type: 'text', text }], createdAt: new Date(at) };
}

/** Small alternating history, well under any threshold. */
function smallHistory(): CompactionMessage[] {
  return [
    msg('m1', 'user', 'hello', '2024-01-01T00:00:01Z'),
    msg('m2', 'assistant', 'hi', '2024-01-01T00:00:02Z'),
    msg('m3', 'user', 'next question', '2024-01-01T00:00:03Z'),
    msg('m4', 'assistant', 'next answer', '2024-01-01T00:00:04Z'),
  ];
}

/** Big alternating history that exceeds 75% of the default 200k window. */
function hugeHistory(): CompactionMessage[] {
  const big = 'x'.repeat(80_000); // ≈20k tokens per message
  const out: CompactionMessage[] = [];
  for (let i = 0; i < 10; i++) {
    out.push(
      msg(`m${i}`, i % 2 === 0 ? 'user' : 'assistant', big, `2024-01-01T00:00:${String(i).padStart(2, '0')}Z`)
    );
  }
  return out;
}

const baseParams = {
  conversationId: 'conv-1',
  source: 'page' as const,
  pageId: 'page-1',
  model: 'some-unknown-model',
  provider: 'openrouter',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetState.mockResolvedValue(null);
});

describe('prepareConversationContext — authenticated gate', () => {
  it('authenticated non-admin users run through the compaction path (under threshold: messages unchanged)', async () => {
    const messages = smallHistory();

    const result = await prepareConversationContext({
      ...baseParams,
      messages,
      user: { id: 'u1', role: 'user' },
    });

    expect(result.messages).toEqual(messages); // same content; gate is open so a new array is returned
    expect(result.pendingCompaction).toBeNull();
    expect(mockGetState).toHaveBeenCalled(); // DB is read (gate is open for all authenticated users)
    result.scheduleCompaction();
    expect(mockAfter).not.toHaveBeenCalled(); // no compaction needed (under threshold)
  });

  it('null user is treated as unauthenticated (fail closed — exact passthrough, no DB reads)', async () => {
    const messages = smallHistory();

    const result = await prepareConversationContext({
      ...baseParams,
      messages,
      user: null,
    });

    expect(result.messages).toBe(messages); // exact same reference — true passthrough
    expect(mockGetState).not.toHaveBeenCalled();
  });
});

describe('prepareConversationContext — admin path', () => {
  it('under threshold with no stored state: messages unchanged, no compaction planned', async () => {
    const messages = smallHistory();

    const result = await prepareConversationContext({
      ...baseParams,
      messages,
      user: { id: 'u1', role: 'admin' },
    });

    expect(result.messages).toEqual(messages);
    expect(result.pendingCompaction).toBeNull();
    result.scheduleCompaction();
    expect(mockAfter).not.toHaveBeenCalled();
  });

  it('with stored state: synthetic summary message is prepended and pre-pointer messages are cut', async () => {
    const messages = smallHistory();
    mockGetState.mockResolvedValueOnce({
      conversationId: 'conv-1',
      source: 'page',
      pageId: 'page-1',
      summary: 'Earlier the user asked about X.',
      summaryTokens: 10,
      compactedUpToMessageId: 'm2',
      compactedUpToCreatedAt: new Date('2024-01-01T00:00:02Z'),
      summaryVersion: 1,
      summarizerModel: 'openai/gpt-test',
      lastCompactedAt: new Date('2024-01-01T01:00:00Z'),
      createdAt: new Date('2024-01-01T01:00:00Z'),
      updatedAt: new Date('2024-01-01T01:00:00Z'),
    });

    const result = await prepareConversationContext({
      ...baseParams,
      messages,
      user: { id: 'u1', role: 'admin' },
    });

    expect(isSyntheticSummaryMessage(result.messages[0])).toBe(true);
    // Tail starts after the pointer (m2) at the next user turn (m3)
    expect(result.messages.slice(1).map((m) => m.id)).toEqual(['m3', 'm4']);
  });

  it('over the soft threshold: emits pendingCompaction and scheduleCompaction registers it via after()', async () => {
    const messages = hugeHistory();

    const result = await prepareConversationContext({
      ...baseParams,
      messages,
      user: { id: 'u1', role: 'admin' },
    });

    expect(result.pendingCompaction).not.toBeNull();
    expect(result.pendingCompaction).toMatchObject({
      conversationId: 'conv-1',
      source: 'page',
      pageId: 'page-1',
      userId: 'u1',
      provider: 'openrouter',
      model: 'some-unknown-model',
    });

    result.scheduleCompaction();
    expect(mockAfter).toHaveBeenCalledTimes(1);

    // Invoking the registered callback runs the compaction with the pending params
    const registered = mockAfter.mock.calls[0][0] as () => void;
    registered();
    expect(runCompaction).toHaveBeenCalledWith(result.pendingCompaction);
  });
});
