/**
 * ADR 0004 §5 + §8.18 — the audit record shape and the rule that audit
 * acceptance PRECEDES execution (F13).
 *
 * Written RED at G1b before `build-audit-record.ts`, `decide-audit-gate.ts`
 * and `redact-known-values.ts` existed. The adapter half (a durable row in
 * the hash-chained audit before the executor acts) is
 * `audit-repository.integration.test.ts`, against the real :5433 Postgres.
 */
import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { buildAuditRecord } from '../build-audit-record';
import { decideAuditGate } from '../decide-audit-gate';
import { redactKnownValues } from '../redact-known-values';
import { canonicalizeRequest } from '../canonicalize-request';
import { digestRequest } from '../digest-request';
import { GRANT_ISSUER } from '../grant-constants';
import type { AgentAccountAuditRecord, AuditOutcome } from '../audit';
import type { CanonicalRequest, CanonicalRequestInput } from '../canonical-request';
import type {
  AgentAccountGrant,
  AgentPageId,
  ApprovalId,
  BindingDigest,
  ConversationId,
  GrantDenyReason,
  GrantId,
  HashBytes,
  Nonce,
  PresenterKeyId,
  RunId,
  SandboxGeneration,
  SandboxInstanceId,
  SessionId,
  SpriteName,
  UserId,
} from '../grant';
import type { AccountId, CredentialVersion, PolicyVersion, TenantId } from '@pagespace/db/schema/agent-accounts';

const hash: HashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const AT = 1_800_000_000_000;

const SECRET = 'ghp_canary_9f3a2b7c4d1e';
const BODY_TEXT = `{"title":"ship it","token":"${SECRET}"}`;

function canonical(overrides: Partial<CanonicalRequestInput> = {}): CanonicalRequest {
  const result = canonicalizeRequest({
    channel: 'http-executor',
    method: 'POST',
    url: 'https://api.github.com/repos/octo/hello/issues?state=open',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: new TextEncoder().encode(BODY_TEXT),
    resources: { repo: 'octo/hello' },
    operation: { class: 'write', name: 'github.issues.create' },
    declaredHeaders: [],
    ...overrides,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.canonical;
}

function makeGrant(overrides: Partial<AgentAccountGrant> = {}): AgentAccountGrant {
  return {
    grantId: 'grant_1' as GrantId,
    iss: GRANT_ISSUER,
    aud: 'http-executor',
    tenantId: 'user:user_1' as TenantId,
    human: { userId: 'user_1' as UserId, sessionId: 'session_1' as SessionId },
    delegationId: null,
    agentPageId: 'page_1' as AgentPageId,
    conversationId: 'conv_1' as ConversationId,
    runId: 'run_1' as RunId,
    sandbox: null,
    callerCeiling: { allowedDriveIds: ['drive_1'], originatingMcpTokenId: 'mcp_1' },
    accountId: 'acct_1' as AccountId,
    accountKind: 'api_key',
    credentialVersion: 3 as CredentialVersion,
    policyVersion: 5 as PolicyVersion,
    bindingDigest: 'bd_1' as BindingDigest,
    operation: { class: 'write', name: 'github.issues.create' },
    requestDigest: digestRequest({ canonical: canonical(), hash }),
    sessionHttp: false,
    approvalId: 'approval_1' as ApprovalId,
    iat: AT - 1_000,
    nbf: AT - 1_000,
    exp: AT + 60_000,
    nonce: 'nonce_1' as Nonce,
    presenter: { keyId: 'pk_1' as PresenterKeyId, channel: 'http-executor' },
    ...overrides,
  };
}

const build = (outcome: AuditOutcome, grant = makeGrant(), c = canonical()): AgentAccountAuditRecord =>
  buildAuditRecord({ grant, canonical: c, outcome, at: AT });

describe('buildAuditRecord', () => {
  it('given a canonical request with a body and a resolved credential in scope, should produce a record containing neither (property test over random bodies, query strings and header values) [0004 §8.18]', () => {
    const leaks: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      const secret = randomBytes(16).toString('hex');
      const bodyText = `{"note":"${randomBytes(8).toString('hex')}","token":"${secret}"}`;
      const inQuery = randomBytes(12).toString('hex');
      const inHeader = randomBytes(12).toString('hex');
      const record = build(
        { kind: 'executed', upstreamStatus: 201 },
        makeGrant(),
        canonical({
          body: new TextEncoder().encode(bodyText),
          url: `https://api.github.com/repos/octo/hello/issues?token=${inQuery}`,
          headers: { accept: `application/vnd.${inHeader}+json` },
        }),
      );
      const serialized = JSON.stringify(record);
      for (const value of [secret, bodyText, inQuery, inHeader]) {
        if (serialized.includes(value)) leaks.push(value);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('given a credential carried in the PATH or a resource, should land in the record — the shape carries both, so a URL-embedded secret reaches the chain (stated, not hidden)', () => {
    // Recorded deliberately rather than fixed here: `normalizedAction.path`
    // and `resources` are part of the frozen record shape (ADR 0004 §5), and
    // the chain cannot be erased afterwards. Keeping a credential out of a
    // path is the operation catalogue's job, and narrowing the shape is a
    // [D-n]. This test exists so the property above is never read as a
    // guarantee it does not make.
    const record = build({ kind: 'allowed' }, makeGrant(), canonical({ url: 'https://api.github.com/v1/tokens/ghp_in_the_path', resources: { repo: 'ghp_in_a_resource' } }));
    const serialized = JSON.stringify(record);
    expect({ path: serialized.includes('ghp_in_the_path'), resource: serialized.includes('ghp_in_a_resource') }).toEqual({ path: true, resource: true });
  });

  it('given a canonical request, should carry header NAMES only, never values', () => {
    const record = build({ kind: 'allowed' });
    const serialized = JSON.stringify(record);
    expect(record.normalizedAction.headerNames).toEqual(['accept', 'content-length', 'content-type']);
    expect(serialized).not.toContain('application/json');
  });

  it('given a canonical request with a query string, should carry the path without it (the digest pins the exact request)', () => {
    const record = build({ kind: 'allowed' });
    expect(record.normalizedAction.path).toBe('/repos/octo/hello/issues');
    expect(JSON.stringify(record)).not.toContain('state=open');
  });

  it('given every principal on the grant, should carry each by id', () => {
    const grant = makeGrant({ sandbox: { spriteName: 'ws' as SpriteName, instanceId: 'sprite-1' as SandboxInstanceId, generation: 2 as SandboxGeneration } });
    const record = build({ kind: 'allowed' }, grant);
    expect(record.principal).toEqual({
      tenantId: grant.tenantId,
      human: grant.human,
      delegationId: grant.delegationId,
      agentPageId: grant.agentPageId,
      conversationId: grant.conversationId,
      runId: grant.runId,
      sandbox: grant.sandbox,
      callerCeiling: grant.callerCeiling,
    });
  });

  it('given a grant, should carry the account, versions, approval, digest and presenter by id', () => {
    const grant = makeGrant();
    const record = build({ kind: 'allowed' }, grant);
    expect({
      grantId: record.grantId,
      accountId: record.accountId,
      accountKind: record.accountKind,
      credentialVersion: record.credentialVersion,
      policyVersion: record.policyVersion,
      approvalId: record.approvalId,
      requestDigest: record.requestDigest,
      presenter: record.presenter,
      at: record.at,
    }).toEqual({
      grantId: grant.grantId,
      accountId: grant.accountId,
      accountKind: grant.accountKind,
      credentialVersion: grant.credentialVersion,
      policyVersion: grant.policyVersion,
      approvalId: grant.approvalId,
      requestDigest: grant.requestDigest,
      presenter: grant.presenter,
      at: AT,
    });
  });

  it('given a canonical request, should carry its bodySha256 so the exact bytes stay provable without being stored', () => {
    const c = canonical();
    const record = build({ kind: 'allowed' }, makeGrant(), c);
    expect(record.normalizedAction.bodySha256).toBe(c.bodySha256);
  });

  it('given a denied verdict, should carry the GrantDenyReason (Record over every reason; typecheck fails on an added reason)', () => {
    const reasons: Readonly<Record<GrantDenyReason, true>> = {
      malformed: true,
      wrong_audience: true,
      ceiling: true,
      tenant_mismatch: true,
      principal_mismatch: true,
      version_mismatch: true,
      policy_epoch: true,
      no_delegation: true,
      digest_mismatch: true,
      generation_mismatch: true,
      ttl_too_long: true,
      clock_skew: true,
      not_yet_valid: true,
      expired: true,
      bad_signature: true,
      replayed: true,
      replay_store_unavailable: true,
      audit_unavailable: true,
      approval_mismatch: true,
      kind_not_resolvable: true,
    };
    const actual = (Object.keys(reasons) as GrantDenyReason[]).map((reason) => build({ kind: 'denied', reason }).outcome);
    expect(actual).toEqual((Object.keys(reasons) as GrantDenyReason[]).map((reason) => ({ kind: 'denied', reason })));
  });

  it('given a record, should carry only the frozen field set (nothing that could hold a body or a value)', () => {
    const actual = Object.keys(build({ kind: 'allowed' })).sort();
    expect(actual).toEqual([
      'accountId',
      'accountKind',
      'approvalId',
      'at',
      'credentialVersion',
      'grantId',
      'normalizedAction',
      'outcome',
      'policyVersion',
      'presenter',
      'principal',
      'requestDigest',
    ].sort());
  });

  it('given the same inputs twice, should produce the same record (pure)', () => {
    const actual = [build({ kind: 'allowed' }), build({ kind: 'allowed' })];
    expect(actual[0]).toEqual(actual[1]);
  });
});

describe('decideAuditGate (ADR 0004 F13)', () => {
  it('given the allowed record durably accepted, should proceed', () => {
    const actual = decideAuditGate({ acceptance: { kind: 'accepted' } });
    expect(actual).toEqual({ action: 'proceed' });
  });

  it.each(['unavailable', 'rejected', 'pending'] as const)('given acceptance %s, should refuse with audit_unavailable and never proceed', (kind) => {
    const actual = decideAuditGate({ acceptance: { kind } });
    expect(actual).toEqual({ action: 'refuse', reason: 'audit_unavailable' });
  });
});

describe('redactKnownValues (Λ10 tripwire, threat model A1)', () => {
  it('given text containing a known value, should replace every occurrence and report the tripwire', () => {
    const actual = redactKnownValues({ text: `a ${SECRET} b ${SECRET}`, knownValues: [SECRET] });
    expect(actual).toEqual({ text: 'a [redacted] b [redacted]', redacted: true });
  });

  it('given text containing no known value, should return it unchanged and report no tripwire', () => {
    const actual = redactKnownValues({ text: 'nothing here', knownValues: [SECRET] });
    expect(actual).toEqual({ text: 'nothing here', redacted: false });
  });

  it('given a known value that is empty or trivially short, should ignore it (never redact the whole text)', () => {
    const actual = redactKnownValues({ text: 'a b c', knownValues: ['', ' ', 'a'] });
    expect(actual).toEqual({ text: 'a b c', redacted: false });
  });

  it('given a known value containing regex metacharacters, should match it literally', () => {
    const actual = redactKnownValues({ text: 'key a.b*c+d here', knownValues: ['a.b*c+d'] });
    expect(actual).toEqual({ text: 'key [redacted] here', redacted: true });
  });

  it('given a base64 or url-encoded echo of a known value, should NOT catch it (a stated non-guarantee, Λ10)', () => {
    const encoded = Buffer.from(SECRET).toString('base64');
    const actual = redactKnownValues({ text: `echo ${encoded}`, knownValues: [SECRET] });
    expect(actual).toEqual({ text: `echo ${encoded}`, redacted: false });
  });

  it('given several known values, should redact each', () => {
    const actual = redactKnownValues({ text: 'one AAAA1111 two BBBB2222', knownValues: ['AAAA1111', 'BBBB2222'] });
    expect(actual).toEqual({ text: 'one [redacted] two [redacted]', redacted: true });
  });
});

describe('audit acceptance before execute — adapter (ADR 0004 F13)', () => {
  it.todo('given an unavailable audit store, should refuse the operation with audit_unavailable and not act — see audit-repository.integration.test.ts');
  it.todo('given a durable allowed record, should act, then write the outcome row keyed by the same grantId — see audit-repository.integration.test.ts');
});
