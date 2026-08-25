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

  it('given the row vanished mid-tick, should report `row_gone` rather than throwing', async () => {
    await db.delete(publishedApps).where(eq(publishedApps.id, appId));

    expect(
      await defaultAwakeMeterDeps.writeSettle({
        publishedAppId: appId,
        billedThrough: NOW,
        holdId: 'hold-next',
      }),
    ).toBe('row_gone');
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

describe.skipIf(dbSkipExplicitlyAllowed())('the billing CHECK constraints', () => {
  it('refuses an open awake window on a row with no wake boundary', async () => {
    // `published_apps_awake_window_needs_wake`: the weekly reconcile compares our
    // billed span from `lastWakeAt`, and a watermark without one cannot be
    // checked against anything.
    await expect(
      db.update(publishedApps).set({ awakeBilledThrough: NOW, lastWakeAt: null }).where(eq(publishedApps.id, appId)),
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
