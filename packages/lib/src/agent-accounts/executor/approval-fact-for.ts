/**
 * `approvalFactFor` — the `ApprovalFact` the HTTP executor hands `verifyGrant`
 * (ADR 0004 F14/F15; L2·G2). Pure.
 *
 * A concrete approval id is reported as the main-DB row holds it; the
 * verifier compares its account, digest, consuming grant and expiry with the
 * signed grant, so a row a writer inserted still needs a grant signed over it.
 * The `'policy'` sentinel reports the account's policy version and the plane's
 * own usage verdict (`decidePolicyUsage` over the PLANE's stored policy and
 * usage ledger — never the main-DB row's policy, which a writer could widen).
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

export function approvalFactFor({
  approvalId,
  approval,
  policyVersion,
  policyUsage,
}: {
  readonly approvalId: ApprovalId | 'policy';
  readonly approval: ApprovalRowFacts | null;
  readonly policyVersion: number;
  readonly policyUsage: { readonly expired: boolean; readonly limitsExceeded: boolean };
}): ApprovalFact {
  if (approvalId === 'policy') return { kind: 'policy', policyVersion: policyVersion as PolicyVersion, expired: policyUsage.expired, limitsExceeded: policyUsage.limitsExceeded };
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
