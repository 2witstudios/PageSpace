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
import { orgSubscriptions } from '@pagespace/db/schema/organizations';
import { isBillingEnabled } from '../deployment-mode';
import {
  deriveOrgStatus,
  orgStatusAllows,
  type OrgCapabilityCheck,
  type OrgStatusResult,
  type OrgSubscriptionState,
} from './status-core';

export {
  ORG_LAPSED_CODE,
  ORG_LAPSED_MESSAGE,
  orgBillingNotice,
  type OrgBillingNotice,
  type OrgCapabilityCheck,
  type OrgStatus,
  type OrgStatusResult,
} from './status-core';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export type OrgStatusRead = Readonly<{ result: OrgStatusResult; subscription: OrgSubscriptionState | null }>;

/** The org's billing status and the stored subscription it was derived from. */
export async function readOrgStatus(orgId: string, opts: { now?: Date; executor?: Executor } = {}): Promise<OrgStatusRead> {
  const billingEnabled = isBillingEnabled();
  if (!billingEnabled) return { result: { status: 'active', reason: null }, subscription: null };
  const executor = opts.executor ?? db;
  const [row] = await executor
    .select({
      status: orgSubscriptions.status,
      trialEnd: orgSubscriptions.trialEnd,
      currentPeriodEnd: orgSubscriptions.currentPeriodEnd,
      cancelAtPeriodEnd: orgSubscriptions.cancelAtPeriodEnd,
    })
    .from(orgSubscriptions)
    .where(eq(orgSubscriptions.orgId, orgId))
    .limit(1);
  const subscription = row ?? null;
  return { result: deriveOrgStatus({ billingEnabled, subscription, now: opts.now ?? new Date() }), subscription };
}

/** The org's status: active | trialing | past_due | lapsed (with why). */
export async function getOrgStatus(orgId: string, opts: { now?: Date; executor?: Executor } = {}): Promise<OrgStatusResult> {
  return (await readOrgStatus(orgId, opts)).result;
}

/** SEAT-9: may the org use its org-only capabilities right now? False only while lapsed. */
export async function isOrgActive(orgId: string, opts: { now?: Date; executor?: Executor } = {}): Promise<boolean> {
  return (await getOrgStatus(orgId, opts)).status !== 'lapsed';
}

/** SEAT-9: the refusal an org-only capability returns (`{ ok: false, code: 'org_lapsed', message }`) or ok. */
export async function checkOrgActive(orgId: string, opts: { now?: Date; executor?: Executor } = {}): Promise<OrgCapabilityCheck> {
  return orgStatusAllows(await getOrgStatus(orgId, opts));
}
