/**
 * Awake-seconds metering against the REAL tables — the parts of this feature that
 * a mocked db cannot prove:
 *
 *  1. **The event mirror's idempotency.** `mirrorFlyMachineEvents` re-reads Fly's
 *     last-20 window on every start and stop, so it re-offers rows it has already
 *     written. Its `ON CONFLICT DO NOTHING` names a PARTIAL unique index, and
 *     Postgres only infers a partial index as the arbiter when its predicate is
 *     restated — get that wrong and every re-mirror THROWS rather than no-ops,
 *     turning a routine call into a mirroring outage. Only a real Postgres can
 *     tell the two apart.
 *  2. **The watermark's monotonic guard.** `writeSettle` uses `GREATEST` so a wake
 *     landing mid-tick is not dragged backward, and guards the HOLD that rides in
 *     the same statement on the same comparison. A hold overwritten there is
 *     stranded for its whole TTL, suppressing a real payer's spendable balance.
 *  3. **The CHECK constraints** that make an incoherent billing row
 *     unrepresentable rather than merely unwritten.
 *
 * Runs in CI (the Unit Tests job provides Postgres) and is deliberately NOT
 * excluded from the coverage run — a billing proof that never executes is worse
 * than no proof, because the green tick still appears. `requireDb` makes a missing
 * database a LOUD failure with one explicit opt-out (`ALLOW_SKIP_DB_TESTS=1`) that
 * CI never sets.
 *
 * Locally:
 *     DATABASE_URL=postgresql://user:password@localhost:5433/pagespace_test \
 *       bun run --filter '@pagespace/lib' test -- src/services/app-hosting/__tests__/awake-metering.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, eq, inArray, sql } from '@pagespace/db/operators';
import { requireDb, dbSkipExplicitlyAllowed } from '@pagespace/db/test/require-db';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { publishedApps, publishedAppMachineEvents } from '@pagespace/db/schema/published-apps';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { assert } from '../../sandbox/__tests__/riteway';
import { defaultAwakeMeterDeps } from '../awake-meter';
import {
  closeAppWindowAtBoundary,
  defaultAppLifecycleMeteringDeps,
  passThroughSettleLock,
  stopPublishedApp,
  type AppLifecycleMeteringDeps,
} from '../app-lifecycle-metering';
import { awakeSecondsFromEvents } from '../app-metering-core';
import {
  mirrorFlyMachineEvents,
  recordOrchestratorBoundary,
  findStopBoundarySince,
  listBoundaryEvents,
} from '../app-machine-events';
import type { MachineEvent } from '../../fly/flaps-client';

const ownerId = createId();
const driveId = createId();
const envId = createId();
const appId = createId();
const machineId = 'd8901e2f3a4b5c';
const flyAppName = `pgs-app-${appId}`;

const NOW = new Date('2026-08-20T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

let dbAvailable = true;

async function seedApp(over: Record<string, unknown> = {}): Promise<void> {
  await db.delete(publishedApps).where(eq(publishedApps.id, appId));
  await db.insert(publishedApps).values({
    id: appId,
    envId,
    driveId,
    ownerId,
    flyAppName,
    networkName: 'published-apps',
    subdomain: `awake-${appId}`,
    machineId,
    status: 'running',
    tier: 'metered',
    imageDigest: 'sha256:abc',
    lastWakeAt: ago(3_600_000),
    awakeBilledThrough: ago(600_000),
    awakeHoldId: 'hold-live',
    updatedAt: NOW,
    ...over,
  } as never);
}

async function readApp() {
  const [row] = await db
    .select({
      awakeBilledThrough: publishedApps.awakeBilledThrough,
      awakeHoldId: publishedApps.awakeHoldId,
      lastWakeAt: publishedApps.lastWakeAt,
      awakeSecondsDay: publishedApps.awakeSecondsDay,
      awakeSecondsToday: publishedApps.awakeSecondsToday,
    })
    .from(publishedApps)
    .where(eq(publishedApps.id, appId));
  return row;
}

function flyEvent(over: Partial<MachineEvent> = {}): MachineEvent {
  return {
    id: '01JABCDEF',
    type: 'start',
    status: 'started',
    timestamp: ago(1_800_000).getTime(),
    ...over,
  } as MachineEvent;
}

const ref = () => ({ publishedAppId: appId, flyAppName, machineId });

beforeAll(async () => {
  try {
    await db.execute(sql`SELECT 1`);
  } catch (error) {
    requireDb('awake-metering.integration.test.ts', error);
    dbAvailable = false;
    return;
  }
  await db
    .insert(users)
    .values({ id: ownerId, email: `awake-${ownerId}@test.local`, name: 'Drive Owner', updatedAt: new Date() })
    .onConflictDoNothing();
  await db
    .insert(drives)
    .values({ id: driveId, name: 'Awake Drive', slug: `awake-${driveId}`, ownerId, updatedAt: new Date() })
    .onConflictDoNothing();
  // A published app hangs off an ENVIRONMENT — that is the whole reason its payer
  // is the drive owner rather than its own `ownerId` column.
  await db
    .insert(driveEnvs)
    .values({ id: envId, driveId, name: 'Awake Env', createdBy: ownerId, updatedAt: new Date() })
    .onConflictDoNothing();
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await db.delete(publishedAppMachineEvents).where(eq(publishedAppMachineEvents.publishedAppId, appId));
  await seedApp();
});

afterAll(async () => {
  if (!dbAvailable) return;
  await db.delete(publishedAppMachineEvents).where(eq(publishedAppMachineEvents.publishedAppId, appId));
  await db.delete(publishedApps).where(eq(publishedApps.id, appId));
  await db.delete(driveEnvs).where(eq(driveEnvs.id, envId));
  await db.delete(drives).where(eq(drives.id, driveId));
  await db.delete(users).where(inArray(users.id, [ownerId]));
});

describe.skipIf(dbSkipExplicitlyAllowed())('the machine-event mirror — real table, real conflict arbiter', () => {
  it('RE-MIRRORING the same Fly window is a clean no-op, not a throw', async () => {
    // The partial unique index needs its predicate restated in ON CONFLICT for
    // Postgres to infer it as the arbiter. If it is not, this second call raises
    // "there is no unique or exclusion constraint matching the ON CONFLICT
    // specification" and every start/stop after the first stops mirroring.
    const events = [flyEvent({ id: 'ev-1' }), flyEvent({ id: 'ev-2', type: 'exit' })];

    const first = await mirrorFlyMachineEvents(ref(), events);
    const second = await mirrorFlyMachineEvents(ref(), events);

    assert({
      given: 'the same last-20 window read twice, as every start and stop does',
      should: 'insert each Fly event exactly once and never fail',
      actual: { first, second },
      expected: {
        first: { boundaries: 2, inserted: 2, failed: false },
        second: { boundaries: 2, inserted: 0, failed: false },
      },
    });
  });

  it('does NOT collapse our own orchestrator boundaries, which carry no Fly event id', async () => {
    // A plain (non-partial) unique index on (machineId, flyEventId) would permit
    // exactly ONE null-id row per machine and silently discard the primary
    // billing record this table exists to keep.
    await recordOrchestratorBoundary(ref(), 'start', ago(3_600_000));
    await recordOrchestratorBoundary(ref(), 'stop', ago(1_800_000));
    await recordOrchestratorBoundary(ref(), 'start', ago(900_000));

    const rows = await db
      .select({ id: publishedAppMachineEvents.id })
      .from(publishedAppMachineEvents)
      .where(
        and(
          eq(publishedAppMachineEvents.publishedAppId, appId),
          eq(publishedAppMachineEvents.origin, 'orchestrator'),
        ),
      );

    assert({
      given: 'three of our own start/stop calls on one machine',
      should: 'keep all three',
      actual: rows.length,
      expected: 3,
    });
  });

  it('drops a Fly event that is not a boundary, or whose timestamp is unusable', async () => {
    // An unrecognised type must not be guessed at, and a malformed timestamp must
    // not land dated to 1970 — the reconcile would read that as a decades-long
    // awake window.
    const result = await mirrorFlyMachineEvents(ref(), [
      flyEvent({ id: 'ev-restart', type: 'restart' }),
      flyEvent({ id: 'ev-bad-time', type: 'start', timestamp: 0 as never }),
      flyEvent({ id: '', type: 'start' }),
    ]);

    expect(result).toEqual({ boundaries: 0, inserted: 0, failed: false });
  });

  it('refuses an incoherent origin/event-id pair at the DATABASE, not merely in code', async () => {
    // `published_app_machine_events_fly_event_id_coherent`: our own call has no
    // Fly event id, and a mirrored Fly event is worthless without one.
    await expect(
      db.insert(publishedAppMachineEvents).values({
        publishedAppId: appId,
        flyAppName,
        machineId,
        origin: 'fly',
        action: 'start',
        flyEventId: null,
        occurredAt: NOW,
      } as never),
    ).rejects.toThrow();

    await expect(
      db.insert(publishedAppMachineEvents).values({
        publishedAppId: appId,
        flyAppName,
        machineId,
        origin: 'orchestrator',
        action: 'start',
        flyEventId: 'ev-x',
        occurredAt: NOW,
      } as never),
    ).rejects.toThrow();
  });
});

describe.skipIf(dbSkipExplicitlyAllowed())('findStopBoundarySince / listBoundaryEvents — real reads', () => {
  it('finds the LATEST stop after the watermark, never an earlier one', async () => {
    // Between `since` and now the machine may have stopped, been restarted by a
    // wake we did record, and stopped again. Closing at the earliest would
    // forgive the real awake time in between.
    await recordOrchestratorBoundary(ref(), 'stop', ago(1_500_000));
    await recordOrchestratorBoundary(ref(), 'stop', ago(300_000));

    const boundary = await findStopBoundarySince(machineId, ago(1_800_000), NOW);

    expect(boundary?.toISOString()).toBe(ago(300_000).toISOString());
  });

  it('ignores a stop at or before the watermark, and one dated in the future', async () => {
    await recordOrchestratorBoundary(ref(), 'stop', ago(3_600_000));
    await recordOrchestratorBoundary(ref(), 'stop', new Date(NOW.getTime() + 600_000));

    assert({
      given: 'a stop belonging to the previous window and one from a skewed clock',
      should: 'find neither',
      actual: await findStopBoundarySince(machineId, ago(1_800_000), NOW),
      expected: null,
    });
  });

  it('given a machine that was ALREADY UP at the window start, should seed an open start at the edge', async () => {
    // The false-alarm this guards: an app woken ten days ago and still running has
    // NO events inside a seven-day window, so it reconciled as zero local seconds
    // against a full week of `fly_instance_up` — a standing `under_billed` alert on
    // exactly the longest-running apps.
    const from = ago(7 * 24 * 60 * 60 * 1000);
    await recordOrchestratorBoundary(ref(), 'start', ago(10 * 24 * 60 * 60 * 1000));

    const boundaries = await listBoundaryEvents(appId, from, NOW);

    assert({
      given: 'a start ten days ago and nothing since',
      should: 'seed one start clamped to the window edge, not an empty stream',
      actual: boundaries.map((b) => ({ action: b.action, at: b.occurredAt.toISOString() })),
      expected: [{ action: 'start', at: from.toISOString() }],
    });
  });

  it('given the machine was DOWN at the window start, should seed nothing', async () => {
    // Claiming an app was running because we have no evidence either way would
    // invent awake time. Only a start as the last prior boundary seeds a window.
    const from = ago(7 * 24 * 60 * 60 * 1000);
    await recordOrchestratorBoundary(ref(), 'start', ago(12 * 24 * 60 * 60 * 1000));
    await recordOrchestratorBoundary(ref(), 'stop', ago(10 * 24 * 60 * 60 * 1000));

    assert({
      given: 'a stop as the last boundary before the window',
      should: 'read back no boundaries at all',
      actual: await listBoundaryEvents(appId, from, NOW),
      expected: [],
    });
  });

  it('given an app already up that STOPS inside the window, should bill the prefix rather than dropping it', async () => {
    // Without the seed this stop is unmatched, and `awakeSecondsFromEvents`
    // correctly ignores an unmatched stop — so the whole span silently vanished.
    const from = ago(7 * 24 * 60 * 60 * 1000);
    await recordOrchestratorBoundary(ref(), 'start', ago(9 * 24 * 60 * 60 * 1000));
    await recordOrchestratorBoundary(ref(), 'stop', ago(6 * 24 * 60 * 60 * 1000));

    const boundaries = await listBoundaryEvents(appId, from, NOW);

    expect(boundaries.map((b) => b.action)).toEqual(['start', 'stop']);
    // One full day of the window elapsed before the stop.
    expect(awakeSecondsFromEvents(boundaries, NOW)).toBe(24 * 60 * 60);
  });

  it('returns both origins as one ordered boundary stream', async () => {
    await recordOrchestratorBoundary(ref(), 'start', ago(3_600_000));
    await mirrorFlyMachineEvents(ref(), [flyEvent({ id: 'ev-stop', type: 'exit', timestamp: ago(1_800_000).getTime() })]);

    const boundaries = await listBoundaryEvents(appId, ago(7_200_000), NOW);

    assert({
      given: 'our own start and Fly’s own stop',
      should: 'read back in time order, both origins together',
      actual: boundaries.map((b) => b.action),
      expected: ['start', 'stop'],
    });
  });
});

describe.skipIf(dbSkipExplicitlyAllowed())('writeSettle — the monotonic watermark and its hold', () => {
  it('advances the watermark and installs the re-hold', async () => {
    const outcome = await defaultAwakeMeterDeps.writeSettle({
      publishedAppId: appId,
      billedThrough: NOW,
      billedSeconds: 600,
      holdId: 'hold-next',
    });

    const row = await readApp();
    assert({
      given: 'a settle for a window that is still ours',
      should: 'advance the watermark and carry the new reservation',
      actual: { outcome, billedThrough: row?.awakeBilledThrough?.toISOString(), holdId: row?.awakeHoldId },
      expected: { outcome: 'advanced', billedThrough: NOW.toISOString(), holdId: 'hold-next' },
    });
  });

  it('given a wake carried the row PAST this tick, should refuse the advance AND leave the wake’s hold intact', async () => {
    // The regression this guards: `awakeHoldId` used to be written
    // unconditionally beside the GREATEST-guarded watermark, so a superseded
    // settle clobbered the wake's live reservation — stranded for its whole TTL,
    // never settled, never released, suppressing the payer's spendable balance.
    const wakeInstant = new Date(NOW.getTime() + 300_000);
    await seedApp({ awakeBilledThrough: wakeInstant, awakeHoldId: 'hold-from-wake', lastWakeAt: wakeInstant });

    const outcome = await defaultAwakeMeterDeps.writeSettle({
      publishedAppId: appId,
      billedThrough: NOW,
      billedSeconds: 600,
      holdId: 'hold-next',
    });

    const row = await readApp();
    assert({
      given: 'a concurrent wake that opened a newer window mid-tick',
      should: 'keep the wake’s watermark and the wake’s hold',
      actual: { outcome, billedThrough: row?.awakeBilledThrough?.toISOString(), holdId: row?.awakeHoldId },
      expected: {
        outcome: 'superseded',
        billedThrough: wakeInstant.toISOString(),
        holdId: 'hold-from-wake',
      },
    });
  });

  it('given the row vanished mid-tick, should report `superseded` rather than throwing', async () => {
    await db.delete(publishedApps).where(eq(publishedApps.id, appId));

    expect(
      await defaultAwakeMeterDeps.writeSettle({
        publishedAppId: appId,
        billedThrough: NOW,
        billedSeconds: 600,
        holdId: 'hold-next',
      }),
    ).toBe('superseded');
  });

  it('given a STOP closed the window mid-tick, should refuse rather than REOPEN a window on a stopped row', async () => {
    // The regression this guards: an id-only UPDATE would compute
    // `GREATEST(NULL, billedThrough)` on the closed window and reopen it, installing
    // a hold that no later tick can settle or release — `listRunningApps` only ever
    // sees `running` rows, so it would be stranded until its TTL.
    await seedApp({ status: 'stopped', awakeBilledThrough: null, awakeHoldId: null, lastStopAt: NOW });

    const outcome = await defaultAwakeMeterDeps.writeSettle({
      publishedAppId: appId,
      billedThrough: NOW,
      billedSeconds: 600,
      holdId: 'hold-next',
    });

    const row = await readApp();
    assert({
      given: 'a stop that closed the window between this tick’s read and its write',
      should: 'leave the window closed and install no hold',
      actual: { outcome, billedThrough: row?.awakeBilledThrough, holdId: row?.awakeHoldId },
      expected: { outcome: 'superseded', billedThrough: null, holdId: null },
    });
  });
});

describe.skipIf(dbSkipExplicitlyAllowed())('writeSettle — the per-app daily awake counter', () => {
  it('adds the settled seconds to TODAY’s counter, in the same statement as the watermark', async () => {
    // Seconds that were charged but not counted are seconds the daily cap cannot
    // see, and bounding one app's daily spend is the cap's whole job.
    await defaultAwakeMeterDeps.writeSettle({
      publishedAppId: appId,
      billedThrough: NOW,
      billedSeconds: 600,
      holdId: 'hold-next',
    });

    const row = await readApp();
    assert({
      given: 'a settle of ten minutes',
      should: 'record the day and the seconds',
      actual: { day: row?.awakeSecondsDay, seconds: row?.awakeSecondsToday },
      expected: { day: '2026-08-20', seconds: 600 },
    });
  });

  it('ACCUMULATES within a day, and RESETS on the first settle of a new one', async () => {
    // The reset lives in the statement rather than in a preceding read, so a
    // counter can never be advanced against a day another writer already rolled.
    await seedApp({ awakeSecondsDay: '2026-08-20', awakeSecondsToday: 600 });
    await defaultAwakeMeterDeps.writeSettle({
      publishedAppId: appId,
      billedThrough: NOW,
      billedSeconds: 300,
      holdId: null,
    });
    const sameDay = await readApp();

    const nextDay = new Date('2026-08-21T00:05:00.000Z');
    await defaultAwakeMeterDeps.writeSettle({
      publishedAppId: appId,
      billedThrough: nextDay,
      billedSeconds: 120,
      holdId: null,
    });
    const rolled = await readApp();

    assert({
      given: 'a second settle the same day, then one after midnight UTC',
      should: 'add within the day and start over on the new one',
      actual: {
        same: { day: sameDay?.awakeSecondsDay, seconds: sameDay?.awakeSecondsToday },
        rolled: { day: rolled?.awakeSecondsDay, seconds: rolled?.awakeSecondsToday },
      },
      expected: {
        same: { day: '2026-08-20', seconds: 900 },
        rolled: { day: '2026-08-21', seconds: 120 },
      },
    });
  });

  it('given a SUPERSEDED settle, should leave the counter alone — those seconds belong to another window', async () => {
    // The counter rides the same guard as the watermark and the hold. Adding to a
    // row a wake has already carried past this tick would charge the new window's
    // budget for the old window's time.
    const wakeInstant = new Date(NOW.getTime() + 300_000);
    await seedApp({
      awakeBilledThrough: wakeInstant,
      lastWakeAt: wakeInstant,
      awakeSecondsDay: '2026-08-20',
      awakeSecondsToday: 600,
    });

    const outcome = await defaultAwakeMeterDeps.writeSettle({
      publishedAppId: appId,
      billedThrough: NOW,
      billedSeconds: 999,
      holdId: null,
    });

    const row = await readApp();
    assert({
      given: 'a wake that opened a newer window mid-tick',
      should: 'refuse the advance and add nothing to the day',
      actual: { outcome, seconds: row?.awakeSecondsToday },
      expected: { outcome: 'superseded', seconds: 600 },
    });
  });

  it('given a settle that billed NOTHING, should not roll the row onto a day it spent no seconds in', async () => {
    await seedApp({ awakeSecondsDay: null, awakeSecondsToday: 0 });

    await defaultAwakeMeterDeps.writeSettle({
      publishedAppId: appId,
      billedThrough: NOW,
      billedSeconds: 0,
      holdId: null,
    });

    const row = await readApp();
    assert({
      given: 'a zero-second settle on a row with no day',
      should: 'leave both counter columns untouched',
      actual: { day: row?.awakeSecondsDay, seconds: row?.awakeSecondsToday },
      expected: { day: null, seconds: 0 },
    });
  });
});

describe.skipIf(dbSkipExplicitlyAllowed())('stampWindowStart — opens a window only where there is none', () => {
  it('stamps a running row that carries no watermark, and seeds `lastWakeAt` with it', async () => {
    await seedApp({ awakeBilledThrough: null, awakeHoldId: null, lastWakeAt: null });

    const outcome = await defaultAwakeMeterDeps.stampWindowStart({
      publishedAppId: appId,
      at: NOW,
      holdId: 'hold-stamp',
    });

    const row = await readApp();
    assert({
      given: 'a `running` row with no billing window',
      should: 'open one at now, satisfying the wake-boundary CHECK',
      actual: {
        outcome,
        billedThrough: row?.awakeBilledThrough?.toISOString(),
        lastWakeAt: row?.lastWakeAt?.toISOString(),
        holdId: row?.awakeHoldId,
      },
      expected: {
        outcome: 'stamped',
        billedThrough: NOW.toISOString(),
        lastWakeAt: NOW.toISOString(),
        holdId: 'hold-stamp',
      },
    });
  });

  it('given a wake opened a window first, should REFUSE rather than drag the watermark backward', async () => {
    // The tick captures one clock then makes several awaits per row, so a wake
    // landing inside that span opens a window at a LATER instant. Stamping over
    // it would hand the next tick a span to re-bill and replace a live hold.
    const wakeInstant = new Date(NOW.getTime() + 300_000);
    await seedApp({ awakeBilledThrough: wakeInstant, awakeHoldId: 'hold-from-wake', lastWakeAt: wakeInstant });

    const outcome = await defaultAwakeMeterDeps.stampWindowStart({
      publishedAppId: appId,
      at: NOW,
      holdId: 'hold-stamp',
    });

    const row = await readApp();
    assert({
      given: 'a row that acquired a window between the read and the stamp',
      should: 'leave the wake’s window and hold untouched',
      actual: { outcome, billedThrough: row?.awakeBilledThrough?.toISOString(), holdId: row?.awakeHoldId },
      expected: {
        outcome: 'superseded',
        billedThrough: wakeInstant.toISOString(),
        holdId: 'hold-from-wake',
      },
    });
  });
});

describe.skipIf(dbSkipExplicitlyAllowed())('stopPublishedApp — the final settle against the real table', () => {
  /**
   * The stop seam with its world replaced and its DATABASE REAL: Fly is a no-op, the
   * ledger is a stub, the meter lock is already held (so no pool is taken), and the
   * clock is fixed. What is being proved is the statement it writes — the same
   * `dailyAwakeCounterPatch` the heartbeat's counter is judged against, which a
   * mocked-db unit test can only assert the SHAPE of.
   */
  function stopDeps(over: Partial<AppLifecycleMeteringDeps> = {}): AppLifecycleMeteringDeps {
    return {
      ...defaultAppLifecycleMeteringDeps,
      isEnabled: () => true,
      billing: {
        resolvePayerId: async () => ownerId,
        gate: async () => ({ allowed: true, holdId: 'hold-x' }),
        trackUsage: async () => {},
        releaseHold: async () => {},
      },
      startMachine: async () => {},
      stopMachine: async () => {},
      listMachineEvents: async () => [],
      serializeSettle: passThroughSettleLock,
      dailyAwakeCapSeconds: () => 0,
      now: () => NOW,
      ...over,
    };
  }

  it('closes the window AND counts the settled seconds on the app’s day', async () => {
    await seedApp({ awakeBilledThrough: ago(600_000), awakeSecondsDay: null, awakeSecondsToday: 0 });

    const result = await stopPublishedApp(appId, 'idle', stopDeps());

    const row = await readApp();
    assert({
      given: 'a ten-minute window closed by an idle stop',
      should: 'bill it, close the window and record the day’s seconds',
      actual: {
        billed: result.outcome === 'stopped' ? result.billedSeconds : null,
        billedThrough: row?.awakeBilledThrough,
        day: row?.awakeSecondsDay,
        seconds: row?.awakeSecondsToday,
      },
      expected: { billed: 600, billedThrough: null, day: '2026-08-20', seconds: 600 },
    });
  });

  it('ADDS to a counter the heartbeat already started today', async () => {
    // The stop and the heartbeat write the same counter through two different
    // statements; a stop that overwrote rather than added would forgive every second
    // the heartbeat had already counted, and the cap would never fire on a
    // long-running app.
    await seedApp({
      awakeBilledThrough: ago(600_000),
      awakeSecondsDay: '2026-08-20',
      awakeSecondsToday: 42_000,
    });

    await stopPublishedApp(appId, 'idle', stopDeps());

    expect((await readApp())?.awakeSecondsToday).toBe(42_600);
  });

  it('keys the counter on the TICK’s day, not on a repair boundary in a previous one', async () => {
    // The repair path closes at a MIRRORED boundary, which can sit in an earlier UTC
    // day. Keying the counter off that boundary would stamp a stale day, whose next
    // comparison reads as "nothing spent today" — the cap failing OPEN on exactly the
    // broken-lifecycle rows it exists to catch.
    const yesterday = new Date('2026-08-19T23:00:00.000Z');
    await seedApp({
      awakeBilledThrough: new Date('2026-08-19T22:00:00.000Z'),
      lastWakeAt: new Date('2026-08-19T21:00:00.000Z'),
      awakeSecondsDay: null,
      awakeSecondsToday: 0,
    });

    await closeAppWindowAtBoundary(
      (await db.select().from(publishedApps).where(eq(publishedApps.id, appId)))[0],
      yesterday,
      stopDeps(),
    );

    const row = await readApp();
    assert({
      given: 'a window repaired at a boundary in the previous UTC day',
      should: 'charge the seconds to the day the tick discovered them',
      actual: { day: row?.awakeSecondsDay, seconds: row?.awakeSecondsToday },
      expected: { day: '2026-08-20', seconds: 3600 },
    });
  });

  it('a `daily_cap` stop parks the row and records the reason the unpark sweep matches on', async () => {
    // The sweep that releases these apps keys on this exact `lastError` string —
    // an insolvency park and a cap park are the same `status`, and releasing the
    // wrong one hands a payer with no credits a running machine.
    await seedApp({ awakeBilledThrough: ago(600_000) });

    const result = await stopPublishedApp(appId, 'daily_cap', stopDeps());

    const [row] = await db
      .select({ status: publishedApps.status, lastError: publishedApps.lastError })
      .from(publishedApps)
      .where(eq(publishedApps.id, appId));
    assert({
      given: 'a stop for exceeding the daily budget',
      should: 'park the row with the reason on it',
      actual: {
        status: result.outcome === 'stopped' ? result.status : null,
        rowStatus: row?.status,
        lastError: row?.lastError,
      },
      expected: {
        status: 'parked',
        rowStatus: 'parked',
        lastError: 'parked: daily_awake_cap_exceeded',
      },
    });
  });
});

describe.skipIf(dbSkipExplicitlyAllowed())('the billing CHECK constraints', () => {
  it('refuses an open awake window on a row with no wake boundary', async () => {
    // `published_apps_awake_window_needs_wake`: the weekly reconcile compares our
    // billed span from `lastWakeAt`, and a watermark without one cannot be
    // checked against anything.
    await expect(
      db.update(publishedApps).set({ awakeBilledThrough: NOW, lastWakeAt: null }).where(eq(publishedApps.id, appId)),
    ).rejects.toThrow();
  });

  it('refuses a NEGATIVE daily awake counter', async () => {
    // `published_apps_awake_seconds_today_nonneg`: a negative counter is not a
    // small number, it is a corrupt one — and it hides a runaway app from exactly
    // the cap that exists to stop it.
    await expect(
      db.update(publishedApps).set({ awakeSecondsToday: -1 }).where(eq(publishedApps.id, appId)),
    ).rejects.toThrow();
  });

  it('refuses seconds counted against NO day', async () => {
    // `published_apps_awake_counter_needs_day`: seconds with no day cannot be
    // reset and cannot be judged — the cap would compare today's budget against an
    // accumulation of unknown age.
    await expect(
      db
        .update(publishedApps)
        .set({ awakeSecondsDay: null, awakeSecondsToday: 60 })
        .where(eq(publishedApps.id, appId)),
    ).rejects.toThrow();
  });

  it('refuses an image size the storage meter could not date', async () => {
    // `published_apps_image_size_measured_coherent`: a size with no timestamp
    // reads to the meter as "never measured" and bills the 0 floor forever while
    // the watermark advances over real rootfs.
    await expect(
      db
        .update(publishedApps)
        .set({ imageSizeBytes: 1_000_000_000, imageSizeMeasuredAt: null })
        .where(eq(publishedApps.id, appId)),
    ).rejects.toThrow();
  });

  it('defaults a new row’s storage watermark to now, so it can never bill retroactively', async () => {
    const [row] = await db
      .select({ storageLastBilledAt: publishedApps.storageLastBilledAt })
      .from(publishedApps)
      .where(eq(publishedApps.id, appId));

    expect(row?.storageLastBilledAt).toBeInstanceOf(Date);
    // Seeded moments ago, and certainly not before this suite started running.
    expect(row!.storageLastBilledAt.getTime()).toBeGreaterThan(Date.now() - 5 * 60_000);
  });
});
