import { describe, it, expect, vi, beforeEach } from 'vitest';

const { staleRowsState, executedSql, FakeTerminalRunError } = vi.hoisted(() => {
  class FakeTerminalRunError extends Error {
    constructor(runId: string) {
      super(`appendEvent: runId "${runId}" is already terminal (status=completed)`);
      this.name = 'TerminalRunError';
    }
  }
  return {
    staleRowsState: { rows: [] as Array<{ id: string }> },
    executedSql: [] as Array<{ strings: readonly string[]; values: unknown[] }>,
    FakeTerminalRunError,
  };
});

vi.mock('@pagespace/db', () => ({
  db: {
    execute: vi.fn(async (sqlObj: { strings: readonly string[]; values: unknown[] }) => {
      executedSql.push(sqlObj);
      return { rows: staleRowsState.rows };
    }),
  },
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings: [...strings],
    values,
  }),
}));

const appendEventMock = vi.fn();
vi.mock('../appendEvent', () => ({
  appendEvent: (...args: unknown[]) => appendEventMock(...args),
  TerminalRunError: FakeTerminalRunError,
}));

import { reapStaleRuns } from '../reapStaleRuns';

beforeEach(() => {
  staleRowsState.rows = [];
  executedSql.length = 0;
  appendEventMock.mockReset();
  appendEventMock.mockResolvedValue({ seq: 1 });
});

describe('reapStaleRuns', () => {
  it('given no stale runs, should return an empty list without calling appendEvent', async () => {
    const result = await reapStaleRuns();
    expect(result.reapedRunIds).toEqual([]);
    expect(appendEventMock).not.toHaveBeenCalled();
  });

  it('given two stale runs, should append an error event for each and return their ids', async () => {
    staleRowsState.rows = [{ id: 'run_a' }, { id: 'run_b' }];
    const result = await reapStaleRuns();
    expect(result.reapedRunIds.sort()).toEqual(['run_a', 'run_b']);
    expect(appendEventMock).toHaveBeenCalledTimes(2);
    const calledRunIds = appendEventMock.mock.calls.map((c) => (c[0] as { runId: string }).runId).sort();
    expect(calledRunIds).toEqual(['run_a', 'run_b']);
    for (const call of appendEventMock.mock.calls) {
      expect(call[0]).toMatchObject({ type: 'error' });
    }
  });

  it('given the default threshold, should filter by status=streaming and a 60s heartbeat cutoff', async () => {
    await reapStaleRuns();
    const joined = executedSql[0].strings.join('?');
    expect(joined).toContain("status = 'streaming'");
    expect(joined).toContain('lastHeartbeatAt');
    expect(executedSql[0].values).toContain(60);
  });

  it('given a custom threshold of 30 seconds, should pass 30 into the interval', async () => {
    await reapStaleRuns({ staleThresholdSec: 30 });
    expect(executedSql[0].values).toContain(30);
  });

  it('given appendEvent throws for one run, should continue reaping the rest and exclude the failed one from the result', async () => {
    staleRowsState.rows = [{ id: 'run_a' }, { id: 'run_b' }, { id: 'run_c' }];
    appendEventMock.mockImplementation(async (input: { runId: string }) => {
      if (input.runId === 'run_b') throw new Error('append failed');
      return { seq: 1 };
    });
    const result = await reapStaleRuns();
    expect(result.reapedRunIds.sort()).toEqual(['run_a', 'run_c']);
  });

  it('given appendEvent throws TerminalRunError because the worker finished first, should swallow the error and not include the run in the reaped list', async () => {
    staleRowsState.rows = [{ id: 'run_finished' }, { id: 'run_still_stuck' }];
    appendEventMock.mockImplementation(async (input: { runId: string }) => {
      if (input.runId === 'run_finished') throw new FakeTerminalRunError(input.runId);
      return { seq: 1 };
    });
    const result = await reapStaleRuns();
    expect(result.reapedRunIds).toEqual(['run_still_stuck']);
  });

  it('given a stale run, should carry the threshold into the error message so operators can tell reaps apart from model errors', async () => {
    staleRowsState.rows = [{ id: 'run_x' }];
    await reapStaleRuns({ staleThresholdSec: 45 });
    const payload = appendEventMock.mock.calls[0][0] as { payload: { message: string } };
    expect(payload.payload.message).toMatch(/45/);
    expect(payload.payload.message).toMatch(/heartbeat/i);
  });
});
