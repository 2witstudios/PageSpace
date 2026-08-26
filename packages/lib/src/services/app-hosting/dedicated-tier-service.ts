/**
 * dedicated-tier-service — the imperative shell for the DEDICATED tier: moving an
 * app between tiers, pushing the always-on setting to its live machine, and
 * mirroring the Stripe subscription that pays for it.
 *
 * Every rule about what those facts MEAN lives in the pure `dedicated-tier.ts`
 * next door; this file only reads state, calls those functions, and persists the
 * result — the same split as `provisioner` / `provisioner-core`.
 *
 * NOTHING HERE TALKS TO STRIPE. Stripe lives in `apps/web` (the client, the
 * webhook, the price catalogue), and hosting is consumed by `apps/web`,
 * `apps/processor` and `apps/realtime` alike, so a Stripe import here would drag a
 * secret-bearing SDK into two services that must never have one. The web app
 * creates or cancels the subscription and hands the resulting FACTS to
 * {@link recordDedicatedSubscription}; this module is the mirror, not the caller.
 *
 * Dark behind `APP_HOSTING_ENABLED`, checked before any read — and separately,
 * the tier is a no-op on a deployment where `isBillingEnabled()` is false
 * (tenant, onprem): see {@link isDedicatedTierPurchasable}.
 */

import { and, eq } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { publishedApps, type PublishedApp, type PublishedAppTier } from '@pagespace/db/schema/published-apps';
import {
  publishedAppSubscriptions,
  type PublishedAppSubscription,
} from '@pagespace/db/schema/published-app-subscriptions';
import { loggers } from '../../logging/logger-config';
import { isBillingEnabled } from '../../deployment-mode';
import { stopPublishedApp } from './app-lifecycle-metering';
import { releaseHold as releaseCreditHold } from '../../billing/credit-consume';
import { isAppHostingEnabled, resolveFlyMachinesToken } from './app-hosting-env';
import {
  updateMachineConfig,
  type FlapsTransport,
  type MachineConfig,
} from '../fly/flaps-client';
import {
  applyMinMachinesRunning,
  isDedicatedEntitled,
  DEFAULT_GUEST_PRESET,
  isCreditMetered,
  minMachinesRunningFor,
  planSubscriptionMirrorWrite,
  planTierChange,
  type TierChangeRefusal,
} from './dedicated-tier';

/**
 * Whether the dedicated tier can be BOUGHT on this deployment.
 *
 * False on tenant and onprem, where `isBillingEnabled()` is false. On those
 * deployments hosting is unlimited by design and there is no Stripe customer to
 * charge, so "buy always-on" is not a thing that can happen — and the honest
 * shape of that is a flag that refuses, not a Stripe call that fails. Every entry
 * point that would move money checks this BEFORE it looks at anything else, so a
 * billing-disabled deployment makes no Stripe call at all rather than making one
 * that errors.
 *
 * Note what this does NOT gate: an app whose `tier` column already says
 * `dedicated` keeps behaving as dedicated everywhere (always-on, reaper-exempt,
 * no credit drain) on every deployment. The tier is a runtime BEHAVIOUR that
 * happens to be sold; only the selling needs billing.
 */
export function isDedicatedTierPurchasable(): boolean {
  return isAppHostingEnabled() && isBillingEnabled();
}

export interface DedicatedTierDeps {
  isEnabled: () => boolean;
  /**
   * Push a merged config to a live machine. Bound to `updateMachineConfig`, the
   * only sanctioned mutation path — a partial update silently deletes a serving
   * app's `services`.
   */
  updateMachineConfig: (
    flyAppName: string,
    machineId: string,
    mergeFn: (current: MachineConfig) => MachineConfig,
  ) => Promise<void>;
  /**
   * Return a credit reservation without billing it — used when an UPGRADE closes
   * an awake window that nothing will ever settle. See
   * {@link setPublishedAppTier}.
   */
  releaseHold: (holdId: string) => Promise<void>;
  /**
   * Stop an app's machine, reporting whether the machine is actually DOWN.
   *
   * A boolean rather than a throw, because `stopPublishedApp` never throws: it
   * reports every refusal as a value (`stop_failed`, `lock_busy`, `not_running`).
   * A caller that wrapped it in try/catch would therefore catch nothing and sail
   * past a machine that is still running — which is exactly the failure this
   * whole path exists to prevent, so the contract states the answer instead of
   * hiding it in an exception that never arrives.
   */
  stopApp: (publishedAppId: string) => Promise<{ stopped: boolean; error?: string }>;
}

function defaultTransport(): FlapsTransport {
  return { token: resolveFlyMachinesToken() };
}

export const defaultDedicatedTierDeps: DedicatedTierDeps = {
  isEnabled: isAppHostingEnabled,
  async updateMachineConfig(flyAppName, machineId, mergeFn) {
    await updateMachineConfig(defaultTransport(), flyAppName, machineId, mergeFn);
  },
  releaseHold: (holdId) => releaseCreditHold(holdId),
  async stopApp(publishedAppId) {
    // `operator`, not `insolvent`: `insolvent` lands in `parked`, and `parked` is
    // metered-only at the database — the app is still `dedicated` at this point,
    // so that transition would be refused and the machine would stay up.
    const result = await stopPublishedApp(publishedAppId, 'operator');
    if (result.outcome === 'stopped') return { stopped: true };
    // ALREADY DOWN counts as stopped. There is no machine left to end, and
    // treating it as a failure would block the resize on the one case where the
    // resize is safest.
    if (result.outcome === 'refused' && result.reason === 'not_running') return { stopped: true };
    // Everything else leaves a machine that may still be RUNNING: Fly refused the
    // stop, or the awake meter's advisory lock was held so nothing was read or
    // stopped at all.
    return {
      stopped: false,
      error: result.outcome === 'stop_failed' ? result.error : result.outcome,
    };
  },
};

export interface SetTierOptions {
  /**
   * Move the app back to the default guest in the SAME statement as the tier.
   *
   * Enforcement only. A resize destroys and recreates the machine on the next
   * deploy (a guest change is a machine CREATE — the rootfs assembles there), so
   * doing it as a side effect of an ordinary billing event would take a live app
   * down over a card decline. {@link enforceUnpaidDedicated} is the one caller,
   * and it stops the app FIRST so there is nothing live to interrupt.
   */
  resetGuestPreset?: boolean;
  /** Replace `lastError` with a plain-language reason the publish surface can show. */
  lastError?: string | null;
}

export type SetTierResult =
  | {
      ok: true;
      app: PublishedApp;
      /**
       * Whether the live machine's `min_machines_running` was updated to match the
       * new tier.
       *
       * FALSE IS NOT A FAILURE of the tier change, and the two are deliberately
       * reported separately. The database row is the source of truth for what the
       * customer bought; the machine config is a projection of it that the next
       * build re-derives from scratch anyway (`buildMachineConfig` reads the tier).
       * Rolling the tier back because Fly was briefly unreachable would undo a
       * paid-for upgrade over a transient network error — so the row commits, the
       * push is attempted, and a failure is reported for {@link syncDedicatedMachineConfig}
       * (or the next deploy) to repair.
       */
      machineConfigSynced: boolean;
      machineConfigError?: string;
    }
  | { ok: false; reason: TierChangeRefusal | 'disabled' | 'not_found' };

/**
 * Move a published app between tiers.
 *
 * THE TIER AND THE STATUS MOVE IN ONE STATEMENT, because for the most important
 * case they must. An upgrade from a PARKED metered app has to un-park it in the
 * same write: `published_apps_parked_is_metered_only` makes a parked dedicated row
 * unrepresentable, so "set the tier, then fix the status" is two statements of
 * which the first cannot commit. That the constraint forces the behaviour the
 * product wants — paying the flat price is how an out-of-credits app serves again
 * — is a happy accident, but the write has to be built knowing it.
 *
 * The app lands in `stopped`, not `running`: un-parking is not waking. It resumes
 * through the ordinary wake path on its next request, which is the only path that
 * records an awake boundary.
 *
 * The row is locked for the read so the decision is made against state that cannot
 * change underneath it, exactly as `transitionPublishedApp` does — a tier change
 * racing the metering cron produces one winner and one refusal rather than two
 * writes where the second silently overwrites a decision the first had validated.
 */
export async function setPublishedAppTier(
  publishedAppId: string,
  to: PublishedAppTier,
  deps: DedicatedTierDeps = defaultDedicatedTierDeps,
  options: SetTierOptions = {},
): Promise<SetTierResult> {
  if (!deps.isEnabled()) return { ok: false, reason: 'disabled' };

  const written = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(publishedApps)
      .where(eq(publishedApps.id, publishedAppId))
      .limit(1)
      .for('update');
    if (!row) return { ok: false as const, reason: 'not_found' as const };

    // The guest the app will be running AFTER this write. Normally its current
    // one; on the enforcement path the default, because the two columns have to
    // move together — `published_apps_metered_guest_preset` makes a metered row on
    // a larger guest unrepresentable, so "set the tier, then resize" is two
    // statements of which the first cannot commit.
    const nextGuestPreset = options.resetGuestPreset ? DEFAULT_GUEST_PRESET : row.guestPreset;

    const plan = planTierChange({
      from: row.tier,
      to,
      status: row.status,
      guestPreset: nextGuestPreset,
    });
    if (!plan.allowed) return { ok: false as const, reason: plan.reason };

    // CLOSING THE AWAKE WINDOW IS PART OF THE UPGRADE, not a separate cleanup.
    //
    // An app upgraded WHILE AWAKE carries an open metering window and the credit
    // HOLD the wake placed. The moment its tier changes, the awake meter stops
    // listing it — so nothing will ever settle that window or release that hold,
    // and the reservation would suppress the payer's spendable balance for its
    // whole TTL against a charge that is never coming. So the window is closed in
    // the same statement as the tier, and the hold is returned after the commit.
    //
    // The accrued-but-unbilled seconds since the last settle are FORGIVEN rather
    // than settled. That is the deliberate direction: the customer has just moved
    // to a flat price, the amount is at most one heartbeat interval on the fixed
    // v1 guest, and settling it here would mean putting a charge in the middle of
    // an upgrade path — money moving in a function whose job is a column write.
    const closesWindow = !isCreditMetered(plan.tier);
    const heldId = closesWindow ? row.awakeHoldId : null;

    const [updated] = await tx
      .update(publishedApps)
      .set({
        tier: plan.tier,
        status: plan.nextStatus,
        // The park reason is cleared with the park. Leaving it behind would make
        // the publish surface — which reads this column as "why is my app not
        // serving" — keep telling a customer who just paid that they are out of
        // credits.
        ...(plan.unpark ? { lastError: null } : {}),
        ...(closesWindow ? { awakeBilledThrough: null, awakeHoldId: null } : {}),
        ...(nextGuestPreset === row.guestPreset ? {} : { guestPreset: nextGuestPreset }),
        ...(options.lastError === undefined ? {} : { lastError: options.lastError }),
      })
      // Guarded on the tier we planned against, not on the id alone: two tier
      // changes racing (a webhook cancelling while a user upgrades) must produce
      // one winner, and the loser must see `not_found` rather than overwrite a
      // decision made against state it never read.
      .where(and(eq(publishedApps.id, publishedAppId), eq(publishedApps.tier, row.tier)))
      .returning();
    if (!updated) return { ok: false as const, reason: 'not_found' as const };
    return { ok: true as const, app: updated, releasedHoldId: heldId };
  });

  if (!written.ok) return written;

  // AFTER the commit, never inside it: `releaseHold` is a separate write on the
  // ledger, and a Stripe-facing tier change must not hold a `published_apps` row
  // lock open across it. A failure here is logged and swallowed — the hold expires
  // on its own TTL, whereas letting it throw would report a committed upgrade as a
  // failure and invite a retry that finds `same_tier`.
  if (written.releasedHoldId) {
    try {
      await deps.releaseHold(written.releasedHoldId);
    } catch (error) {
      loggers.ai.warn('Dedicated upgrade could not return the awake hold; it will expire on its TTL', {
        publishedAppId: written.app.id,
        holdId: written.releasedHoldId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const sync = await pushMinMachinesRunning(written.app, deps);
  return {
    ok: true,
    app: written.app,
    machineConfigSynced: sync.ok,
    ...(sync.ok ? {} : { machineConfigError: sync.error }),
  };
}

/**
 * Make a live machine's `min_machines_running` agree with its app's tier.
 *
 * Separately callable so a tier change whose push failed can be repaired without
 * re-running the billing decision — the row already says what the customer bought,
 * and this only makes Fly agree with it.
 *
 * Goes through `updateMachineConfig`, the fetch-merge-send path, and through it
 * ALONE. Fly's machine update is a full replace: a partial post deletes the
 * `services` an app is serving traffic through, `mounts`, and `checks`, with a
 * 200 OK. The merge callback spreads the config it is handed
 * ({@link applyMinMachinesRunning}), so every field — including ones this repo has
 * never heard of — survives.
 */
export async function syncDedicatedMachineConfig(
  publishedAppId: string,
  deps: DedicatedTierDeps = defaultDedicatedTierDeps,
): Promise<{ ok: boolean; error?: string }> {
  if (!deps.isEnabled()) return { ok: false, error: 'disabled' };
  const [row] = await db
    .select()
    .from(publishedApps)
    .where(eq(publishedApps.id, publishedAppId))
    .limit(1);
  if (!row) return { ok: false, error: 'not_found' };
  return pushMinMachinesRunning(row, deps);
}

async function pushMinMachinesRunning(
  app: PublishedApp,
  deps: DedicatedTierDeps,
): Promise<{ ok: boolean; error?: string }> {
  // No machine yet (never deployed, or mid blue/green swap) is a SUCCESS, not a
  // failure: there is no config to correct, and the machine the next deploy
  // creates is built from the tier by `buildMachineConfig`. Reporting a failure
  // here would make every upgrade of an un-deployed app look broken.
  if (!app.machineId) return { ok: true };

  const desired = minMachinesRunningFor(app.tier);
  try {
    await deps.updateMachineConfig(app.flyAppName, app.machineId, (current) => {
      const merged = applyMinMachinesRunning(current, desired);
      if (merged.applied === 0) {
        // The machine has no services to carry the setting. Worth saying out loud:
        // a published app's machine is created WITH a service (that is how the
        // router's replay reaches it), so a config without one is a machine that
        // is not serving traffic at all — a fact the operator wants, and one this
        // function would otherwise hide behind a successful no-op update.
        loggers.ai.warn('Published app machine has no services to carry min_machines_running', {
          publishedAppId: app.id,
          flyAppName: app.flyAppName,
          machineId: app.machineId,
        });
      }
      return merged.config;
    });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    loggers.ai.error(
      'Published app min_machines_running could not be pushed to Fly — the tier row is correct and the machine is not',
      error instanceof Error ? error : new Error(message),
      { publishedAppId: app.id, flyAppName: app.flyAppName, tier: app.tier, desired },
    );
    return { ok: false, error: message };
  }
}

// ── The Stripe mirror ────────────────────────────────────────────────────────

/** The facts `apps/web` reads off a Stripe subscription and hands to the mirror. */
export interface DedicatedSubscriptionFacts {
  publishedAppId: string;
  userId: string;
  stripeSubscriptionId: string;
  stripePriceId: string;
  guestPreset: string;
  status: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  /**
   * `event.created` of the Stripe event these facts came from, or null when they
   * came from an API response rather than a webhook (the purchase path). Used
   * only to ORDER writes — see {@link planSubscriptionMirrorWrite}.
   */
  stripeEventCreated?: Date | null;
}

/**
 * What the mirror write did, and the row that is now authoritative.
 *
 * `row` is returned on EVERY outcome, including the refusals, and that is the
 * point rather than a convenience: a caller that has just been told its event was
 * stale still needs to know what the mirror actually says, because the tier must
 * follow the STORED status rather than the status of an event we just declined to
 * believe. Returning only on success would leave the caller re-entitling an app
 * from the very event the guard rejected.
 */
export interface MirrorWriteResult {
  outcome: 'applied' | 'stale_event' | 'terminal_absorbed';
  row: PublishedAppSubscription | null;
}

/**
 * Record (or update) the subscription paying for an app's dedicated tier.
 *
 * Upserts on `publishedAppId` rather than on `stripeSubscriptionId`, and the
 * choice matters: an app has at most ONE dedicated subscription, so a second
 * subscription id arriving for the same app means the first was replaced (a
 * cancel-and-resubscribe), and the row should follow the app rather than
 * accumulate one row per subscription the app has ever had. Conflicting on the
 * subscription id instead would leave the stale row in place and make
 * "is this app paid for" ambiguous.
 *
 * Returns null when hosting is dark, so the mirror is inert on a deployment where
 * the feature does not exist.
 */
export async function recordDedicatedSubscription(
  facts: DedicatedSubscriptionFacts,
): Promise<MirrorWriteResult> {
  if (!isAppHostingEnabled()) return { outcome: 'applied', row: null };

  const incomingEventCreated = facts.stripeEventCreated ?? null;

  return db.transaction(async (tx) => {
    // Locked for the read so the decision is made against state that cannot change
    // underneath it. Two Stripe deliveries racing the same subscription is exactly
    // the situation this guard exists for, so reading without the lock would leave
    // the ordering decision itself subject to the reordering it is meant to refuse.
    const [existing] = await tx
      .select()
      .from(publishedAppSubscriptions)
      .where(eq(publishedAppSubscriptions.publishedAppId, facts.publishedAppId))
      .limit(1)
      .for('update');

    const plan = planSubscriptionMirrorWrite({
      existing: existing
        ? {
            stripeSubscriptionId: existing.stripeSubscriptionId,
            status: existing.status,
            stripeEventCreated: existing.stripeEventCreated,
          }
        : null,
      incomingSubscriptionId: facts.stripeSubscriptionId,
      incomingEventCreated,
    });

    if (!plan.apply) {
      loggers.ai.warn('Dedicated subscription mirror refused an out-of-order Stripe event', {
        publishedAppId: facts.publishedAppId,
        stripeSubscriptionId: facts.stripeSubscriptionId,
        incomingStatus: facts.status,
        storedStatus: existing?.status,
        reason: plan.reason,
      });
      return { outcome: plan.reason, row: existing ?? null };
    }

    const values = {
      publishedAppId: facts.publishedAppId,
      userId: facts.userId,
      stripeSubscriptionId: facts.stripeSubscriptionId,
      stripePriceId: facts.stripePriceId,
      guestPreset: facts.guestPreset,
      status: facts.status,
      currentPeriodStart: facts.currentPeriodStart,
      currentPeriodEnd: facts.currentPeriodEnd,
      cancelAtPeriodEnd: facts.cancelAtPeriodEnd,
      stripeEventCreated: incomingEventCreated,
    };

    const [row] = await tx
      .insert(publishedAppSubscriptions)
      .values(values)
      .onConflictDoUpdate({
        // An app has at most ONE dedicated subscription, so a second subscription
        // id for the same app means the first was replaced (a cancel-and-rebuy) and
        // the row should follow the app. Conflicting on the subscription id instead
        // would leave the stale row in place and make "is this app paid for"
        // ambiguous.
        target: publishedAppSubscriptions.publishedAppId,
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    return { outcome: 'applied' as const, row: row ?? null };
  });
}

/**
 * The subscription mirror row for one Stripe subscription id — the webhook's
 * lookup, which knows a subscription and needs the app.
 */
export async function findDedicatedSubscriptionByStripeId(
  stripeSubscriptionId: string,
): Promise<PublishedAppSubscription | null> {
  const [row] = await db
    .select()
    .from(publishedAppSubscriptions)
    .where(eq(publishedAppSubscriptions.stripeSubscriptionId, stripeSubscriptionId))
    .limit(1);
  return row ?? null;
}

/** The subscription mirror row for one app — the publish surface's lookup. */
export async function findDedicatedSubscriptionForApp(
  publishedAppId: string,
): Promise<PublishedAppSubscription | null> {
  const [row] = await db
    .select()
    .from(publishedAppSubscriptions)
    .where(eq(publishedAppSubscriptions.publishedAppId, publishedAppId))
    .limit(1);
  return row ?? null;
}

export type DedicatedSubscriptionSyncOutcome =
  /** The subscription entitles its app to be dedicated, and the app now is. */
  | { outcome: 'entitled'; publishedAppId: string; tierChanged: boolean }
  /** The subscription no longer pays, and the app was moved back to metered. */
  | { outcome: 'downgraded'; publishedAppId: string; tierChanged: boolean }
  /** Nothing local points at this subscription — see the note in the function. */
  | { outcome: 'unknown_subscription' }
  /** Entitlement changed but the tier could not follow. Reported, never thrown. */
  | { outcome: 'tier_change_refused'; publishedAppId: string; reason: string };

/**
 * Make an app's tier follow its subscription's status — the webhook's whole job
 * once it has the facts.
 *
 * TAKES THE MIRROR ROW, NEVER AN EVENT'S STATUS, and that is a correctness
 * property rather than an interface preference. `recordDedicatedSubscription` can
 * REFUSE an out-of-order event (a late `active` after a cancellation, a stale
 * update), and the mirror then holds the status we still believe. Syncing from the
 * event's own status instead would re-entitle an app from the very message the
 * ordering guard had just rejected — the guard would refuse the write and the tier
 * would move anyway, which is worse than having no guard, because it looks
 * defended. Passing the row makes that mistake unexpressible.
 *
 * ENTITLEMENT IS A STATUS QUESTION, not an existence one: a `canceled` or `unpaid`
 * subscription still leaves a mirror row, and the row is what lets us say WHY an
 * app went back to metered. So the tier is derived from
 * {@link isDedicatedEntitled} on the stored status rather than from whether a row
 * is present.
 *
 * A DOWNGRADE CAN LEGITIMATELY FAIL, and this reports rather than forces it. An
 * app on a bigger guest cannot be metered (`published_apps_metered_guest_preset`
 * — the awake meter prices one fixed shape and would under-bill it), so a
 * customer who stops paying for a 4x app leaves an app that cannot go back to the
 * metered tier as it stands. Forcing it by silently resizing would destroy and
 * recreate the machine — an outage as a side effect of a billing event, and one
 * the customer never asked for. The refusal is returned so the caller can act on
 * it deliberately (stop the app, or resize it and retry); what must not happen is
 * a webhook quietly taking a live app down.
 */
export async function syncAppTierToSubscription(
  mirror: Pick<PublishedAppSubscription, 'publishedAppId' | 'status'> | null,
  deps: DedicatedTierDeps = defaultDedicatedTierDeps,
): Promise<DedicatedSubscriptionSyncOutcome> {
  if (!mirror) {
    // Not an error, and deliberately not a throw. Stripe redelivers events, and a
    // subscription this deployment has no app for (one created against another
    // environment's database — the common test-mode case) would otherwise be
    // retried forever against a row that is never going to appear.
    return { outcome: 'unknown_subscription' };
  }

  const entitled = isDedicatedEntitled(mirror.status);
  const target: PublishedAppTier = entitled ? 'dedicated' : 'metered';
  const result = await setPublishedAppTier(mirror.publishedAppId, target, deps);

  if (!result.ok) {
    // `same_tier` is the ordinary case — most subscription events do not change
    // entitlement at all (a renewal, a payment method update), and reporting each
    // of those as a refusal would bury the ones that matter.
    if (result.reason === 'same_tier') {
      return entitled
        ? { outcome: 'entitled', publishedAppId: mirror.publishedAppId, tierChanged: false }
        : { outcome: 'downgraded', publishedAppId: mirror.publishedAppId, tierChanged: false };
    }
    // A DOWNGRADE THAT CANNOT HAPPEN IS NOT A DOWNGRADE. If the app is running a
    // guest the metered tier may not run, the plain tier change is refused — and
    // leaving it there would mean an app that nobody is paying for keeps its
    // always-on configuration, stays out of BOTH meters, and does so forever,
    // because no further Stripe event is coming for a dead subscription. Enforce
    // it instead.
    if (!entitled && result.reason === 'guest_preset_not_allowed') {
      return enforceUnpaidDedicated(mirror.publishedAppId, deps);
    }

    loggers.ai.warn('Published app tier could not follow its dedicated subscription', {
      publishedAppId: mirror.publishedAppId,
      status: mirror.status,
      target,
      reason: result.reason,
    });
    return { outcome: 'tier_change_refused', publishedAppId: mirror.publishedAppId, reason: result.reason };
  }

  return entitled
    ? { outcome: 'entitled', publishedAppId: mirror.publishedAppId, tierChanged: true }
    : { outcome: 'downgraded', publishedAppId: mirror.publishedAppId, tierChanged: true };
}

// ── Dunning visibility ───────────────────────────────────────────────────────

/**
 * How long a dedicated app may serve on an unpaid subscription before the fact
 * becomes an operator-visible signal, in days.
 *
 * NOT an enforcement threshold — nothing is switched off at 7 days, and this
 * constant deliberately gives no code the power to. It exists because the choice
 * to keep a `past_due` app always-on (see `DEDICATED_ENTITLED_STATUSES`) trades a
 * customer-facing outage for a bounded free ride, and that bound is a STRIPE
 * ACCOUNT SETTING rather than anything this repo controls: dunning configured to
 * leave failed subscriptions `past_due` indefinitely would serve a dedicated
 * machine free forever, and the only reason we would ever find out is if
 * something counted. This is that something.
 *
 * Seven days because that is comfortably past a normal Stripe retry schedule (a
 * card that is going to work has worked by then), so a row over this line means
 * dunning is not converging rather than that it is still in progress.
 */
export const DEDICATED_DUNNING_VISIBILITY_DAYS = 7;

export interface DedicatedDunningSurvey {
  /** Dedicated subscriptions currently in Stripe's retry window. */
  pastDue: number;
  /** Of those, the ones overdue past {@link DEDICATED_DUNNING_VISIBILITY_DAYS} — the number that matters. */
  pastDueStale: number;
  /** The app ids behind `pastDueStale`, so the signal names its subjects rather than only counting them. */
  staleAppIds: string[];
}

/**
 * Count the dedicated apps being served on an unpaid subscription.
 *
 * Measured from `currentPeriodEnd`, which is when the money became due: Stripe
 * does not advance a subscription's period while a renewal is unpaid, so the gap
 * between that timestamp and now IS how long the app has been served for free.
 * (`updatedAt` would be wrong — every retry attempt writes it, so an actively
 * failing subscription would look freshly-touched forever.)
 *
 * Returns zeroes rather than throwing when hosting is dark, so the caller's cron
 * stays green on a deployment where the feature does not exist.
 */
export async function surveyDedicatedDunning(
  now: Date = new Date(),
): Promise<DedicatedDunningSurvey> {
  if (!isAppHostingEnabled()) return { pastDue: 0, pastDueStale: 0, staleAppIds: [] };

  const rows = await db
    .select({
      publishedAppId: publishedAppSubscriptions.publishedAppId,
      currentPeriodEnd: publishedAppSubscriptions.currentPeriodEnd,
    })
    .from(publishedAppSubscriptions)
    .where(eq(publishedAppSubscriptions.status, 'past_due'));

  const cutoff = new Date(now.getTime() - DEDICATED_DUNNING_VISIBILITY_DAYS * 24 * 60 * 60 * 1000);
  const stale = rows.filter((row) => row.currentPeriodEnd.getTime() < cutoff.getTime());
  return {
    pastDue: rows.length,
    pastDueStale: stale.length,
    // Bounded so a pathological fleet cannot turn a log line into a payload. The
    // COUNT above is the complete figure; this is the sample an operator starts
    // from.
    staleAppIds: stale.slice(0, 20).map((row) => row.publishedAppId),
  };
}

/**
 * The `lastError` an enforced downgrade writes — the ONE user-facing explanation
 * of why an app came off the dedicated tier and shrank.
 *
 * Carried on the row rather than raised as a notification for the same reason the
 * daily-cap park is: `published_apps.lastError` is the column the publish surface
 * already reads as "why is my app not serving", and adding a notification type is
 * user-visible UI work inside a branch whose safety property is that it ships dark.
 */
export const UNPAID_DOWNGRADE_REASON =
  'dedicated hosting ended: the app was stopped and returned to the standard machine size';

/**
 * Take an app off the dedicated tier when its subscription has stopped paying and
 * the ordinary downgrade cannot be expressed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SITUATION. A dedicated app may run a guest the metered tier is forbidden
 * (the awake meter prices one fixed shape, so a metered row on a larger guest is
 * under-billed silently — `published_apps_metered_guest_preset` makes it
 * unrepresentable). When such an app's subscription ends, `setPublishedAppTier`
 * correctly refuses. Stopping there is the trap: the row stays `dedicated`, so it
 * keeps `min_machines_running: 1`, stays out of the awake meter AND the rootfs
 * storage drain, and does it INDEFINITELY — the subscription is dead, so no
 * further event will ever arrive to reconsider. An unpaid machine, running
 * forever, invisible to both meters.
 *
 * THE ORDER IS THE WHOLE DESIGN, and each step is where it is because of what the
 * previous one makes safe:
 *
 *   1. STOP the machine. This is what actually ends the cost, and it is first so
 *      that everything after it happens to an app that is already down. `operator`
 *      rather than `insolvent`, because `insolvent` lands in `parked` and `parked`
 *      is metered-only — the app is still `dedicated` here, so that transition
 *      would be refused and the machine would stay up.
 *   2. TIER AND GUEST TOGETHER. Both columns move in one statement, because
 *      neither shape is legal alone. The resize is the only part a customer did
 *      not ask for, and it is defensible precisely because step 1 already stopped
 *      the app: no live machine is interrupted, and the smaller guest is what the
 *      next wake creates rather than something that happens to a serving app.
 *      Nothing is lost with it — a published app's machine has no volume; its
 *      filesystem comes from the image.
 *   3. PUSH `min_machines_running: 0`. Without this the row says metered while the
 *      LIVE machine config still says keep-one-up, and Fly's proxy would restart
 *      the machine we just stopped. The row alone does not reach Fly.
 *
 * A failure at step 1 ABORTS: resizing an app we could not stop would leave a
 * running machine whose row promises a guest it is not on, and would still be
 * always-on. Better to leave the state consistent, report it, and let the next
 * event or an operator retry.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export async function enforceUnpaidDedicated(
  publishedAppId: string,
  deps: DedicatedTierDeps = defaultDedicatedTierDeps,
): Promise<DedicatedSubscriptionSyncOutcome> {
  let stop: { stopped: boolean; error?: string };
  try {
    stop = await deps.stopApp(publishedAppId);
  } catch (error) {
    // The default binding reports failures as values, but a deps implementation
    // (or the transport under it) can still throw, and a throw here must not
    // escape into the webhook as a 500 for an app we have merely failed to tidy.
    stop = { stopped: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!stop.stopped) {
    loggers.ai.error(
      'Unpaid dedicated app could not be stopped; leaving it on the dedicated tier rather than resizing a running machine',
      new Error(stop.error ?? 'stop refused'),
      { publishedAppId, error: stop.error },
    );
    return { outcome: 'tier_change_refused', publishedAppId, reason: 'stop_failed' };
  }

  const result = await setPublishedAppTier(publishedAppId, 'metered', deps, {
    resetGuestPreset: true,
    lastError: UNPAID_DOWNGRADE_REASON,
  });
  if (!result.ok) {
    // ALREADY METERED IS SUCCESS, not a fault. Stripe redelivers events, so a
    // second `deleted` for a subscription already enforced lands here with nothing
    // left to do — and a machine that is already stopped and already metered is
    // exactly the state this function exists to reach. Reporting it as a refusal
    // would raise an operator alert, on every redelivery, for work that is done.
    if (result.reason === 'same_tier') {
      return { outcome: 'downgraded', publishedAppId, tierChanged: false };
    }
    loggers.ai.error(
      'Unpaid dedicated app was stopped but could not be returned to the metered tier',
      new Error(result.reason),
      { publishedAppId, reason: result.reason },
    );
    return { outcome: 'tier_change_refused', publishedAppId, reason: result.reason };
  }

  return { outcome: 'downgraded', publishedAppId, tierChanged: true };
}
