/**
 * L2·G2 — `authorize`: the authority's whole intersection as ONE pure function
 * (task item 3; ADR 0004 §4, threat model §4):
 *
 *   authenticated caller ∩ delegation ∩ account permission (decideAccountAccess)
 *   ∩ PageSpace page permission ∩ explicit account-use binding ∩ kind
 *   ∩ canonical request ∩ origin pin ∩ approval ∩ epochs → an UNSIGNED grant
 *
 * or a typed refusal. Requirements pinned here:
 * - an `accountId` the caller is not entitled to is indistinguishable from a
 *   missing one (same refusal, same shape);
 * - a caller with view-only access to the agent page cannot use its account;
 * - any origin but the pin (another port included) is refused before I/O;
 * - a kind other than `api_key` is refused at use with a typed reason;
 * - an unknown generic request needs a concrete approval bound to its digest
 *   unless the human accepted a bounded policy for exactly that capability.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { AgentAccountRecord } from '@pagespace/db/schema/agent-accounts';
import type { AgentPageId, ApprovalId, ConversationId, DelegationId, GrantId, HashBytes, Nonce, PresenterKeyId, RunId, SessionId, UserId } from '../grant';
import type { AccountApprovalPolicy } from '../approval';
import type { CanonicalOrigin } from '../canonical-request';
import { canonicalizeRequest } from '../canonicalize-request';
import { digestRequest } from '../digest-request';
import { digestBindings } from '../store/digest-bindings';
import { planeBindingsFor } from '../plane-bindings-for';
import { authorize, type AuthorizeInput } from '../authorize';

const sha3: HashBytes = (bytes) => createHash('sha3-256').update(bytes).digest('hex');
const NOW = 1_800_000_000_000;
const ORIGIN = 'https://api.weather.example:443' as CanonicalOrigin;
const HUMAN = 'user_h' as UserId;

const genericPolicy: AccountApprovalPolicy = {
  scope: { origins: [ORIGIN], operations: [{ class: 'unknown', name: 'generic_request' }], resources: [] },
  trigger: 'irreversible_only',
  duration: null,
  limits: { maxUsesPerHour: 100, maxBytesOut: 1_000_000, maxConcurrent: 4 },
  approver: HUMAN,
};

const agentAccount = {
  id: 'acct_1',
  kind: 'api_key',
  ownerKind: 'agent_page',
  ownerUserId: null,
  ownerAgentPageId: 'page_a',
  ownerDriveId: 'drive_1',
  tenantId: 'drive:drive_1',
  name: 'Weather',
  providerSlug: null,
  allowedOrigins: [ORIGIN],
  auxiliaryOrigins: [],
  resourceRestrictions: {},
  approvalPolicy: genericPolicy,
  credentialVersion: 1,
  policyVersion: 2,
  acknowledgment: 'dedicated_agent_account',
  sessionFormat: null,
  sessionHttpEnabled: false,
  status: 'active',
  upstreamRevocation: null,
  lastUsedAt: null,
  createdAt: new Date(NOW - 10_000),
  updatedAt: new Date(NOW - 10_000),
  revokedAt: null,
} as unknown as AgentAccountRecord;

const request = { channel: 'http-executor' as const, method: 'GET', url: 'https://api.weather.example/v1/forecast?city=Oslo', headers: { accept: 'application/json' }, body: new Uint8Array(0) };

function input(overrides: Partial<AuthorizeInput> = {}): AuthorizeInput {
  return {
    caller: {
      actorUserId: HUMAN,
      actingHumanUserId: HUMAN,
      sessionId: 'sess_1' as SessionId,
      agentPageId: 'page_a' as AgentPageId,
      conversationId: 'conv_1' as ConversationId,
      runId: 'run_1' as RunId,
      callerCeiling: { allowedDriveIds: [], originatingMcpTokenId: null },
    },
    account: agentAccount,
    facts: { humanDriveRole: 'MEMBER', agentPagePermission: 'edit', agentBoundToAccount: false, boundAgentPageIds: [], delegation: { kind: 'live_session' }, ceilingAdmitsAccount: true },
    request,
    registry: [],
    approvals: [],
    usage: { usesThisHour: 0, bytesOutThisHour: 0, concurrent: 0 },
    presenter: { keyId: 'exec_key_1' as PresenterKeyId, channel: 'http-executor' },
    now: NOW,
    grantId: 'grant_1' as GrantId,
    nonce: 'nonce_1' as Nonce,
    ttlMs: 60_000,
    hash: sha3,
    ...overrides,
  };
}

const canonicalOf = (req = request) => {
  const result = canonicalizeRequest({ request: req, providerSlug: null, registry: [] });
  if (!result.ok) throw new Error(result.reason);
  return result.canonical;
};
const DIGEST = digestRequest({ canonical: canonicalOf(), hash: sha3 });
const UNAVAILABLE = { ok: false, reason: 'account_unavailable' };

describe('authorize — the intersection', () => {
  it('given an entitled editor of the agent page and a bounded policy for generic requests to the pin, should issue a grant binding every principal, the digest, the epochs and the plane bindings', () => {
    const verdict = authorize(input());
    const { bindings } = planeBindingsFor({ row: agentAccount, boundAgentPageIds: [], hash: sha3 });
    const actual = verdict.ok ? { grant: verdict.grant, approvalToConsume: verdict.approvalToConsume, approvalStepUp: verdict.approvalStepUp } : verdict;
    const expected = {
      grant: {
        grantId: 'grant_1',
        iss: 'pagespace-account-authority',
        aud: 'http-executor',
        tenantId: 'drive:drive_1',
        human: { userId: HUMAN, sessionId: 'sess_1' },
        delegationId: null,
        agentPageId: 'page_a',
        conversationId: 'conv_1',
        runId: 'run_1',
        sandbox: null,
        callerCeiling: { allowedDriveIds: [], originatingMcpTokenId: null },
        accountId: 'acct_1',
        accountKind: 'api_key',
        credentialVersion: 1,
        policyVersion: 2,
        bindingDigest: digestBindings({ bindings, hash: sha3 }),
        operation: { class: 'unknown', name: 'generic_request' },
        requestDigest: DIGEST,
        sessionHttp: false,
        approvalId: 'policy',
        iat: NOW,
        nbf: NOW,
        exp: NOW + 60_000,
        nonce: 'nonce_1',
        presenter: { keyId: 'exec_key_1', channel: 'http-executor' },
      },
      approvalToConsume: null,
      approvalStepUp: false,
    };
    expect(actual).toEqual(expected);
  });

  it('given no account row, a caller outside the drive, a caller ceiling that excludes the drive, or a revoked account, should refuse with the SAME account_unavailable', () => {
    const actual = [
      authorize(input({ account: null })),
      authorize(input({ facts: { ...input().facts, humanDriveRole: null } })),
      authorize(input({ facts: { ...input().facts, ceilingAdmitsAccount: false } })),
      authorize(input({ caller: { ...input().caller, callerCeiling: { allowedDriveIds: ['drive_other'], originatingMcpTokenId: 'mcp_1' } } })),
      authorize(input({ account: { ...agentAccount, status: 'revoked' } as AgentAccountRecord })),
    ];
    const expected = [UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, UNAVAILABLE];
    expect(actual).toEqual(expected);
  });

  it('given a drive member with only view access to the agent page, should be unable to use its account', () => {
    const actual = authorize(input({ facts: { ...input().facts, agentPagePermission: 'view' } }));
    const expected = UNAVAILABLE;
    expect(actual).toEqual(expected);
  });

  it('given the run driving ANOTHER agent page than the one owning the account, should refuse (cross-agent substitution)', () => {
    const actual = authorize(input({ caller: { ...input().caller, agentPageId: 'page_b' as AgentPageId } }));
    const expected = UNAVAILABLE;
    expect(actual).toEqual(expected);
  });

  it('given a user-owned account and another member driving the shared agent it is bound to, should refuse; the owner driving it, should issue', () => {
    const owned = { ...agentAccount, ownerKind: 'user', ownerUserId: 'user_owner', ownerAgentPageId: null, ownerDriveId: null, tenantId: 'user:user_owner' } as AgentAccountRecord;
    const facts = { ...input().facts, humanDriveRole: null, agentBoundToAccount: true, boundAgentPageIds: ['page_a' as AgentPageId] };
    const actual = [
      authorize(input({ account: owned, facts })),
      authorize(input({ account: owned, facts, caller: { ...input().caller, actorUserId: 'user_owner' as UserId, actingHumanUserId: 'user_owner' as UserId } })).ok,
    ];
    const expected = [UNAVAILABLE, true];
    expect(actual).toEqual(expected);
  });

  it('given an entitled caller and an account kind this slice does not implement, should refuse kind_not_supported', () => {
    const actual = authorize(input({ account: { ...agentAccount, kind: 'bearer' } as AgentAccountRecord }));
    const expected = { ok: false, reason: 'kind_not_supported' };
    expect(actual).toEqual(expected);
  });

  it('given an account whose material was never committed, should refuse not_provisioned', () => {
    const actual = authorize(input({ account: { ...agentAccount, credentialVersion: 0 } as AgentAccountRecord }));
    const expected = { ok: false, reason: 'not_provisioned' };
    expect(actual).toEqual(expected);
  });

  it('given the pinned host on another port, another host, a URL with userinfo, or a model-supplied Authorization header, should refuse before issuing anything', () => {
    const actual = [
      authorize(input({ request: { ...request, url: 'https://api.weather.example:8443/v1/forecast' } })),
      authorize(input({ request: { ...request, url: 'https://collector.evil.test/v1/forecast' } })),
      authorize(input({ request: { ...request, url: 'https://u:p@api.weather.example/v1/forecast' } })),
      authorize(input({ request: { ...request, headers: { authorization: 'Bearer stolen' } } })),
    ];
    const expected = [
      { ok: false, reason: 'destination_denied', rule: 'origin_not_allowed' },
      { ok: false, reason: 'destination_denied', rule: 'origin_not_allowed' },
      { ok: false, reason: 'request_refused', rule: 'userinfo_present' },
      { ok: false, reason: 'request_refused', rule: 'reserved_header' },
    ];
    expect(actual).toEqual(expected);
  });

  it('given no policy, should require a concrete approval bound to the request digest and hand the human-readable subject', () => {
    const verdict = authorize(input({ account: { ...agentAccount, approvalPolicy: null } as AgentAccountRecord }));
    const actual = verdict.ok ? verdict : { reason: verdict.reason, digest: 'digest' in verdict ? verdict.digest : null, stepUp: 'stepUp' in verdict ? verdict.stepUp : null, origin: 'subject' in verdict ? verdict.subject.origin : null };
    const expected = { reason: 'approval_required', digest: DIGEST, stepUp: false, origin: ORIGIN };
    expect(actual).toEqual(expected);
  });

  it('given an unconsumed allow-once approval for exactly this digest, should issue under it and name it for consumption; for another digest, expired, or already consumed, should still require approval', () => {
    const noPolicy = { ...agentAccount, approvalPolicy: null } as AgentAccountRecord;
    const approval = { approvalId: 'appr_1' as ApprovalId, accountId: 'acct_1', requestDigest: DIGEST, expiresAt: NOW + 60_000, consumed: false, steppedUp: false };
    const verdicts = [
      authorize(input({ account: noPolicy, approvals: [approval] })),
      authorize(input({ account: noPolicy, approvals: [{ ...approval, requestDigest: 'other' as never }] })),
      authorize(input({ account: noPolicy, approvals: [{ ...approval, expiresAt: NOW - 1 }] })),
      authorize(input({ account: noPolicy, approvals: [{ ...approval, consumed: true }] })),
      authorize(input({ account: noPolicy, approvals: [{ ...approval, accountId: 'acct_other' }] })),
    ];
    const actual = verdicts.map((verdict) => (verdict.ok ? [verdict.grant.approvalId, verdict.approvalToConsume] : verdict.reason));
    const expected = [['appr_1', 'appr_1'], 'approval_required', 'approval_required', 'approval_required', 'approval_required'];
    expect(actual).toEqual(expected);
  });

  it('given an unattended run with no delegation, should refuse; with a live delegation for this account, page and human, should issue carrying its id', () => {
    const unattended = { ...input().caller, sessionId: null };
    const delegation = { kind: 'delegation' as const, delegationId: 'del_1' as DelegationId, accountId: 'acct_1' as never, agentPageId: 'page_a' as AgentPageId, delegatedBy: HUMAN, scope: genericPolicy.scope, expired: false, revoked: false };
    const verdicts = [
      authorize(input({ caller: unattended, facts: { ...input().facts, delegation: { kind: 'none' } } })),
      authorize(input({ caller: unattended, facts: { ...input().facts, delegation } })),
    ];
    const actual = verdicts.map((verdict) => (verdict.ok ? { delegationId: verdict.grant.delegationId, sessionId: verdict.grant.human.sessionId } : verdict));
    const expected = [UNAVAILABLE, { delegationId: 'del_1', sessionId: null }];
    expect(actual).toEqual(expected);
  });

  it('given the policy use limit exhausted, should refuse limits_exceeded', () => {
    const actual = authorize(input({ usage: { usesThisHour: 100, bytesOutThisHour: 0, concurrent: 0 } }));
    const expected = { ok: false, reason: 'limits_exceeded' };
    expect(actual).toEqual(expected);
  });

  it('given a requested lifetime above the 15-minute ceiling, should clamp exp to iat + 15 minutes', () => {
    const verdict = authorize(input({ ttlMs: 3_600_000 }));
    const actual = verdict.ok ? verdict.grant.exp - verdict.grant.iat : verdict;
    const expected = 900_000;
    expect(actual).toEqual(expected);
  });
});
