import { describe, it, expect, beforeEach, vi } from 'vitest';
import { assert } from './riteway';

const {
  mockInsert,
  mockInsertValues,
  mockOnConflictDoUpdate,
  mockUpdateSet,
  mockUpdateWhere,
  mockBroadcastAiStreamComplete,
  mockLoggerWarn,
} = vi.hoisted(() => ({
  mockInsert: vi.fn(),
  mockInsertValues: vi.fn(),
  mockOnConflictDoUpdate: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockUpdateWhere: vi.fn(),
  mockBroadcastAiStreamComplete: vi.fn(),
  mockLoggerWarn: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    insert: mockInsert,
    update: vi.fn(() => ({ set: mockUpdateSet })),
  },
}));

// Identity-shaped operators (the house pattern — see stream-abort-mark.test.ts) so a test can
// assert on the predicate itself rather than trusting drizzle to have built it correctly.
vi.mock('@pagespace/db/operators', () => ({
  and: vi.fn((...args: unknown[]) => ({ conds: args })),
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
  ne: vi.fn((field: unknown, value: unknown) => ({ ne: [field, value] })),
}));

vi.mock('@pagespace/db/schema/ai-streams', () => ({
  aiStreamSessions: {
    messageId: 'ai_stream_sessions.message_id',
    status: 'ai_stream_sessions.status',
  },
}));

vi.mock('@pagespace/db/schema/core', () => ({
  chatMessages: {
    id: 'chat_messages.id',
    status: 'chat_messages.status',
  },
}));

vi.mock('@pagespace/db/schema/conversations', () => ({
  messages: {
    id: 'messages.id',
    status: 'messages.status',
  },
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { ai: { info: vi.fn(), warn: mockLoggerWarn, error: vi.fn(), debug: vi.fn() } },
}));

vi.mock('@/lib/websocket', () => ({
  broadcastAiStreamComplete: mockBroadcastAiStreamComplete,
}));

import { materializeInterruptedStream, type MaterializableStreamRow } from '../materialize-interrupted-stream';
import type { UIMessagePart } from '../stream-multicast-registry';

const textPart = (text: string): UIMessagePart => ({ type: 'text', text }) as UIMessagePart;

const toolCallPart = (): UIMessagePart =>
  ({
    type: 'tool-search',
    toolCallId: 'tc-1',
    toolName: 'search',
    input: { q: 'hello' },
    output: { results: [] },
    state: 'output-available',
  }) as UIMessagePart;

const pageRow = (over: Partial<MaterializableStreamRow> = {}): MaterializableStreamRow => ({
  messageId: 'msg-1',
  channelId: 'page-abc123',
  conversationId: 'conv-1',
  userId: 'user-a',
  parts: [textPart('partial reply')],
  ...over,
});

const globalRow = (over: Partial<MaterializableStreamRow> = {}): MaterializableStreamRow => ({
  messageId: 'msg-2',
  channelId: 'user:user-a:global',
  conversationId: 'conv-2',
  userId: 'user-a',
  parts: [textPart('partial global reply')],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockInsert.mockReturnValue({ values: mockInsertValues });
  mockInsertValues.mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
  mockOnConflictDoUpdate.mockResolvedValue(undefined);
  mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
  mockUpdateWhere.mockResolvedValue(undefined);
  mockBroadcastAiStreamComplete.mockResolvedValue(undefined);
});

describe('materializeInterruptedStream — table routing', () => {
  it('given a page-chat channelId, writes to chat_messages with pageId = channelId', async () => {
    await materializeInterruptedStream(pageRow({ channelId: 'page-abc123' }));

    assert({
      given: 'a provably-dead page-chat stream row',
      should: 'insert into chat_messages, not messages',
      actual: mockInsert.mock.calls[0][0],
      expected: { id: 'chat_messages.id', status: 'chat_messages.status' },
    });

    const values = mockInsertValues.mock.calls[0][0];
    assert({
      given: 'a page-chat row',
      should: 'set pageId from channelId, userId null, sourceAgentId null (mirrors the placeholder insert contract)',
      actual: { pageId: values.pageId, userId: values.userId, sourceAgentId: values.sourceAgentId, status: values.status },
      expected: { pageId: 'page-abc123', userId: null, sourceAgentId: null, status: 'interrupted' },
    });
  });

  it('given a global-assistant channelId, writes to messages with the row owner as userId', async () => {
    await materializeInterruptedStream(globalRow({ channelId: 'user:user-a:global', userId: 'user-a' }));

    assert({
      given: 'a provably-dead global-assistant stream row',
      should: 'insert into messages, not chat_messages',
      actual: mockInsert.mock.calls[0][0],
      expected: { id: 'messages.id', status: 'messages.status' },
    });

    const values = mockInsertValues.mock.calls[0][0];
    assert({
      given: 'a global-assistant row',
      should: 'set userId to the stream owner (messages.userId is NOT NULL)',
      actual: { userId: values.userId, status: values.status },
      expected: { userId: 'user-a', status: 'interrupted' },
    });
  });
});

describe('materializeInterruptedStream — content from the parts snapshot', () => {
  it('builds message content via the shared execute-end/onFinish payload builder', async () => {
    await materializeInterruptedStream(pageRow({ parts: [textPart('Hello'), textPart(' world')] }));

    const values = mockInsertValues.mock.calls[0][0];
    assert({
      given: 'a parts snapshot with two text parts',
      should: 'produce the same concatenated content buildAssistantPersistencePayload would for a finished stream',
      actual: values.content,
      expected: 'Hello world',
    });
  });

  it('given parts that include a tool call, serializes toolCalls/toolResults as JSON rather than leaving them null', async () => {
    await materializeInterruptedStream(pageRow({ parts: [textPart('Here'), toolCallPart()] }));

    const values = mockInsertValues.mock.calls[0][0];
    assert({
      given: 'a parts snapshot with a completed tool call',
      should: 'persist non-null, JSON-serialized toolCalls and toolResults',
      actual: { toolCalls: values.toolCalls !== null, toolResults: values.toolResults !== null },
      expected: { toolCalls: true, toolResults: true },
    });
  });

  it('given no parts at all, still writes an interrupted row with empty content', async () => {
    await materializeInterruptedStream(pageRow({ parts: [] }));

    const values = mockInsertValues.mock.calls[0][0];
    assert({
      given: 'a stream that died before any part was ever pushed',
      should: 'materialize an empty-but-honest interrupted row rather than skipping it',
      actual: { content: values.content, status: values.status },
      expected: { content: '', status: 'interrupted' },
    });
  });
});

describe('materializeInterruptedStream — the #2022 invariant (never overwrite complete)', () => {
  // Stands in for Postgres evaluating `ON CONFLICT ... DO UPDATE SET ... WHERE <setWhere>`:
  // the update is applied only when the simulated current row's status satisfies the guard.
  const simulatePostgresConflict = (currentStatus: string) => {
    mockOnConflictDoUpdate.mockImplementation(async (config: { setWhere: { ne: [string, string] } }) => {
      const [, guardedAgainst] = config.setWhere.ne;
      return guardedAgainst === currentStatus ? 'skipped' : 'updated';
    });
  };

  it('the onConflictDoUpdate guard names the row status column and "complete"', async () => {
    await materializeInterruptedStream(pageRow());

    assert({
      given: 'any materialization attempt',
      should: 'guard the conflict update with status != complete',
      actual: mockOnConflictDoUpdate.mock.calls[0][0].setWhere,
      expected: { ne: ['chat_messages.status', 'complete'] },
    });
  });

  it('given a row already complete (the old worker\'s onFinish landed first), the simulated conflict update is a no-op', async () => {
    simulatePostgresConflict('complete');

    const outcome = await mockOnConflictDoUpdate({ setWhere: { ne: ['chat_messages.status', 'complete'] } });

    assert({
      given: 'a message row already flipped to complete between the caller\'s read and this write',
      should: 'never relabel it interrupted',
      actual: outcome,
      expected: 'skipped',
    });
  });

  it('given a row still streaming, the simulated conflict update applies', async () => {
    simulatePostgresConflict('streaming');

    const outcome = await mockOnConflictDoUpdate({ setWhere: { ne: ['chat_messages.status', 'complete'] } });

    assert({
      given: 'a message row still streaming',
      should: 'apply the interrupted write',
      actual: outcome,
      expected: 'updated',
    });
  });
});

describe('materializeInterruptedStream — settling the session row', () => {
  it('settles ai_stream_sessions terminal only after the message write succeeds', async () => {
    await materializeInterruptedStream(pageRow({ messageId: 'msg-settle' }));

    const written = mockUpdateSet.mock.calls[0][0] as Record<string, unknown>;
    assert({
      given: 'a successful message materialization',
      should: 'drive the session row terminal, clearing its parts snapshot',
      actual: { status: written.status, parts: written.parts, rawPartsCount: written.rawPartsCount, abortRequestedAt: written.abortRequestedAt },
      expected: { status: 'aborted', parts: [], rawPartsCount: 0, abortRequestedAt: null },
    });

    const conds = (mockUpdateWhere.mock.calls[0][0] as { conds: Array<{ field?: string; value?: unknown }> }).conds;
    assert({
      given: 'the session-row settle write',
      should: 'only ever touch a row still marked streaming',
      actual: conds.find((c) => c.field === 'ai_stream_sessions.status')?.value,
      expected: 'streaming',
    });
  });

  it('does not settle the session row when the message write fails', async () => {
    mockOnConflictDoUpdate.mockRejectedValue(new Error('db down'));

    await materializeInterruptedStream(pageRow());

    expect(mockUpdateSet).not.toHaveBeenCalled();
    assert({
      given: 'a message upsert that could not be confirmed',
      should: 'warn rather than silently losing the row',
      actual: mockLoggerWarn.mock.calls.length > 0,
      expected: true,
    });
  });

  it('logs but does not throw when the session-row settle itself fails', async () => {
    mockUpdateWhere.mockRejectedValue(new Error('db down'));

    await expect(materializeInterruptedStream(pageRow())).resolves.toBeUndefined();
    expect(mockLoggerWarn).toHaveBeenCalled();
  });

  it('logs a non-Error message-write rejection without throwing', async () => {
    mockOnConflictDoUpdate.mockRejectedValue('a rejected string, not an Error instance');

    await expect(materializeInterruptedStream(pageRow())).resolves.toBeUndefined();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: 'unknown' }),
    );
  });

  it('logs a non-Error session-settle rejection without throwing', async () => {
    mockUpdateWhere.mockRejectedValue('a rejected string, not an Error instance');

    await expect(materializeInterruptedStream(pageRow())).resolves.toBeUndefined();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: 'unknown' }),
    );
  });
});

describe('materializeInterruptedStream — broadcast', () => {
  it('broadcasts stream_complete with aborted:true after a successful materialization', async () => {
    await materializeInterruptedStream(pageRow({ messageId: 'msg-3', channelId: 'page-xyz', conversationId: 'conv-3' }));

    assert({
      given: 'a materialized interrupted stream',
      should: 'tell every subscriber the generation is over, the same as a live abort would',
      actual: mockBroadcastAiStreamComplete.mock.calls[0][0],
      expected: { messageId: 'msg-3', pageId: 'page-xyz', conversationId: 'conv-3', aborted: true },
    });
  });

  it('does not broadcast when the message write failed (nothing was actually materialized)', async () => {
    mockOnConflictDoUpdate.mockRejectedValue(new Error('db down'));

    await materializeInterruptedStream(pageRow());

    expect(mockBroadcastAiStreamComplete).not.toHaveBeenCalled();
  });
});

describe('materializeInterruptedStream — never throws', () => {
  it('resolves even when every DB call rejects', async () => {
    mockOnConflictDoUpdate.mockResolvedValue(undefined);
    mockUpdateWhere.mockRejectedValue(new Error('db down'));
    mockBroadcastAiStreamComplete.mockRejectedValue(new Error('socket down'));

    await expect(materializeInterruptedStream(pageRow())).resolves.toBeUndefined();
  });
});
