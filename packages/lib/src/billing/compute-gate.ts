/**
 * compute-gate — the ONE shell every compute charge site holds and settles through (WAL-9):
 * the sandbox tool runner, the realtime terminal, browsers, published-app wakes and the
 * machine-storage reconcile. The decisions are `compute-charge.ts`; this file only does I/O.
 *
 * Hold-then-settle-once, as the AI paths do: `gateComputeCharge` reserves on the charge's
 * wallet BEFORE any work starts; the site settles with `AIMonitoring.trackUsage`, passing
 * `computeSettleWalletId(charge)` so the charge lands on the SAME wallet the hold named — the
 * org pool for an org charge (there is one per org), the person's personal root otherwise.
 * An org charge whose pool is gone at settle does not settle at all: it never lands on the
 * recorded person's wallet.
 */

import { eq } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { users } from '@pagespace/db/schema/auth';
import {
  canConsumeAI,
  canConsumeOrgPool,
  findOrgPoolWalletId,
  hasSpendableBalance,
  hasSpendableOrgPool,
  type GateOptions,
} from './credit-gate';
import { PERSONAL_SPEND } from './spend-target';
import { holdWalletId } from './credit-consume';
import { ensurePersonalRootWalletId } from './personal-wallet';
import { isBillingEnabled } from '../deployment-mode';
import { toSubscriptionTier, type SubscriptionTier } from './subscription-tiers';
import type { UsageTrackingOutcome } from '../monitoring/ai-monitoring';
import { computeChargeTier, computeSpendKind, orgComputeRefusalOf, type ComputeCharge, type OrgComputeGateRefusal } from './compute-charge';

/** A compute site's reservation bounds; `maxInFlight` may follow the charge's tier. */
export interface ComputeGateOptions extends Omit<GateOptions, 'spend' | 'maxInFlight' | 'spendKind'> {
  maxInFlight?: number | ((tier: SubscriptionTier) => number);
}

export type ComputeGateResult =
  | { allowed: true; holdId?: string; walletId?: string }
  /**
   * `orgRefusal` is set only for an org charge, naming why the org pool refused; a personal
   * charge's refusal keeps the gate's own `reason` (what the site has always mapped).
   */
  | { allowed: false; reason: string; orgRefusal?: OrgComputeGateRefusal };

/** A person's stored plan tier (unknown/missing reads as free). */
async function personalTier(userId: string): Promise<SubscriptionTier> {
  const [row] = await db
    .select({ subscriptionTier: users.subscriptionTier })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return toSubscriptionTier(row?.subscriptionTier);
}

/**
 * The tier a charge's entitlements and ceilings follow — the org's for an org charge (no read),
 * the paying person's own otherwise.
 */
export async function resolveComputeChargeTier(charge: ComputeCharge): Promise<SubscriptionTier> {
  return charge.kind === 'org' ? computeChargeTier(charge, 'free') : personalTier(charge.userId);
}

/** Reserve for one compute run on the charge's wallet, before the run starts. */
export async function gateComputeCharge(charge: ComputeCharge, opts: ComputeGateOptions): Promise<ComputeGateResult> {
  const tier = await resolveComputeChargeTier(charge);
  const maxInFlight = typeof opts.maxInFlight === 'function' ? opts.maxInFlight(tier) : opts.maxInFlight;
  // Every compute hold is marked compute, and a drive accrual as one ('drive_compute'), so only
  // the compute a member ran counts toward their seat on an org pool (seat-allowance).
  const bounds = { ...opts, maxInFlight, spendKind: computeSpendKind(charge) };
  if (charge.kind === 'org') {
    const result = await canConsumeOrgPool(charge.userId, charge.orgId, bounds);
    const orgRefusal = orgComputeRefusalOf(result);
    return orgRefusal === null
      ? { allowed: true, holdId: result.holdId, walletId: result.walletId }
      : { allowed: false, reason: orgRefusal, orgRefusal };
  }
  // Compute bills the payer's personal wallet: wallets do not change compute billing (WAL-9).
  const result = await canConsumeAI(charge.userId, tier, { ...bounds, spend: PERSONAL_SPEND });
  return result.allowed
    ? { allowed: true, holdId: result.holdId, walletId: result.walletId }
    : { allowed: false, reason: result.reason };
}

/**
 * The wallet a compute charge settles against — ALWAYS named explicitly, so a hold left on a
 * different wallet (the payer changed mid-run) is refused at settle rather than winning
 * (review 5343636479 P1-1): the org pool for an org charge (null when the pool no longer
 * exists — the caller must NOT settle), the person's personal root for a personal charge.
 * Undefined only where billing is off: no wallet moves money there.
 */
export async function computeSettleWalletId(charge: ComputeCharge): Promise<string | null | undefined> {
  if (!isBillingEnabled()) return undefined;
  if (charge.kind === 'org') return findOrgPoolWalletId(charge.orgId);
  return ensurePersonalRootWalletId(db, charge.userId);
}

/**
 * Whether `holdId` reserves on the wallet `charge` settles on. A hold that no longer exists
 * conflicts with nothing (the settle names its wallet explicitly). Read-only for an org
 * charge; a personal charge's root is created on demand, as its settle would.
 */
export async function holdMatchesCharge(input: { holdId: string; charge: ComputeCharge }): Promise<boolean> {
  if (!isBillingEnabled()) return true;
  const held = await holdWalletId(input.holdId);
  if (held === null) return true;
  return held === (await computeSettleWalletId(input.charge));
}

/**
 * The outcome a site reports when an org charge cannot settle because its pool is gone: nothing
 * was written, so the window stays open and nobody — least of all the recorded person — is
 * charged. The caller releases the hold.
 */
export const UNSETTLED_COMPUTE: UsageTrackingOutcome = Object.freeze({ persisted: false, creditsSettled: false });

/** Read-only: could this charge's wallet fund a published-app wake right now? Never holds. */
export async function hasSpendableComputeBalance(charge: ComputeCharge): Promise<boolean> {
  if (charge.kind === 'org') return hasSpendableOrgPool(charge.orgId);
  return hasSpendableBalance(charge.userId, await personalTier(charge.userId));
}
