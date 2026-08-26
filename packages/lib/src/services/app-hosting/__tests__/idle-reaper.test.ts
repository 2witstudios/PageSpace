import { describe, it, expect, vi } from 'vitest';
import { assert } from '../../sandbox/__tests__/riteway';
import {
  reapIdlePublishedApps,
  reapIdlePublishedAppsSerialized,
  type IdleReaperDeps,
  type ReapableApp,
} from '../idle-reaper';
import type { StopPublishedAppResult } from '../app-lifecycle-metering';

const NOW = new Date('2026-08-20T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function idleApp(over: Partial<ReapableApp> = {}): ReapableApp {
  return {
    id: 'app-1',
    driveId: 'drive-1',
    tier: 'metered',
    lastHitAt: ago(1_800_000),
    lastWakeAt: ago(3_600_000),
    ...over,
  } as ReapableApp;
}

function makeDeps(over: Partial<IdleReaperDeps> = {}) {
  const stop = vi.fn<IdleReaperDeps['stop']>(async () => ({
    outcome: 'stopped',
    status: 'stopped',
    billedSeconds: 600,
  }));
  const listIdleCandidates = vi.fn<IdleReaperDeps['listIdleCandidates']>(async () => [idleApp()]);
  const deps: IdleReaperDeps = {
    isEnabled: () => true,
    listIdleCandidates,
    stop,
    idleStopSeconds: () => 900,
    now: () => NOW,
    ...over,
  };
  return { deps, stop, listIdleCandidates };
}

/** Narrow the run to its reaped shape — the two skip outcomes carry no counters. */
async function reap(deps: IdleReaperDeps) {
  const run = await reapIdlePublishedApps(deps);
  if (run.outcome !== 'reaped') throw new Error(`expected a reaped run, got ${run.outcome}`);
  return run;
}

describe('reapIdlePublishedApps — the kill switch', () => {
  it('given APP_HOSTING_ENABLED is off, should report `disabled` and read NOTHING', async () => {
    // A dark feature must never redden a live cron, and must not query for rows it
    // has no business stopping.
    const { deps, listIdleCandidates, stop } = makeDeps({ isEnabled: () => false });

    assert({
      given: 'the hosting kill switch off',
      should: 'report disabled without listing or stopping anything',
      actual: {
        outcome: (await reapIdlePublishedApps(deps)).outcome,
        listed: listIdleCandidates.mock.calls.length,
        stopped: stop.mock.calls.length,
      },
      expected: { outcome: 'disabled', listed: 0, stopped: 0 },
    });
  });

  it('given the threshold configured to 0, should report `reaping_disabled` BEFORE reading a row', async () => {
    // Asked before the row source on purpose: a disabled reaper must read nothing
    // rather than read the fleet and then decline to act on it.
    const { deps, listIdleCandidates } = makeDeps({ idleStopSeconds: () => 0 });

    assert({
      given: 'PUBLISHED_APP_IDLE_STOP_SECONDS=0',
      should: 'report reaping_disabled without listing candidates',
      actual: {
        outcome: (await reapIdlePublishedApps(deps)).outcome,
        listed: listIdleCandidates.mock.calls.length,
      },
      expected: { outcome: 'reaping_disabled', listed: 0 },
    });
  });
});

describe('reapIdlePublishedApps — stopping', () => {
  it('stops an idle app THROUGH THE STOP SEAM and counts the seconds its final settle billed', async () => {
    // The reaper prices nothing itself. A parallel settle here would be a second
    // answer to "what does this window owe", which for money is a wrong one.
    const { deps, stop } = makeDeps();

    const run = await reap(deps);

    expect(stop).toHaveBeenCalledWith('app-1');
    assert({
      given: 'one app idle past the threshold',
      should: 'stop it and report what the stop settled',
      actual: { stopped: run.stopped, settledSeconds: run.settledSeconds, idleSeconds: run.idleSeconds },
      expected: { stopped: 1, settledSeconds: 600, idleSeconds: 900 },
    });
  });

  it('given a candidate that turns out to be ACTIVE, should keep it — the planner re-judges every prefiltered row', async () => {
    // The row source is a prefilter, deliberately looser than the decision: a hit
    // landing between the query and the decision must not cost somebody a stopped
    // machine.
    const { deps, stop } = makeDeps({
      listIdleCandidates: async () => [idleApp({ lastHitAt: ago(10_000) })],
    });

    const run = await reap(deps);

    expect(stop).not.toHaveBeenCalled();
    assert({
      given: 'a candidate hit ten seconds ago',
      should: 'count it active and stop nothing',
      actual: { active: run.active, stopped: run.stopped },
      expected: { active: 1, stopped: 0 },
    });
  });

  it('given a running row with NO activity stamp, should leave it alone and count the anomaly', async () => {
    const { deps, stop } = makeDeps({
      listIdleCandidates: async () => [idleApp({ lastHitAt: null, lastWakeAt: null })],
    });

    const run = await reap(deps);

    expect(stop).not.toHaveBeenCalled();
    assert({
      given: 'a running row with neither a wake nor a hit',
      should: 'count it as unsignalled rather than reaping it',
      actual: { noActivitySignal: run.noActivitySignal, stopped: run.stopped },
      expected: { noActivitySignal: 1, stopped: 0 },
    });
  });

  it('judges every row against ONE clock, and hands the row source that same clock', async () => {
    // Two clocks would mean rows selected under one instant and decided under
    // another — a row could be listed as idle and then judged active by the drift
    // between them.
    const clock = vi.fn(() => NOW);
    const { deps, listIdleCandidates } = makeDeps({ now: clock });

    await reap(deps);

    expect(listIdleCandidates).toHaveBeenCalledWith({ idleSeconds: 900, now: NOW });
    expect(clock).toHaveBeenCalledTimes(1);
  });
});

describe('reapIdlePublishedApps — what each stop outcome means', () => {
  const outcomes: Array<[StopPublishedAppResult, keyof Awaited<ReturnType<typeof reap>>]> = [
    [{ outcome: 'lock_busy' }, 'lockBusy'],
    [{ outcome: 'refused', reason: 'not_running' }, 'refused'],
    [{ outcome: 'stop_failed', error: 'fly said no' }, 'stopFailed'],
  ];

  for (const [result, counter] of outcomes) {
    it(`counts a ${result.outcome} stop under its own name, and never as a stop`, async () => {
      const { deps } = makeDeps({ stop: async () => result });

      const run = await reap(deps);

      assert({
        given: `a stop that answered ${result.outcome}`,
        should: `count it as ${String(counter)} and stop nothing`,
        actual: { counted: run[counter], stopped: run.stopped, settled: run.settledSeconds },
        expected: { counted: 1, stopped: 0, settled: 0 },
      });
    });
  }
});

describe('reapIdlePublishedApps — never throws', () => {
  it('given the row source fails, should report sourceFailed rather than reject', async () => {
    const { deps } = makeDeps({
      listIdleCandidates: async () => {
        throw new Error('database down');
      },
    });

    const run = await reap(deps);

    assert({
      given: 'an unreadable row source',
      should: 'report the failure as a value, having stopped nothing',
      actual: { sourceFailed: run.sourceFailed, processed: run.processed, stopped: run.stopped },
      expected: { sourceFailed: true, processed: 0, stopped: 0 },
    });
  });

  it('ISOLATES one app’s failure — the rest of the fleet is still reaped', async () => {
    // One app whose stop rejects must not leave every other idle machine awake.
    const { deps } = makeDeps({
      listIdleCandidates: async () => [idleApp({ id: 'app-bad' }), idleApp({ id: 'app-good' })],
      stop: async (id) => {
        if (id === 'app-bad') throw new Error('boom');
        return { outcome: 'stopped', status: 'stopped', billedSeconds: 42 };
      },
    });

    const run = await reap(deps);

    assert({
      given: 'two idle apps, the first of which throws',
      should: 'count the failure and still stop the second',
      actual: { failed: run.failed, stopped: run.stopped, settledSeconds: run.settledSeconds },
      expected: { failed: 1, stopped: 1, settledSeconds: 42 },
    });
  });
});

describe('reapIdlePublishedAppsSerialized', () => {
  /** A pool double whose try-lock answers `acquired`. */
  function pool(acquired: boolean) {
    const release = vi.fn();
    const query = vi.fn(async (text: string, _params?: unknown[]) => {
      if (text.includes('pg_try_advisory_lock')) return { rows: [{ acquired }] };
      return { rows: [] };
    });
    return { pool: { connect: async () => ({ query, release }) }, query, release };
  }

  it('given the reaper lock is held elsewhere, should be a clean no-op that reads NOTHING', async () => {
    // Two overlapping runs would each issue a Fly stop for the same machine and the
    // loser's would fail — turning a routine tick into an error signal about a
    // machine doing exactly what it was told.
    const { deps, listIdleCandidates } = makeDeps();
    const { pool: busy } = pool(false);

    assert({
      given: 'another container mid-scan',
      should: 'report lock_busy without listing a single candidate',
      actual: {
        outcome: (await reapIdlePublishedAppsSerialized(deps, busy)).outcome,
        listed: listIdleCandidates.mock.calls.length,
      },
      expected: { outcome: 'lock_busy', listed: 0 },
    });
  });

  it('takes its OWN lock key, not the awake meter’s — the two must not block each other', async () => {
    // The meter's key is taken and released PER APP by `stopPublishedApp` inside
    // this scan. Sharing one key would mean a reaper run blocking every heartbeat
    // for the length of the scan, and the scan's own stops deadlocking behind it.
    const { deps } = makeDeps();
    const { pool: free, query } = pool(true);

    await reapIdlePublishedAppsSerialized(deps, free);

    const lockKeys = query.mock.calls
      .filter((c) => String(c[0]).includes('advisory'))
      .map((c) => (c[1] as string[] | undefined)?.[0]);
    assert({
      given: 'a serialized reaper run',
      should: 'lock and unlock its own reaper key',
      actual: lockKeys,
      expected: ['reap-published-apps-idle', 'reap-published-apps-idle'],
    });
  });

  it('given the lock connection fails, should THROW rather than report a clean skip', async () => {
    // A pool that cannot hand out a connection is an outage. Reporting it as
    // lock_busy would present an outage as a routine, self-correcting skip.
    const { deps } = makeDeps();
    const brokenPool = {
      connect: async () => {
        throw new Error('pool exhausted');
      },
    };

    await expect(reapIdlePublishedAppsSerialized(deps, brokenPool)).rejects.toThrow('pool exhausted');
  });
});
