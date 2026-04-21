import { describe, it, expect, vi, beforeEach } from 'vitest';

const { testState, createMockTxFn } = vi.hoisted(() => {
  const state = {
    executedSql: [] as Array<{ strings: readonly string[]; values: unknown[] }>,
    rowsByPattern: new Map<string, Array<Record<string, unknown>>>(),
  };

  const createMockTx = () => ({
    execute: (sqlObj: { strings: readonly string[]; values: unknown[] }) => {
      state.executedSql.push(sqlObj);
      const joined = sqlObj.strings.join('?');
      for (const [pattern, rows] of state.rowsByPattern) {
        if (joined.includes(pattern)) {
          return Promise.resolve({ rows });
        }
      }
      return Promise.resolve({ rows: [] });
    },
  });

  return { testState: state, createMockTxFn: createMockTx };
});

vi.mock('@pagespace/db', () => ({
  db: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    transaction: vi.fn().mockImplementation(async (callback: any) => {
      const tx = createMockTxFn();
      return callback(tx);
    }),
  },
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings: [...strings],
    values,
  }),
}));

import { db } from '@pagespace/db';
import { appendEvent } from '../appendEvent';

function joinedSql(): string[] {
  return testState.executedSql.map((s) => s.strings.join('?'));
}

function allValues(): unknown[] {
  return testState.executedSql.flatMap((s) => s.values);
}

const runId = 'run_abc';

beforeEach(() => {
  vi.clearAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(db.transaction).mockImplementation(async (callback: any) => {
    const tx = createMockTxFn();
    return callback(tx);
  });
  testState.executedSql.length = 0;
  testState.rowsByPattern.clear();
  // default: run exists with lastSeq = 0, status = pending
  testState.rowsByPattern.set('FROM agent_runs', [{ last_seq: 0, status: 'pending' }]);
});

describe('appendEvent', () => {
  describe('transaction and locking', () => {
    it('given an append, should run inside a single db.transaction', async () => {
      await appendEvent({ runId, type: 'text-segment', payload: { text: 'hi' } });
      expect(db.transaction).toHaveBeenCalledOnce();
    });

    it('given an append, should acquire pg_advisory_xact_lock scoped to the runId as the first SQL', async () => {
      await appendEvent({ runId, type: 'text-segment', payload: { text: 'hi' } });
      const first = joinedSql()[0] ?? '';
      expect(first).toContain('pg_advisory_xact_lock');
      expect(first).toContain('hashtextextended');
      const firstValues = testState.executedSql[0].values;
      expect(firstValues).toContain(runId);
    });

    it('given two appends on different runIds, should issue distinct lock values', async () => {
      await appendEvent({ runId: 'run_a', type: 'text-segment', payload: { text: 'x' } });
      testState.rowsByPattern.set('FROM agent_runs', [{ last_seq: 0, status: 'pending' }]);
      const firstLockValuesA = testState.executedSql[0].values;
      testState.executedSql.length = 0;

      await appendEvent({ runId: 'run_b', type: 'text-segment', payload: { text: 'y' } });
      const firstLockValuesB = testState.executedSql[0].values;

      expect(firstLockValuesA).not.toEqual(firstLockValuesB);
    });
  });

  describe('seq assignment', () => {
    it('given lastSeq=0 in the row, should assign seq=1 and return it', async () => {
      const result = await appendEvent({
        runId,
        type: 'text-segment',
        payload: { text: 'hi' },
      });
      expect(result.seq).toBe(1);
    });

    it('given lastSeq=7 in the row, should assign seq=8', async () => {
      testState.rowsByPattern.set('FROM agent_runs', [{ last_seq: 7, status: 'streaming' }]);
      const result = await appendEvent({
        runId,
        type: 'text-segment',
        payload: { text: 'hi' },
      });
      expect(result.seq).toBe(8);
    });

    it('given the runId does not exist, should throw a descriptive error', async () => {
      testState.rowsByPattern.set('FROM agent_runs', []);
      await expect(
        appendEvent({ runId: 'run_missing', type: 'text-segment', payload: { text: 'x' } }),
      ).rejects.toThrow(/runId.*run_missing/);
    });

    it('given an append, should bump agent_runs.lastSeq to the assigned seq', async () => {
      testState.rowsByPattern.set('FROM agent_runs', [{ last_seq: 4, status: 'streaming' }]);
      await appendEvent({ runId, type: 'text-segment', payload: { text: 'hi' } });
      const updateSql = joinedSql().find((s) => s.includes('UPDATE agent_runs'));
      expect(updateSql).toBeDefined();
      expect(updateSql).toContain('"lastSeq"');
      expect(allValues()).toContain(5);
    });
  });

  describe('row write', () => {
    it('given an append, should insert into agent_run_events with runId, seq, type, payload', async () => {
      const payload = { text: 'hello' };
      await appendEvent({ runId, type: 'text-segment', payload });
      const insertSql = joinedSql().find((s) => s.includes('INSERT INTO agent_run_events'));
      expect(insertSql).toBeDefined();
      expect(allValues()).toContain(runId);
      expect(allValues()).toContain(1);
      expect(allValues()).toContain('text-segment');
      expect(allValues()).toContain(JSON.stringify(payload));
    });
  });

  describe('heartbeat and status', () => {
    it('given any append, should update lastHeartbeatAt', async () => {
      await appendEvent({ runId, type: 'text-segment', payload: { text: 'hi' } });
      const updateSql = joinedSql().find((s) => s.includes('UPDATE agent_runs'));
      expect(updateSql).toContain('"lastHeartbeatAt"');
    });

    it('given a non-terminal append while status=pending, should transition status to streaming', async () => {
      testState.rowsByPattern.set('FROM agent_runs', [{ last_seq: 0, status: 'pending' }]);
      await appendEvent({ runId, type: 'text-segment', payload: { text: 'hi' } });
      expect(allValues()).toContain('streaming');
    });

    it('given a finish event, should transition status to completed and set completedAt', async () => {
      testState.rowsByPattern.set('FROM agent_runs', [{ last_seq: 3, status: 'streaming' }]);
      await appendEvent({
        runId,
        type: 'finish',
        payload: { tokenUsageInput: 10, tokenUsageOutput: 20 },
      });
      expect(allValues()).toContain('completed');
      const updateSql = joinedSql().find((s) => s.includes('UPDATE agent_runs'));
      expect(updateSql).toContain('"completedAt"');
    });

    it('given an error event, should transition status to failed and record error message', async () => {
      testState.rowsByPattern.set('FROM agent_runs', [{ last_seq: 2, status: 'streaming' }]);
      await appendEvent({
        runId,
        type: 'error',
        payload: { message: 'boom' },
      });
      expect(allValues()).toContain('failed');
      expect(allValues()).toContain('boom');
    });

    it('given an aborted event, should transition status to aborted', async () => {
      testState.rowsByPattern.set('FROM agent_runs', [{ last_seq: 5, status: 'streaming' }]);
      await appendEvent({ runId, type: 'aborted', payload: {} });
      expect(allValues()).toContain('aborted');
    });
  });

  describe('pg_notify', () => {
    it('given an append, should emit pg_notify on channel agent_run_events inside the same transaction', async () => {
      await appendEvent({ runId, type: 'text-segment', payload: { text: 'hi' } });
      const notifySql = joinedSql().find((s) => s.includes('pg_notify'));
      expect(notifySql).toBeDefined();
      expect(notifySql).toContain('agent_run_events');
    });

    it('given an append, should include runId, seq, and type in the notify payload', async () => {
      await appendEvent({ runId, type: 'tool-input', payload: { callId: 'c1', toolName: 't', input: {} } });
      const notifyIdx = joinedSql().findIndex((s) => s.includes('pg_notify'));
      const notifyValues = testState.executedSql[notifyIdx].values.map(String).join('|');
      expect(notifyValues).toContain(runId);
      expect(notifyValues).toContain('1');
      expect(notifyValues).toContain('tool-input');
    });
  });
});
