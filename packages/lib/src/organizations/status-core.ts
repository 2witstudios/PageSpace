/**
 * Org billing status — the pure decisions behind SEAT-9 (lapse) and the banner data
 * SEAT-6 allows each role to see. No IO: `status.ts` reads the stored subscription
 * and calls these.
 *
 * An org is in exactly one of four states:
 *   - `active`    paid and current;
 *   - `trialing`  on its Business trial (SEAT-8);
 *   - `past_due`  a payment failed and Stripe is still retrying — the org keeps every
 *                 capability (a temporary decline is not a lapse), Owner and Admins
 *                 are told;
 *   - `lapsed`    trial expired, unpaid, canceled, or never subscribed (there is no
 *                 free org tier, A-7). Org drives stay readable; org-only capabilities
 *                 stop (SEAT-9). NOTHING is deleted or reallocated: lapse is a read of
 *                 the subscription, never a write to drives, members or wallets, so
 *                 leaving lapse restores exactly what was there.
 *
 * Where billing is off (onprem, tenant) there is no subscription to lapse: always
 * active.
 */

export const ORG_STATUSES = ['active', 'trialing', 'past_due', 'lapsed'] as const;
export type OrgStatus = (typeof ORG_STATUSES)[number];

export type OrgLapseReason =
  | 'no_subscription'
  | 'trial_expired'
  | 'unpaid'
  | 'canceled'
  | 'incomplete'
  | 'unknown_status';

export type OrgStatusResult =
  | { status: Exclude<OrgStatus, 'lapsed'>; reason: null }
  | { status: 'lapsed'; reason: OrgLapseReason };

/** The stored org subscription as the status reads it (org_subscriptions). */
export interface OrgSubscriptionState {
  /** Stripe's subscription status. */
  status: string;
  trialEnd: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

/**
 * How long a `trialing` row outlives its trial end before it reads as lapsed. Stripe
 * ends a trial with no card by canceling it (trial_settings missing_payment_method =
 * cancel), and that arrives as a webhook; if the webhook is lost the stored row would
 * say `trialing` forever. Past this grace the org lapses on its own; a late webhook
 * saying `active` (the card did land) lifts it again.
 */
export const ORG_TRIAL_GRACE_MS = 24 * 60 * 60 * 1000;

/** The SEAT-9 refusal, shown wherever an org-only capability is refused. No credit or price figure. */
export const ORG_LAPSED_MESSAGE =
  "This organization's subscription has lapsed. Its drives stay readable and nothing has been deleted, " +
  'but inviting, creating org drives, the org pool and allocations, policy changes, publishing and ' +
  'sandboxes are paused until an Owner or Admin reactivates billing.';

export const ORG_LAPSED_CODE = 'org_lapsed' as const;

export function deriveOrgStatus(input: {
  billingEnabled: boolean;
  subscription: OrgSubscriptionState | null;
  now: Date;
}): OrgStatusResult {
  if (!input.billingEnabled) return { status: 'active', reason: null };
  const sub = input.subscription;
  if (!sub) return { status: 'lapsed', reason: 'no_subscription' };

  const trialOver = sub.trialEnd !== null && input.now.getTime() - sub.trialEnd.getTime() >= ORG_TRIAL_GRACE_MS;
  switch (sub.status) {
    case 'active':
      return { status: 'active', reason: null };
    case 'past_due':
      return { status: 'past_due', reason: null };
    case 'trialing':
      return trialOver ? { status: 'lapsed', reason: 'trial_expired' } : { status: 'trialing', reason: null };
    case 'canceled':
    case 'incomplete_expired':
      // A trial Stripe canceled at its end (no card) is a trial that expired.
      return {
        status: 'lapsed',
        reason: sub.trialEnd !== null && sub.trialEnd.getTime() <= input.now.getTime() ? 'trial_expired' : 'canceled',
      };
    case 'unpaid':
    case 'paused':
      return { status: 'lapsed', reason: 'unpaid' };
    case 'incomplete':
      return { status: 'lapsed', reason: 'incomplete' };
    default:
      return { status: 'lapsed', reason: 'unknown_status' };
  }
}

export type OrgCapabilityCheck = { ok: true } | { ok: false; code: typeof ORG_LAPSED_CODE; message: string };

/** The one rule every org-only capability applies (SEAT-9): refused only while lapsed. */
export function orgStatusAllows(result: OrgStatusResult): OrgCapabilityCheck {
  return result.status === 'lapsed' ? { ok: false, code: ORG_LAPSED_CODE, message: ORG_LAPSED_MESSAGE } : { ok: true };
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
 * detail (SEAT-6): the lapse reason, a failed payment, the trial end. A member sees
 * only that the org is read-only while it is lapsed, and nothing otherwise.
 */
export type OrgBillingNotice =
  | { kind: 'reactivate'; reason: OrgLapseReason; canManageBilling: true }
  | { kind: 'payment_failed'; canManageBilling: true }
  | { kind: 'trial'; trialEnd: string | null; canManageBilling: true }
  | { kind: 'read_only'; canManageBilling: false };

export function orgBillingNotice(input: {
  result: OrgStatusResult;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  trialEnd: Date | null;
}): OrgBillingNotice | null {
  const manages = input.role === 'OWNER' || input.role === 'ADMIN';
  const { result } = input;
  if (result.status === 'lapsed') {
    return manages ? { kind: 'reactivate', reason: result.reason, canManageBilling: true } : { kind: 'read_only', canManageBilling: false };
  }
  if (!manages) return null;
  if (result.status === 'past_due') return { kind: 'payment_failed', canManageBilling: true };
  if (result.status === 'trialing') return { kind: 'trial', trialEnd: input.trialEnd?.toISOString() ?? null, canManageBilling: true };
  return null;
}
