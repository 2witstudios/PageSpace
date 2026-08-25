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
