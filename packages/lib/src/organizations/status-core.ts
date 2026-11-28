/**
 * SEAT-8/9 organization capability decisions. Only an active subscription grants
 * capabilities in cloud. Payment retries and Stripe-side trials do not grant grace.
 * Lapse is a read: member data and credit remain intact, and security tightening
 * remains available. Billing-disabled deployments derive capability separately.
 */
import { holdsOrgRole } from './authorize-core';

export const ORG_STATUSES = ['active', 'lapsed'] as const;
export type OrgStatus = (typeof ORG_STATUSES)[number];

export type OrgLapseReason =
  | 'no_subscription'
  | 'never_funded'
  | 'trial_unsupported'
  | 'payment_failed'
  | 'unpaid'
  | 'canceled'
  | 'incomplete'
  | 'manual_collection'
  | 'unknown_status';

export type OrgStatusResult =
  | { status: Exclude<OrgStatus, 'lapsed'>; reason: null }
  | { status: 'lapsed'; reason: OrgLapseReason };

/** The stored org subscription as the status reads it (org_subscriptions). */
export interface OrgSubscriptionState {
  /** Stripe status, or unverified_price when the mirror cannot verify the plan items. */
  status: string;
  /** Stripe collection_method as mirrored: only charge_automatically can grant capability ([D-OW-44]). */
  collectionMethod: string;
  /** Verified invoice evidence for this exact org and subscription (org_subscription_funding). */
  hasVerifiedFunding: boolean;
}

/** The SEAT-9 refusal, shown wherever an org-only capability is refused; restricting stays allowed (D-OW-33). No credit or price figure. */
export const ORG_LAPSED_MESSAGE =
  "This organization's subscription has lapsed. Its drives stay readable and nothing has been deleted, " +
  'but inviting, creating org drives, the org pool and allocations, loosening policies or caps, approving ' +
  'guests, publishing and sandboxes are paused until an Owner or Admin reactivates billing. Restricting access still works.';

export const ORG_LAPSED_CODE = 'org_lapsed' as const;

export function deriveOrgStatus(input: {
  billingEnabled: boolean;
  subscription: OrgSubscriptionState | null;
}): OrgStatusResult {
  if (!input.billingEnabled) return { status: 'active', reason: null };
  const sub = input.subscription;
  // [D-OW-30]: no creation trial — an org nobody has paid for spends nothing.
  if (!sub) return { status: 'lapsed', reason: 'no_subscription' };
  // [D-OW-44]: an invoice-billed subscription reads `active` before anything is paid, so only
  // automatic collection can grant capability; anything else is lapsed whatever its status.
  if (sub.collectionMethod !== 'charge_automatically') return { status: 'lapsed', reason: 'manual_collection' };

  switch (sub.status) {
    case 'active':
      return sub.hasVerifiedFunding === true
        ? { status: 'active', reason: null }
        : { status: 'lapsed', reason: 'never_funded' };
    case 'past_due':
      return { status: 'lapsed', reason: 'payment_failed' };
    case 'trialing':
      return { status: 'lapsed', reason: 'trial_unsupported' };
    case 'canceled':
    case 'incomplete_expired':
      return { status: 'lapsed', reason: 'canceled' };
    case 'unpaid':
    case 'paused':
      return { status: 'lapsed', reason: 'unpaid' };
    case 'incomplete':
      return { status: 'lapsed', reason: 'incomplete' };
    default:
      return { status: 'lapsed', reason: 'unknown_status' };
  }
}

/** SEAT-9's refusal, shaped like every other org refusal ({ ok, code, status, message }). 402: payment required. */
export type OrgLapsedRefusal = { ok: false; code: typeof ORG_LAPSED_CODE; status: 402; message: string };

export const ORG_LAPSED_REFUSAL: OrgLapsedRefusal = Object.freeze({
  ok: false,
  code: ORG_LAPSED_CODE,
  status: 402,
  message: ORG_LAPSED_MESSAGE,
}) as OrgLapsedRefusal;

export type OrgCapabilityCheck = { ok: true } | OrgLapsedRefusal;

/**
 * [D-OW-33] the ONE guard for a write that could loosen access in an org (SEAT-9 as amended:
 * a lapsed org may only restrict). The caller says whether its change loosens (by its own pure
 * rule: visibilityChangeOnlyRestricts, roleChangeOnlyRestricts, loosenedPolicyKeys, …) and passes
 * the lapse it read in the write's transaction (status.ts readOrgLapsed); the answer is the lapse
 * refusal, or null to go ahead.
 */
export function decideOrgMayLoosen(input: { orgLapsed: boolean; loosens: boolean }): OrgLapsedRefusal | null {
  return input.orgLapsed && input.loosens ? ORG_LAPSED_REFUSAL : null;
}

/** The one rule every org-only capability applies (SEAT-9): refused only while lapsed. */
export function orgStatusAllows(result: OrgStatusResult): OrgCapabilityCheck {
  return result.status === 'lapsed' ? { ...ORG_LAPSED_REFUSAL } : { ok: true };
}

export type OrgLapseTransition = 'entered_lapse' | 'left_lapse';

/** Whether a status change enters or leaves lapse; `before` is null for an org seen for the first time. */
export function orgLapseTransition(before: OrgStatus | null, after: OrgStatus): OrgLapseTransition | null {
  const wasLapsed = before === 'lapsed';
  const isLapsed = after === 'lapsed';
  if (!wasLapsed && isLapsed) return 'entered_lapse';
  if (wasLapsed && !isLapsed) return 'left_lapse';
  return null;
}

/**
 * What the org surfaces show about billing, per role. Owner and Admins see plan
 * detail (SEAT-6): the lapse reason. A member sees
 * only that the org is read-only while it is lapsed, and nothing otherwise.
 */
export type OrgBillingNotice =
  | { kind: 'reactivate'; reason: OrgLapseReason; canManageBilling: true }
  | { kind: 'read_only'; canManageBilling: false };

export function orgBillingNotice(input: {
  result: OrgStatusResult;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
}): OrgBillingNotice | null {
  const manages = holdsOrgRole(input.role, 'ADMIN');
  const { result } = input;
  if (result.status === 'lapsed') {
    return manages ? { kind: 'reactivate', reason: result.reason, canManageBilling: true } : { kind: 'read_only', canManageBilling: false };
  }
  return null;
}

/**
 * SEAT-9 at the spend gate: while its org is lapsed, an org wallet leg (a drive wallet in
 * an org drive, a seat on the org pool) reads as `paused` — the existing kill-switch
 * state (WAL-7) — WITHOUT writing it. The spend decision then refuses a person, naming
 * the source and offering their own credits (never a silent switch, SPEND-4), and skips
 * an automation, never falling back to a person (SPEND-6). Leaving lapse restores the
 * stored status, because nothing was stored.
 */
export function orgLegStatus<S extends 'active' | 'paused' | 'over'>(stored: S, orgLapsed: boolean): S | 'paused' {
  return orgLapsed ? 'paused' : stored;
}
