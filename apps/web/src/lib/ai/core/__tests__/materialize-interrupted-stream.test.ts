import { describe, it, expect, beforeEach, vi } from 'vitest';
import { assert } from './riteway';

const {
  mockInsert,
  mockInsertValues,
  mockOnConflictDoUpdate,
  mockReturning,
  mockUpdateSet,
  mockUpdateWhere,
  mockTxSelectLimit,
  mockFindPageById,
  mockGetConversation,
  mockBroadcastAiStreamComplete,
  mockNotifyMentionedUsers,
  mockRecomputeLastMessageAt,
  mockLoggerWarn,
  mockFrameSelectOrderBy,
  mockDeleteWhere,
  mockClaimDeadStream,
  mockIsReapClaimStillHeld,
} = vi.hoisted(() => ({
  mockInsert: vi.fn(),
  mockInsertValues: vi.fn(),
  mockOnConflictDoUpdate: vi.fn(),
  mockReturning: vi.fn(),
  mockUpdateSet: vi.fn(),
  mockUpdateWhere: vi.fn(),
  mockTxSelectLimit: vi.fn(),
  mockFindPageById: vi.fn(),
  mockGetConversation: vi.fn(),
  mockBroadcastAiStreamComplete: vi.fn(),
  mockNotifyMentionedUsers: vi.fn(),
  mockRecomputeLastMessageAt: vi.fn(),
  mockLoggerWarn: vi.fn(),
  // The durable frame log's read (`readFrames`) and release (`deleteFrames`). Kept as raw
  // db chains rather than a module mock so these tests exercise the REAL frame-log module —
  // the seq-contiguity rule that decides what a recovery actually folds lives there.
  mockFrameSelectOrderBy: vi.fn(),
  mockDeleteWhere: vi.fn(),
  mockClaimDeadStream: vi.fn(),
  mockIsReapClaimStillHeld: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    insert: mockInsert,
    update: vi.fn(() => ({ set: mockUpdateSet })),
    // `readFrames` — the only top-level select the materializer makes. It runs a metadata pass
    // and then a payload pass bounded by `from_seq <= lastWanted`, so the mock models that
    // predicate; replaying one canned array to both would make its truncation cases vacuous.
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((cond: unknown) => ({
          orderBy: async () => {
            const rows = (await mockFrameSelectOrderBy()) as { fromSeq: number }[];
            const parts = (cond as { conds?: unknown[] })?.conds ?? [cond];
            const bound = parts
              .map((part) => (part as { lteValue?: number })?.lteValue)
              .find((v): v is number => typeof v === 'number');
            return bound === undefined ? rows : rows.filter((r) => r.fromSeq <= bound);
          },
        })),
      })),
    })),
    // `deleteFrames` — the retention release, once the message write is confirmed.
    delete: vi.fn(() => ({ where: mockDeleteWhere })),
    // The repository choke point (SSoT Phase 2) wraps the CAS upsert + the
    // conversations.rev bump in one transaction. The tx reuses the SAME
    // insert spies (so every table-routing/setWhere assertion below still
    // binds to the real repository SQL); the rev bump's update chain returns
    // no row (legacy-conversation shape), which the repository tolerates.
    //
    // `select` is the unified leg's FK precheck (Phase 4 PR 10,
    // unified-message-leg.ts): a page-chat terminal write now lands on BOTH
    // `chat_messages` and `messages` in this same transaction, and it looks
    // the `conversations` row up first because `messages`'s FK is validated.
    // Defaults to "the conversation exists" — the only shape a materializable
    // stream can have, since its placeholder was written through the same
    // repository.
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        insert: mockInsert,
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({ limit: mockTxSelectLimit })),
          })),
        })),
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })),
          })),
        })),
      }),
    ),
  },
}));

// Identity-shaped operators (the house pattern — see stream-abort-mark.test.ts) so a test can
// assert on the predicate itself rather than trusting drizzle to have built it correctly.
vi.mock('@pagespace/db/operators', () => ({
  and: vi.fn((...args: unknown[]) => ({ conds: args })),
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
  // Pulled in transitively by the message-repository module graph.
  sql: vi.fn(),
  ne: vi.fn(),
  gt: vi.fn(),
  lt: vi.fn(),
  desc: vi.fn(),
  exists: vi.fn(),
  isNull: vi.fn(),
  isNotNull: vi.fn(),
  inArray: vi.fn(),
  asc: vi.fn((field: unknown) => ({ asc: field })),
  lte: vi.fn((field: unknown, value: unknown) => ({ field, lteValue: value })),
}));

vi.mock('@pagespace/db/schema/ai-streams', () => ({
  aiStreamSessions: {
    messageId: 'ai_stream_sessions.message_id',
    status: 'ai_stream_sessions.status',
    reapClaimedAt: 'ai_stream_sessions.reap_claimed_at',
    lastHeartbeatAt: 'ai_stream_sessions.last_heartbeat_at',
  },
  aiStreamFrames: {
    messageId: 'ai_stream_frames.message_id',
    fromSeq: 'ai_stream_frames.from_seq',
    frameCount: 'ai_stream_frames.frame_count',
    frames: 'ai_stream_frames.frames',
  },
}));

vi.mock('@pagespace/db/schema/core', () => ({
}));

vi.mock('@pagespace/db/schema/conversations', () => ({
  messages: {
    id: 'messages.id',
    status: 'messages.status',
  },
  conversations: {
    id: 'conversations.id',
    rev: 'conversations.rev',
  },
}));

/**
 * The reap claim — mocked at its two DB-touching functions ONLY.
 *
 * `reapClaimFence` stays REAL, and that is the point: it is the predicate every destructive
 * write below carries, so the cases asserting on the settle's WHERE clause must see the
 * clauses the production code actually builds. `claimDeadStream` and `isReapClaimStillHeld`
 * are the statements themselves; `stream-reap-claim.test.ts` covers those.
 */
vi.mock('../stream-reap-claim', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stream-reap-claim')>();
  return {
    ...actual,
    claimDeadStream: mockClaimDeadStream,
    isReapClaimStillHeld: mockIsReapClaimStillHeld,
  };
});

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    ai: { info: vi.fn(), warn: mockLoggerWarn, error: vi.fn(), debug: vi.fn() },
    api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
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
// `recomputeLastMessageAt` moved from `global-conversation-repository` to
// `message-repository` with the repository merge (epic "Agent-Session Single
// Source of Truth", Phase 4 / D6, PR 12) — page conversations read from the
// same table now, so the field they sort on has one writer for both kinds.
// Only that method is redirected: the rest of the module (the materializer's
// own CAS terminal writes) stays REAL, which is what these tests exercise.
vi.mock('@/lib/repositories/message-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/repositories/message-repository')>();
  return {
    ...actual,
    messageRepository: { ...actual.messageRepository, recomputeLastMessageAt: mockRecomputeLastMessageAt },
  };
});

import { materializeInterruptedStream } from '../materialize-interrupted-stream';
import type { ReapClaim } from '../stream-reap-claim';
import type { UIMessagePart } from '../stream-channel-registry';

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
const HEARTBEAT_AT_CLAIM = new Date('2026-07-15T00:01:00.000Z');
const CLAIMED_AT = new Date('2026-07-15T00:05:00.000Z');

const pageRow = (over: Partial<ReapClaim> = {}): ReapClaim => ({
  messageId: 'msg-1',
  claimedAt: CLAIMED_AT,
  heartbeatAtClaim: HEARTBEAT_AT_CLAIM,
  channelId: 'page-abc123',
  conversationId: 'conv-1',
  userId: 'user-a',
  parts: [textPart('partial reply')],
  rawPartsCount: 0,
  startedAt: STREAM_STARTED_AT,
  ...over,
});

const globalRow = (over: Partial<ReapClaim> = {}): ReapClaim => ({
  messageId: 'msg-2',
  claimedAt: CLAIMED_AT,
  heartbeatAtClaim: HEARTBEAT_AT_CLAIM,
  channelId: 'user:user-a:global',
  conversationId: 'conv-2',
  userId: 'user-a',
  startedAt: STREAM_STARTED_AT,
  parts: [textPart('partial global reply')],
  rawPartsCount: 0,
  ...over,
});

/**
 * Drive the materializer with a given claimed row.
 *
 * The production entry point takes a messageId and CLAIMS the row itself — one statement that
 * is both the read and the fence (see stream-reap-claim.ts). These cases are about what happens
 * with a won claim, so the claim is stubbed and the row it returns is the case's input. The
 * "no claim" cases call `materializeInterruptedStream` directly.
 */
const materialize = async (row: ReapClaim): Promise<boolean> => {
  mockClaimDeadStream.mockResolvedValue(row);
  return materializeInterruptedStream({ messageId: row.messageId });
};

beforeEach(() => {
  vi.clearAllMocks();
  mockInsert.mockReturnValue({ values: mockInsertValues });
  mockInsertValues.mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
  // The page-chat chain ends `.returning(...)` (reports whether the CAS wrote — the mention
  // gate needs it); the global chain awaits the upsert directly and ignores this shape.
  mockOnConflictDoUpdate.mockReturnValue({ returning: mockReturning });
  mockReturning.mockResolvedValue([{ id: 'msg-1' }]);
  // The unified leg's `conversations` precheck — present by default.
  mockTxSelectLimit.mockResolvedValue([{ id: 'conv-1' }]);
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
  // Default: no durable frame log for this stream — a row started by a worker from before
  // the log had a writer. Every pre-existing case below therefore keeps exercising the
  // `parts` fallback exactly as it did, and the frame path is opted into per-test.
  mockFrameSelectOrderBy.mockResolvedValue([]);
  mockDeleteWhere.mockResolvedValue(undefined);
  // The frame release re-verifies the claim before deleting. Held by default; the case that
  // matters overrides it.
  mockIsReapClaimStillHeld.mockResolvedValue(true);
});

describe('materializeInterruptedStream — table routing', () => {
  it('given a page-chat channelId, writes to messages with no human author', async () => {
    await materialize(pageRow({ channelId: 'page-abc123' }));

    // Both kinds of channel land in `messages` — one table since PR 15
    // dropped `chat_messages`. The routing that survives is in the VALUES, not
    // the table: a page row carries no human author, a global one does. The
    // page itself is the CONVERSATION's, so nothing here writes it.
    assert({
      given: 'a provably-dead page-chat stream row',
      should: 'insert into messages — the one message table',
      actual: mockInsert.mock.calls[0][0],
      expected: { id: 'messages.id', status: 'messages.status' },
    });

    const values = mockInsertValues.mock.calls[0][0];
    assert({
      given: 'a page-chat row',
      should: 'set userId null and sourceAgentId null (mirrors the placeholder insert contract), and carry no page column',
      actual: { hasPageId: 'pageId' in values, userId: values.userId, sourceAgentId: values.sourceAgentId, status: values.status },
      expected: { hasPageId: false, userId: null, sourceAgentId: null, status: 'interrupted' },
    });
  });

  it('given a global-assistant channelId, writes to messages with the row owner as userId', async () => {
    await materialize(globalRow({ channelId: 'user:user-a:global', userId: 'user-a' }));

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
    await materialize(pageRow({ conversationId: 'conv-fresh' }));

    const setClause = mockOnConflictDoUpdate.mock.calls[0][0].set;
    assert({
      given: 'a materialization upsert',
      should: 'include conversationId in the conflict update set clause',
      actual: setClause.conversationId,
      expected: 'conv-fresh',
    });
  });

  // Materialization IS the terminal write for a recovered reply — a class of
  // row no backfill re-derives — so a second INSERT appearing here would be a
  // resurrected legacy writer silently forking the record.
  it('writes the materialized page reply ONCE, to the one message table', async () => {
    await materialize(pageRow({ channelId: 'page-abc123', conversationId: 'conv-1' }));

    assert({
      given: 'a materialized page-chat reply',
      should: 'insert into messages exactly once',
      actual: mockInsert.mock.calls.map((call) => call[0]),
      expected: [{ id: 'messages.id', status: 'messages.status' }],
    });

    const written = mockInsertValues.mock.calls[0][0];
    assert({
      given: 'the materialized page reply',
      should: 'carry its id, status and conversation — the conversation is what names its page',
      actual: {
        id: written.id,
        status: written.status,
        conversationId: written.conversationId,
        hasPageId: 'pageId' in written,
      },
      expected: {
        id: 'msg-1',
        status: 'interrupted',
        conversationId: 'conv-1',
        hasPageId: false,
      },
    });
  });

  // The CAS is the gate: it is what proves the row was still 'streaming'. A
  // declined write must not be retried against anything, or it would clobber a
  // terminal row the route's own onFinish already wrote correctly.
  it('given the CAS wrote nothing, writes nothing else either', async () => {
    mockReturning.mockResolvedValue([]);

    await materialize(pageRow());

    assert({
      given: 'a materialization whose compare-and-swap matched no streaming row',
      should: 'attempt exactly one insert and mirror it nowhere',
      actual: mockInsert.mock.calls.map((call) => call[0]),
      expected: [{ id: 'messages.id', status: 'messages.status' }],
    });
  });

  // Unchanged by the merge: the global assistant's table has always been
  // `messages`, and a duplicate insert would be a real bug.
  it('given a global-assistant row, writes messages exactly once', async () => {
    await materialize(globalRow());

    assert({
      given: 'a materialized global-assistant reply',
      should: 'write the messages table once',
      actual: mockInsert.mock.calls.map((call) => call[0]),
      expected: [{ id: 'messages.id', status: 'messages.status' }],
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
    await materialize(pageRow({ parts: [textPart('Hello'), textPart(' world')] }));

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
    await materialize(pageRow({ parts: [textPart('Here'), toolCallPart()] }));

    const values = mockInsertValues.mock.calls[0][0];
    assert({
      given: 'a parts snapshot with a completed tool call',
      should: 'persist non-null, JSON-serialized toolCalls and toolResults',
      actual: { toolCalls: values.toolCalls !== null, toolResults: values.toolResults !== null },
      expected: { toolCalls: true, toolResults: true },
    });
  });

  it('given no parts at all, still writes an interrupted row with empty content', async () => {
    await materialize(pageRow({ parts: [] }));

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
    await materialize(pageRow());

    assert({
      given: 'any materialization attempt',
      should: 'guard the conflict update with status == streaming',
      actual: mockOnConflictDoUpdate.mock.calls[0][0].setWhere,
      expected: { field: 'messages.status', value: 'streaming' },
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
    await materialize(pageRow({ startedAt }));

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
    await expect(materialize(pageRow())).resolves.toBe(true);
  });

  it('settles ai_stream_sessions terminal only after the message write succeeds', async () => {
    await materialize(pageRow({ messageId: 'msg-settle' }));

    const written = mockUpdateSet.mock.calls[0][0] as Record<string, unknown>;
    assert({
      given: 'a successful message materialization',
      should: 'drive the session row terminal, clearing its parts snapshot',
      actual: { status: written.status, parts: written.parts, rawPartsCount: written.rawPartsCount, abortRequestedAt: written.abortRequestedAt },
      expected: { status: 'aborted', parts: [], rawPartsCount: 0, abortRequestedAt: null },
    });

    const conds = (mockUpdateWhere.mock.calls[0][0] as { conds: Array<{ field?: string; value?: unknown; lteValue?: unknown }> }).conds;
    assert({
      given: 'the session-row settle write',
      should: 'only ever touch a row still marked streaming',
      actual: conds.find((c) => c.field === 'ai_stream_sessions.status')?.value,
      expected: 'streaming',
    });

    // THE FENCE. `status='streaming'` alone cannot stop this write reaching a LIVE stream — a
    // live owner has not changed its status, so a misjudging reaper wins that CAS every time.
    // These two clauses are the ones that can say no, and losing either silently re-opens the
    // N>1 race: the settle writes `aborted, parts: []` over a running generation, which then
    // vanishes from /active-streams, cannot be joined, and cannot be Stopped.
    assert({
      given: 'the session-row settle write',
      should: 'carry the reap claim token and the heartbeat-at-claim bound',
      actual: {
        claim: conds.find((c) => c.field === 'ai_stream_sessions.reap_claimed_at')?.value,
        heartbeatBound: conds.find((c) => c.field === 'ai_stream_sessions.last_heartbeat_at')?.lteValue,
      },
      expected: { claim: CLAIMED_AT, heartbeatBound: HEARTBEAT_AT_CLAIM },
    });
  });

  it('given no claim (the row settled itself, or a peer holds it), does nothing at all', async () => {
    mockClaimDeadStream.mockResolvedValue(null);

    const settled = await materializeInterruptedStream({ messageId: 'msg-unclaimable' });

    assert({
      given: 'a reap that could not win the claim',
      should: 'write no message, settle no row, and report false',
      actual: {
        settled,
        messageWrites: mockInsert.mock.calls.length,
        sessionWrites: mockUpdateSet.mock.calls.length,
      },
      expected: { settled: false, messageWrites: 0, sessionWrites: 0 },
    });
  });

  // The fenced UPDATE does NOT throw when it matches zero rows — it succeeds and changes
  // nothing. Two things produce that, and both are correct outcomes: the row already left
  // 'streaming' by another path, or the FENCE said no (the claim was superseded, or the owner
  // beat again between the claim committing and this write and was never dead at all).
  // Reporting `true` would credit this call with a settle that never happened, and would mask
  // the case that most needs the next sweep to retry (see the `rowCount: 0` semantics matching
  // compaction-repository.ts's own conditional-update pattern).
  it('reports false when the session-row update matches zero rows (already settled, or fenced off)', async () => {
    mockUpdateWhere.mockResolvedValue({ rowCount: 0 });

    await expect(materialize(pageRow())).resolves.toBe(false);
    // The message write still succeeded and is not itself an error — only the session-settle
    // half is "unsettled", so this is not a warn-worthy failure the way a thrown error is.
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('defensively treats a missing rowCount (driver/mock returns undefined) as zero, not as settled', async () => {
    mockUpdateWhere.mockResolvedValue({});

    await expect(materialize(pageRow())).resolves.toBe(false);
  });

  it('does not settle the session row when the message write fails', async () => {
    mockReturning.mockRejectedValue(new Error('db down'));

    await expect(materialize(pageRow())).resolves.toBe(false);

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

    await expect(materialize(pageRow())).resolves.toBe(false);
    expect(mockLoggerWarn).toHaveBeenCalled();
  });

  it('logs a non-Error message-write rejection without throwing, and reports false', async () => {
    mockReturning.mockRejectedValue('a rejected string, not an Error instance');

    await expect(materialize(pageRow())).resolves.toBe(false);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: 'unknown' }),
    );
  });

  it('logs a non-Error session-settle rejection without throwing, and reports false', async () => {
    mockUpdateWhere.mockRejectedValue('a rejected string, not an Error instance');

    await expect(materialize(pageRow())).resolves.toBe(false);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: 'unknown' }),
    );
  });
});

describe('materializeInterruptedStream — broadcast', () => {
  it('broadcasts stream_complete with aborted:true after a successful materialization', async () => {
    await materialize(pageRow({ messageId: 'msg-3', channelId: 'page-xyz', conversationId: 'conv-3' }));

    assert({
      given: 'a materialized interrupted stream',
      should: 'tell every subscriber the generation is over, the same as a live abort would',
      actual: mockBroadcastAiStreamComplete.mock.calls[0][0],
      expected: { messageId: 'msg-3', pageId: 'page-xyz', conversationId: 'conv-3', aborted: true },
    });
  });

  it('does not broadcast when the message write failed (nothing was actually materialized)', async () => {
    mockReturning.mockRejectedValue(new Error('db down'));

    await materialize(pageRow());

    expect(mockBroadcastAiStreamComplete).not.toHaveBeenCalled();
  });

  it('logs but does not throw when the broadcast itself fails — a broadcast failure alone does not undo an otherwise-successful materialization', async () => {
    mockBroadcastAiStreamComplete.mockRejectedValue(new Error('socket down'));

    await expect(materialize(pageRow())).resolves.toBe(true);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('broadcast failed'),
      expect.objectContaining({ error: 'socket down' }),
    );
  });

  it('logs a non-Error broadcast rejection without throwing', async () => {
    mockBroadcastAiStreamComplete.mockRejectedValue('a rejected string, not an Error instance');

    await expect(materialize(pageRow())).resolves.toBe(true);
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

    await expect(materialize(pageRow())).resolves.toBe(false);
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

    await materialize(pageRow({ parts: [textPart(MENTION_CONTENT)] }));
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
    await materialize(globalRow({ parts: [textPart(MENTION_CONTENT)] }));
    await flushNotify();

    expect(mockNotifyMentionedUsers).not.toHaveBeenCalled();
    expect(mockFindPageById).not.toHaveBeenCalled();
  });

  it('given the compare-and-swap upsert wrote nothing (the row already left streaming via its own onFinish, which already notified), does not notify again', async () => {
    gateLookups();
    mockReturning.mockResolvedValue([]);

    await materialize(pageRow({ parts: [textPart(MENTION_CONTENT)] }));
    await flushNotify();

    expect(mockNotifyMentionedUsers).not.toHaveBeenCalled();
  });

  it('given the message write itself failed, does not notify (nothing was materialized)', async () => {
    gateLookups();
    mockReturning.mockRejectedValue(new Error('db down'));

    await expect(materialize(pageRow({ parts: [textPart(MENTION_CONTENT)] }))).resolves.toBe(false);
    await flushNotify();

    expect(mockNotifyMentionedUsers).not.toHaveBeenCalled();
  });

  it('given an empty recovered reply (no parts survived), does not notify — mirrors the finalize path\'s content.trim() gate', async () => {
    gateLookups();

    await materialize(pageRow({ parts: [] }));
    await flushNotify();

    expect(mockNotifyMentionedUsers).not.toHaveBeenCalled();
    expect(mockFindPageById).not.toHaveBeenCalled();
  });

  it('given the page row is gone or trashed (findById filters both), does not notify', async () => {
    gateLookups({ page: null });

    await materialize(pageRow({ parts: [textPart(MENTION_CONTENT)] }));
    await flushNotify();

    expect(mockNotifyMentionedUsers).not.toHaveBeenCalled();
  });

  it('given the conversation row is missing, fails closed and does not notify — same as the route treating a missing row as private', async () => {
    gateLookups({ conversation: null });

    await materialize(pageRow({ parts: [textPart(MENTION_CONTENT)] }));
    await flushNotify();

    expect(mockNotifyMentionedUsers).not.toHaveBeenCalled();
  });

  it('given the conversation is not shared, does not notify — a private conversation\'s reply must not page other drive members', async () => {
    gateLookups({ conversation: { isShared: false } });

    await materialize(pageRow({ parts: [textPart(MENTION_CONTENT)] }));
    await flushNotify();

    expect(mockNotifyMentionedUsers).not.toHaveBeenCalled();
  });

  it('given the gate lookup rejects, warns (best-effort, operator-visible) and the materialization result is unaffected', async () => {
    mockFindPageById.mockRejectedValue(new Error('lookup down'));

    await expect(materialize(pageRow({ parts: [textPart(MENTION_CONTENT)] }))).resolves.toBe(true);
    await flushNotify();

    expect(mockNotifyMentionedUsers).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('mention notification failed'),
      expect.objectContaining({ error: 'lookup down' }),
    );
  });

  it('given the gate lookup rejects with a non-Error value, still warns without throwing', async () => {
    mockFindPageById.mockRejectedValue('a rejected string, not an Error instance');

    await expect(materialize(pageRow({ parts: [textPart(MENTION_CONTENT)] }))).resolves.toBe(true);
    await flushNotify();

    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('mention notification failed'),
      expect.objectContaining({ error: 'unknown' }),
    );
  });

  it('given notifyMentionedUsers itself rejects, warns and the materialization result is unaffected', async () => {
    gateLookups();
    mockNotifyMentionedUsers.mockRejectedValue(new Error('notify boom'));

    await expect(materialize(pageRow({ parts: [textPart(MENTION_CONTENT)] }))).resolves.toBe(true);
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
    await materialize(globalRow({ conversationId: 'conv-2' }));

    assert({
      given: 'a materialized global-assistant reply',
      should: 'invoke the shared lastMessageAt recompute for its conversation, same as the live persist paths',
      actual: mockRecomputeLastMessageAt.mock.calls,
      expected: [['conv-2']],
    });
  });

  it('given a page-chat row, does not touch the global conversations table', async () => {
    await materialize(pageRow());

    assert({
      given: 'a materialized page-chat reply',
      should: 'never invoke the global-conversation recompute (chat pages have no conversations.lastMessageAt)',
      actual: mockRecomputeLastMessageAt.mock.calls.length,
      expected: 0,
    });
  });

  it('a recompute failure degrades like a failed message write — row left retryable, session not settled', async () => {
    mockRecomputeLastMessageAt.mockRejectedValueOnce(new Error('recompute down'));

    const settled = await materialize(globalRow());

    assert({
      given: 'a lastMessageAt recompute that throws mid-materialization',
      should: 'return false and leave the session row unsettled so the next sweep retries',
      actual: { settled, sessionSettleAttempts: mockUpdateSet.mock.calls.length },
      expected: { settled: false, sessionSettleAttempts: 0 },
    });
  });
});

/**
 * LEAF 3 — recovery reads the durable frame log.
 *
 * The reason the log exists at all: `row.parts` is a debounced, folded snapshot, whereas
 * `ai_stream_frames` holds the generation's own `UIMessageChunk`s. Folding those here runs the
 * SAME reduction a live client ran over the SAME frames, so a recovered reply is not a
 * degraded approximation of what was on screen — it is the same message.
 */
describe('materializeInterruptedStream — durable frame log', () => {
  /**
   * The persisted `content` is `extractStructuredContentFromParts`' envelope whenever a reply
   * has more than plain text in it. These tests are about WHICH FRAMES were folded, not about
   * that envelope's shape, so they compare the text it carries.
   */
  const persistedText = (values: Record<string, unknown>): string => {
    const content = values.content as string;
    try {
      const parsed = JSON.parse(content) as { originalContent?: unknown };
      return typeof parsed.originalContent === 'string' ? parsed.originalContent : content;
    } catch {
      return content;
    }
  };

  /** One row of the log, in the shape `readFrames` selects. */
  const frameRow = (fromSeq: number, frames: unknown[]) => ({
    fromSeq,
    frameCount: frames.length,
    frames,
  });

  /** An ordinary turn: reasoning, a tool round trip, then the answer. */
  const RICH_TURN = [
    { type: 'start', messageId: 'msg-1' },
    { type: 'reasoning-start', id: 'r1' },
    { type: 'reasoning-delta', id: 'r1', delta: 'checking the invoices' },
    { type: 'reasoning-end', id: 'r1' },
    { type: 'tool-input-available', toolCallId: 'tc1', toolName: 'search_pages', input: { q: 'inv' } },
    { type: 'tool-output-available', toolCallId: 'tc1', output: { hits: 3 } },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: 'I found ' },
    { type: 'text-delta', id: 't1', delta: 'three invoices.' },
  ];

  it('given a frame log, materializes from the frames rather than the parts snapshot', async () => {
    mockFrameSelectOrderBy.mockResolvedValue([
      frameRow(0, RICH_TURN.slice(0, 4)),
      frameRow(4, RICH_TURN.slice(4)),
    ]);

    await materialize(
      pageRow({ parts: [textPart('a much staler debounced snapshot')] }),
    );

    const values = mockInsertValues.mock.calls[0][0];
    assert({
      given: 'a dead stream whose frame log holds the whole turn',
      should: 'persist the content folded from the FRAMES, not the stale parts column',
      actual: persistedText(values),
      expected: 'I found three invoices.',
    });
  });

  it('given a frame log, preserves the fidelity a live client saw — reasoning and tool parts, not just text', async () => {
    mockFrameSelectOrderBy.mockResolvedValue([frameRow(0, RICH_TURN)]);

    await materialize(pageRow({ parts: [] }));

    const values = mockInsertValues.mock.calls[0][0];
    const persisted = JSON.parse(values.content as string) as { textParts?: unknown[] };
    const toolCalls = JSON.parse((values.toolCalls as string) ?? 'null') as { toolName: string }[] | null;
    assert({
      given: 'a frame log containing reasoning and a tool round trip',
      should: 'carry the tool call through to the persisted message rather than flattening to text',
      actual: toolCalls?.map((c) => c.toolName) ?? null,
      expected: ['search_pages'],
    });
    assert({
      given: 'a frame log whose text arrived as two deltas',
      should: 'fold them into one text part, exactly as the SDK reduction would',
      actual: Array.isArray(persisted.textParts) ? persisted.textParts.length : -1,
      expected: 1,
    });
  });

  it('given NO frame log (a stream started by an older worker), falls back to the parts snapshot', async () => {
    mockFrameSelectOrderBy.mockResolvedValue([]);

    await materialize(pageRow({ parts: [textPart('the debounced snapshot')] }));

    const values = mockInsertValues.mock.calls[0][0];
    assert({
      given: 'a dead stream with no rows in the frame log',
      should: 'materialize from the parts column rather than an empty reply',
      actual: persistedText(values),
      expected: 'the debounced snapshot',
    });
  });

  it('given a frame log SHORTER than the checkpoint, prefers the richer snapshot', async () => {
    // "The log exists" is not "the log is longer". The writer gives up at its first failed
    // batch and at its durable-byte ceiling, leaving a valid but short contiguous prefix,
    // while the checkpoint fold carries on independently from memory. Preferring the log
    // unconditionally would materialize the truncated one.
    mockFrameSelectOrderBy.mockResolvedValue([frameRow(0, RICH_TURN.slice(0, 2))]);

    await materialize(
      pageRow({ parts: [textPart('a far more complete snapshot')], rawPartsCount: 900 }),
    );

    const values = mockInsertValues.mock.calls[0][0];
    assert({
      given: 'a 2-frame durable log against a snapshot reflecting 900 frames',
      should: 'materialize the snapshot — the log stopped early and is not the fuller record',
      actual: persistedText(values),
      expected: 'a far more complete snapshot',
    });
  });

  it('given a frame log at least as long as the checkpoint, prefers the log', async () => {
    mockFrameSelectOrderBy.mockResolvedValue([frameRow(0, RICH_TURN)]);

    await materialize(
      pageRow({ parts: [textPart('the staler snapshot')], rawPartsCount: RICH_TURN.length }),
    );

    const values = mockInsertValues.mock.calls[0][0];
    assert({
      given: 'a log and a snapshot that reach equally far',
      should: 'fold the log — equal reach means equal content, and the log is the unfolded original',
      actual: persistedText(values),
      expected: 'I found three invoices.',
    });
  });

  it('given a row that does not project rawPartsCount, trusts the log rather than crashing', async () => {
    mockFrameSelectOrderBy.mockResolvedValue([frameRow(0, RICH_TURN)]);

    await materialize(pageRow({ parts: [textPart('snapshot')], rawPartsCount: undefined }));

    const values = mockInsertValues.mock.calls[0][0];
    assert({
      given: 'a caller that omitted the comparison column',
      should: 'degrade to preferring the log, not to a crash',
      actual: persistedText(values),
      expected: 'I found three invoices.',
    });
  });

  it('given a frame-log read that fails, falls back to the parts snapshot rather than losing the reply', async () => {
    mockFrameSelectOrderBy.mockRejectedValue(new Error('frames table unreachable'));

    const settled = await materialize(pageRow({ parts: [textPart('the debounced snapshot')] }));

    const values = mockInsertValues.mock.calls[0][0];
    assert({
      given: 'a frame-log read that throws',
      should: 'still materialize, from the parts column',
      actual: { content: persistedText(values), settled },
      expected: { content: 'the debounced snapshot', settled: true },
    });
  });

  it('given a GAP in the frame log, folds only the contiguous prefix rather than splicing across the hole', async () => {
    // seq 2 is missing: the row after the first batch starts at 3, not 2. Folding across
    // that would concatenate text the model never said consecutively.
    mockFrameSelectOrderBy.mockResolvedValue([
      frameRow(0, [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'before the gap' },
      ]),
      frameRow(3, [{ type: 'text-delta', id: 't1', delta: ' AFTER the gap' }]),
    ]);

    await materialize(pageRow({ parts: [] }));

    const values = mockInsertValues.mock.calls[0][0];
    assert({
      given: 'a frame log missing a seq in the middle',
      should: 'keep only what precedes the hole — a truncated prefix, never a spliced message',
      actual: persistedText(values),
      expected: 'before the gap',
    });
  });

  it('given a frame log that does not start at seq 0, treats it as no log rather than an empty reply', async () => {
    mockFrameSelectOrderBy.mockResolvedValue([
      frameRow(7, [{ type: 'text-start', id: 't1' }, { type: 'text-delta', id: 't1', delta: 'orphan tail' }]),
    ]);

    await materialize(pageRow({ parts: [textPart('the debounced snapshot')] }));

    const values = mockInsertValues.mock.calls[0][0];
    assert({
      given: 'a log whose earliest surviving row is not seq 0 (its head was swept)',
      should: 'fall back to the parts snapshot instead of materializing a headless tail',
      actual: persistedText(values),
      expected: 'the debounced snapshot',
    });
  });
});

/**
 * LEAF 2 — retention, from the recovery side.
 *
 * "Only after the write is confirmed" is the whole rule. Frames are the ONLY copy of a reply
 * whose process died, so deleting them on any path that did not durably persist the message
 * throws away exactly what the log was built to keep.
 */
describe('materializeInterruptedStream — frame retention', () => {
  it('given a confirmed message write, releases that message\'s frames', async () => {
    await materialize(pageRow({ messageId: 'msg-released' }));

    assert({
      given: 'a materialization whose message write succeeded',
      should: 'delete the frame log, scoped to that messageId',
      actual: mockDeleteWhere.mock.calls.map((c) => c[0]),
      expected: [{ field: 'ai_stream_frames.message_id', value: 'msg-released' }],
    });
  });

  it('given a FAILED message write, leaves the frames alone so the next sweep can still recover', async () => {
    mockReturning.mockRejectedValueOnce(new Error('message write failed'));

    const settled = await materialize(pageRow());

    assert({
      given: 'a materialization whose message write threw',
      should: 'return false and delete nothing — the frames are still the only copy of the reply',
      actual: { settled, deletes: mockDeleteWhere.mock.calls.length },
      expected: { settled: false, deletes: 0 },
    });
  });

  it('releases the frames under the REAP CLAIM, not by bare messageId', async () => {
    await materialize(pageRow({ messageId: 'msg-fenced' }));

    assert({
      given: 'a materialization releasing its message\'s frames',
      should: 'verify the claim it holds before deleting — the local `writers` check is empty on every instance but the generator\'s',
      actual: mockIsReapClaimStillHeld.mock.calls.map(([c]) => (c as ReapClaim).messageId),
      expected: ['msg-fenced'],
    });
  });

  it('given a claim that no longer holds, does not delete the frames', async () => {
    mockIsReapClaimStillHeld.mockResolvedValue(false);

    await materialize(pageRow({ messageId: 'msg-still-generating' }));

    assert({
      given: 'a reap whose claim was superseded before the frame delete ran',
      should: 'leave the frame log intact — it belongs to a generation that is still writing it',
      actual: mockDeleteWhere.mock.calls.length,
      expected: 0,
    });
  });

  it('given a frame delete that fails, still settles the session row', async () => {
    mockDeleteWhere.mockRejectedValue(new Error('delete failed'));

    const settled = await materialize(pageRow());

    assert({
      given: 'a retention delete that throws after a confirmed message write',
      should: 'degrade to the retention backstop rather than un-succeed the materialization',
      actual: settled,
      expected: true,
    });
  });
});
