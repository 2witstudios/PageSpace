/**
 * The per-holder lock: distinctive keys, bounded retries, and the rule that
 * failing to lock is never an error.
 */
import { describe, it, expect, vi } from 'vitest';
import { assert } from '../../__tests__/riteway';
import type { AdvisoryLockClient, AdvisoryLockPool } from '@pagespace/db/advisory-lock';
import { createDevPreviewLock, devPreviewLockKeyFor, unlocked } from '../dev-preview-lock';

const HOLDER = { kind: 'env', id: 'env1' } as const;

/**
 * A pool whose try-lock answers from a scripted queue. `withAdvisoryLock`
 * issues `SELECT pg_try_advisory_lock(hashtext($1))`, so the boolean in the
 * first row is what decides acquisition.
 */
function fakePool(acquisitions: readonly boolean[], { connectThrows = false } = {}) {
  const keys: string[] = [];
  let call = 0;
  const pool: AdvisoryLockPool = {
    connect: async (): Promise<AdvisoryLockClient> => {
      if (connectThrows) throw new Error('pool exhausted');
      return {
        query: async (text: string, params?: unknown[]) => {
          if (text.includes('pg_try_advisory_lock')) {
            keys.push(String(params?.[0]));
            const acquired = acquisitions[call] ?? false;
            call += 1;
            return { rows: [{ acquired }] };
          }
          return { rows: [{}] };
        },
        release: () => {},
      };
    },
  };
  return { pool, keys };
}

describe('devPreviewLockKeyFor', () => {
  it('namespaces by feature and holder kind, so two holders can never collide', () => {
    assert({ given: 'an env holder', should: 'name the feature and kind', actual: devPreviewLockKeyFor({ kind: 'env', id: 'x' }), expected: 'dev-preview:env:x' });
    expect(devPreviewLockKeyFor({ kind: 'env', id: 'x' })).not.toBe(devPreviewLockKeyFor({ kind: 'workspace', id: 'x' }));
  });
});

describe('createDevPreviewLock', () => {
  it('runs the work under the holder key and returns its result', async () => {
    const { pool, keys } = fakePool([true]);
    const lock = createDevPreviewLock({ pool });
    assert({ given: 'a free lock', should: 'run and return', actual: await lock(HOLDER, async () => 'done'), expected: { outcome: 'acquired', result: 'done' } });
    assert({ given: 'the attempt', should: 'use the holder key', actual: keys, expected: ['dev-preview:env:env1'] });
  });

  it('retries a busy lock on the given schedule and gives up bounded — never waiting forever', async () => {
    const waits: number[] = [];
    const { pool } = fakePool([false, false, true]);
    const acquired = await createDevPreviewLock({ pool, retries: [10, 20, 30], wait: async (ms) => { waits.push(ms); } })(HOLDER, async () => 'ok');
    assert({ given: 'busy twice then free', should: 'acquire after two waits', actual: { acquired, waits }, expected: { acquired: { outcome: 'acquired', result: 'ok' }, waits: [10, 20] } });

    const busyWaits: number[] = [];
    const fn = vi.fn();
    const busy = await createDevPreviewLock({ pool: fakePool([false, false, false]).pool, retries: [10, 20], wait: async (ms) => { busyWaits.push(ms); } })(HOLDER, async () => { fn(); return 'never'; });
    assert({ given: 'busy on every attempt', should: 'report busy without running the work', actual: { busy, waits: busyWaits, ran: fn.mock.calls.length }, expected: { busy: { outcome: 'busy' }, waits: [10, 20], ran: 0 } });
  });

  it('a degraded lock pool reports busy and warns — it never throws into a user action or a detection frame', async () => {
    const warnings: string[] = [];
    const { pool } = fakePool([], { connectThrows: true });
    const outcome = await createDevPreviewLock({ pool, log: { warn: (m) => warnings.push(m) } })(HOLDER, async () => 'unreached');
    assert({ given: 'a pool that cannot connect', should: 'be busy, not an exception', actual: outcome, expected: { outcome: 'busy' } });
    assert({ given: 'the degradation', should: 'be warned about once', actual: warnings, expected: ['dev-preview: lock unavailable, proceeding unserialized'] });
  });

  it('the no-op lock always acquires (the default where serialization is optional)', async () => {
    assert({ given: 'the unlocked default', should: 'run the work', actual: await unlocked(HOLDER, async () => 7), expected: { outcome: 'acquired', result: 7 } });
  });
});
