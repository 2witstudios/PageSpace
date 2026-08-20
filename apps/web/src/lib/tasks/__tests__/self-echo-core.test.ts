import { describe, it, expect } from 'vitest';
import {
  startSelfWrite,
  settleSelfWrite,
  deferredEchoesNeedRevalidation,
  classifyTaskEcho,
  pruneSelfWrites,
  hasInFlightSelfWrite,
  hasAnyInFlightSelfWrite,
  SELF_WRITE_TTL_MS,
  MAX_SELF_WRITES,
  type SelfWrite,
} from '../self-echo-core';

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

const NOW = 1_000_000;
const ME = 'user-me';
const STAMP = '2026-08-19T10:00:00.000Z';

const event = (over: Partial<{ taskId: string; userId: string; updatedAt: string | null }> = {}) => ({
  taskId: over.taskId ?? 'task-1',
  userId: over.userId ?? ME,
  data: { updatedAt: over.updatedAt === undefined ? STAMP : over.updatedAt ?? undefined },
});

describe('startSelfWrite / settleSelfWrite', () => {
  it('registers an unresolved record', () => {
    const next = startSelfWrite([], { writeId: 1, taskId: 'task-1', at: NOW }, NOW);
    assert({
      given: 'an empty log and a write starting',
      should: 'hold one unresolved record',
      actual: [next.length, next[0].updatedAt],
      expected: [1, null],
    });
  });

  it('stamps that record when the write resolves', () => {
    const started = startSelfWrite([], { writeId: 1, taskId: 'task-1', at: NOW }, NOW);
    const resolved = settleSelfWrite(started, 1, STAMP, NOW);
    assert({
      given: 'a write that started and then resolved',
      should: 'leave exactly one record, carrying the stamp',
      actual: [resolved.length, resolved[0].updatedAt],
      expected: [1, STAMP],
    });
  });

  it('drops the record when the write failed', () => {
    const started = startSelfWrite([], { writeId: 1, taskId: 'task-1', at: NOW }, NOW);
    assert({
      given: 'a write that failed',
      should: 'forget it, so later events for that task are not read as our echo',
      actual: settleSelfWrite(started, 1, null, NOW).length,
      expected: 0,
    });
  });

  it('settles only the write named, leaving a sibling on the SAME task open', () => {
    // The bug this keys on: two writes to one task overlap easily (a
    // double-clicked checkbox is complete-then-reopen). Keying the records on
    // taskId alone made the first to settle erase the second's marker, so the
    // "is anything still open?" guard reported false while a write was still
    // inside its updater — and the revalidation it gates could then race that
    // write's commit.
    let log = startSelfWrite([], { writeId: 1, taskId: 'task-1', at: NOW }, NOW);
    log = startSelfWrite(log, { writeId: 2, taskId: 'task-1', at: NOW }, NOW);
    const afterFirst = settleSelfWrite(log, 1, 'stamp-1', NOW);
    assert({
      given: 'two concurrent writes to the same task, the first settling',
      should: 'still report the second as in flight',
      actual: {
        anyInFlight: hasAnyInFlightSelfWrite(afterFirst, NOW),
        records: afterFirst.map((r) => [r.writeId, r.updatedAt]),
      },
      expected: { anyInFlight: true, records: [[1, 'stamp-1'], [2, null]] },
    });
  });

  it('keeps both stamps when two writes to one task resolve', () => {
    let log = startSelfWrite([], { writeId: 1, taskId: 'task-1', at: NOW }, NOW);
    log = startSelfWrite(log, { writeId: 2, taskId: 'task-1', at: NOW }, NOW);
    log = settleSelfWrite(log, 1, 'stamp-1', NOW);
    log = settleSelfWrite(log, 2, 'stamp-2', NOW);
    assert({
      given: 'two resolved writes to the same task inside the TTL',
      should: 'keep both so either echo can still be matched',
      actual: log.map((r) => r.updatedAt),
      expected: ['stamp-1', 'stamp-2'],
    });
  });

  it('does not mutate the input log', () => {
    const input: SelfWrite[] = [];
    startSelfWrite(input, { writeId: 1, taskId: 'task-1', at: NOW }, NOW);
    assert({
      given: 'an input log',
      should: 'still be empty',
      actual: input.length,
      expected: 0,
    });
  });
});

describe('deferredEchoesNeedRevalidation', () => {
  it('is false when every deferred echo turns out to have been ours', () => {
    // The server broadcasts before it responds, so our own echo routinely
    // arrives mid-write. Re-asking once the stamp is known is what keeps the
    // common case from ending in a full revalidation.
    const settled: SelfWrite[] = [{ writeId: 1, taskId: 'task-1', updatedAt: STAMP, at: NOW }];
    assert({
      given: 'a deferred echo whose stamp matches the write that produced it',
      should: 'need no revalidation',
      actual: deferredEchoesNeedRevalidation(settled, [event()], ME, NOW),
      expected: false,
    });
  });

  it('is true when a deferred echo belongs to somebody else', () => {
    const settled: SelfWrite[] = [{ writeId: 1, taskId: 'task-1', updatedAt: STAMP, at: NOW }];
    assert({
      given: 'a deferred echo carrying a stamp we never wrote',
      should: 'require a revalidation',
      actual: deferredEchoesNeedRevalidation(settled, [event({ updatedAt: 'someone-else' })], ME, NOW),
      expected: true,
    });
  });

  it('is true when any one of several is foreign', () => {
    const settled: SelfWrite[] = [{ writeId: 1, taskId: 'task-1', updatedAt: STAMP, at: NOW }];
    assert({
      given: 'one of our echoes and one foreign echo',
      should: 'require a revalidation',
      actual: deferredEchoesNeedRevalidation(
        settled, [event(), event({ updatedAt: 'other' })], ME, NOW,
      ),
      expected: true,
    });
  });

  it('is false for an empty queue', () => {
    assert({
      given: 'nothing deferred',
      should: 'need no revalidation',
      actual: deferredEchoesNeedRevalidation([], [], ME, NOW),
      expected: false,
    });
  });
});

describe('pruneSelfWrites', () => {
  it('drops records older than the TTL and keeps one exactly at the boundary out', () => {
    const records: SelfWrite[] = [
      { writeId: 7, taskId: 'old', updatedAt: STAMP, at: NOW - SELF_WRITE_TTL_MS },
      { writeId: 8, taskId: 'edge', updatedAt: STAMP, at: NOW - SELF_WRITE_TTL_MS + 1 },
      { writeId: 9, taskId: 'new', updatedAt: STAMP, at: NOW },
    ];
    assert({
      given: 'records at, just inside, and well inside the TTL window',
      should: 'drop only the one that has reached the TTL',
      actual: pruneSelfWrites(records, NOW).map((r) => r.taskId),
      expected: ['edge', 'new'],
    });
  });

  it('caps the log length, keeping the most recent', () => {
    const records: SelfWrite[] = Array.from({ length: MAX_SELF_WRITES + 5 }, (_, i) => ({
      writeId: i,
      taskId: `task-${i}`,
      updatedAt: STAMP,
      at: NOW,
    }));
    const pruned = pruneSelfWrites(records, NOW);
    assert({
      given: 'more records than the cap',
      should: 'keep the cap, ending with the newest',
      actual: [pruned.length, pruned[pruned.length - 1].taskId],
      expected: [MAX_SELF_WRITES, `task-${MAX_SELF_WRITES + 4}`],
    });
  });
});

describe('hasInFlightSelfWrite', () => {
  it('sees an unresolved write and ignores a resolved one', () => {
    const records: SelfWrite[] = [
      { writeId: 10, taskId: 'resolved', updatedAt: STAMP, at: NOW },
      { writeId: 11, taskId: 'pending', updatedAt: null, at: NOW },
    ];
    assert({
      given: 'one resolved and one unresolved record',
      should: 'report in-flight only for the unresolved task',
      actual: [
        hasInFlightSelfWrite(records, 'pending'),
        hasInFlightSelfWrite(records, 'resolved'),
      ],
      expected: [true, false],
    });
  });
});

describe('hasAnyInFlightSelfWrite', () => {
  it('is true while any write is unresolved, regardless of which task', () => {
    // The deferred revalidation is view-wide, so it must wait on EVERY open
    // write — not just the one that happened to settle.
    const records: SelfWrite[] = [
      { writeId: 12, taskId: 'a', updatedAt: STAMP, at: NOW },
      { writeId: 13, taskId: 'b', updatedAt: null, at: NOW },
    ];
    assert({
      given: 'one settled write and one still open, on different tasks',
      should: 'report an in-flight write',
      actual: hasAnyInFlightSelfWrite(records, NOW),
      expected: true,
    });
  });

  it('is false once everything has settled', () => {
    assert({
      given: 'only resolved writes',
      should: 'report none in flight',
      actual: hasAnyInFlightSelfWrite([{ writeId: 14, taskId: 'a', updatedAt: STAMP, at: NOW }], NOW),
      expected: false,
    });
  });

  it('ignores an abandoned write once its TTL has passed', () => {
    // A write whose component unmounted mid-flight never settles. Without the
    // TTL prune it would block the view's revalidation forever.
    const stale: SelfWrite[] = [{ writeId: 15, taskId: 'a', updatedAt: null, at: NOW - SELF_WRITE_TTL_MS }];
    assert({
      given: 'an unresolved write older than the TTL',
      should: 'stop counting it as in flight',
      actual: hasAnyInFlightSelfWrite(stale, NOW),
      expected: false,
    });
  });
});

describe('classifyTaskEcho', () => {
  const resolved: SelfWrite[] = [{ writeId: 16, taskId: 'task-1', updatedAt: STAMP, at: NOW }];

  it('recognises our own completed write', () => {
    assert({
      given: 'an echo whose taskId and updatedAt match a write we made',
      should: 'classify it as self so no revalidation runs',
      actual: classifyTaskEcho(resolved, event(), ME, NOW),
      expected: 'self',
    });
  });

  it('treats the same user in another tab as foreign', () => {
    // The most important case here. Suppressing on userId alone would make a
    // second tab of the same account permanently stale.
    assert({
      given: 'an event for the same task and user but a different updatedAt',
      should: 'classify it as foreign',
      actual: classifyTaskEcho(resolved, event({ updatedAt: '2026-08-19T11:00:00.000Z' }), ME, NOW),
      expected: 'foreign',
    });
  });

  it('treats another user as foreign', () => {
    assert({
      given: 'an event from a different user',
      should: 'classify it as foreign even with a matching stamp',
      actual: classifyTaskEcho(resolved, event({ userId: 'user-other' }), ME, NOW),
      expected: 'foreign',
    });
  });

  it('treats an event for a different task as foreign', () => {
    assert({
      given: 'an event for a task we did not write',
      should: 'classify it as foreign',
      actual: classifyTaskEcho(resolved, event({ taskId: 'task-2' }), ME, NOW),
      expected: 'foreign',
    });
  });

  it('reports in-flight rather than self while our PATCH is outstanding', () => {
    // The distinction matters: `self` means "already applied, ignore forever",
    // `self-in-flight` obliges the caller to revalidate once the write resolves.
    const inFlight: SelfWrite[] = [{ writeId: 17, taskId: 'task-1', updatedAt: null, at: NOW }];
    assert({
      given: 'an echo arriving before our own PATCH response',
      should: 'classify it as self-in-flight',
      actual: classifyTaskEcho(inFlight, event(), ME, NOW),
      expected: 'self-in-flight',
    });
  });

  it('stops matching a write once the TTL has elapsed', () => {
    const stale: SelfWrite[] = [{ writeId: 18, taskId: 'task-1', updatedAt: STAMP, at: NOW - SELF_WRITE_TTL_MS }];
    assert({
      given: 'a self-write that has reached the TTL',
      should: 'classify a matching echo as foreign',
      actual: classifyTaskEcho(stale, event(), ME, NOW),
      expected: 'foreign',
    });
  });

  it('treats an event with no taskId as foreign', () => {
    assert({
      given: 'a reorder-style event carrying no taskId',
      should: 'classify it as foreign so the list still revalidates',
      actual: classifyTaskEcho(resolved, { userId: ME, data: {} }, ME, NOW),
      expected: 'foreign',
    });
  });

  it('treats an unauthenticated viewer as receiving foreign events', () => {
    assert({
      given: 'no current user id',
      should: 'classify everything as foreign',
      actual: classifyTaskEcho(resolved, event(), null, NOW),
      expected: 'foreign',
    });
  });

  it('does not match on a non-string updatedAt', () => {
    assert({
      given: 'an event whose updatedAt is not a string',
      should: 'fall through to foreign rather than matching loosely',
      actual: classifyTaskEcho(
        resolved,
        { taskId: 'task-1', userId: ME, data: { updatedAt: 12345 } },
        ME,
        NOW,
      ),
      expected: 'foreign',
    });
  });
});
