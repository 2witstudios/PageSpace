/**
 * compute-charge — the PURE decisions behind charging compute (Spec WAL-9): sandbox runtime,
 * the terminal, browsers, environments and published apps.
 *
 * The payer seam (`sandbox-payer.ts`) answers WHO pays: the org for an org drive, else the
 * drive's owner. This module turns that into the charge a compute site holds and settles:
 *
 * - A personal payer charges that person's personal root wallet, exactly as before wallets.
 * - An org payer charges the ORG POOL (WAL-2: the org-owned root wallet) — never the drive
 *   wallet, never a seat (WAL-9: wallets do not change compute billing), and never a person.
 *   A hold and a usage row must still name a person (credit_holds.userId and
 *   credit_ledger.userId are NOT NULL), so an org charge carries `userId`: the person who ran
 *   it, or the drive lead for an accrual no person ran. That person is who the row is
 *   RECORDED under; the money moves on the org pool alone.
 *
 * INVARIANT: zero I/O. The shell is `compute-gate.ts`.
 */

import type { BillingPayer } from './sandbox-payer';
import type { CreditGateResult } from './credit-gate';
import { ORG_ENTITLEMENT_TIER } from './spend-target';
import type { SubscriptionTier } from './subscription-tiers';

/**
 * What one compute charge debits. `userId` is always a real person: the payer themselves for a
 * personal charge; for an org charge, only who the hold and usage rows are recorded under.
 */
export type ComputeCharge =
  | { kind: 'user'; userId: string }
  | { kind: 'org'; orgId: string; userId: string };

/**
 * The charge for `payer`, recorded under `recordedUserId` when the payer is an org. A personal
 * payer is charged as themselves whoever ran the work (the drive owner pays for their drive).
 * There is no branch that turns an org payer into a person's charge.
 */
export function computeChargeFor(payer: BillingPayer, recordedUserId: string): ComputeCharge {
  return payer.kind === 'org'
    ? { kind: 'org', orgId: payer.orgId, userId: recordedUserId }
    : { kind: 'user', userId: payer.userId };
}

/**
 * Whether two charges are the same PAYER: same org pool, or same person. `userId` on an org
 * charge is only who the rows are recorded under, so it never makes two org charges differ.
 * A long-lived meter compares its charge with the one the drive resolves to NOW to see that the
 * drive moved into or out of an org (or changed hands) since the window opened.
 */
export function sameCharge(a: ComputeCharge, b: ComputeCharge): boolean {
  if (a.kind === 'org') return b.kind === 'org' && a.orgId === b.orgId;
  return b.kind === 'user' && a.userId === b.userId;
}

/**
 * The tier a compute charge's entitlements and ceilings follow: the org's (SEAT-8: there is no
 * free org tier) for an org charge, the paying person's own otherwise. `personalTier` is the
 * tier read for `charge.userId`; it is ignored for an org charge, so a free-tier member running
 * compute in an org drive gets the org's machines and ceilings, not their own.
 */
export function computeChargeTier(charge: ComputeCharge, personalTier: SubscriptionTier): SubscriptionTier {
  return charge.kind === 'org' ? ORG_ENTITLEMENT_TIER : personalTier;
}

/** Why an org pool refused a compute hold: missing, paused, or unable to cover it. */
export type OrgComputeRefusal = 'org_wallet_unavailable' | 'org_wallet_paused' | 'org_wallet_empty';

/** What the person who asked sees for each org pool refusal. Nothing was started or charged. */
export const ORG_COMPUTE_REFUSAL_MESSAGES: Readonly<Record<OrgComputeRefusal, string>> = Object.freeze({
  org_wallet_unavailable:
    "This drive belongs to an organization that has no wallet to bill compute to, so nothing was started. An org Owner or Admin needs to set up the organization's billing.",
  org_wallet_paused:
    "This drive belongs to an organization whose wallet is paused, so compute here is stopped and nothing was started. An org Owner or Admin can resume it.",
  org_wallet_empty:
    "This drive belongs to an organization whose wallet can't cover this run, so nothing was started. An org Owner or Admin can add credits.",
});

const ORG_COMPUTE_REFUSALS: readonly string[] = Object.keys(ORG_COMPUTE_REFUSAL_MESSAGES);

export function isOrgComputeRefusal(reason: string): reason is OrgComputeRefusal {
  return ORG_COMPUTE_REFUSALS.includes(reason);
}

/** The refusal an org pool hold can answer: an org state, or the two per-person bounds. */
export type OrgComputeGateRefusal = OrgComputeRefusal | 'concurrency_limit' | 'daily_cap_exceeded';

/**
 * Names an org pool gate's refusal for the person who asked, or null when it allowed. The
 * in-flight and daily bounds stay their own reasons: waiting clears them, a top-up does not.
 */
export function orgComputeRefusalOf(answer: CreditGateResult): OrgComputeGateRefusal | null {
  if (answer.allowed) return null;
  if (answer.reason === 'too_many_in_flight') return 'concurrency_limit';
  if (answer.reason === 'daily_cap_exceeded') return 'daily_cap_exceeded';
  if (answer.refusal?.reason === 'source_unavailable') return 'org_wallet_unavailable';
  if (answer.refusal?.reason === 'source_paused') return 'org_wallet_paused';
  return 'org_wallet_empty';
}
