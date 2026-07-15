import { describe, it, expect, beforeEach, vi } from 'vitest';
import { assert } from './riteway';

const {
  mockUpdateSet,
  mockUpdateWhere,
  mockReturning,
  mockSelectWhere,
  mockLoggerWarn,
  mockMaterializeInterruptedStream,
} = vi.hoisted(() => ({
  mockUpdateSet: vi.fn(),
  mockUpdateWhere: vi.fn(),
  mockReturning: vi.fn(),
  mockSelectWhere: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockMaterializeInterruptedStream: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    update: vi.fn(() => ({ set: mockUpdateSet })),
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: mockSelectWhere })) })),
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

// Materialization is its own unit with its own tests (materialize-interrupted-stream.test.ts —
// where the #2022 never-overwrite-complete guard and the settle/broadcast steps are asserted).
// Stubbed here so these tests exercise what reconcileDeadStreamRows reads and hands off, not how
// a row is turned into an interrupted message.
vi.mock('@/lib/ai/core/materialize-interrupted-stream', () => ({
  materializeInterruptedStream: mockMaterializeInterruptedStream,
}));

import {
  markAbortRequested,
  markAbortRequestedAsOwner,
  awaitAbortSettled,
  readMarkedStreams,
  reconcileDeadStreamRows,
  clearAbortMarks,
} from '../stream-abort-mark';
import type { SettleRow } from '../stream-abort-decisions';

interface Predicate {
  conds: Array<{ field?: string; value?: unknown }>;
}

const conditions = (): Predicate['conds'] =>
  (mockUpdateWhere.mock.calls[0][0] as Predicate).conds;

// `.where(...)` is used two ways in this module: awaited directly (reconcile, clear) and chained
// into `.returning()` (the marks). So it must be BOTH a thenable and an object carrying
// `.returning` — mocking only one shape silently breaks the other.
const whereResult = () => Object.assign(Promise.resolve(undefined), { returning: mockReturning });

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
  mockUpdateWhere.mockImplementation(whereResult);
  mockReturning.mockResolvedValue([]);
  mockSelectWhere.mockResolvedValue([]);
});

const selectConditions = (): Predicate['conds'] =>
  (mockSelectWhere.mock.calls[0][0] as Predicate).conds;

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
      actual: (await markAbortRequested({ messageId: 'msg-of-user-a', userId: 'user-b' })).marked,
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
      actual: (await markAbortRequested({ messageId: 'msg-of-user-a', userId: 'user-a' })).marked,
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
      actual: (await markAbortRequested({ userId: 'user-a' })).marked,
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

// Every function below was previously mocked out at ALL of its call sites and had no test of its
// own. That is the "green light wired to nothing" failure: each writes or reads a SQL predicate
// whose deletion produces a severe, silent bug that the whole suite would sail through.
describe('markAbortRequested — what it actually writes', () => {
  // The six authorization tests above all inspect the WHERE clause. NONE of them looked at the
  // SET. Point this at the wrong column (or at `null`) and every cross-instance Stop becomes a
  // silent no-op — with the entire suite still green.
  it('writes the abort request onto the row', async () => {
    const now = new Date('2026-07-12T12:00:00Z');

    await markAbortRequested({ messageId: 'msg-1', userId: 'user-a', now });

    assert({
      given: 'an abort request for a stream',
      should: 'stamp abort_requested_at, which is the whole signal the owning instance reads',
      actual: mockUpdateSet.mock.calls[0][0],
      expected: { abortRequestedAt: now },
    });
  });

  // A write that never happened is NOT "nothing was in flight". The client stays SILENT on
  // not_found by design, so collapsing the two would mean: the DB is down, the Stop reaches
  // nobody, the agent keeps generating and billing, and the user is told nothing at all.
  it('reports a failed write as failed, never as an empty match', async () => {
    mockUpdateWhere.mockImplementation(() =>
      Object.assign(Promise.resolve(undefined), {
        returning: vi.fn().mockRejectedValue(new Error('db down')),
      }),
    );

    assert({
      given: 'the database refusing the write that records the abort',
      should: 'say the request FAILED, so the caller can warn instead of staying silent',
      actual: await markAbortRequested({ messageId: 'msg-1', userId: 'user-a' }),
      expected: { marked: [], failed: true },
    });
  });

  // The rolling-deploy hole: a stream started by the previous image has stream_id = NULL, so the
  // X-Stream-Id the client holds matches zero rows. Without the conversation it reads as not_found →
  // the client stays silent → the generation runs on and bills.
  it('marks by the conversation when a precise name matches nothing', async () => {
    mockReturning
      .mockResolvedValueOnce([])                       // by streamId — a legacy row has none
      .mockResolvedValueOnce([{ messageId: 'msg-1' }]); // by conversationId

    const result = await markAbortRequested({
      streamId: 'stream-1',
      conversationId: 'conv-1',
      userId: 'user-a',
    });

    const convConds = (mockUpdateWhere.mock.calls[1][0] as Predicate).conds;
    expect(convConds.find((c) => c.field === 'ai_stream_sessions.conversation_id')?.value).toBe('conv-1');
    // The authorization rides every branch. It must never be the loose one.
    expect(convConds.find((c) => c.field === 'ai_stream_sessions.user_id')?.value).toBe('user-a');
    assert({
      given: 'a streamId that resolves to no row (a stream from a pre-migration worker)',
      should: 'mark by the conversation rather than silently reporting nothing in flight',
      actual: result.marked,
      expected: ['msg-1'],
    });
  });

  // THE CARDINAL SIN, and the reason this is a UNION rather than a first-match.
  //
  // A client's streamId can be STALE — it holds the previous turn's until the new response headers
  // land — and a stale name is NOT the same as a name that resolves to nothing. During the tail of
  // onFinish (after the controller is unregistered, before the terminal write lands) the finished
  // stream's row STILL READS 'streaming'. So the stale name MATCHES. With first-match precedence
  // the search stopped right there, the conversation was never marked, and the generation that was
  // actually running — a later turn, possibly on another instance — was never asked to stop, while
  // the caller was told `not_found` (which the UI stays silent about).
  it('still marks the conversation when a STALE precise name matches a finishing row', async () => {
    mockReturning
      .mockResolvedValueOnce([{ messageId: 'msg-turn-1' }])  // the stale streamId DOES match: turn 1 is mid-onFinish
      .mockResolvedValueOnce([{ messageId: 'msg-turn-2' }]); // and turn 2 is the one actually generating

    const result = await markAbortRequested({
      streamId: 'stale-stream-turn-1',
      conversationId: 'conv-1',
      userId: 'user-a',
    });

    assert({
      given: "a Stop whose streamId names the previous turn, which is still finishing",
      should: 'mark the conversation too — never stop at the stale name and leave turn 2 running',
      actual: result.marked,
      expected: ['msg-turn-1', 'msg-turn-2'],
    });
  });

  it('does not mark a stream twice when two names resolve to the same row', async () => {
    mockReturning
      .mockResolvedValueOnce([{ messageId: 'msg-1' }])
      .mockResolvedValueOnce([{ messageId: 'msg-1' }]);

    assert({
      given: 'a streamId and a conversationId that name the same in-flight stream',
      should: 'report it once',
      actual: (await markAbortRequested({ streamId: 's1', conversationId: 'conv-1', userId: 'user-a' })).marked,
      expected: ['msg-1'],
    });
  });
});

describe('markAbortRequestedAsOwner — the takeover-only mark', () => {
  // This is the ONE function in the change that deliberately omits the user_id predicate, because
  // a second send on a SHARED conversation must be able to take over a co-member's generation. Its
  // only remaining guard is the status predicate. It must never be reachable from a client Stop.
  it('marks only rows that are still streaming', async () => {
    await markAbortRequestedAsOwner({ messageIds: ['msg-1'] });

    assert({
      given: 'a takeover marking in-flight rows',
      should: 'never re-mark a row that already reached a terminal status',
      actual: conditions().find((c) => c.field === 'ai_stream_sessions.status')?.value,
      expected: 'streaming',
    });
  });

  it('reports a failed write as failed', async () => {
    mockUpdateWhere.mockImplementation(() =>
      Object.assign(Promise.resolve(undefined), {
        returning: vi.fn().mockRejectedValue(new Error('db down')),
      }),
    );

    assert({
      given: 'the database refusing the takeover mark',
      should: 'say so — the send is about to generate alongside a live stream',
      actual: await markAbortRequestedAsOwner({ messageIds: ['msg-1'] }),
      expected: { marked: [], failed: true },
    });
  });
});

describe('readMarkedStreams — what the watcher is allowed to act on', () => {
  // THE most dangerous untested predicate in the change. Delete `isNotNull(abort_requested_at)` and
  // this returns EVERY in-flight row the instance owns — all of which decideWatcherActions then
  // matches (same messageId, same streamId, same owner: they are our own streams) — so the watcher
  // aborts every generation on the instance within a second of it starting. Silently.
  it('returns only rows that someone actually asked to abort', async () => {
    await readMarkedStreams({ messageIds: ['msg-1'] });

    assert({
      given: 'the watcher reading its own in-flight streams',
      should: 'return only rows carrying an abort request — never every stream it owns',
      actual: selectConditions().some((c) => 'isNotNull' in (c as object)),
      expected: true,
    });
  });

  it('returns only rows that are still streaming', async () => {
    await readMarkedStreams({ messageIds: ['msg-1'] });

    assert({
      given: 'the watcher reading marked rows',
      should: 'ignore rows that already reached a terminal status',
      actual: selectConditions().find((c) => c.field === 'ai_stream_sessions.status')?.value,
      expected: 'streaming',
    });
  });

  it('does not query at all when the instance owns no streams', async () => {
    await readMarkedStreams({ messageIds: [] });

    expect(mockSelectWhere).not.toHaveBeenCalled();
  });
});

describe('reconcileDeadStreamRows — materializes each dead row as an interrupted message', () => {
  // Only rows still 'streaming' may be reconciled. Drop this predicate and a stream that
  // terminated on its own between the caller's read and here would be picked up and
  // materialized a second time (materializeInterruptedStream's own guard makes that a no-op
  // rather than data corruption, but this SELECT is the first line of defense).
  it('reads only rows still marked streaming', async () => {
    mockSelectWhere.mockResolvedValueOnce([]);

    await reconcileDeadStreamRows({ messageIds: ['msg-dead'] });

    assert({
      given: 'messageIds the caller proved dead',
      should: 'only read rows still marked streaming — one that terminated on its own is left alone',
      actual: selectConditions().find((c) => c.field === 'ai_stream_sessions.status')?.value,
      expected: 'streaming',
    });
  });

  it('hands each row it reads to materializeInterruptedStream with its full parts snapshot', async () => {
    const parts = [{ type: 'text', text: 'partial reply' }];
    mockSelectWhere.mockResolvedValueOnce([
      { messageId: 'msg-dead', channelId: 'page-1', conversationId: 'conv-1', userId: 'user-1', parts },
    ]);

    await reconcileDeadStreamRows({ messageIds: ['msg-dead'] });

    assert({
      given: 'a dead row read fresh from the DB',
      should: 'materialize it as an interrupted message rather than just wiping the session row',
      actual: mockMaterializeInterruptedStream.mock.calls[0][0],
      expected: { messageId: 'msg-dead', channelId: 'page-1', conversationId: 'conv-1', userId: 'user-1', parts },
    });
  });

  it('materializes multiple dead rows independently', async () => {
    mockSelectWhere.mockResolvedValueOnce([
      { messageId: 'msg-a', channelId: 'page-1', conversationId: 'conv-1', userId: 'user-1', parts: [] },
      { messageId: 'msg-b', channelId: 'page-2', conversationId: 'conv-2', userId: 'user-2', parts: [] },
    ]);

    await reconcileDeadStreamRows({ messageIds: ['msg-a', 'msg-b'] });

    expect(mockMaterializeInterruptedStream).toHaveBeenCalledTimes(2);
  });

  it('does nothing when there is nothing to reconcile', async () => {
    await reconcileDeadStreamRows({ messageIds: [] });

    expect(mockSelectWhere).not.toHaveBeenCalled();
    expect(mockMaterializeInterruptedStream).not.toHaveBeenCalled();
  });

  it('warns and does not throw when the read itself fails', async () => {
    mockSelectWhere.mockRejectedValueOnce(new Error('db down'));

    await expect(reconcileDeadStreamRows({ messageIds: ['msg-dead'] })).resolves.toBeUndefined();
    expect(mockLoggerWarn).toHaveBeenCalled();
    expect(mockMaterializeInterruptedStream).not.toHaveBeenCalled();
  });
});

describe('clearAbortMarks', () => {
  it('clears the abort request', async () => {
    await clearAbortMarks({ messageIds: ['msg-1'] });

    assert({
      given: 'an unactionable mark',
      should: 'null it out, so the watcher stops re-reading it on every tick forever',
      actual: mockUpdateSet.mock.calls[0][0],
      expected: { abortRequestedAt: null },
    });
  });

  it('does nothing when there is nothing to clear', async () => {
    await clearAbortMarks({ messageIds: [] });

    expect(mockUpdateSet).not.toHaveBeenCalled();
  });
});
