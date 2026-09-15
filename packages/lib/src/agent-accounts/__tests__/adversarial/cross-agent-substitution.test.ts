import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify, createPublicKey, createHash } from 'node:crypto';
import { verifyGrant } from '../../verify-grant';
import { encodeGrant } from '../../encode-grant';
import { GRANT_ISSUER } from '../../grant-constants';
import { canonicalizeRequest } from '../../canonicalize-request';
import { digestRequest } from '../../digest-request';
import { decideAccountAccess } from '../../../permissions/decide-account-access';
import type { AccountAccessFacts } from '../../../permissions/account-permissions';
import type {
  AgentAccountGrant,
  AgentPageId,
  ApprovalId,
  BindingDigest,
  ConversationId,
  DelegationId,
  DriveId,
  Ed25519Verify,
  ExpectedBinding,
  GrantId,
  HashBytes,
  Nonce,
  PresenterKeyId,
  RequestDigest,
  RunId,
  SessionId,
  UserId,
} from '../../grant';
import type { AccountId, CredentialVersion, PolicyVersion, TenantId } from '@pagespace/db/schema/agent-accounts';
import type { CanonicalRequestInput } from '../../canonical-request';

// Threat model A3 (ASI03). Table rows over verifyGrant / decideAccountAccess
// first; I/O cases last (Control Board §7.7). Every row here is pure.

const issuer = generateKeyPairSync('ed25519');
const issuerPublicKey = new Uint8Array(issuer.publicKey.export({ type: 'spki', format: 'der' }));
const verify: Ed25519Verify = (message, signature, publicKey) =>
  nodeVerify(null, message, createPublicKey({ key: Buffer.from(publicKey), type: 'spki', format: 'der' }), signature);
const hash: HashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const NOW = 1_800_000_000_000;
const DRIVE = 'drive_1' as DriveId;

function digestOf(resources: Record<string, string>): RequestDigest {
  const input: CanonicalRequestInput = {
    channel: 'http-executor',
    method: 'POST',
    url: 'https://api.github.com/repos/octo/hello/issues',
    headers: {},
    body: new Uint8Array(0),
    resources,
    operation: { class: 'write', name: 'github.issues.create' },
    declaredHeaders: [],
  };
  const result = canonicalizeRequest(input);
  if (!result.ok) throw new Error(result.reason);
  return digestRequest({ canonical: result.canonical, hash });
}

const DIGEST_X = digestOf({ account: 'acct_X', repo: 'octo/hello' });

function grantFor(overrides: Partial<AgentAccountGrant> = {}): AgentAccountGrant {
  return {
    grantId: 'grant_1' as GrantId,
    iss: GRANT_ISSUER,
    aud: 'http-executor',
    tenantId: 'drive:drive_1' as TenantId,
    human: { userId: 'user_1' as UserId, sessionId: 'session_1' as SessionId },
    delegationId: null,
    agentPageId: 'page_A' as AgentPageId,
    conversationId: 'conv_1' as ConversationId,
    runId: 'run_1' as RunId,
    sandbox: null,
    callerCeiling: { allowedDriveIds: [], originatingMcpTokenId: null },
    accountId: 'acct_X' as AccountId,
    accountKind: 'api_key',
    credentialVersion: 1 as CredentialVersion,
    policyVersion: 1 as PolicyVersion,
    bindingDigest: 'bd' as BindingDigest,
    operation: { class: 'write', name: 'github.issues.create' },
    requestDigest: DIGEST_X,
    sessionHttp: false,
    approvalId: 'approval_1' as ApprovalId,
    iat: NOW - 1_000,
    nbf: NOW - 1_000,
    exp: NOW + 60_000,
    nonce: 'nonce_1' as Nonce,
    presenter: { keyId: 'pk_exec' as PresenterKeyId, channel: 'http-executor' },
    ...overrides,
  };
}

function present(grant: AgentAccountGrant, expected: Partial<ExpectedBinding> = {}, requestDigest: RequestDigest = DIGEST_X) {
  return verifyGrant({
    grant,
    signature: Buffer.from(nodeSign(null, encodeGrant(grant), issuer.privateKey)).toString('base64'),
    issuerPublicKey,
    now: NOW,
    expected: {
      aud: grant.aud,
      presenter: grant.presenter,
      human: grant.human,
      agentPageId: grant.agentPageId,
      conversationId: grant.conversationId,
      runId: grant.runId,
      tenantId: grant.tenantId,
      accountId: grant.accountId,
      accountKind: grant.accountKind,
      accountDriveId: DRIVE,
      currentCredentialVersion: grant.credentialVersion,
      currentPolicyVersion: grant.policyVersion,
      delegation: grant.delegationId === null ? { kind: 'live_session' } : { kind: 'delegation', delegationId: grant.delegationId, accountId: grant.accountId, expired: false, revoked: false },
      sandbox: null,
      ceilingAdmitsAccount: true,
      ...expected,
    },
    requestDigest,
    requestOperation: grant.operation,
    nonceState: 'fresh',
    approval: { kind: 'concrete', approvalId: 'approval_1' as ApprovalId, requestDigest: DIGEST_X, consumedByGrantId: grant.grantId },
    verify,
    hash,
  });
}

const facts = (overrides: Partial<AccountAccessFacts> = {}): AccountAccessFacts => ({
  accountId: 'acct_X' as AccountId,
  kind: 'api_key',
  status: 'active',
  owner: { kind: 'user', userId: 'user_owner' },
  accountDriveId: null,
  actorUserId: 'user_other' as UserId,
  actingHumanUserId: 'user_other' as UserId,
  humanDriveRole: 'MEMBER',
  humanCanEditAgentPage: true,
  agentPageId: 'page_A' as AgentPageId,
  agentBoundToAccount: true,
  delegation: { kind: 'live_session' },
  sessionHttpEnabled: false,
  callerCeiling: { allowedDriveIds: [], originatingMcpTokenId: null },
  ceilingAdmitsAccount: true,
  ...overrides,
});

describe('adversarial: cross-agent-substitution', () => {
  it('given a valid unused grant issued for agent page A presented by the same presenter for a run driven by agent page B, should return principal_mismatch (ExpectedBinding carries the current run) [PR #2637 P1]', () => {
    const actual = present(grantFor({ agentPageId: 'page_A' as AgentPageId }), { agentPageId: 'page_B' as AgentPageId });
    expect(actual).toEqual({ ok: false, reason: 'principal_mismatch' });
  });

  it('given a grant issued for conversation C1 presented on run R2 of conversation C2, should return principal_mismatch', () => {
    const actual = present(grantFor(), { conversationId: 'conv_2' as ConversationId, runId: 'run_2' as RunId });
    expect(actual).toEqual({ ok: false, reason: 'principal_mismatch' });
  });

  it('given a user-owned account bound to a shared agent and a different member invoking that agent, should return use false and issue no grant', () => {
    const actual = decideAccountAccess({ facts: facts() });
    expect(actual).toEqual({ view: false, use: false, manage: false, grant: false, session_http: false });
  });

  it('given a drive-scoped MCP token whose ceiling excludes the account drive, should read the account as nonexistent (ceiling first) [B0 B-10]', () => {
    const access = decideAccountAccess({
      facts: facts({
        owner: { kind: 'agent_page', agentPageId: 'page_A', driveId: 'drive_1' },
        accountDriveId: DRIVE,
        actorUserId: 'user_1' as UserId,
        actingHumanUserId: 'user_1' as UserId,
        humanDriveRole: 'OWNER',
        callerCeiling: { allowedDriveIds: ['drive_other'], originatingMcpTokenId: 'mcp_1' },
        ceilingAdmitsAccount: false,
      }),
    });
    const verdict = present(grantFor({ callerCeiling: { allowedDriveIds: ['drive_other'], originatingMcpTokenId: 'mcp_1' } }), { ceilingAdmitsAccount: false });
    expect({ access, verdict }).toEqual({
      access: { view: false, use: false, manage: false, grant: false, session_http: false },
      verdict: { ok: false, reason: 'ceiling' },
    });
  });

  it('given a grant for account X and a request naming account Y in resources, should return digest_mismatch', () => {
    const actual = present(grantFor(), {}, digestOf({ account: 'acct_Y', repo: 'octo/hello' }));
    expect(actual).toEqual({ ok: false, reason: 'digest_mismatch' });
  });

  it('given the same human, two agent pages, and a delegation for only one, should deny the other with no_delegation', () => {
    const unattended = grantFor({ human: { userId: 'user_1' as UserId, sessionId: null }, delegationId: 'dlg_A' as DelegationId, agentPageId: 'page_B' as AgentPageId });
    // The presenter's current run is page_B; the only delegation on file is for another account/page pairing.
    const actual = present(unattended, {
      delegation: { kind: 'delegation', delegationId: 'dlg_A' as DelegationId, accountId: 'acct_other' as AccountId, expired: false, revoked: false },
    });
    expect(actual).toEqual({ ok: false, reason: 'no_delegation' });
  });

  it('given a grant whose acting human is not the run human (another user driving the shared agent), should return principal_mismatch', () => {
    const actual = present(grantFor(), { human: { userId: 'user_2' as UserId, sessionId: 'session_9' as SessionId } });
    expect(actual).toEqual({ ok: false, reason: 'principal_mismatch' });
  });
});
