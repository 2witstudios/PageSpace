import { describe, it, expect, beforeEach, vi } from 'vitest';
import { assert } from './riteway';

const { mockUpdateSet, mockUpdateWhere, mockReturning, mockLoggerWarn } = vi.hoisted(() => ({
  mockUpdateSet: vi.fn(),
  mockUpdateWhere: vi.fn(),
  mockReturning: vi.fn(),
  mockLoggerWarn: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    update: vi.fn(() => ({ set: mockUpdateSet })),
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(async () => []) })) })),
  },
}));

// Operators are mocked as identity-shaped objects (the house pattern) SO THAT THE TEST CAN ASSERT
// ON THE PREDICATE ITSELF. That matters more here than anywhere else in this change: the
// `user_id = <caller>` condition in the UPDATE below is the entire authorization story for a
// cross-instance abort. If it is ever dropped, nothing else in the system would notice — the
// abort would simply start working on other users' streams.
vi.mock('@pagespace/db/operators', () => ({
  and: vi.fn((...args: unknown[]) => ({ conds: args })),
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
  inArray: vi.fn((field: unknown, values: unknown) => ({ field, values })),
  isNotNull: vi.fn((field: unknown) => ({ isNotNull: field })),
}));

vi.mock('@pagespace/db/schema/ai-streams', () => ({
  aiStreamSessions: {
    messageId: 'ai_stream_sessions.message_id',
    streamId: 'ai_stream_sessions.stream_id',
    conversationId: 'ai_stream_sessions.conversation_id',
    userId: 'ai_stream_sessions.user_id',
    status: 'ai_stream_sessions.status',
    abortRequestedAt: 'ai_stream_sessions.abort_requested_at',
    startedAt: 'ai_stream_sessions.started_at',
    lastHeartbeatAt: 'ai_stream_sessions.last_heartbeat_at',
    parts: 'ai_stream_sessions.parts',
    completedAt: 'ai_stream_sessions.completed_at',
  },
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { ai: { info: vi.fn(), warn: mockLoggerWarn, error: vi.fn(), debug: vi.fn() } },
}));

import { markAbortRequested, awaitAbortSettled } from '../stream-abort-mark';
import type { SettleRow } from '../stream-abort-decisions';

interface Predicate {
  conds: Array<{ field?: string; value?: unknown }>;
}

const conditions = (): Predicate['conds'] =>
  (mockUpdateWhere.mock.calls[0][0] as Predicate).conds;

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
  mockUpdateWhere.mockReturnValue({ returning: mockReturning });
  mockReturning.mockResolvedValue([]);
});

describe('markAbortRequested — the authorization', () => {
  // THE test. The cross-instance abort works by writing an intent onto a row that ANOTHER web
  // instance will read and act on. If that write were not scoped to the caller's own streams, any
  // user holding any messageId could stop any other user's generation from any instance — a
  // remote kill switch, strictly worse than the bug being fixed. The WHERE clause IS the guard;
  // this asserts it exists.
  it('scopes the mark to the caller\'s own streams', async () => {
    await markAbortRequested({ messageId: 'msg-1', userId: 'user-a' });

    const userCondition = conditions().find((c) => c.field === 'ai_stream_sessions.user_id');

    assert({
      given: 'an abort request naming a stream',
      should: 'constrain the write to rows owned by the requesting user',
      actual: userCondition?.value,
      expected: 'user-a',
    });
  });

  // The forged / cross-user abort, end to end: user B names user A's stream.
  //
  // This one does NOT stub the answer — a test that simply asserted "the mock returned []" would
  // pass just as happily with the `user_id` predicate deleted, which is the exact regression it is
  // supposed to catch. So the fake below EVALUATES the WHERE clause the code actually built,
  // against a real row, the way Postgres would. Delete the predicate and this goes red.
  it('marks nothing when a user names a stream they do not own', async () => {
    const rowOwnedByUserA = {
      'ai_stream_sessions.message_id': 'msg-of-user-a',
      'ai_stream_sessions.user_id': 'user-a',
      'ai_stream_sessions.status': 'streaming',
    } as Record<string, unknown>;

    // Stands in for Postgres: the UPDATE ... RETURNING yields the row only if EVERY condition of
    // the predicate holds for it.
    mockReturning.mockImplementation(async () => {
      const predicate = mockUpdateWhere.mock.calls[0][0] as Predicate;
      const matches = predicate.conds.every(
        (cond) => rowOwnedByUserA[cond.field as string] === cond.value,
      );
      return matches ? [{ messageId: 'msg-of-user-a' }] : [];
    });

    assert({
      given: "user B naming user A's in-flight stream",
      should: 'mark nothing — the abort cannot cross users',
      actual: await markAbortRequested({ messageId: 'msg-of-user-a', userId: 'user-b' }),
      expected: [],
    });
  });

  // The other half of the same fake, so the test above cannot pass by matching nothing at all:
  // the OWNER's own abort request must still go through.
  it('marks the stream when its real owner asks for it', async () => {
    const rowOwnedByUserA = {
      'ai_stream_sessions.message_id': 'msg-of-user-a',
      'ai_stream_sessions.user_id': 'user-a',
      'ai_stream_sessions.status': 'streaming',
    } as Record<string, unknown>;

    mockReturning.mockImplementation(async () => {
      const predicate = mockUpdateWhere.mock.calls[0][0] as Predicate;
      const matches = predicate.conds.every(
        (cond) => rowOwnedByUserA[cond.field as string] === cond.value,
      );
      return matches ? [{ messageId: 'msg-of-user-a' }] : [];
    });

    assert({
      given: 'user A stopping their own in-flight stream',
      should: 'mark it for the owning instance to abort',
      actual: await markAbortRequested({ messageId: 'msg-of-user-a', userId: 'user-a' }),
      expected: ['msg-of-user-a'],
    });
  });

  it('only ever marks a stream that is still streaming', async () => {
    await markAbortRequested({ messageId: 'msg-1', userId: 'user-a' });

    const statusCondition = conditions().find((c) => c.field === 'ai_stream_sessions.status');

    assert({
      given: 'an abort request',
      should: 'not mark rows that already reached a terminal status',
      actual: statusCondition?.value,
      expected: 'streaming',
    });
  });

  // streamId is the name the client holds from the X-Stream-Id header, and so the one Stop uses
  // most. It is resolvable across instances ONLY because it is persisted on the row.
  it('resolves a stream by streamId', async () => {
    await markAbortRequested({ streamId: 'stream-1', userId: 'user-a' });

    const streamCondition = conditions().find((c) => c.field === 'ai_stream_sessions.stream_id');

    assert({
      given: 'an abort naming a streamId minted on another instance',
      should: 'resolve the row by its persisted stream_id',
      actual: streamCondition?.value,
      expected: 'stream-1',
    });
  });

  it('marks nothing when given no name at all', async () => {
    assert({
      given: 'an abort request with no messageId, streamId or conversationId',
      should: 'mark nothing rather than matching every row',
      actual: await markAbortRequested({ userId: 'user-a' }),
      expected: [],
    });
  });
});

describe('awaitAbortSettled', () => {
  // Effects are injected, so this drives the REAL polling loop against a real (in-memory) row
  // store. Nothing here is a mock's opinion of what the code did.
  const rowStore = (rows: SettleRow[]) => {
    const store = { rows, reads: 0 };
    return {
      store,
      readRows: async () => {
        store.reads += 1;
        return store.rows;
      },
    };
  };

  const NOW = new Date('2026-07-12T12:00:00Z').getTime();
  const streaming = (over: Partial<SettleRow> = {}): SettleRow => ({
    messageId: 'msg-1',
    status: 'streaming',
    startedAt: new Date(NOW - 30_000),
    lastHeartbeatAt: new Date(NOW - 5_000),
    ...over,
  });

  it('returns as soon as the owning instance stops the stream', async () => {
    const { store, readRows } = rowStore([streaming()]);

    // The owner consumes the mark and drives the row terminal between the first and second poll.
    const sleep = async () => {
      store.rows = [streaming({ status: 'aborted' })];
    };

    const outcome = await awaitAbortSettled({
      messageIds: ['msg-1'],
      readRows,
      sleep,
      now: () => NOW,
    });

    assert({
      given: 'an abort the owning instance consumes while we wait',
      should: 'confirm the stream stopped',
      actual: { aborted: outcome.aborted, code: outcome.code },
      expected: { aborted: ['msg-1'], code: 'aborted' },
    });
  });

  // The timeout must be real. A wait that loops forever on a stream nobody will ever stop would
  // hang the Stop button (and, via the takeover, every subsequent send on the conversation).
  it('gives up once the deadline passes, and says the stream is still running', async () => {
    const { readRows } = rowStore([streaming()]);
    let clock = NOW;

    const outcome = await awaitAbortSettled({
      messageIds: ['msg-1'],
      timeoutMs: 1_000,
      readRows,
      sleep: async () => { clock += 500; },
      now: () => clock,
    });

    assert({
      given: 'a stream that keeps beating and is never stopped',
      should: 'report it as still live rather than waiting forever',
      actual: { stillLive: outcome.stillLive, code: outcome.code },
      expected: { stillLive: ['msg-1'], code: 'unconfirmed' },
    });
  });

  it('does not poll at all when nothing was marked', async () => {
    const { store, readRows } = rowStore([]);

    const outcome = await awaitAbortSettled({ messageIds: [], readRows, now: () => NOW });

    expect(store.reads).toBe(0);
    assert({
      given: 'no stream was marked for abort',
      should: 'report not_found without touching the database',
      actual: outcome.code,
      expected: 'not_found',
    });
  });

  // A read failure means we cannot SEE whether it stopped — not that it did. Claiming success here
  // would tell the user their agent stopped when it may still be generating and billing.
  it('reports unconfirmed when the status read-back fails', async () => {
    const outcome = await awaitAbortSettled({
      messageIds: ['msg-1'],
      readRows: async () => { throw new Error('db down'); },
      now: () => NOW,
    });

    assert({
      given: 'the database is unreachable while confirming the abort',
      should: 'refuse to claim the stream stopped',
      actual: { aborted: outcome.aborted, code: outcome.code },
      expected: { aborted: [], code: 'unconfirmed' },
    });
  });
});
