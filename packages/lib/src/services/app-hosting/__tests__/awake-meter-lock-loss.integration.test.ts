/**
 * The awake meter when its advisory lock is lost mid-tick — against a REAL Postgres lock.
 *
 * The meter's lock is what stops two ticks pricing the same awake window from the same watermark:
 * `trackUsage` charges BEFORE the watermark advance, and the advance's monotonic guard lets a second
 * tick that read the same watermark through. If the lock connection's backend dies while tick A
 * runs, Postgres drops the session lock with it and tick B can acquire. Before the lock-lost signal,
 * A carried on and charged the same span B had just charged: a double charge.
 *
 * Billing is faked (it is the thing being counted); the LOCK is real, and so is the kill. Run with:
 *     bun run --filter '@pagespace/lib' test:integration -- src/services/app-hosting/__tests__/awake-meter-lock-loss.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool, type PoolClient } from 'pg';
import { requireDb } from '@pagespace/db/test/require-db';
import type { AdvisoryLockPool } from '@pagespace/db/advisory-lock';
import type { PublishedApp } from '@pagespace/db/schema/published-apps';
import { meterAwakePublishedAppsSerialized, type AwakeMeterDeps, type MeterAwakeRunResult } from '../awake-meter';

const NOW = new Date('2026-08-20T12:00:00.000Z');
const WINDOW_START = new Date(NOW.getTime() - 600_000);

let pool: Pool;
let admin: Client;
let dbAvailable = false;
const uncaught: unknown[] = [];
const onUncaught = (error: unknown) => {
  uncaught.push(error);
};

beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  admin = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await admin.connect();
    dbAvailable = true;
  } catch (error) {
    requireDb('awake-meter-lock-loss.integration.test.ts', error);
  }
  process.on('uncaughtException', onUncaught);
});

afterEach(() => {
  uncaught.length = 0;
});

afterAll(async () => {
  process.off('uncaughtException', onUncaught);
  if (dbAvailable) await admin.end();
  await pool.end();
});

/** The real pool, recording the backend pid of every lock connection it hands out. */
function trackingPool(pids: number[]): AdvisoryLockPool {
  return {
    connect: async () => {
      const client: PoolClient = await pool.connect();
      pids.push((client as PoolClient & { processID: number }).processID);
      return client;
    },
  };
}

async function terminateBackend(pid: number): Promise<void> {
  const killed = await admin.query<{ killed: boolean }>('SELECT pg_terminate_backend($1) AS killed', [pid]);
  expect(killed.rows[0]?.killed).toBe(true);
  for (let i = 0; i < 100; i += 1) {
    const alive = await admin.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid]);
    if (alive.rowCount === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // Let the client socket read the FATAL and the close, which aborts the lock-lost signal.
  await new Promise((resolve) => setTimeout(resolve, 200));
}

/** One awake app whose stored watermark both ticks read and the settle advances (monotonically, as `writeSettle` does). */
function fakeFleet() {
  const stored = { awakeBilledThrough: WINDOW_START };
  const charges: { publishedAppId: string; activeSeconds: number }[] = [];
  const row = (): PublishedApp =>
    ({
      id: 'app-1',
      driveId: 'drive-1',
      flyAppName: 'pgs-app-1',
      machineId: 'machine-1',
      status: 'running',
      tier: 'metered',
      imageDigest: 'sha256:abc',
      lastWakeAt: WINDOW_START,
      lastStopAt: null,
      awakeBilledThrough: stored.awakeBilledThrough,
      awakeHoldId: 'hold-1',
      awakeSecondsDay: null,
      awakeSecondsToday: 0,
      lastHitAt: null,
    }) as unknown as PublishedApp;

  const deps = (
    listRunningApps: () => Promise<PublishedApp[]>,
    resolveCharge: () => Promise<{ kind: 'user'; userId: string } | null> = async () => ({ kind: 'user', userId: 'payer-1' }),
  ): AwakeMeterDeps => ({
    isEnabled: () => true,
    billing: {
      resolveCharge,
      gate: async () => ({ allowed: true, holdId: 'hold-next' }),
      trackUsage: async ({ publishedAppId, activeSeconds }) => {
        charges.push({ publishedAppId, activeSeconds });
        return { persisted: true, creditsSettled: true };
      },
      releaseHold: async () => {},
      holdMatchesCharge: async () => true,
    },
    listRunningApps,
    findStopBoundary: async () => null,
    writeSettle: async ({ billedThrough }) => {
      // `GREATEST(...)`-style monotonic guard: a stale tick advancing to the same instant passes.
      if (billedThrough.getTime() < stored.awakeBilledThrough.getTime()) return 'superseded';
      stored.awakeBilledThrough = billedThrough;
      return 'advanced';
    },
    stampWindowStart: async () => 'stamped',
    closeAtBoundary: async () => ({ billedSeconds: 0, failed: false }),
    park: async () => {},
    dailyAwakeCapSeconds: () => 0,
    now: () => NOW,
    orgComputeBillingEpoch: async () => NOW,
  });
  return { row, deps, charges };
}

describe('meterAwakePublishedAppsSerialized when the meter lock is lost mid-tick', () => {
  it('given tick A loses its lock after reading the fleet and tick B then meters the same window, should charge that window exactly ONCE', async () => {
    if (!dbAvailable) return;
    const fleet = fakeFleet();
    const pids: number[] = [];
    const lockPool = trackingPool(pids);
    let tickB: MeterAwakeRunResult | undefined;

    const tickA = await meterAwakePublishedAppsSerialized(
      fleet.deps(async () => {
        const snapshot = [fleet.row()];
        // A has read the fleet under its lock. Now its lock connection dies, and B runs a whole
        // tick — it acquires the lock Postgres just released and prices the same window.
        const [lockPid] = pids;
        if (lockPid === undefined) throw new Error('tick A lock pid was not recorded');
        await terminateBackend(lockPid);
        tickB = await meterAwakePublishedAppsSerialized(fleet.deps(async () => [fleet.row()]), lockPool);
        return snapshot;
      }),
      lockPool,
    );

    expect(fleet.charges).toEqual([{ publishedAppId: 'app-1', activeSeconds: 600 }]);
    expect(tickB).toMatchObject({ outcome: 'metered', settled: 1 });
    // A stopped before pricing its stale snapshot.
    expect(tickA).toMatchObject({ outcome: 'metered', settled: 0 });
    expect(uncaught).toEqual([]);
  });

  it('given tick A loses its lock while pricing a row and tick B then meters the same window, should charge that window exactly ONCE', async () => {
    if (!dbAvailable) return;
    // The lock dies AFTER A's loop has started on the row, so only the last check before
    // `trackUsage` stands between A and a second charge.
    const fleet = fakeFleet();
    const pids: number[] = [];
    const lockPool = trackingPool(pids);
    let tickB: MeterAwakeRunResult | undefined;

    const tickA = await meterAwakePublishedAppsSerialized(
      fleet.deps(
        async () => [fleet.row()],
        async () => {
          const [lockPid] = pids;
          if (lockPid === undefined) throw new Error('tick A lock pid was not recorded');
          await terminateBackend(lockPid);
          tickB = await meterAwakePublishedAppsSerialized(fleet.deps(async () => [fleet.row()]), lockPool);
          return { kind: 'user' as const, userId: 'payer-1' };
        },
      ),
      lockPool,
    );

    expect(fleet.charges).toEqual([{ publishedAppId: 'app-1', activeSeconds: 600 }]);
    expect(tickB).toMatchObject({ outcome: 'metered', settled: 1 });
    expect(tickA).toMatchObject({ outcome: 'metered', settled: 0, failed: 1 });
    expect(uncaught).toEqual([]);
  });
});
