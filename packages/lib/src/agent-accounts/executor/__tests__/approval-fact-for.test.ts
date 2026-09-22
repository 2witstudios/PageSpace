/**
 * L2·G2 — `approvalFactFor`: the `ApprovalFact` the executor hands the
 * verifier (ADR 0004 F14/F15). For a concrete approval it is the ROW as the
 * main DB holds it (the verifier compares its account, digest, consuming grant
 * and expiry against the signed grant). For the `'policy'` sentinel it reports
 * whether the account's stored policy has run out: an expired policy never
 * covers a use, and a row whose policy is gone or unreadable covers nothing.
 */
import { describe, expect, it } from 'vitest';
import type { ApprovalId, GrantId, RequestDigest } from '../../grant';
import { approvalFactFor } from '../approval-fact-for';

const NOW = 1_800_000_000_000;
const policy = { scope: { origins: [], operations: [], resources: [] }, trigger: 'irreversible_only', duration: null, limits: { maxUsesPerHour: 10, maxBytesOut: 10, maxConcurrent: 1 }, approver: 'u1' };
const approval = { approvalId: 'a1' as ApprovalId, accountId: 'acct_1', requestDigest: 'd1' as RequestDigest, consumedByGrantId: 'g1' as GrantId, expiresAt: NOW + 1 };

describe('approvalFactFor', () => {
  it('given a concrete approval id and its row, should report the row facts', () => {
    const actual = approvalFactFor({ approvalId: 'a1' as ApprovalId, approval, account: { approvalPolicy: policy, policyVersion: 3 }, now: NOW });
    const expected = { kind: 'concrete', approvalId: 'a1', accountId: 'acct_1', requestDigest: 'd1', consumedByGrantId: 'g1', expiresAt: NOW + 1 };
    expect(actual).toEqual(expected);
  });

  it('given a concrete approval id with no row, should report none', () => {
    const actual = approvalFactFor({ approvalId: 'a1' as ApprovalId, approval: null, account: { approvalPolicy: policy, policyVersion: 3 }, now: NOW });
    const expected = { kind: 'none' };
    expect(actual).toEqual(expected);
  });

  it('given the policy sentinel, should report the policy version and whether it expired; a missing policy counts as expired', () => {
    const actual = [
      approvalFactFor({ approvalId: 'policy', approval: null, account: { approvalPolicy: policy, policyVersion: 3 }, now: NOW }),
      approvalFactFor({ approvalId: 'policy', approval: null, account: { approvalPolicy: { ...policy, duration: { until: NOW } }, policyVersion: 3 }, now: NOW }),
      approvalFactFor({ approvalId: 'policy', approval: null, account: { approvalPolicy: null, policyVersion: 3 }, now: NOW }),
    ];
    const expected = [
      { kind: 'policy', policyVersion: 3, expired: false, limitsExceeded: false },
      { kind: 'policy', policyVersion: 3, expired: true, limitsExceeded: false },
      { kind: 'policy', policyVersion: 3, expired: true, limitsExceeded: false },
    ];
    expect(actual).toEqual(expected);
  });
});
