import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  getActivityLogArchivalConfig,
  shouldContinueArchiving,
  archiveActivityLogs,
} from './activity-log-archival';

type DB = NodePgDatabase<Record<string, unknown>>;

const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.ACTIVITY_LOGS_ARCHIVE_DAYS;
  delete process.env.ACTIVITY_LOGS_ARCHIVE_BATCH_SIZE;
  delete process.env.ACTIVITY_LOGS_ARCHIVE_MAX_RUN_MS;
});

afterEach(() => {
  process.env = originalEnv;
});

/**
 * Fake db that returns a scripted sequence of id batches from the select chain
 * and records every payload passed to `.set()` on the update chain. No real DB.
 */
function makeDb(batches: string[][]) {
  let call = 0;
  const setPayloads: unknown[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => (batches[call++] ?? []).map((id) => ({ id })),
          }),
        }),
      }),
    }),
    update: () => ({
      set: (payload: unknown) => {
        setPayloads.push(payload);
        return { where: async () => undefined };
      },
    }),
  };
  return { db: db as unknown as DB, setPayloads };
}

describe('getActivityLogArchivalConfig', () => {
  it('given_noEnvVars_returnsDefaults', () => {
    expect(getActivityLogArchivalConfig()).toEqual({
      archiveDays: 365,
      batchSize: 1000,
      maxRunMs: 25000,
    });
  });

  it('given_validEnvVars_usesThem', () => {
    process.env.ACTIVITY_LOGS_ARCHIVE_DAYS = '180';
    process.env.ACTIVITY_LOGS_ARCHIVE_BATCH_SIZE = '500';
    process.env.ACTIVITY_LOGS_ARCHIVE_MAX_RUN_MS = '10000';
    expect(getActivityLogArchivalConfig()).toEqual({
      archiveDays: 180,
      batchSize: 500,
      maxRunMs: 10000,
    });
  });

  it('given_invalidOrEmptyEnvVars_fallsBackPerField', () => {
    process.env.ACTIVITY_LOGS_ARCHIVE_DAYS = '0';
    process.env.ACTIVITY_LOGS_ARCHIVE_BATCH_SIZE = '-1';
    process.env.ACTIVITY_LOGS_ARCHIVE_MAX_RUN_MS = 'nope';
    expect(getActivityLogArchivalConfig()).toEqual({
      archiveDays: 365,
      batchSize: 1000,
      maxRunMs: 25000,
    });
  });
});

describe('shouldContinueArchiving', () => {
  it('given_drainedBatch_stops', () => {
    expect(
      shouldContinueArchiving({ lastBatchSize: 3, batchSize: 1000, elapsedMs: 0, maxRunMs: 25000 }),
    ).toBe(false);
  });

  it('given_wallClockExhausted_stops', () => {
    expect(
      shouldContinueArchiving({ lastBatchSize: 1000, batchSize: 1000, elapsedMs: 25000, maxRunMs: 25000 }),
    ).toBe(false);
  });

  it('given_fullBatchAndTimeRemaining_continues', () => {
    expect(
      shouldContinueArchiving({ lastBatchSize: 1000, batchSize: 1000, elapsedMs: 10, maxRunMs: 25000 }),
    ).toBe(true);
  });
});

describe('archiveActivityLogs', () => {
  it('given_agedUnarchivedRows_flipsIsArchivedInBatches', async () => {
    // Two full batches then a partial batch drains the loop.
    const { db, setPayloads } = makeDb([['a', 'b'], ['c', 'd'], ['e']]);

    const result = await archiveActivityLogs(db, {
      archiveDays: 365,
      batchSize: 2,
      maxRunMs: 60_000,
    });

    expect(result).toEqual({ table: 'activity_logs', archived: 5, batches: 3 });
    expect(setPayloads).toHaveLength(3);
  });

  it('given_anyBatch_updatePayloadContainsOnlyIsArchived_neverHashChainFields', async () => {
    const { db, setPayloads } = makeDb([['a']]);

    await archiveActivityLogs(db, { archiveDays: 365, batchSize: 1000, maxRunMs: 60_000 });

    for (const payload of setPayloads) {
      expect(payload).toEqual({ isArchived: true });
      const keys = Object.keys(payload as object);
      expect(keys).toEqual(['isArchived']);
      for (const forbidden of ['previousLogHash', 'logHash', 'chainSeed', 'chainSeq']) {
        expect(keys).not.toContain(forbidden);
      }
    }
  });

  it('given_emptyFirstBatch_performsZeroUpdates', async () => {
    const { db, setPayloads } = makeDb([[]]);

    const result = await archiveActivityLogs(db, { archiveDays: 365, batchSize: 1000, maxRunMs: 60_000 });

    expect(result).toEqual({ table: 'activity_logs', archived: 0, batches: 0 });
    expect(setPayloads).toHaveLength(0);
  });

  it('given_wallClockBudgetExhaustedMidRun_stopsEarlyKeepingCount', async () => {
    // Full batches available, but the injected clock jumps past maxRunMs after batch 1.
    const { db } = makeDb([['a', 'b'], ['c', 'd'], ['e', 'f']]);
    let t = 0;
    const clock = () => {
      const v = t;
      t += 30_000; // each read advances 30s
      return v;
    };

    const result = await archiveActivityLogs(db, {
      archiveDays: 365,
      batchSize: 2,
      maxRunMs: 25_000,
      clock,
    });

    expect(result.archived).toBe(2);
    expect(result.batches).toBe(1);
  });
});
