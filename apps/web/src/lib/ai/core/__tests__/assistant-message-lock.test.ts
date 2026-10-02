import { describe, it, vi } from 'vitest';
import { assert } from './riteway';

vi.mock('@pagespace/db/db', () => ({ getAdvisoryLockPool: vi.fn() }));

import type { AdvisoryLockClient, AdvisoryLockPool } from '@pagespace/db/advisory-lock';
import { withAssistantMessageLock, AssistantMessageBusyError } from '../assistant-message-lock';

/** A pool whose try-lock answers from a script: true = acquired, false = busy. */
function scriptedPool(answers: boolean[]) {
  const queries: Array<{ text: string; params?: unknown[] }> = [];
  const pool: AdvisoryLockPool = {
    async connect(): Promise<AdvisoryLockClient> {
      return {
        async query(text, params) {
          queries.push({ text, params });
          if (text.includes('pg_try_advisory_lock')) return { rows: [{ acquired: answers.shift() ?? false }] };
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  return { pool, queries };
}

const noSleep = { sleep: async () => {} };

describe('withAssistantMessageLock', () => {
  it('runs the writer under a lock keyed by the message id and returns its result', async () => {
    const { pool, queries } = scriptedPool([true]);
    const result = await withAssistantMessageLock('msg-1', async () => 'written', { pool, ...noSleep });
    assert({
      given: 'a free lock',
      should: 'return the writer result, having locked and unlocked the message key',
      actual: {
        result,
        key: queries.find((q) => q.text.includes('pg_try_advisory_lock'))?.params,
        unlocked: queries.some((q) => q.text.includes('pg_advisory_unlock')),
      },
      expected: { result: 'written', key: ['assistant-message-parts:msg-1'], unlocked: true },
    });
  });

  it('waits for a busy lock instead of failing, and runs the writer exactly once', async () => {
    const { pool } = scriptedPool([false, false, true]);
    const fn = vi.fn(async () => 'ok');
    const sleep = vi.fn(async () => {});
    const result = await withAssistantMessageLock('msg-1', fn, { pool, sleep });
    assert({
      given: 'a lock held by another writer for two probes',
      should: 'back off, then run the writer once when it frees',
      actual: { result, runs: fn.mock.calls.length, waits: sleep.mock.calls.length },
      expected: { result: 'ok', runs: 1, waits: 2 },
    });
  });

  it('gives up with AssistantMessageBusyError once the wait budget is spent, never running the writer', async () => {
    const { pool } = scriptedPool([]);
    let clock = 0;
    const fn = vi.fn(async () => 'never');
    const error = await withAssistantMessageLock('msg-1', fn, {
      pool,
      maxWaitMs: 100,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    }).catch((e: unknown) => e);
    assert({
      given: 'a lock that never frees',
      should: 'reject with AssistantMessageBusyError and not run the writer',
      actual: { busy: error instanceof AssistantMessageBusyError, runs: fn.mock.calls.length },
      expected: { busy: true, runs: 0 },
    });
  });

  it('surfaces a lock-connection failure as a rejection, never running the writer', async () => {
    const boom = new Error('pool exhausted');
    const pool: AdvisoryLockPool = { connect: async () => { throw boom; } };
    const fn = vi.fn(async () => 'never');
    const error = await withAssistantMessageLock('msg-1', fn, { pool, ...noSleep }).catch((e: unknown) => e);
    assert({
      given: 'a lock pool that cannot connect',
      should: 'reject with that error and not run the writer',
      actual: { error, runs: fn.mock.calls.length },
      expected: { error: boom, runs: 0 },
    });
  });

  it("propagates the writer's own error after releasing the lock", async () => {
    const { pool, queries } = scriptedPool([true]);
    const boom = new Error('persist failed');
    const error = await withAssistantMessageLock('msg-1', async () => { throw boom; }, { pool, ...noSleep }).catch((e: unknown) => e);
    assert({
      given: 'a writer that throws',
      should: 'reject with its error and still unlock',
      actual: { error, unlocked: queries.some((q) => q.text.includes('pg_advisory_unlock')) },
      expected: { error: boom, unlocked: true },
    });
  });
});
