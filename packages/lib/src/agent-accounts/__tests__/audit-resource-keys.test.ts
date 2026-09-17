/**
 * ADR 0004 §5, §8.41, §8.44 — the audit chain's resource values are an
 * explicit allowlist (G1c R6), and a denial records the account status the
 * caller never sees (G1c R14). Written RED before `audit-resource-keys-for.ts`
 * and `build-denied-outcome.ts` exist (Control Board §7.2).
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { OperationRegistryEntry } from '../canonical-request';
import type { AccountId, CredentialVersion, PolicyVersion, TenantId } from '@pagespace/db/schema/agent-accounts';
import type {
  AgentAccountGrant,
  ApprovalId,
  BindingDigest,
  ConversationId,
  GrantDenyReason,
  GrantId,
  HashBytes,
  Nonce,
  PresenterKeyId,
  RequestDigest,
  RunId,
  SessionId,
  UserId,
} from '../grant';
import { auditResourceKeysFor } from '../audit-resource-keys-for';
import { buildDeniedOutcome } from '../build-denied-outcome';
import { canonicalizeRequest } from '../canonicalize-request';
import { buildAuditRecord } from '../build-audit-record';
import { ENTRY_DEFAULTS, TEST_ORIGIN, TEST_PROVIDER } from './operation-registry.fixture';

const sha3: HashBytes = (bytes) => createHash('sha3-256').update(bytes).digest('hex');

const GRANT: AgentAccountGrant = {
  grantId: 'grant_1' as GrantId,
  iss: 'pagespace-account-authority',
  aud: 'http-executor',
  tenantId: 'user:u1' as TenantId,
  human: { userId: 'u1' as UserId, sessionId: 's1' as SessionId },
  delegationId: null,
  agentPageId: null,
  conversationId: 'c1' as ConversationId,
  runId: 'r1' as RunId,
  sandbox: null,
  callerCeiling: { allowedDriveIds: [], originatingMcpTokenId: null },
  accountId: 'acct_1' as AccountId,
  accountKind: 'api_key',
  credentialVersion: 1 as CredentialVersion,
  policyVersion: 1 as PolicyVersion,
  bindingDigest: 'bd' as BindingDigest,
  operation: { class: 'privilege', name: 'github.tokens.get' },
  requestDigest: 'rd' as RequestDigest,
  sessionHttp: false,
  approvalId: 'ap_1' as ApprovalId,
  iat: 0,
  nbf: 0,
  exp: 60_000,
  nonce: 'n1' as Nonce,
  presenter: { keyId: 'pk' as PresenterKeyId, channel: 'http-executor' },
};

function tokenEntry(overrides: Partial<OperationRegistryEntry> = {}): OperationRegistryEntry {
  return {
    ...ENTRY_DEFAULTS,
    origin: TEST_ORIGIN,
    providerSlug: TEST_PROVIDER,
    channel: 'http-executor',
    method: 'GET',
    pathTemplate: '/repos/{owner}/{repo}/tokens/{token}',
    operation: { class: 'privilege', name: 'github.tokens.get' },
    declaredHeaders: [],
    ...overrides,
  };
}

describe('auditResourceKeysFor (G1c R6)', () => {
  it('given an entry with no auditResourceSlots, should allow no resource into the chain', () => {
    const actual = auditResourceKeysFor({ entry: tokenEntry() });
    expect(actual).toEqual([]);
  });

  it('given allowlisted slots, should return their restriction keys (a slot without a mapping keeps its name)', () => {
    const actual = auditResourceKeysFor({ entry: tokenEntry({ auditResourceSlots: ['repo', 'owner'], restrictionKeys: { repo: 'github.repo' } }) });
    expect(actual).toEqual(['github.repo', 'owner']);
  });

  it('given no matched entry (a generic request), should allow nothing', () => {
    const actual = auditResourceKeysFor({ entry: null });
    expect(actual).toEqual([]);
  });

  it('given a secret-bearing path slot that the entry does not allowlist, should keep the secret out of the audit record end to end', () => {
    const secret = 'ghp_canary_g1c_r6_5e1f';
    const entry = tokenEntry({ auditResourceSlots: ['repo'] });
    const result = canonicalizeRequest({
      request: { channel: 'http-executor', method: 'GET', url: `https://api.github.com/repos/octo/hello/tokens/${secret}`, headers: {}, body: new Uint8Array(0) },
      providerSlug: TEST_PROVIDER,
      registry: [entry],
    });
    if (!result.ok) throw new Error(result.reason);
    const record = buildAuditRecord({
      grant: GRANT,
      canonical: result.canonical,
      outcome: { kind: 'allowed' },
      at: 1,
      hash: sha3,
      auditResourceKeys: auditResourceKeysFor({ entry }),
    });
    const actual = { resourceIds: record.normalizedAction.resourceIds, leaks: JSON.stringify(record).includes(secret) };
    expect(actual).toEqual({ resourceIds: [['repo', 'hello']], leaks: false });
  });
});

describe('buildDeniedOutcome (G1c R14)', () => {
  it('given account_not_active, should carry the status the adapter read', () => {
    const actual = (['revoked', 'needs_reauth', 'deleted'] as const).map((accountStatus) => buildDeniedOutcome({ reason: 'account_not_active', accountStatus }));
    expect(actual).toEqual([
      { kind: 'denied', reason: 'account_not_active', accountStatus: 'revoked' },
      { kind: 'denied', reason: 'account_not_active', accountStatus: 'needs_reauth' },
      { kind: 'denied', reason: 'account_not_active', accountStatus: 'deleted' },
    ]);
  });

  it('given any other reason, or an unknown account (null status), should carry null', () => {
    const reasons: readonly GrantDenyReason[] = ['version_mismatch', 'ceiling', 'bad_signature'];
    const actual = [...reasons.map((reason) => buildDeniedOutcome({ reason, accountStatus: 'active' })), buildDeniedOutcome({ reason: 'account_not_active', accountStatus: null })];
    expect(actual).toEqual([
      { kind: 'denied', reason: 'version_mismatch', accountStatus: null },
      { kind: 'denied', reason: 'ceiling', accountStatus: null },
      { kind: 'denied', reason: 'bad_signature', accountStatus: null },
      { kind: 'denied', reason: 'account_not_active', accountStatus: null },
    ]);
  });
});

describe('a defective registry entry never reaches the audit projection at runtime (CodeRabbit #2660)', () => {
  it('given a matched entry whose slots share a restriction key, canonicalizeRequest should refuse malformed — no loader has to have run first', () => {
    const shared = tokenEntry({ restrictionKeys: { repo: 'github.id', token: 'github.id' }, auditResourceSlots: ['repo'] });
    const actual = canonicalizeRequest({
      request: { channel: 'http-executor', method: 'GET', url: 'https://api.github.com/repos/octo/hello/tokens/ghp_canary_shared', headers: {}, body: new Uint8Array(0) },
      providerSlug: TEST_PROVIDER,
      registry: [shared],
    });
    expect(actual).toEqual({ ok: false, reason: 'malformed' });
  });

  it('given a matched entry with an audit slot it does not declare, canonicalizeRequest should refuse malformed', () => {
    const undeclared = tokenEntry({ auditResourceSlots: ['secret'] });
    const actual = canonicalizeRequest({
      request: { channel: 'http-executor', method: 'GET', url: 'https://api.github.com/repos/octo/hello/tokens/x', headers: {}, body: new Uint8Array(0) },
      providerSlug: TEST_PROVIDER,
      registry: [undeclared],
    });
    expect(actual).toEqual({ ok: false, reason: 'malformed' });
  });
});
