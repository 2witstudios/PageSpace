import { describe, it, expect } from 'vitest';
import {
  recordSelfWrite,
  classifyTaskEcho,
  pruneSelfWrites,
  hasInFlightSelfWrite,
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

describe('recordSelfWrite', () => {
  it('appends an in-flight record', () => {
    const next = recordSelfWrite([], { taskId: 'task-1', updatedAt: null, at: NOW }, NOW);
    assert({
      given: 'an empty log and a write starting',
      should: 'hold one unresolved record',
      actual: [next.length, next[0].updatedAt],
      expected: [1, null],
    });
  });

  it('replaces the in-flight record when the write resolves', () => {
    const started = recordSelfWrite([], { taskId: 'task-1', updatedAt: null, at: NOW }, NOW);
    const resolved = recordSelfWrite(started, { taskId: 'task-1', updatedAt: STAMP, at: NOW }, NOW);
    assert({
      given: 'a write that started and then resolved',
      should: 'leave exactly one record, carrying the stamp',
      actual: [resolved.length, resolved[0].updatedAt],
      expected: [1, STAMP],
    });
  });

  it('keeps an earlier resolved record for the same task', () => {
    const first = recordSelfWrite([], { taskId: 'task-1', updatedAt: 'stamp-1', at: NOW }, NOW);
    const second = recordSelfWrite(first, { taskId: 'task-1', updatedAt: 'stamp-2', at: NOW }, NOW);
    assert({
      given: 'two resolved writes to the same task inside the TTL',
      should: 'keep both so either echo can still be matched',
      actual: second.map((r) => r.updatedAt),
      expected: ['stamp-1', 'stamp-2'],
    });
  });

  it('does not mutate the input log', () => {
    const input: SelfWrite[] = [];
    recordSelfWrite(input, { taskId: 'task-1', updatedAt: null, at: NOW }, NOW);
    assert({
      given: 'an input log',
      should: 'still be empty',
      actual: input.length,
      expected: 0,
    });
  });
});

describe('pruneSelfWrites', () => {
  it('drops records older than the TTL and keeps one exactly at the boundary out', () => {
    const records: SelfWrite[] = [
      { taskId: 'old', updatedAt: STAMP, at: NOW - SELF_WRITE_TTL_MS },
      { taskId: 'edge', updatedAt: STAMP, at: NOW - SELF_WRITE_TTL_MS + 1 },
      { taskId: 'new', updatedAt: STAMP, at: NOW },
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
      { taskId: 'resolved', updatedAt: STAMP, at: NOW },
      { taskId: 'pending', updatedAt: null, at: NOW },
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

describe('classifyTaskEcho', () => {
  const resolved: SelfWrite[] = [{ taskId: 'task-1', updatedAt: STAMP, at: NOW }];

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
    const inFlight: SelfWrite[] = [{ taskId: 'task-1', updatedAt: null, at: NOW }];
    assert({
      given: 'an echo arriving before our own PATCH response',
      should: 'classify it as self-in-flight',
      actual: classifyTaskEcho(inFlight, event(), ME, NOW),
      expected: 'self-in-flight',
    });
  });

  it('stops matching a write once the TTL has elapsed', () => {
    const stale: SelfWrite[] = [{ taskId: 'task-1', updatedAt: STAMP, at: NOW - SELF_WRITE_TTL_MS }];
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
