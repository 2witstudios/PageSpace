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
import { holdWalletId, releaseHold } from './credit-consume';
import { lookupDriveBillingFacts, resolveEnvCharge } from './sandbox-payer';
import { MACHINE_HOLD_ESTIMATE_CENTS } from './credit-pricing';
import { ensurePersonalRootWalletId } from './personal-wallet';
import { isBillingEnabled } from '../deployment-mode';
import { toSubscriptionTier, type SubscriptionTier } from './subscription-tiers';
import type { UsageTrackingOutcome } from '../monitoring/ai-monitoring';
import { isOrgActive } from '../organizations/status';
import { ORG_LAPSED_MESSAGE } from '../organizations/status-core';
import { ORG_COMPUTE_REFUSAL_MESSAGES, computeChargeTier, computeSpendKind, orgComputeRefusalOf, type ComputeCharge, type OrgComputeGateRefusal } from './compute-charge';

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
 * The tier a charge's entitlements and ceilings follow — the org's for an org charge (Business
 * while paid, none while LAPSED: SEAT-9, WAL-8), the paying person's own otherwise.
 */
export async function resolveComputeChargeTier(charge: ComputeCharge): Promise<SubscriptionTier> {
  return charge.kind === 'org' ? computeChargeTier(charge, 'free', !(await isOrgActive(charge.orgId))) : personalTier(charge.userId);
}

/** Reserve for one compute run on the charge's wallet, before the run starts. */
export async function gateComputeCharge(charge: ComputeCharge, opts: ComputeGateOptions): Promise<ComputeGateResult> {
  const tier = await resolveComputeChargeTier(charge);
  const maxInFlight = typeof opts.maxInFlight === 'function' ? opts.maxInFlight(tier) : opts.maxInFlight;
  // Every compute hold is marked compute, an env or app accrual as 'drive_compute'; on an org pool
  // both count toward the recorded person's seat (seat-allowance, [D-OW-28]).
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

/** Why a drive's new billable compute is refused: the org lapsed (SEAT-9), or the member's cap is spent (WAL-2). */
export type DriveComputeAdmissionRefusal = { allowed: false; code: 'org_lapsed' | 'org_member_cap_reached'; message: string };

/**
 * [D-OW-28] Whether `userId` may CREATE a billable environment or published app in `driveId`. Its
 * compute will be recorded under, and capped against, them; a member already at their cap cannot
 * add a resource that would only ever be refused or overshoot. Decided the way every compute
 * admission is — a real hold for the creator's charge, taken under the pool row's lock in the
 * gate's transaction (gateSharedWallet), then released at once: creating starts no machine, so
 * nothing is reserved past the decision. The member's own cap refuses here, and so does a LAPSED org
 * (SEAT-9, review 3+4 P1-2: no new environment or published app while the org has not paid); an
 * empty or paused pool refuses the resource's first wake, as before. A personal drive, a deployment
 * without billing, or an unresolvable drive admits: there is no per-member cap to apply.
 */
export async function admitDriveComputeCreator(input: { driveId: string; userId: string }): Promise<{ allowed: true } | DriveComputeAdmissionRefusal> {
  if (!isBillingEnabled()) return { allowed: true };
  const charge = await resolveEnvCharge({ driveId: input.driveId, costOwnerId: input.userId, lookupDriveBillingFacts: (id) => lookupDriveBillingFacts(id) });
  if (!charge || charge.kind !== 'org') return { allowed: true };
  const gate = await gateComputeCharge(charge, { estCostCents: MACHINE_HOLD_ESTIMATE_CENTS });
  if (gate.allowed) {
    if (gate.holdId) await releaseHold(gate.holdId);
    return { allowed: true };
  }
  if (gate.orgRefusal === 'org_lapsed') return { allowed: false, code: 'org_lapsed', message: ORG_LAPSED_MESSAGE };
  return gate.orgRefusal === 'org_member_cap_reached'
    ? { allowed: false, code: 'org_member_cap_reached', message: ORG_COMPUTE_REFUSAL_MESSAGES.org_member_cap_reached }
    : { allowed: true };
}

/**
 * SEAT-9 (review #2761 P2-1): whether a drive's org is paid up, for actions that re-start compute on
 * an EXISTING resource — re-publishing an app, rebuilding an environment — where no new per-member
 * cost is created (so the creator cap does not apply) but a lapsed org must still start nothing. A
 * personal drive, a deployment without billing, or an unresolvable drive admits.
 */
export async function admitDriveOrgActive(input: { driveId: string }): Promise<{ allowed: true } | { allowed: false; code: 'org_lapsed'; message: string }> {
  if (!isBillingEnabled()) return { allowed: true };
  const facts = await lookupDriveBillingFacts(input.driveId);
  if (!facts?.orgId) return { allowed: true };
  return (await isOrgActive(facts.orgId)) ? { allowed: true } : { allowed: false, code: 'org_lapsed', message: ORG_LAPSED_MESSAGE };
}
