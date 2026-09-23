/**
 * L2·G2 — `approvalFactFor`: the `ApprovalFact` the executor hands the
 * verifier (ADR 0004 F14/F15). For a concrete approval it is the ROW as the
 * main DB holds it (the verifier compares its account, digest, consuming grant
 * and expiry against the signed grant). For the `'policy'` sentinel it is the
 * account's policy version plus the plane's own usage verdict
 * (`decidePolicyUsage` over the PLANE's stored policy and ledger — review
 * Codex P1): an expired or exhausted policy covers nothing.
 */
import { describe, expect, it } from 'vitest';
import type { ApprovalId, GrantId, RequestDigest } from '../../grant';
import { approvalFactFor } from '../approval-fact-for';

const NOW = 1_800_000_000_000;
const approval = { approvalId: 'a1' as ApprovalId, accountId: 'acct_1', requestDigest: 'd1' as RequestDigest, consumedByGrantId: 'g1' as GrantId, expiresAt: NOW + 1 };
const live = { expired: false, limitsExceeded: false };

describe('approvalFactFor', () => {
  it('given a concrete approval id and its row, should report the row facts', () => {
    const actual = approvalFactFor({ approvalId: 'a1' as ApprovalId, approval, policyVersion: 3, policyUsage: live });
    const expected = { kind: 'concrete', approvalId: 'a1', accountId: 'acct_1', requestDigest: 'd1', consumedByGrantId: 'g1', expiresAt: NOW + 1 };
    expect(actual).toEqual(expected);
  });

  it('given a concrete approval id with no row, should report none', () => {
    const actual = approvalFactFor({ approvalId: 'a1' as ApprovalId, approval: null, policyVersion: 3, policyUsage: live });
    const expected = { kind: 'none' };
    expect(actual).toEqual(expected);
  });

  it('given the policy sentinel, should carry the plane usage verdict — expired and exhausted pass through', () => {
    const actual = [
      approvalFactFor({ approvalId: 'policy', approval: null, policyVersion: 3, policyUsage: live }),
      approvalFactFor({ approvalId: 'policy', approval: null, policyVersion: 3, policyUsage: { expired: true, limitsExceeded: false } }),
      approvalFactFor({ approvalId: 'policy', approval: null, policyVersion: 3, policyUsage: { expired: false, limitsExceeded: true } }),
    ];
    const expected = [
      { kind: 'policy', policyVersion: 3, expired: false, limitsExceeded: false },
      { kind: 'policy', policyVersion: 3, expired: true, limitsExceeded: false },
      { kind: 'policy', policyVersion: 3, expired: false, limitsExceeded: true },
    ];
    expect(actual).toEqual(expected);
  });
});
