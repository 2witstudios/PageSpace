/**
 * The env storage-measurement seam — the write side of the meter that bills an
 * environment.
 *
 * These assertions are about WHICH ROW the bytes land on and WHICH GENERATION
 * they are CASed against, because those are the two things this module decides;
 * the `du`, its parse and its throttle belong to `refreshSessionStorageMeasurement`
 * and are covered by that module's own suite.
 *
 * The failure this guards is silent by construction: an env with no measurement
 * writer bills the never-measured 0 floor forever while the storage reconcile
 * keeps advancing its watermark. Nothing throws — the provisioner swallows this
 * seam by design, because a billing observation must never fail a provision —
 * and the only symptom is revenue that never arrives. So two things are pinned
 * here rather than left to whichever composition currently holds the deps: that
 * the bytes land on the right row, and that every path which fails to produce
 * them SAYS SO, naming the env.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockError, mockWarn } = vi.hoisted(() => ({ mockError: vi.fn(), mockWarn: vi.fn() }));
vi.mock('../../../logging/logger-config', () => ({
  loggers: { ai: { error: mockError, warn: mockWarn } },
}));
import { assert } from '../../sandbox/__tests__/riteway';
import { envStorageMeasureSeam, type EnvStorageMeasureStore } from '../env-storage-measure';
import type { SandboxHandle } from '../../sandbox/sandbox-host';

type Measurement = Parameters<EnvStorageMeasureStore['recordStorageMeasurement']>[0];

beforeEach(() => {
  mockError.mockClear();
  mockWarn.mockClear();
});

function makeStore(): { store: EnvStorageMeasureStore; writes: Measurement[] } {
  const writes: Measurement[] = [];
  return {
    writes,
    store: {
      recordStorageMeasurement: async (input) => {
        writes.push(input);
      },
    },
  };
}

/** An ALREADY-AWAKE handle reporting a 2GB tree — measurement never provisions or wakes. */
function makeHandle(
  over: { spriteInstanceId?: string | null; stdout?: string; throws?: boolean } = {},
): Pick<SandboxHandle, 'exec' | 'spriteInstanceId'> & { exec: ReturnType<typeof vi.fn> } {
  return {
    spriteInstanceId: over.spriteInstanceId === undefined ? 'inst-1' : over.spriteInstanceId,
    exec: vi.fn(async () => {
      if (over.throws) throw new Error('sandbox unreachable');
      return { exitCode: 0, stdout: over.stdout ?? '2000000000\t/workspace\n', stderr: '' };
    }),
  } as never;
}

describe('envStorageMeasureSeam', () => {
  it("persists the measured bytes against the ENV's own row id", async () => {
    const { store, writes } = makeStore();
    const measure = envStorageMeasureSeam(store);

    await measure({ holderId: 'env-42', handle: makeHandle() as never });

    assert({
      given: 'a freshly-provisioned env Sprite reporting 2GB written',
      should: "record those bytes on the env's row, keyed by the env id the provisioner named",
      actual: { envId: writes[0]?.envId, measuredBytes: writes[0]?.measuredBytes },
      expected: { envId: 'env-42', measuredBytes: 2_000_000_000 },
    });
  });

  it('CASes on the instance from the HANDLE, never on one read back from the row', async () => {
    const { store, writes } = makeStore();
    const measure = envStorageMeasureSeam(store);

    await measure({ holderId: 'env-42', handle: makeHandle({ spriteInstanceId: 'gen-2' }) as never });

    assert({
      given: 'a measurement taken on a specific Sprite generation',
      should: 'carry THAT generation to the writer, so the bytes cannot land on its replacement',
      actual: writes[0]?.spriteInstanceId,
      expected: 'gen-2',
    });
  });

  it('degrades to the liveness guard when the driver reports no instance id', async () => {
    const { store, writes } = makeStore();
    const measure = envStorageMeasureSeam(store);

    await measure({ holderId: 'env-42', handle: makeHandle({ spriteInstanceId: null }) as never });

    // Null is the most any caller can know without a generation id; the store's
    // `eqOrIsNull` matches the row's own null rather than never persisting.
    expect(writes[0]?.spriteInstanceId).toBeNull();
  });

  it('measures the subtree ONCE per call, and never wakes anything to do it', async () => {
    const { store } = makeStore();
    const handle = makeHandle();

    await envStorageMeasureSeam(store)({ holderId: 'env-42', handle: handle as never });

    expect(handle.exec).toHaveBeenCalledTimes(1);
    // `du -sxB1 --`: summary, one filesystem, ACTUAL allocated bytes, and `--` so
    // a path starting with `-` is never read as a flag.
    expect(handle.exec.mock.calls[0][0]).toMatchObject({ cmd: 'du', args: ['-sxB1', '--', '/workspace'] });
  });

  it('writes NOTHING when the sandbox cannot be reached — a billing observation must never fail a provision', async () => {
    const { store, writes } = makeStore();

    await expect(
      envStorageMeasureSeam(store)({ holderId: 'env-42', handle: makeHandle({ throws: true }) as never }),
    ).resolves.toBeUndefined();

    assert({
      given: 'a sandbox whose exec throws',
      should: 'leave the last good measurement untouched rather than persisting a guess',
      actual: writes.length,
      expected: 0,
    });
  });

  it('writes NOTHING when the output cannot be parsed', async () => {
    const { store, writes } = makeStore();

    await envStorageMeasureSeam(store)({ holderId: 'env-42', handle: makeHandle({ stdout: 'not a size\n' }) as never });

    expect(writes).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Every failure path must SAY SO. The provisioner swallows this seam's
  // rejection under a comment claiming "the seam already logs"; a silent seam
  // makes that comment false, and for an env — whose only measurement writer
  // this is — a lost reading means billing the 0 floor indefinitely.
  // -------------------------------------------------------------------------

  it('LOGS, naming the env, when the measurement produces no reading', async () => {
    const { store } = makeStore();

    await envStorageMeasureSeam(store)({ holderId: 'env-42', handle: makeHandle({ throws: true }) as never });

    assert({
      given: 'a sandbox whose exec throws, so no reading is produced',
      should: "warn once and name the env, so the failure is traceable to a row rather than only an aggregate count",
      actual: { calls: mockWarn.mock.calls.length, meta: mockWarn.mock.calls[0]?.[1] },
      expected: { calls: 1, meta: { envId: 'env-42' } },
    });
  });

  it('LOGS an error, naming the env, when the PERSIST itself rejects', async () => {
    const store: EnvStorageMeasureStore = {
      recordStorageMeasurement: async () => {
        throw new Error('db blip');
      },
    };

    // Still resolves: a billing observation must never fail a provision.
    await expect(
      envStorageMeasureSeam(store)({ holderId: 'env-99', handle: makeHandle() as never }),
    ).resolves.toBeUndefined();

    assert({
      given: 'a healthy sandbox whose measurement write rejects',
      should: 'log an ERROR naming the env — the one failure that leaves a NULL row behind a perfectly healthy Sprite',
      actual: { calls: mockError.mock.calls.length, meta: mockError.mock.calls[0]?.[2] },
      expected: { calls: 1, meta: { envId: 'env-99' } },
    });
  });

  it('stays SILENT on the happy path — a log per provision would be noise, not signal', async () => {
    const { store, writes } = makeStore();

    await envStorageMeasureSeam(store)({ holderId: 'env-42', handle: makeHandle() as never });

    expect({ writes: writes.length, errors: mockError.mock.calls.length, warns: mockWarn.mock.calls.length })
      .toEqual({ writes: 1, errors: 0, warns: 0 });
  });
});
