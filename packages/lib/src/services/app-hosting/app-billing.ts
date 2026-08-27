/**
 * app-billing — the billing SEAM for published-app hosting, and its default
 * (real) composition.
 *
 * Deliberately the same shape as `defaultSandboxBillingDeps`
 * (`services/sandbox/sandbox-billing.ts`): resolve a payer, gate + hold, settle
 * against the hold, release. Two meters, one credit pipeline, one vocabulary — a
 * published app is metered through `canConsumeAI` / `AIMonitoring.trackUsage` /
 * `releaseHold` exactly as a sandbox run is, so there is one place where money
 * moves and one place where a gate can be got wrong.
 *
 * THE PAYER IS THE DRIVE OWNER, via `resolveEnvPayerId`. A published app hangs off
 * an ENVIRONMENT, and an environment is drive-owned and drive-shared; billing is
 * keyed to the environment and is deliberately substrate-agnostic, so nothing here
 * names Fly. `published_apps.ownerId` is denormalized for indexing and cascade
 * reach and is NOT consulted as the payer: a drive that changes hands, or an owner
 * column that drifts from `drives.ownerId`, must not silently redirect a charge.
 * An unresolvable drive yields NO payer, and the caller SKIPS rather than
 * substituting one — a money movement to the wrong person cannot be taken back,
 * while a skipped cycle self-corrects on the next tick.
 *
 * Everything here is dark behind `APP_HOSTING_ENABLED`: the callers
 * (`app-lifecycle-metering`, `awake-meter`) check the kill switch before they ever
 * reach these deps.
 */

import { eq } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import { canConsumeAI } from '../../billing/credit-gate';
import { releaseHold as releaseCreditHold } from '../../billing/credit-consume';
import {
  MACHINE_MARKUP_BPS,
  PUBLISHED_APP_DAILY_CAP_CEILING_CENTS,
  PUBLISHED_APP_MAX_INFLIGHT,
  PUBLISHED_APP_WAKE_HOLD_ESTIMATE_CENTS,
} from '../../billing/credit-pricing';
import { resolveEnvPayerId, lookupDriveOwnerId } from '../../billing/sandbox-payer';
import { AIMonitoring, type UsageTrackingOutcome } from '../../monitoring/ai-monitoring';
import { calculateMachineCostDollars, PUBLISHED_APP_GUEST_SHAPE } from '../../monitoring/machine-pricing';
import { toSubscriptionTier, type SubscriptionTier } from '../../billing/subscription-tiers';
import { PUBLISHED_APP_AWAKE_MODEL } from '../../monitoring/usage-source';

export interface AppBillingDeps {
  /**
   * Who pays for this app's runtime — the OWNING DRIVE's owner, with no fallback.
   * Null means unresolvable (a stale read of a drive mid-delete): the caller
   * refuses the wake or skips the settle rather than billing anyone else.
   */
  resolvePayerId: (input: { driveId: string }) => Promise<string | null>;
  /**
   * Balance check + reservation, run BEFORE the machine is started. This is the
   * whole of hosting's credit enforcement: an exhausted payer is refused a wake
   * and the router serves a parked page. There is no clawback path and there is
   * not meant to be one.
   */
  gate: (input: { payerId: string }) => Promise<{ allowed: boolean; holdId?: string; reason?: string }>;
  /**
   * Settles accrued awake-seconds against the wake's hold. Called by every
   * heartbeat and once more at the stop boundary.
   *
   * REPORTS ITS OUTCOME rather than resolving regardless: a resolved call is not
   * a settled one, and `UsageTrackingOutcome.persisted` is what says whether this
   * app's usage row landed. The callers close the awake window only on a persisted
   * settle — on a lost one the window stays open and the next tick re-bills the
   * whole span, which is safe precisely because nothing was written.
   */
  trackUsage: (input: {
    payerId: string;
    holdId?: string;
    activeSeconds: number;
    driveId: string;
    publishedAppId: string;
  }) => Promise<UsageTrackingOutcome>;
  /** Releases a reservation without billing — every exit that never settles. */
  releaseHold: (holdId: string) => Promise<void>;
}

/**
 * The gate evaluates the PAYER's tier, never an acting user's. Nobody is
 * necessarily "acting" at all when a published app wakes — the trigger is an
 * inbound HTTP request from a stranger on the internet — so the tier has to be
 * read from the resolved payer directly. Mirrors `resolvePayerTier` in
 * sandbox-billing.ts.
 */
async function resolvePayerTier(payerId: string): Promise<SubscriptionTier> {
  const [row] = await db
    .select({ subscriptionTier: users.subscriptionTier })
    .from(users)
    .where(eq(users.id, payerId))
    .limit(1);
  return toSubscriptionTier(row?.subscriptionTier);
}

export const defaultAppBillingDeps: AppBillingDeps = {
  resolvePayerId({ driveId }) {
    // Called through a closure rather than passed unbound: `resolveEnvPayerId`
    // invokes its input off its own object, and handing over a bare method
    // reference would drop `this` for any non-literal deps implementation.
    return resolveEnvPayerId({ driveId, lookupDriveOwnerId: (id) => lookupDriveOwnerId(id) });
  },

  async gate({ payerId }) {
    const tier = await resolvePayerTier(payerId);
    const result = await canConsumeAI(payerId, tier, {
      estCostCents: PUBLISHED_APP_WAKE_HOLD_ESTIMATE_CENTS,
      maxInFlight: PUBLISHED_APP_MAX_INFLIGHT,
      // ALWAYS passed, in every deployment mode — this is the "unlimited but not
      // unbounded" half of the tenant/onprem rule. `canConsumeAI` short-circuits
      // to the query-free unlimited path when billing is disabled AND no ceiling
      // is supplied; supplying one keeps a per-payer daily bound in force there,
      // metered from `ai_usage_logs` since those deployments have no ledger.
      dailyCapCeilingCents: PUBLISHED_APP_DAILY_CAP_CEILING_CENTS,
    });
    return {
      allowed: result.allowed,
      holdId: result.holdId,
      reason: result.allowed ? undefined : result.reason,
    };
  },

  trackUsage({ payerId, holdId, activeSeconds, driveId, publishedAppId }) {
    // Returned, not awaited-and-discarded — the outcome IS the contract here.
    return AIMonitoring.trackUsage({
      userId: payerId,
      // The substrate, named where substrate names belong — in the usage row's
      // provider field, not in the payer resolution or the billed unit above it.
      provider: 'fly',
      // The BILLED UNIT. Shared constant rather than a literal because the usage
      // breakdown splits on exactly this string (a hosting row and a terminal row
      // both carry `source: 'terminal'` and no `pageId`).
      model: PUBLISHED_APP_AWAKE_MODEL,
      // One feature bucket with the rest of sandbox/substrate runtime: splitting
      // the source would fragment the usage breakdown's totals for no gain the
      // model label does not already give.
      source: 'terminal',
      // No pageId — a published app serves an environment, not a page.
      pageId: undefined,
      // First-class drive attribution, so hosting spend can be grouped by drive
      // without JSON forensics. An app's drive is NOT NULL by construction.
      driveId,
      // `AIUsageData.sessionId` is the shared analytics column written by many
      // sources; map at the boundary. Carries the `published_apps` id — `model`
      // above is what says which table that id addresses.
      sessionId: publishedAppId,
      // Priced at the app's KNOWN guest, not the sandbox's assumed one.
      providerCostDollars: calculateMachineCostDollars({
        activeSeconds,
        shape: PUBLISHED_APP_GUEST_SHAPE,
      }),
      duration: Math.round(activeSeconds * 1000),
      success: true,
      holdId,
      // The same 1.5x substrate floor every machine meter uses, independent of
      // the shared AI markup default.
      markupBpsOverride: MACHINE_MARKUP_BPS,
      // Deterministic list price (awake seconds x published rate), never a
      // provider-returned figure — Fly has no billing API.
      costSource: 'list_price',
      metadata: { type: 'published_app_awake', activeSeconds },
    });
  },

  async releaseHold(holdId) {
    await releaseCreditHold(holdId);
  },
};
