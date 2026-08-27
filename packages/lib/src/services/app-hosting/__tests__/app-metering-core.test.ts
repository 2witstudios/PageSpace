import { describe, it, expect } from 'vitest';
import { assert } from '../../sandbox/__tests__/riteway';
import {
  METER_AWAKE_LOCK_KEY,
  msToSeconds,
  planAwakeSettle,
  planDailyAwakeCap,
  planIdleStop,
  utcDayOf,
  classifyFlyEventAction,
  flyEventInstant,
  awakeSecondsFromEvents,
  evaluateAwakeDrift,
  MAX_AWAKE_SETTLE_SPAN_MS,
  AWAKE_DRIFT_TOLERANCE,
  AWAKE_DRIFT_FLOOR_SECONDS,
} from '../app-metering-core';

const NOW = new Date('2026-08-20T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe('msToSeconds', () => {
  it('converts a positive span to seconds', () => {
    assert({
      given: '90 seconds in milliseconds',
      should: 'be 90 seconds',
      actual: msToSeconds(90_000),
      expected: 90,
    });
  });

  it('floors a negative, zero or non-finite span at 0 rather than producing a negative charge', () => {
    // Every one of these reaches a `providerCostDollars` multiplication. A
    // negative here is not a refund, it is a corrupt ledger row.
    expect(msToSeconds(0)).toBe(0);
    expect(msToSeconds(-1)).toBe(0);
    expect(msToSeconds(Number.NaN)).toBe(0);
    expect(msToSeconds(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('planAwakeSettle', () => {
  it('given no watermark, should STAMP and bill nothing — an unknown window start costs the payer nothing', () => {
    assert({
      given: 'a row believed awake with no billing watermark',
      should: 'stamp the clock and bill nothing',
      actual: planAwakeSettle({ billedThrough: null, now: NOW }),
      expected: { action: 'stamp' },
    });
  });

  it('given an ordinary elapsed window, should settle exactly that span', () => {
    assert({
      given: 'a watermark ten minutes before now',
      should: 'bill 600 seconds and advance the watermark to now',
      actual: planAwakeSettle({ billedThrough: ago(600_000), now: NOW }),
      expected: { action: 'settle', activeSeconds: 600, billedThrough: NOW, clamped: false },
    });
  });

  it('given a back-to-back rerun with no elapsed time, should SKIP', () => {
    assert({
      given: 'a watermark exactly at now',
      should: 'skip — nothing to bill and nothing to move',
      actual: planAwakeSettle({ billedThrough: NOW, now: NOW }),
      expected: { action: 'skip' },
    });
  });

  it('given a watermark AHEAD of now (clock skew), should SKIP rather than bill a negative span', () => {
    assert({
      given: 'a watermark one minute in the future',
      should: 'skip — a negative span is not a refund mechanism',
      actual: planAwakeSettle({ billedThrough: new Date(NOW.getTime() + 60_000), now: NOW }),
      expected: { action: 'skip' },
    });
  });

  it('given a span longer than a day, should clamp the BILLED seconds but still advance to now', () => {
    // The clamp FORGIVES REVENUE — the excess is dropped once rather than
    // carried, so the next tick starts from `now` and cannot re-bill it.
    const plan = planAwakeSettle({ billedThrough: ago(MAX_AWAKE_SETTLE_SPAN_MS * 3), now: NOW });
    expect(plan).toEqual({
      action: 'settle',
      activeSeconds: MAX_AWAKE_SETTLE_SPAN_MS / 1000,
      billedThrough: NOW,
      clamped: true,
    });
  });

  it('given a span exactly at the cap, should NOT report itself clamped', () => {
    const plan = planAwakeSettle({ billedThrough: ago(MAX_AWAKE_SETTLE_SPAN_MS), now: NOW });
    assert({
      given: 'a span exactly at the maximum',
      should: 'bill it whole and not flag a clamp',
      actual: plan.action === 'settle' ? plan.clamped : 'not-a-settle',
      expected: false,
    });
  });
});

describe('classifyFlyEventAction', () => {
  it('maps the start and stop vocabularies Fly actually logs', () => {
    expect(classifyFlyEventAction('start')).toBe('start');
    expect(classifyFlyEventAction('started')).toBe('start');
    expect(classifyFlyEventAction('stop')).toBe('stop');
    expect(classifyFlyEventAction('exit')).toBe('stop');
  });

  it('given an event type we do not recognise, should fold to NULL rather than guess a boundary', () => {
    // A fabricated boundary lands in the one table that cannot be rebuilt from
    // Fly afterwards, so an unknown type must never be retyped as one we know.
    assert({
      given: 'a Fly event type outside the known vocabulary',
      should: 'classify as not-a-boundary',
      actual: [
        classifyFlyEventAction('restart'),
        classifyFlyEventAction('health_check_status_changed'),
        classifyFlyEventAction(undefined),
        classifyFlyEventAction(''),
      ],
      expected: [null, null, null, null],
    });
  });
});

describe('flyEventInstant', () => {
  it('reads Fly epoch-millisecond timestamps', () => {
    expect(flyEventInstant(NOW.getTime())).toEqual(NOW);
  });

  it('given a malformed or non-positive timestamp, should return null rather than a 1970 date', () => {
    // A 1970 date would read to the reconcile as a decades-long awake window.
    assert({
      given: 'timestamps that are not usable instants',
      should: 'be dropped rather than dated to the epoch',
      actual: [
        flyEventInstant(0),
        flyEventInstant(-1),
        flyEventInstant('2026-08-20'),
        flyEventInstant(undefined),
        flyEventInstant(Number.NaN),
        flyEventInstant(Number.POSITIVE_INFINITY),
      ],
      expected: [null, null, null, null, null, null],
    });
  });
});

describe('awakeSecondsFromEvents', () => {
  const at = (ms: number) => new Date(NOW.getTime() - ms);

  it('sums a simple start/stop pair', () => {
    assert({
      given: 'a machine up for ten minutes and then stopped',
      should: 'total 600 awake seconds',
      actual: awakeSecondsFromEvents(
        [
          { action: 'start', occurredAt: at(900_000) },
          { action: 'stop', occurredAt: at(300_000) },
        ],
        NOW,
      ),
      expected: 600,
    });
  });

  it('consumes events in TIMESTAMP order whatever order they arrive in', () => {
    // The mirror holds two origins written at different moments, so arrival
    // order is not chronological order.
    assert({
      given: 'the stop listed before the start',
      should: 'still total the real span',
      actual: awakeSecondsFromEvents(
        [
          { action: 'stop', occurredAt: at(300_000) },
          { action: 'start', occurredAt: at(900_000) },
        ],
        NOW,
      ),
      expected: 600,
    });
  });

  it('given a START while already started, should ignore it rather than restart the clock', () => {
    // Our own `orchestrator` start and Fly's mirrored `fly` start are the SAME
    // crossing seen twice. Counting the second would lose the span before it.
    assert({
      given: 'a duplicate start midway through an open window',
      should: 'keep the original window open and lose nothing',
      actual: awakeSecondsFromEvents(
        [
          { action: 'start', occurredAt: at(900_000) },
          { action: 'start', occurredAt: at(600_000) },
          { action: 'stop', occurredAt: at(300_000) },
        ],
        NOW,
      ),
      expected: 600,
    });
  });

  it('given a STOP with no open start, should ignore it', () => {
    // Its matching start fell outside the reconciled window — that span belongs
    // to the previous window, not this one.
    assert({
      given: 'a stop whose start predates the window',
      should: 'count nothing for it',
      actual: awakeSecondsFromEvents([{ action: 'stop', occurredAt: at(300_000) }], NOW),
      expected: 0,
    });
  });

  it('given a window still open at `until`, should count up to `until`', () => {
    assert({
      given: 'a machine started five minutes ago and never stopped',
      should: 'count it as awake right now',
      actual: awakeSecondsFromEvents([{ action: 'start', occurredAt: at(300_000) }], NOW),
      expected: 300,
    });
  });

  it('given events after `until`, should stop counting at the boundary', () => {
    assert({
      given: 'a start inside the window and a stop after it',
      should: 'count only up to `until`',
      actual: awakeSecondsFromEvents(
        [
          { action: 'start', occurredAt: at(600_000) },
          { action: 'stop', occurredAt: new Date(NOW.getTime() + 600_000) },
        ],
        NOW,
      ),
      expected: 600,
    });
  });

  it('totals several separate awake windows', () => {
    assert({
      given: 'two complete stop/start cycles',
      should: 'sum both spans',
      actual: awakeSecondsFromEvents(
        [
          { action: 'start', occurredAt: at(1_800_000) },
          { action: 'stop', occurredAt: at(1_500_000) },
          { action: 'start', occurredAt: at(900_000) },
          { action: 'stop', occurredAt: at(600_000) },
        ],
        NOW,
      ),
      expected: 600,
    });
  });

  it('given no events at all, should total zero', () => {
    expect(awakeSecondsFromEvents([], NOW)).toBe(0);
  });
});

describe('evaluateAwakeDrift', () => {
  it('given two figures within tolerance, should not flag drift', () => {
    assert({
      given: 'a 1% disagreement over a long window',
      should: 'report no drift',
      actual: evaluateAwakeDrift({ localSeconds: 10_000, prometheusSeconds: 9_900 }).exceeded,
      expected: false,
    });
  });

  it('given we billed MORE than Fly saw, should flag `over_billed` — the direction that costs a customer', () => {
    const drift = evaluateAwakeDrift({ localSeconds: 10_000, prometheusSeconds: 5_000 });
    assert({
      given: 'our figure double Prometheus’',
      should: 'flag over_billed with a positive delta',
      actual: { exceeded: drift.exceeded, direction: drift.direction, deltaSeconds: drift.deltaSeconds },
      expected: { exceeded: true, direction: 'over_billed', deltaSeconds: 5_000 },
    });
  });

  it('given Fly saw MORE than we billed, should flag `under_billed`', () => {
    const drift = evaluateAwakeDrift({ localSeconds: 5_000, prometheusSeconds: 10_000 });
    assert({
      given: 'Prometheus double our figure',
      should: 'flag under_billed with a negative delta',
      actual: { exceeded: drift.exceeded, direction: drift.direction, deltaSeconds: drift.deltaSeconds },
      expected: { exceeded: true, direction: 'under_billed', deltaSeconds: -5_000 },
    });
  });

  it('given a disagreement BELOW the absolute floor, should stay quiet however large the ratio', () => {
    // Under two minutes one scrape interval is the whole signal, so a 100%
    // relative disagreement there is noise, not a finding.
    const drift = evaluateAwakeDrift({ localSeconds: 60, prometheusSeconds: 0 });
    assert({
      given: 'a total disagreement over a span shorter than the floor',
      should: 'not be flagged as drift',
      actual: { exceeded: drift.exceeded, direction: drift.direction },
      expected: { exceeded: false, direction: 'none' },
    });
  });

  it('flags a disagreement just past the floor and the tolerance, and not one just inside them', () => {
    const justPast = evaluateAwakeDrift({
      localSeconds: AWAKE_DRIFT_FLOOR_SECONDS,
      prometheusSeconds: AWAKE_DRIFT_FLOOR_SECONDS * (1 - AWAKE_DRIFT_TOLERANCE * 2),
    });
    const justInside = evaluateAwakeDrift({
      localSeconds: AWAKE_DRIFT_FLOOR_SECONDS,
      prometheusSeconds: AWAKE_DRIFT_FLOOR_SECONDS * (1 - AWAKE_DRIFT_TOLERANCE / 2),
    });
    expect(justPast.exceeded).toBe(true);
    expect(justInside.exceeded).toBe(false);
  });

  it('given both figures zero, should report a zero relative drift rather than dividing by zero', () => {
    assert({
      given: 'an app that was never awake, per both records',
      should: 'report no drift and no NaN',
      actual: evaluateAwakeDrift({ localSeconds: 0, prometheusSeconds: 0 }),
      expected: { deltaSeconds: 0, relative: 0, exceeded: false, direction: 'none' },
    });
  });

  it('floors negative or non-finite inputs at 0 rather than propagating them into the comparison', () => {
    const drift = evaluateAwakeDrift({ localSeconds: Number.NaN, prometheusSeconds: -5 });
    assert({
      given: 'a NaN local figure and a negative remote one',
      should: 'compare 0 against 0',
      actual: { deltaSeconds: drift.deltaSeconds, exceeded: drift.exceeded },
      expected: { deltaSeconds: 0, exceeded: false },
    });
  });
});


const CAP_NOW = new Date('2026-08-20T12:00:00.000Z');
const capAgo = (ms: number) => new Date(CAP_NOW.getTime() - ms);

describe('utcDayOf', () => {
  it('given an instant late in the UTC day, should name that UTC day and not the local one', () => {
    // The counter this keys is compared against a value another container wrote.
    // Two containers in different zones would roll the day over at different
    // moments — resetting the cap twice a day, or never.
    assert({
      given: '23:30 UTC on the 20th',
      should: 'answer the 20th',
      actual: utcDayOf(new Date('2026-08-20T23:30:00.000Z')),
      expected: '2026-08-20',
    });
  });
});

describe('planDailyAwakeCap', () => {
  it('given a counter from YESTERDAY, should read today’s spend as ZERO', () => {
    // The regression: reading a stale counter as today's parks an app on the
    // strength of yesterday's traffic, every morning, forever.
    assert({
      given: 'a full day’s seconds recorded against yesterday',
      should: 'report nothing spent today and refuse to park',
      actual: planDailyAwakeCap({
        tier: 'metered',
        counterDay: '2026-08-19',
        secondsToday: 86_400,
        today: '2026-08-20',
        capSeconds: 43_200,
      }),
      expected: { exceeded: false, secondsToday: 0 },
    });
  });

  it('given today’s spend AT the cap, should report it exceeded', () => {
    assert({
      given: 'a counter exactly at the budget',
      should: 'exceed — the budget is spent, not nearly spent',
      actual: planDailyAwakeCap({
        tier: 'metered',
        counterDay: '2026-08-20',
        secondsToday: 43_200,
        today: '2026-08-20',
        capSeconds: 43_200,
      }),
      expected: { exceeded: true, secondsToday: 43_200 },
    });
  });

  it('NEVER caps a dedicated app, however many seconds it has spent', () => {
    // The flat-rate tier is sold as always-on, and `parked` is metered-only at the
    // database — capping one would be a refusal the status machine could not carry
    // out even if the product wanted it.
    assert({
      given: 'a dedicated app that has been awake all day',
      should: 'never exceed',
      actual: planDailyAwakeCap({
        tier: 'dedicated',
        counterDay: '2026-08-20',
        secondsToday: 86_400,
        today: '2026-08-20',
        capSeconds: 43_200,
      }).exceeded,
      expected: false,
    });
  });

  it('given a cap of 0 (or a corrupt one), should disable the cap rather than park everything', () => {
    assert({
      given: 'the cap switched off, and a NaN cap',
      should: 'never exceed on either',
      actual: [0, Number.NaN, -1].map((capSeconds) =>
        planDailyAwakeCap({
          tier: 'metered',
          counterDay: '2026-08-20',
          secondsToday: 999_999,
          today: '2026-08-20',
          capSeconds,
        }).exceeded,
      ),
      expected: [false, false, false],
    });
  });

  it('floors a corrupt counter at 0 instead of comparing NaN', () => {
    assert({
      given: 'a NaN counter for today',
      should: 'read as zero spent',
      actual: planDailyAwakeCap({
        tier: 'metered',
        counterDay: '2026-08-20',
        secondsToday: Number.NaN,
        today: '2026-08-20',
        capSeconds: 43_200,
      }),
      expected: { exceeded: false, secondsToday: 0 },
    });
  });
});

describe('planIdleStop', () => {
  it('takes the LATER of the two stamps as recency — a busy app is not reaped for having woken long ago', () => {
    // `lastWakeAt` alone would reap an app 15 minutes after it woke, however much
    // traffic it was serving in between.
    assert({
      given: 'an app woken an hour ago and hit a minute ago',
      should: 'keep it',
      actual: planIdleStop({
        lastHitAt: capAgo(60_000),
        lastWakeAt: capAgo(3_600_000),
        now: CAP_NOW,
        idleSeconds: 900,
      }),
      expected: { action: 'keep', reason: 'active' },
    });
  });

  it('given a WAKE with no hit yet, should keep the app — the wake precedes the request that caused it', () => {
    // The regression: reaping on `lastHitAt` alone stops a machine between the
    // moment it was started and the moment its first request is routed.
    assert({
      given: 'an app woken ten seconds ago and never hit',
      should: 'keep it',
      actual: planIdleStop({ lastHitAt: null, lastWakeAt: capAgo(10_000), now: CAP_NOW, idleSeconds: 900 }),
      expected: { action: 'keep', reason: 'active' },
    });
  });

  it('given no stamp at all, should KEEP the app and say so — never reap on no evidence', () => {
    // A `running` row with no boundary is a row we do not understand. The honest
    // answer is to leave the machine alone and count it; the heartbeat meter
    // back-fills `lastWakeAt` on its next tick, so the state is self-clearing.
    assert({
      given: 'a running row with neither stamp',
      should: 'keep it, under its own reason',
      actual: planIdleStop({ lastHitAt: null, lastWakeAt: null, now: CAP_NOW, idleSeconds: 900 }),
      expected: { action: 'keep', reason: 'no_activity_signal' },
    });
  });

  it('given quiet past the threshold, should stop and report how idle it was', () => {
    assert({
      given: 'an app last hit 20 minutes ago against a 15-minute threshold',
      should: 'stop it',
      actual: planIdleStop({
        lastHitAt: capAgo(1_200_000),
        lastWakeAt: capAgo(3_600_000),
        now: CAP_NOW,
        idleSeconds: 900,
      }),
      expected: { action: 'stop', idleSeconds: 1200 },
    });
  });

  it('given idle time EXACTLY at the threshold, should keep it — the app is idle enough only once past it', () => {
    assert({
      given: 'an app last hit exactly 15 minutes ago',
      should: 'keep it',
      actual: planIdleStop({ lastHitAt: capAgo(900_000), lastWakeAt: null, now: CAP_NOW, idleSeconds: 900 }),
      expected: { action: 'keep', reason: 'active' },
    });
  });

  it('given a stamp in the FUTURE (clock skew), should keep the app rather than stop a live one', () => {
    assert({
      given: 'a hit stamped a minute from now',
      should: 'keep it',
      actual: planIdleStop({ lastHitAt: capAgo(-60_000), lastWakeAt: null, now: CAP_NOW, idleSeconds: 900 }),
      expected: { action: 'keep', reason: 'active' },
    });
  });

  it('given the threshold switched off, should report `disabled` and never stop anything', () => {
    assert({
      given: 'a threshold of 0 against an app idle for a week',
      should: 'keep it, as disabled',
      actual: planIdleStop({
        lastHitAt: capAgo(7 * 86_400_000),
        lastWakeAt: null,
        now: CAP_NOW,
        idleSeconds: 0,
      }),
      expected: { action: 'keep', reason: 'disabled' },
    });
  });

  it('ignores an unusable Date rather than treating it as recency', () => {
    assert({
      given: 'an Invalid Date hit stamp beside a real, stale wake',
      should: 'decide on the wake alone and stop',
      actual: planIdleStop({
        lastHitAt: new Date('nonsense'),
        lastWakeAt: capAgo(1_200_000),
        now: CAP_NOW,
        idleSeconds: 900,
      }).action,
      expected: 'stop',
    });
  });
});

describe('METER_AWAKE_LOCK_KEY', () => {
  it('is the exact key the awake meter’s cron holds — the lifecycle stop must take the SAME lock', () => {
    // The two modules cannot import each other (the meter imports the stop seam),
    // so the key lives here and BOTH read it. Change it in one place only and a
    // stop-settle silently stops serializing against the heartbeat, which is the
    // double-charge PR #2493 flagged.
    expect(METER_AWAKE_LOCK_KEY).toBe('meter-published-apps-awake');
  });
});
