import { describe, it, expect, beforeEach, vi } from 'vitest';
import { assert } from './riteway';

const {
  mockInsert,
  mockInsertValues,
  mockOnConflictDoUpdate,
  mockReturning,
  mockUpdateSet,
  mockUpdateWhere,
  mockFindPageById,
  mockGetConversation,
  mockBroadcastAiStreamComplete,
  mockNotifyMentionedUsers,
  mockRecomputeLastMessageAt,
  mockLoggerWarn,
} = vi.hoisted(() => ({
  mockInsert: vi.fn(),
  mockInsertValues: vi.fn(),
  mockOnConflictDoUpdate: vi.fn(),
  mockReturning: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockUpdateWhere: vi.fn(),
  mockFindPageById: vi.fn(),
  mockGetConversation: vi.fn(),
  mockBroadcastAiStreamComplete: vi.fn(),
  mockNotifyMentionedUsers: vi.fn(),
  mockRecomputeLastMessageAt: vi.fn(),
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

vi.mock('@/lib/channels/notify-mentioned-users', () => ({
  notifyMentionedUsers: mockNotifyMentionedUsers,
}));

// The mention gate reads through the SAME repositories the live paths use (reuse rail) —
// mocked at the module boundary, not as raw db.select chains.
vi.mock('@pagespace/lib/repositories/page-repository', () => ({
  pageRepository: { findById: mockFindPageById },
}));
vi.mock('@/lib/repositories/conversation-repository', () => ({
  conversationRepository: { getConversation: mockGetConversation },
}));
vi.mock('@/lib/repositories/global-conversation-repository', () => ({
  globalConversationRepository: { recomputeLastMessageAt: mockRecomputeLastMessageAt },
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

const STREAM_STARTED_AT = new Date('2026-07-15T00:00:00.000Z');

const pageRow = (over: Partial<MaterializableStreamRow> = {}): MaterializableStreamRow => ({
  messageId: 'msg-1',
  channelId: 'page-abc123',
  conversationId: 'conv-1',
  userId: 'user-a',
  parts: [textPart('partial reply')],
  startedAt: STREAM_STARTED_AT,
  ...over,
});

const globalRow = (over: Partial<MaterializableStreamRow> = {}): MaterializableStreamRow => ({
  messageId: 'msg-2',
  channelId: 'user:user-a:global',
  conversationId: 'conv-2',
  userId: 'user-a',
  startedAt: STREAM_STARTED_AT,
  parts: [textPart('partial global reply')],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockInsert.mockReturnValue({ values: mockInsertValues });
  mockInsertValues.mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
  // The page-chat chain ends `.returning(...)` (reports whether the CAS wrote — the mention
  // gate needs it); the global chain awaits the upsert directly and ignores this shape.
  mockOnConflictDoUpdate.mockReturnValue({ returning: mockReturning });
  mockReturning.mockResolvedValue([{ id: 'msg-1' }]);
  // Default the mention-gate lookups to "page gone" so tests not about notifications never
  // trip the notify path.
  mockFindPageById.mockResolvedValue(null);
  mockGetConversation.mockResolvedValue(null);
  mockNotifyMentionedUsers.mockResolvedValue(undefined);
  mockRecomputeLastMessageAt.mockResolvedValue(undefined);
  mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
  // Defaults to "one row actually settled" (rowCount: 1) — the common case. Tests exercising the
  // zero-row race (a concurrent reap already settled this row) override this per-case.
  mockUpdateWhere.mockResolvedValue({ rowCount: 1 });
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

  // Mirrors saveMessageToDatabase's own update-set ("Update conversationId if message is
  // reprocessed") — a message reparented into a different conversation before this sweep ran
  // must not be left pointing at a stale conversationId after materialization.
  it('re-syncs conversationId on the conflict update, same as the normal terminal-write path', async () => {
    await materializeInterruptedStream(pageRow({ conversationId: 'conv-fresh' }));

    const setClause = mockOnConflictDoUpdate.mock.calls[0][0].set;
    assert({
      given: 'a materialization upsert',
      should: 'include conversationId in the conflict update set clause',
      actual: setClause.conversationId,
      expected: 'conv-fresh',
    });
  });
});

describe('materializeInterruptedStream — content from the parts snapshot', () => {
  // The normal execute-end/onFinish path runs any non-empty parts array through
  // extractStructuredContentFromParts before persisting (message-utils.ts:536,666) — the
  // structured JSON envelope is what preserves file/data parts and chronological ordering on
  // reload. Materialize must produce the SAME envelope, not the plain concatenated text, or a
  // materialized reply with tool calls/file parts would silently degrade to flat text forever
  // (it's a terminal write — no later pass ever fixes it).
  it('builds message content via the same structured-content pipeline execute-end/onFinish use, not plain concatenated text', async () => {
    await materializeInterruptedStream(pageRow({ parts: [textPart('Hello'), textPart(' world')] }));

    const values = mockInsertValues.mock.calls[0][0];
    const parsed = JSON.parse(values.content as string);
    assert({
      given: 'a parts snapshot with two text parts',
      should: 'persist the structured-content envelope (matching saveMessageToDatabase), not flat text',
      actual: { originalContent: parsed.originalContent, textParts: parsed.textParts },
      expected: { originalContent: 'Hello world', textParts: ['Hello', ' world'] },
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

describe('materializeInterruptedStream — the #2022 invariant (compare-and-swap: only from streaming)', () => {
  // Stands in for Postgres evaluating `ON CONFLICT ... DO UPDATE SET ... WHERE <setWhere>`:
  // the update is applied only when the simulated current row's status satisfies the guard.
  const simulatePostgresConflict = (currentStatus: string) => {
    mockOnConflictDoUpdate.mockImplementation(async (config: { setWhere: { field: string; value: string } }) => {
      const { value: requiredStatus } = config.setWhere;
      return requiredStatus === currentStatus ? 'updated' : 'skipped';
    });
  };

  it('the onConflictDoUpdate guard requires the row to still be streaming', async () => {
    await materializeInterruptedStream(pageRow());

    assert({
      given: 'any materialization attempt',
      should: 'guard the conflict update with status == streaming',
      actual: mockOnConflictDoUpdate.mock.calls[0][0].setWhere,
      expected: { field: 'chat_messages.status', value: 'streaming' },
    });
  });

  it('given a row already complete (the old worker\'s onFinish landed first), the simulated conflict update is a no-op', async () => {
    simulatePostgresConflict('complete');

    const outcome = await mockOnConflictDoUpdate({ setWhere: { field: 'chat_messages.status', value: 'streaming' } });

    assert({
      given: 'a message row already flipped to complete between the caller\'s read and this write',
      should: 'never relabel it interrupted',
      actual: outcome,
      expected: 'skipped',
    });
  });

  // The gap the guard was widened to close: a clean Stop whose onFinish already persisted the
  // FULL content as 'interrupted', but whose ai_stream_sessions terminal write then failed
  // (fire-and-forget), leaves the session row eligible for a later sweep. A `!= 'complete'`
  // guard would let that sweep clobber the already-correct content with an older checkpoint;
  // `== 'streaming'` cannot, because the row already left 'streaming'.
  it('given a row already interrupted by its own onFinish (session-row settle failed separately), the simulated conflict update is a no-op', async () => {
    simulatePostgresConflict('interrupted');

    const outcome = await mockOnConflictDoUpdate({ setWhere: { field: 'chat_messages.status', value: 'streaming' } });

    assert({
      given: 'a message row already correctly interrupted by its own generation',
      should: 'never overwrite it with a possibly-staler checkpoint',
      actual: outcome,
      expected: 'skipped',
    });
  });

  it('given a row still streaming, the simulated conflict update applies', async () => {
    simulatePostgresConflict('streaming');

    const outcome = await mockOnConflictDoUpdate({ setWhere: { field: 'chat_messages.status', value: 'streaming' } });

    assert({
      given: 'a message row still streaming',
      should: 'apply the interrupted write',
      actual: outcome,
      expected: 'updated',
    });
  });
});

describe('materializeInterruptedStream — the defensive insert-if-missing path', () => {
  it('uses the stream\'s actual start time, not reap time, as createdAt for a newly-inserted row', async () => {
    const startedAt = new Date('2026-07-15T01:23:45.000Z');
    await materializeInterruptedStream(pageRow({ startedAt }));

    const values = mockInsertValues.mock.calls[0][0];
    assert({
      given: 'a materialization whose placeholder insert never happened',
      should: 'timestamp the recovered row at the stream\'s actual start, so it still sorts correctly against a later user message',
      actual: values.createdAt,
      expected: startedAt,
    });
  });
});

describe('materializeInterruptedStream — settling the session row', () => {
  it('reports true when both the message write and the session settle succeed', async () => {
    await expect(materializeInterruptedStream(pageRow())).resolves.toBe(true);
  });

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

  // The conditional UPDATE (`WHERE messageId = X AND status = 'streaming'`) does NOT throw when
  // it matches zero rows — it succeeds and changes nothing. That happens when a concurrent reap
  // (another instance's takeover, or a second sweep racing this one) already settled this exact
  // row first. Reporting `true` here would credit THIS call with settling a row someone else
  // already handled, and — more importantly — would mask the case where the row was never
  // settled by anyone (see the `rowCount: 0` semantics matching compaction-repository.ts's own
  // conditional-update pattern).
  it('reports false when the session-row update matches zero rows (a concurrent reap already settled it)', async () => {
    mockUpdateWhere.mockResolvedValue({ rowCount: 0 });

    await expect(materializeInterruptedStream(pageRow())).resolves.toBe(false);
    // The message write still succeeded and is not itself an error — only the session-settle
    // half is "unsettled", so this is not a warn-worthy failure the way a thrown error is.
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('defensively treats a missing rowCount (driver/mock returns undefined) as zero, not as settled', async () => {
    mockUpdateWhere.mockResolvedValue({});

    await expect(materializeInterruptedStream(pageRow())).resolves.toBe(false);
  });

  it('does not settle the session row when the message write fails', async () => {
    mockReturning.mockRejectedValue(new Error('db down'));

    await expect(materializeInterruptedStream(pageRow())).resolves.toBe(false);

    expect(mockUpdateSet).not.toHaveBeenCalled();
    assert({
      given: 'a message upsert that could not be confirmed',
      should: 'warn rather than silently losing the row',
      actual: mockLoggerWarn.mock.calls.length > 0,
      expected: true,
    });
  });

  it('logs but does not throw when the session-row settle itself fails, and reports false (not truly reconciled)', async () => {
    mockUpdateWhere.mockRejectedValue(new Error('db down'));

    await expect(materializeInterruptedStream(pageRow())).resolves.toBe(false);
    expect(mockLoggerWarn).toHaveBeenCalled();
  });

  it('logs a non-Error message-write rejection without throwing, and reports false', async () => {
    mockReturning.mockRejectedValue('a rejected string, not an Error instance');

    await expect(materializeInterruptedStream(pageRow())).resolves.toBe(false);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: 'unknown' }),
    );
  });

  it('logs a non-Error session-settle rejection without throwing, and reports false', async () => {
    mockUpdateWhere.mockRejectedValue('a rejected string, not an Error instance');

    await expect(materializeInterruptedStream(pageRow())).resolves.toBe(false);
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
    mockReturning.mockRejectedValue(new Error('db down'));

    await materializeInterruptedStream(pageRow());

    expect(mockBroadcastAiStreamComplete).not.toHaveBeenCalled();
  });

  it('logs but does not throw when the broadcast itself fails — a broadcast failure alone does not undo an otherwise-successful materialization', async () => {
    mockBroadcastAiStreamComplete.mockRejectedValue(new Error('socket down'));

    await expect(materializeInterruptedStream(pageRow())).resolves.toBe(true);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('broadcast failed'),
      expect.objectContaining({ error: 'socket down' }),
    );
  });

  it('logs a non-Error broadcast rejection without throwing', async () => {
    mockBroadcastAiStreamComplete.mockRejectedValue('a rejected string, not an Error instance');

    await expect(materializeInterruptedStream(pageRow())).resolves.toBe(true);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('broadcast failed'),
      expect.objectContaining({ error: 'unknown' }),
    );
  });
});

describe('materializeInterruptedStream — never throws', () => {
  it('resolves (with false, since the session row never settled) even when every DB call rejects', async () => {
    mockUpdateWhere.mockRejectedValue(new Error('db down'));
    mockBroadcastAiStreamComplete.mockRejectedValue(new Error('socket down'));

    await expect(materializeInterruptedStream(pageRow())).resolves.toBe(false);
  });
});

// D task st3pyh9q4zwnmae00j195o97: an interrupted reply that @mentions a user must produce the
// same mention notification the normal finalize path produces (message-utils.ts's
// saveMessageToDatabase fires notifyMentionedUsers for assistant saves when the route's gate —
// page.driveId present, a triggering user, conversation explicitly shared — passes). Before this
// fix, a reply that died mid-stream and was materialized here never notified anyone, so an
// @mention in a recovered reply silently vanished.
describe('materializeInterruptedStream — mention notifications (best-effort, mirrors the finalize path)', () => {
  const MENTION_CONTENT = 'Hey @[Alice](alice-id:user), here is what I found so far';

  // Stands in for the two gate lookups the implementation runs: pageRepository.findById
  // (driveId + title; null = missing OR trashed) and conversationRepository.getConversation
  // (`isShared`, the route's own source of isConversationShared).
  const gateLookups = ({
    page = { driveId: 'drive-1', title: 'Research Agent' },
    conversation = { isShared: true },
  }: {
    page?: { driveId: string; title: string } | null;
    conversation?: { isShared: boolean } | null;
  } = {}) => {
    mockFindPageById.mockResolvedValue(page);
    mockGetConversation.mockResolvedValue(conversation);
  };

  // The notification is fire-and-forget (like the finalize path's own `void notifyMentionedUsers`)
  // — drain the microtask/timer queue before asserting on it.
  const flushNotify = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('given a materialized page-chat reply in a shared conversation, fires notifyMentionedUsers exactly once with the finalize path\'s own argument shape', async () => {
    gateLookups();

    await materializeInterruptedStream(pageRow({ parts: [textPart(MENTION_CONTENT)] }));
    await flushNotify();

    expect(mockNotifyMentionedUsers).toHaveBeenCalledTimes(1);
    assert({
      given: 'an interrupted materialization whose reply @mentions a user',
      should: 'notify with the same shape the normal finalize path sends (content, pageId, driveId, stream owner as triggeredBy, page title as mentioner)',
      actual: mockNotifyMentionedUsers.mock.calls[0][0],
      expected: {
        content: MENTION_CONTENT,
        pageId: 'page-abc123',
        driveId: 'drive-1',
        triggeredByUserId: 'user-a',
        mentionerNameOverride: 'Research Agent',
      },
    });
  });

  it('given a global-assistant row, never notifies and never even runs the page/conversation lookups (global conversations have no page mention surface)', async () => {
    await materializeInterruptedStream(globalRow({ parts: [textPart(MENTION_CONTENT)] }));
    await flushNotify();

    expect(mockNotifyMentionedUsers).not.toHaveBeenCalled();
    expect(mockFindPageById).not.toHaveBeenCalled();
  });

  it('given the compare-and-swap upsert wrote nothing (the row already left streaming via its own onFinish, which already notified), does not notify again', async () => {
    gateLookups();
    mockReturning.mockResolvedValue([]);

    await materializeInterruptedStream(pageRow({ parts: [textPart(MENTION_CONTENT)] }));
    await flushNotify();

    expect(mockNotifyMentionedUsers).not.toHaveBeenCalled();
  });

  it('given the message write itself failed, does not notify (nothing was materialized)', async () => {
    gateLookups();
    mockReturning.mockRejectedValue(new Error('db down'));

    await expect(materializeInterruptedStream(pageRow({ parts: [textPart(MENTION_CONTENT)] }))).resolves.toBe(false);
    await flushNotify();

    expect(mockNotifyMentionedUsers).not.toHaveBeenCalled();
  });

  it('given an empty recovered reply (no parts survived), does not notify — mirrors the finalize path\'s content.trim() gate', async () => {
    gateLookups();

    await materializeInterruptedStream(pageRow({ parts: [] }));
    await flushNotify();

    expect(mockNotifyMentionedUsers).not.toHaveBeenCalled();
    expect(mockFindPageById).not.toHaveBeenCalled();
  });

  it('given the page row is gone or trashed (findById filters both), does not notify', async () => {
    gateLookups({ page: null });

    await materializeInterruptedStream(pageRow({ parts: [textPart(MENTION_CONTENT)] }));
    await flushNotify();

    expect(mockNotifyMentionedUsers).not.toHaveBeenCalled();
  });

  it('given the conversation row is missing, fails closed and does not notify — same as the route treating a missing row as private', async () => {
    gateLookups({ conversation: null });

    await materializeInterruptedStream(pageRow({ parts: [textPart(MENTION_CONTENT)] }));
    await flushNotify();

    expect(mockNotifyMentionedUsers).not.toHaveBeenCalled();
  });

  it('given the conversation is not shared, does not notify — a private conversation\'s reply must not page other drive members', async () => {
    gateLookups({ conversation: { isShared: false } });

    await materializeInterruptedStream(pageRow({ parts: [textPart(MENTION_CONTENT)] }));
    await flushNotify();

    expect(mockNotifyMentionedUsers).not.toHaveBeenCalled();
  });

  it('given the gate lookup rejects, warns (best-effort, operator-visible) and the materialization result is unaffected', async () => {
    mockFindPageById.mockRejectedValue(new Error('lookup down'));

    await expect(materializeInterruptedStream(pageRow({ parts: [textPart(MENTION_CONTENT)] }))).resolves.toBe(true);
    await flushNotify();

    expect(mockNotifyMentionedUsers).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('mention notification failed'),
      expect.objectContaining({ error: 'lookup down' }),
    );
  });

  it('given the gate lookup rejects with a non-Error value, still warns without throwing', async () => {
    mockFindPageById.mockRejectedValue('a rejected string, not an Error instance');

    await expect(materializeInterruptedStream(pageRow({ parts: [textPart(MENTION_CONTENT)] }))).resolves.toBe(true);
    await flushNotify();

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('mention notification failed'),
      expect.objectContaining({ error: 'unknown' }),
    );
  });

  it('given notifyMentionedUsers itself rejects, warns and the materialization result is unaffected', async () => {
    gateLookups();
    mockNotifyMentionedUsers.mockRejectedValue(new Error('notify boom'));

    await expect(materializeInterruptedStream(pageRow({ parts: [textPart(MENTION_CONTENT)] }))).resolves.toBe(true);
    await flushNotify();

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('mention notification failed'),
      expect.objectContaining({ error: 'notify boom' }),
    );
  });
});

// Issue #2153 site 4: the AI chat routes bump conversations.lastMessageAt after every
// persist, but the materializer's recovered assistant message previously skipped it —
// leaving the recovered conversation sorted stale in the history list.
describe('materializeInterruptedStream — conversations.lastMessageAt recompute (#2153)', () => {
  it('given a global-assistant row, recomputes the conversation lastMessageAt after the message upsert', async () => {
    await materializeInterruptedStream(globalRow({ conversationId: 'conv-2' }));

    assert({
      given: 'a materialized global-assistant reply',
      should: 'invoke the shared lastMessageAt recompute for its conversation, same as the live persist paths',
      actual: mockRecomputeLastMessageAt.mock.calls,
      expected: [['conv-2']],
    });
  });

  it('given a page-chat row, does not touch the global conversations table', async () => {
    await materializeInterruptedStream(pageRow());

    assert({
      given: 'a materialized page-chat reply',
      should: 'never invoke the global-conversation recompute (chat pages have no conversations.lastMessageAt)',
      actual: mockRecomputeLastMessageAt.mock.calls.length,
      expected: 0,
    });
  });

  it('a recompute failure degrades like a failed message write — row left retryable, session not settled', async () => {
    mockRecomputeLastMessageAt.mockRejectedValueOnce(new Error('recompute down'));

    const settled = await materializeInterruptedStream(globalRow());

    assert({
      given: 'a lastMessageAt recompute that throws mid-materialization',
      should: 'return false and leave the session row unsettled so the next sweep retries',
      actual: { settled, sessionSettleAttempts: mockUpdateSet.mock.calls.length },
      expected: { settled: false, sessionSettleAttempts: 0 },
    });
  });
});
