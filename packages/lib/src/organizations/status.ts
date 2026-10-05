/**
 * Org billing status (Spec SEAT-9) — the ONE check every org-only capability uses:
 * inviting, creating org drives, the org pool and allocations, publishing from org
 * drives, sandbox and environments in org drives, and (when Wave E lands) policy
 * changes. The decision is pure (status-core.ts); this reads the stored subscription
 * the Stripe webhook mirrors (org_subscriptions) and the deployment's billing gate.
 *
 * A lapse is a READ, never a write: nothing here or in any caller deletes, moves or
 * reallocates a drive, a member or a credit. Leaving lapse (the webhook mirrors an
 * `active` subscription, or the Owner resubscribes) restores every capability with
 * everything exactly where it was.
 */
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { organizations, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { isBillingEnabled } from '../deployment-mode';
import {
  deriveOrgStatus,
  orgBillingNotice,
  orgStatusAllows,
  type OrgBillingNotice,
  type OrgCapabilityCheck,
  type OrgStatusResult,
  type OrgSubscriptionState,
} from './status-core';

export {
  ORG_LAPSED_CODE,
  ORG_LAPSED_MESSAGE,
  ORG_LAPSED_REFUSAL,
  type OrgLapsedRefusal,
  type OrgBillingNotice,
  type OrgCapabilityCheck,
  type OrgStatus,
  type OrgStatusResult,
} from './status-core';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export type OrgStatusRead = Readonly<{
  result: OrgStatusResult;
  subscription: OrgSubscriptionState | null;
  /** When a Stripe-side trial ends; null with no subscription (there is no creation trial, [D-OW-30]). */
  trialEnd: Date | null;
}>;

/**
 * The org's billing status and the stored subscription it was derived from. An org that
 * does not exist reads as lapsed (fail closed); callers check existence themselves.
 */
export async function readOrgStatus(orgId: string, opts: { now?: Date; executor?: Executor } = {}): Promise<OrgStatusRead> {
  const billingEnabled = isBillingEnabled();
  if (!billingEnabled) return { result: { status: 'active', reason: null }, subscription: null, trialEnd: null };
  const executor = opts.executor ?? db;
  const [row] = await executor
    .select({
      orgId: organizations.id,
      status: orgSubscriptions.status,
      trialEnd: orgSubscriptions.trialEnd,
      currentPeriodStart: orgSubscriptions.currentPeriodStart,
      currentPeriodEnd: orgSubscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: orgSubscriptions.cancelAtPeriodEnd,
    })
    .from(organizations)
    .leftJoin(orgSubscriptions, eq(orgSubscriptions.orgId, organizations.id))
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!row) return { result: { status: 'lapsed', reason: 'no_subscription' }, subscription: null, trialEnd: null };
  const subscription: OrgSubscriptionState | null =
    row.status === null
      ? null
      : { status: row.status, trialEnd: row.trialEnd, currentPeriodStart: row.currentPeriodStart, currentPeriodEnd: row.currentPeriodEnd, cancelAtPeriodEnd: row.cancelAtPeriodEnd ?? false };
  const result = deriveOrgStatus({ billingEnabled, subscription, now: opts.now ?? new Date() });
  return { result, subscription, trialEnd: subscription ? subscription.trialEnd : null };
}

/** The org's status: active | trialing | past_due | lapsed (with why). */
export async function getOrgStatus(orgId: string, opts: { now?: Date; executor?: Executor } = {}): Promise<OrgStatusResult> {
  return (await readOrgStatus(orgId, opts)).result;
}

/**
 * SEAT-9 / WAL-8: whether a drive's org is lapsed right now — false for a personal drive (or none)
 * with no read. What every compute-tier caller passes as `orgLapsed` (review #2761).
 */
export async function isOrgLapsedForDrive(drive: { orgId: string | null } | null | undefined): Promise<boolean> {
  return drive?.orgId ? !(await isOrgActive(drive.orgId)) : false;
}

/** SEAT-9: may the org use its org-only capabilities right now? False only while lapsed. */
export async function isOrgActive(orgId: string, opts: { now?: Date; executor?: Executor } = {}): Promise<boolean> {
  return (await getOrgStatus(orgId, opts)).status !== 'lapsed';
}

/**
 * SEAT-9 / SEAT-6: the billing notice the org surfaces show this caller — Owner and Admins
 * see plan detail (reactivate with the reason, a failed payment, the trial end), a member
 * only the read-only notice while lapsed. Null where billing is off (onprem, tenant: the
 * billing gate hides it entirely) and whenever there is nothing to show.
 */
export async function getOrgBillingNotice(
  orgId: string,
  role: 'OWNER' | 'ADMIN' | 'MEMBER',
  opts: { now?: Date; executor?: Executor } = {},
): Promise<OrgBillingNotice | null> {
  if (!isBillingEnabled()) return null;
  const read = await readOrgStatus(orgId, opts);
  return orgBillingNotice({ result: read.result, role, trialEnd: read.trialEnd });
}

/** SEAT-9: the refusal an org-only capability returns (`{ ok: false, code: 'org_lapsed', message }`) or ok. */
export async function checkOrgActive(orgId: string, opts: { now?: Date; executor?: Executor } = {}): Promise<OrgCapabilityCheck> {
  return orgStatusAllows(await getOrgStatus(orgId, opts));
}
