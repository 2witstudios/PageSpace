/**
 * app-metering-core — the PURE arithmetic and decisions behind the published-app
 * awake-seconds drain.
 *
 * INVARIANT: zero I/O. No db, no fetch, no env, no clock. Every input is an
 * explicit argument, every output is a value, and nothing throws — the same
 * arrangement as `provisioner-core` beside it and `credit-core` in billing, and
 * for the same reason: this is money arithmetic, and money arithmetic should be
 * exhaustively testable without a database.
 *
 * WHAT IS BILLED. A published app's machine runs with `autostop: "off"`, so every
 * awake boundary is an API call WE made. The billed quantity is therefore exact
 * wall-clock seconds between our own boundaries — not an inference from proxy
 * behavior, and not a figure Fly hands us (there is no billing API). Only the
 * machine SHAPE is assumed, exactly as it is for sandbox runtime: see
 * `calculateMachineCostDollars`, which both meters share.
 */

/**
 * The longest span one settle may bill.
 *
 * The machine really was awake for however long it was awake, so this cap FORGIVES
 * REVENUE rather than protecting the payer from an over-bill — the opposite
 * direction from most clamps. It is here for the failure mode that has no other
 * bound: a row stuck at `running` because a stop call failed to stamp its boundary
 * accrues awake-seconds forever against a machine that is not running, and every
 * tick of that is a charge to a real person for nothing. One day per settle bounds
 * how much any single tick can be wrong by, and the weekly `fly_instance_up`
 * reconcile is what actually catches the stuck row.
 *
 * It does NOT bound the cumulative error — a stuck row keeps accruing a capped day
 * per tick. That is deliberate: capping cumulatively would mean silently deciding
 * not to bill a genuinely long-running app, which is the product working as sold.
 */

import type { PublishedAppTier } from '@pagespace/db/schema/published-apps';
import { isIdleReaperExempt } from './dedicated-tier';

export const MAX_AWAKE_SETTLE_SPAN_MS = 24 * 60 * 60 * 1000;

/** Seconds, from a millisecond span. Negative and non-finite spans price to 0, never to a negative charge. */
export function msToSeconds(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return ms / 1000;
}

/**
 * One row's awake window as the meter sees it, before any decision about what to
 * do with it. `billedThrough` is the watermark (`awakeBilledThrough`); `now` is
 * the tick's single captured clock.
 */
export interface AwakeWindowInput {
  /** The metering watermark. NULL means no window is open — see `planAwakeSettle`. */
  billedThrough: Date | null;
  now: Date;
}

/**
 * What a settle should do with one row.
 *
 *  - `stamp`  — the row is believed awake but carries no watermark. Start the
 *    clock at `now`; bill NOTHING. An unknown window start must cost the payer
 *    nothing rather than an invented amount.
 *  - `skip`   — a window is open but no time has elapsed in it (a back-to-back
 *    rerun). Nothing to bill and nothing to move.
 *  - `settle` — bill `activeSeconds` and advance the watermark to `now`.
 */
export type AwakeSettlePlan =
  | { action: 'stamp' }
  | { action: 'skip' }
  | {
      action: 'settle';
      activeSeconds: number;
      /** The watermark to write. Always `now` — the excess of a clamped window is forgiven once, never carried. */
      billedThrough: Date;
      /** The raw span exceeded {@link MAX_AWAKE_SETTLE_SPAN_MS} and was shortened. */
      clamped: boolean;
    };

/**
 * Decide what one row's settle owes (pure).
 *
 * The clamp shortens the BILLED span but never the watermark advance: the excess
 * is forgiven once rather than accumulating into an ever-larger retroactive charge
 * the next tick would bill instead. Same shape, and the same reasoning, as the
 * storage reconcile's `MAX_BILLABLE_SPAN_MS`.
 */
export function planAwakeSettle({ billedThrough, now }: AwakeWindowInput): AwakeSettlePlan {
  if (billedThrough === null) return { action: 'stamp' };
  const rawElapsedMs = now.getTime() - billedThrough.getTime();
  // A watermark AHEAD of now (a clock skew between containers, or a wake that
  // landed mid-tick) bills nothing and moves nothing: `settle`'s monotonic write
  // would refuse the advance anyway, and billing a negative span is not a refund
  // mechanism, it is a corrupt ledger row.
  if (rawElapsedMs <= 0) return { action: 'skip' };
  const elapsedMs = Math.min(rawElapsedMs, MAX_AWAKE_SETTLE_SPAN_MS);
  return {
    action: 'settle',
    activeSeconds: msToSeconds(elapsedMs),
    billedThrough: now,
    clamped: rawElapsedMs > MAX_AWAKE_SETTLE_SPAN_MS,
  };
}

/**
 * The awake boundary a mirrored event marks, or null for an event that is not a
 * boundary at all.
 *
 * Fly's event vocabulary is open — it logs restarts, health-check transitions,
 * exits and host events alongside the starts and stops we asked for — and a type
 * we do not recognise must fold to "not a boundary" rather than being guessed at.
 * Guessing would write a fabricated awake boundary into the one table that cannot
 * be rebuilt from Fly afterwards.
 *
 * `start`/`exit` are the pair Fly actually logs for a machine's lifecycle;
 * `stop` appears for an explicit stop request. Everything else is recorded by the
 * mirror with a NULL action refused at the database (see the table's
 * `action` CHECK), which is why non-boundary events are dropped rather than stored.
 */
export function classifyFlyEventAction(eventType: string | undefined): 'start' | 'stop' | null {
  switch (eventType) {
    case 'start':
    case 'started':
      return 'start';
    case 'stop':
    case 'exit':
      return 'stop';
    default:
      return null;
  }
}

/**
 * Fly event timestamps are epoch MILLISECONDS (`MachineEvent.timestamp`). Returns
 * null for anything that is not a usable instant, so a malformed event is dropped
 * from the mirror rather than landing there dated to 1970 — which the reconcile
 * would read as a decades-long awake window.
 */
export function flyEventInstant(timestamp: unknown): Date | null {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return null;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Awake seconds implied by a sequence of mirrored boundaries — the local
 * reconcile's side of the weekly `fly_instance_up` comparison.
 *
 * Written against boundaries rather than against the billing watermark on purpose:
 * the watermark says what we CHARGED, and the point of the reconcile is to check
 * that against what the machine actually DID. If they agreed by construction the
 * comparison would be worthless.
 *
 * Rules, all of which exist because real event streams are ragged:
 *  - events are consumed in timestamp order, whatever order they arrive in;
 *  - a `start` while already started is ignored (Fly logs a start for a machine
 *    that was already up; counting it would restart the clock and lose the span);
 *  - a `stop` with no open start is ignored (the matching start fell outside the
 *    window being reconciled — its span belongs to the previous window, not this one);
 *  - a window still open at `until` is counted up to `until`, because a machine
 *    that is awake right now is awake right now.
 */
export function awakeSecondsFromEvents(
  events: ReadonlyArray<{ action: 'start' | 'stop'; occurredAt: Date }>,
  until: Date,
): number {
  const ordered = [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  let openedAt: number | null = null;
  let totalMs = 0;
  for (const event of ordered) {
    const at = event.occurredAt.getTime();
    if (at > until.getTime()) break;
    if (event.action === 'start') {
      if (openedAt === null) openedAt = at;
      continue;
    }
    if (openedAt !== null) {
      totalMs += Math.max(0, at - openedAt);
      openedAt = null;
    }
  }
  if (openedAt !== null) totalMs += Math.max(0, until.getTime() - openedAt);
  return msToSeconds(totalMs);
}

/**
 * How far apart two awake-seconds figures may be before the reconcile calls it
 * drift, as a FRACTION of the larger of the two.
 *
 * Relative rather than absolute because the two sources are sampled differently:
 * `fly_instance_up` is a scraped gauge (a step function sampled every ~15s), while
 * our boundaries are exact API-call instants. A few sample periods of disagreement
 * is expected on every app, and would be a constant false alarm at an absolute
 * threshold that a busy app could never meet.
 */
export const AWAKE_DRIFT_TOLERANCE = 0.05;

/** A minimum absolute span before drift is even asked about — below it, one scrape interval is the whole signal. */
export const AWAKE_DRIFT_FLOOR_SECONDS = 120;

export interface AwakeDriftInput {
  /** Awake seconds implied by OUR mirrored boundaries. */
  localSeconds: number;
  /** Awake seconds implied by managed Prometheus `fly_instance_up`. */
  prometheusSeconds: number;
}

export interface AwakeDrift {
  deltaSeconds: number;
  /** Fraction of the larger figure. 0 when both are 0. */
  relative: number;
  /** Past both the floor and the tolerance — worth an operator's attention. */
  exceeded: boolean;
  /**
   * Which way. `under_billed` means Fly saw MORE awake time than we billed (a
   * boundary we never recorded — the failure mode that costs the platform money);
   * `over_billed` means we billed more than Fly saw, which costs a customer money
   * and is the more serious of the two.
   */
  direction: 'over_billed' | 'under_billed' | 'none';
}

/** Compare the two awake-seconds figures for one app (pure). */
export function evaluateAwakeDrift({ localSeconds, prometheusSeconds }: AwakeDriftInput): AwakeDrift {
  const local = Number.isFinite(localSeconds) && localSeconds > 0 ? localSeconds : 0;
  const remote = Number.isFinite(prometheusSeconds) && prometheusSeconds > 0 ? prometheusSeconds : 0;
  const deltaSeconds = local - remote;
  const larger = Math.max(local, remote);
  const relative = larger === 0 ? 0 : Math.abs(deltaSeconds) / larger;
  const exceeded = larger >= AWAKE_DRIFT_FLOOR_SECONDS && relative > AWAKE_DRIFT_TOLERANCE;
  const direction = !exceeded ? 'none' : deltaSeconds > 0 ? 'over_billed' : 'under_billed';
  return { deltaSeconds, relative, exceeded, direction };
}

/**
 * Advisory-lock key serializing EVERY caller that prices an awake window — the
 * heartbeat meter and the lifecycle stop alike.
 *
 * It lives here, in the pure core, rather than in either of the two modules that
 * take it, because both do and neither owns the other: `awake-meter` imports the
 * stop seam, so a constant exported from the meter would make the lifecycle module
 * import back into it. A lock key that two modules must agree on is exactly the
 * kind of shared fact this file exists to hold.
 *
 * WHY THE STOP NEEDS IT AT ALL: `trackUsage` and the watermark advance are two
 * separate un-transactioned writes, so a stop that reads a row mid-tick prices the
 * same span the heartbeat is already pricing, and both settle. The compare-and-set
 * on the watermark stops the two from corrupting each other's STATE; only the lock
 * stops them from both charging. (Flagged on PR #2493; the weekly reconcile's
 * `over_billed` signal was the interim backstop and should now be unreachable for
 * this cause.)
 */
export const METER_AWAKE_LOCK_KEY = 'meter-published-apps-awake';

/**
 * The UTC calendar day an instant falls in, as `YYYY-MM-DD` — the key the per-app
 * daily awake counter resets on.
 *
 * UTC and only UTC, never the container's local zone: the counter is compared
 * against a value written by whichever container settled last, and two containers
 * in different zones would disagree about when the day rolls over — resetting the
 * cap twice a day, or never. The same rule the rest of the repo's `now()` writes
 * follow.
 */
export function utcDayOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** One row's daily awake budget, as the cap decision sees it. */
export interface DailyAwakeCapInput {
  /**
   * `published_apps.tier`. Only 'metered' is capped — see the decision below.
   *
   * Typed as the enum rather than `string` so the exemption can be asked through
   * the shared `isIdleReaperExempt` predicate. A widened `string` here would have
   * forced that predicate to widen too, and it is the same question the idle
   * reaper asks about whether an app may be switched off — a place where "any
   * string" is exactly the wrong domain.
   */
  tier: PublishedAppTier;
  /** `published_apps.awakeSecondsDay` — the day the counter covers, or null. */
  counterDay: string | null;
  /** `published_apps.awakeSecondsToday`. */
  secondsToday: number;
  /** The UTC day being judged, from {@link utcDayOf}. */
  today: string;
  /** The budget, in seconds. 0 (or anything not positive) disables the cap. */
  capSeconds: number;
}

/**
 * Whether this app has spent its day's awake budget (pure).
 *
 * A STALE COUNTER IS ZERO, not a carried-over total: a row whose `awakeSecondsDay`
 * is yesterday has spent nothing today, and reading its number as today's would
 * park an app on the strength of yesterday's traffic. The reset is expressed here,
 * in the decision, as well as in the SQL that writes the counter — the two agree,
 * and this is the one that is exhaustively testable.
 *
 * DEDICATED APPS ARE NEVER CAPPED. The flat-rate tier is sold as always-on, its
 * awake seconds are not billed per second, and `parked` is metered-only at the
 * database (`published_apps_parked_is_metered_only`) — so capping a dedicated app
 * would be a refusal the status machine could not carry out even if the product
 * wanted it.
 */
export function planDailyAwakeCap(input: DailyAwakeCapInput): { exceeded: boolean; secondsToday: number } {
  const secondsToday = input.counterDay === input.today && Number.isFinite(input.secondsToday)
    ? Math.max(0, input.secondsToday)
    : 0;
  // Asked through the shared predicate rather than an inline `!== 'metered'`, so
  // "which tier is exempt from being switched off" is stated once for the reaper,
  // the cap and anything that comes next — three comparisons that must never drift
  // apart, and that all still compile if one of them silently does.
  if (isIdleReaperExempt(input.tier)) return { exceeded: false, secondsToday };
  if (!Number.isFinite(input.capSeconds) || input.capSeconds <= 0) return { exceeded: false, secondsToday };
  return { exceeded: secondsToday >= input.capSeconds, secondsToday };
}

/** One row's recency, as the idle reaper sees it. */
export interface IdleStopInput {
  /** `published_apps.lastHitAt` — the router's throttled recency stamp. */
  lastHitAt: Date | null;
  /** `published_apps.lastWakeAt` — the wake boundary, the floor under recency. */
  lastWakeAt: Date | null;
  now: Date;
  /** The idle threshold in seconds. 0 (or anything not positive) disables reaping. */
  idleSeconds: number;
}

/**
 * Why an app was left running. Each is a genuinely different fact about the fleet,
 * which is why the reaper counts them separately rather than reporting one
 * "skipped" number: `disabled` means the knob is off, `active` is the ordinary
 * healthy answer, and `no_activity_signal` is an anomaly worth watching.
 */
export type IdleStopKeep = 'disabled' | 'active' | 'no_activity_signal';

export type IdleStopPlan =
  | { action: 'stop'; idleSeconds: number }
  | { action: 'keep'; reason: IdleStopKeep };

/**
 * The later of the two recency stamps, or null when neither is usable — the one
 * definition of "when was this app last active", shared by the reaper's planner and
 * by the stop's own re-check so the two can never disagree.
 *
 * An unusable Date (an `Invalid Date` from a malformed row) is ignored rather than
 * propagated: it must not read as recency, and it must not read as the epoch either.
 */
// (declared above planIdleStop so the planner can use it)

/**
 * Decide whether one running app is idle enough to stop (pure).
 *
 * RECENCY IS THE LATER OF THE TWO STAMPS. `lastHitAt` alone would reap an app the
 * moment it was woken but before its first request was routed — the wake itself is
 * evidence of demand, and on the cold path it PRECEDES the hit it was caused by.
 * `lastWakeAt` alone would reap a busy app 15 minutes after it woke, however much
 * traffic it was serving.
 *
 * NEITHER STAMP AT ALL is not treated as "infinitely idle". A `running` row with
 * no boundary is a row we do not understand, and the honest response to not
 * understanding a live machine is to leave it alone and count it: the heartbeat
 * meter stamps such a row on its next tick (it opens a window and back-fills
 * `lastWakeAt`), which makes this state self-clearing within one meter cadence.
 * Reaping on no evidence would mean stopping a machine that might be serving
 * traffic, on the strength of a column we never wrote.
 */
export function latestActivityAt(lastHitAt: Date | null, lastWakeAt: Date | null): Date | null {
  const stamps = [lastHitAt, lastWakeAt].filter((d): d is Date => d instanceof Date && !Number.isNaN(d.getTime()));
  if (stamps.length === 0) return null;
  return new Date(Math.max(...stamps.map((d) => d.getTime())));
}

export function planIdleStop({ lastHitAt, lastWakeAt, now, idleSeconds }: IdleStopInput): IdleStopPlan {
  if (!Number.isFinite(idleSeconds) || idleSeconds <= 0) return { action: 'keep', reason: 'disabled' };
  const lastActivity = latestActivityAt(lastHitAt, lastWakeAt);
  if (lastActivity === null) return { action: 'keep', reason: 'no_activity_signal' };
  const lastActivityMs = lastActivity.getTime();
  const idleMs = now.getTime() - lastActivityMs;
  // A stamp in the FUTURE (clock skew between containers) reads as negative idle
  // time and keeps the app — the same direction `planAwakeSettle` takes for a
  // watermark ahead of now. Erring toward "leave it running" costs awake-seconds;
  // erring the other way stops a live app on a bad clock.
  if (idleMs <= idleSeconds * 1000) return { action: 'keep', reason: 'active' };
  return { action: 'stop', idleSeconds: msToSeconds(idleMs) };
}
