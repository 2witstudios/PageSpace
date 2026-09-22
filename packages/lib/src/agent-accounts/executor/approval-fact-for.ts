/**
 * `approvalFactFor` — the `ApprovalFact` the HTTP executor hands `verifyGrant`
 * (ADR 0004 F14/F15; L2·G2). Pure.
 *
 * A concrete approval id is reported as the main-DB row holds it; the
 * verifier compares its account, digest, consuming grant and expiry with the
 * signed grant, so a row a writer inserted still needs a grant signed over it.
 * The `'policy'` sentinel reports the account's policy version and whether the
 * stored policy has run out; a policy that is gone or not policy-shaped counts
 * as expired — it covers nothing. Use limits are not yet counted (no usage
 * ledger in this slice), so `limitsExceeded` is false.
 */
import type { ApprovalFact, ApprovalId, GrantId, RequestDigest } from '../grant';
import type { AccountId, PolicyVersion } from '@pagespace/db/schema/agent-accounts';

export type ApprovalRowFacts = {
  readonly approvalId: ApprovalId;
  readonly accountId: string;
  readonly requestDigest: RequestDigest;
  readonly consumedByGrantId: GrantId | null;
  readonly expiresAt: number;
};

function policyExpired(policy: unknown, now: number): boolean {
  if (typeof policy !== 'object' || policy === null || !('duration' in policy)) return true;
  const { duration } = policy as { readonly duration: unknown };
  if (duration === null) return false;
  if (typeof duration !== 'object' || !('until' in duration)) return true;
  const until = (duration as { readonly until: unknown }).until;
  return typeof until !== 'number' || !Number.isFinite(until) || until <= now;
}

export function approvalFactFor({
  approvalId,
  approval,
  account,
  now,
}: {
  readonly approvalId: ApprovalId | 'policy';
  readonly approval: ApprovalRowFacts | null;
  readonly account: { readonly approvalPolicy: unknown; readonly policyVersion: number };
  readonly now: number;
}): ApprovalFact {
  if (approvalId === 'policy') return { kind: 'policy', policyVersion: account.policyVersion as PolicyVersion, expired: policyExpired(account.approvalPolicy, now), limitsExceeded: false };
  if (approval === null) return { kind: 'none' };
  return {
    kind: 'concrete',
    approvalId: approval.approvalId,
    accountId: approval.accountId as AccountId,
    requestDigest: approval.requestDigest,
    consumedByGrantId: approval.consumedByGrantId,
    expiresAt: approval.expiresAt,
  };
}
