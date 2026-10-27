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
import { createAuditedExecutor } from '../audit-gate-executor';
import type { AuditAcceptance } from '../decide-audit-gate';
import type { AgentAccountDenialRecord } from '../denial-audit-record';
import { canonicalizeRequest } from '../canonicalize-request';
import { digestRequest } from '../digest-request';
import { GRANT_ISSUER } from '../grant-constants';
import type { AgentAccountAuditRecord, AuditOutcome } from '../audit';
import type { CanonicalRequest, CanonicalRequestInput } from '../canonical-request';
import { TEST_PROVIDER, TEST_REGISTRY } from './operation-registry.fixture';
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
/** The amended record digests the path with SHA3-256 — the repo's hash for secret-adjacent values. */
const sha3: HashBytes = (bytes) => createHash('sha3-256').update(bytes).digest('hex');
const AUDIT_RESOURCE_KEYS = ['repo', 'org'] as const;
const AT = 1_800_000_000_000;

const SECRET = 'ghp_canary_9f3a2b7c4d1e';
const BODY_TEXT = `{"title":"ship it","token":"${SECRET}"}`;

function canonical(overrides: Partial<CanonicalRequestInput> = {}): CanonicalRequest {
  const result = canonicalizeRequest({
    providerSlug: TEST_PROVIDER,
    registry: TEST_REGISTRY,
    request: {
    channel: 'http-executor',
    method: 'POST',
    url: 'https://api.github.com/repos/octo/hello/issues?state=open',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: new TextEncoder().encode(BODY_TEXT),
    ...overrides,
    },
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
  buildAuditRecord({ grant, canonical: c, outcome, at: AT, hash: sha3, auditResourceKeys: [...AUDIT_RESOURCE_KEYS] });

describe('buildAuditRecord', () => {
  it('given a canonical request with a body and a resolved credential in scope, should produce a record containing neither (property test over random bodies, query strings, header values, path segments and undeclared resources) [0004 §8.18]', () => {
    const leaks: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      const secret = randomBytes(16).toString('hex');
      const bodyText = `{"note":"${randomBytes(8).toString('hex')}","token":"${secret}"}`;
      const inQuery = randomBytes(12).toString('hex');
      const inHeader = randomBytes(12).toString('hex');
      // An undeclared slot IS a path segment now (M8): `{token}` is not a declared resource key.
      const inPath = randomBytes(12).toString('hex');
      const record = build(
        { kind: 'executed', upstreamStatus: 201 },
        makeGrant(),
        canonical({
          body: new TextEncoder().encode(bodyText),
          url: `https://api.github.com/repos/octo/hello/tokens/${inPath}?token=${inQuery}`,
          headers: { accept: `application/vnd.${inHeader}+json` },
        }),
      );
      const serialized = JSON.stringify(record);
      for (const value of [secret, bodyText, inQuery, inHeader, inPath]) {
        if (serialized.includes(value)) leaks.push(value);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('given a path containing a token-shaped segment bound to an undeclared slot, should contain no substring of it and keep only the declared resource [0004 §8.25]', () => {
    const token = 'ghp_9f3a2b7c4d1e5f6a7b8c';
    const c = canonical({ url: `https://api.github.com/repos/octo/hello/tokens/${token}` });
    const record = build({ kind: 'allowed' }, makeGrant(), c);
    const serialized = JSON.stringify(record);
    expect({
      extracted: c.resources,
      token: serialized.includes(token),
      undeclaredKey: serialized.includes('"token"'),
      declaredKept: record.normalizedAction.resourceIds,
    }).toEqual({
      extracted: [
        ['owner', 'octo'],
        ['repo', 'hello'],
        ['token', token],
      ],
      token: false,
      undeclaredKey: false,
      declaredKept: [['repo', 'hello']],
    });
  });

  it('given two requests to the same path, should produce the same pathDigest; given different paths, different digests (correlation survives)', () => {
    const a = build({ kind: 'allowed' }, makeGrant(), canonical({ url: 'https://api.github.com/repos/octo/hello/issues' }));
    const b = build({ kind: 'executed', upstreamStatus: 201 }, makeGrant(), canonical({ url: 'https://api.github.com/repos/octo/hello/issues?state=open' }));
    const other = build({ kind: 'allowed' }, makeGrant(), canonical({ url: 'https://api.github.com/repos/octo/hello/pulls' }));
    expect({ same: a.normalizedAction.pathDigest === b.normalizedAction.pathDigest, different: a.normalizedAction.pathDigest !== other.normalizedAction.pathDigest }).toEqual({ same: true, different: true });
  });

  it('given a canonical path, should digest it with the INJECTED hash over the path bytes (SHA3-256 in production)', () => {
    const c = canonical();
    const actual = build({ kind: 'allowed' }, makeGrant(), c).normalizedAction.pathDigest;
    expect(actual).toBe(sha3(new TextEncoder().encode(c.path)));
  });

  it('given a canonical request, should carry header NAMES only, never values', () => {
    const record = build({ kind: 'allowed' });
    const serialized = JSON.stringify(record);
    expect(record.normalizedAction.headerNames).toEqual(['accept', 'content-length', 'content-type']);
    expect(serialized).not.toContain('application/json');
  });

  it('given a canonical request with a query string, should carry neither the query nor the path itself (the request digest pins the exact request)', () => {
    const record = build({ kind: 'allowed' });
    const serialized = JSON.stringify(record);
    expect({ query: serialized.includes('state=open'), path: serialized.includes('/repos/octo/hello/issues') }).toEqual({ query: false, path: false });
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
      account_not_active: true,
      version_mismatch: true,
      policy_epoch: true,
      no_delegation: true,
      digest_mismatch: true,
      generation_mismatch: true,
      binding_unavailable: true,
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
    const actual = (Object.keys(reasons) as GrantDenyReason[]).map((reason) => build({ kind: 'denied', reason, accountStatus: null }).outcome);
    expect(actual).toEqual((Object.keys(reasons) as GrantDenyReason[]).map((reason) => ({ kind: 'denied', reason, accountStatus: null })));
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

  it('given a record, should carry the amended normalizedAction field set (no path, no free-form resources)', () => {
    const actual = Object.keys(build({ kind: 'allowed' }).normalizedAction).sort();
    expect(actual).toEqual(['bodySha256', 'channel', 'headerNames', 'method', 'operation', 'origin', 'pathDigest', 'resourceIds']);
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

describe('audited executor — the outcome row is part of the answer (ADR 0004 F13)', () => {
  /**
   * A recording fake: it answers each `accept` from a script and keeps every
   * record it was offered, so "what reached the chain" is observable. The real
   * chain is covered by audit-repository.integration.test.ts.
   */
  function scriptedRepository(answers: readonly AuditAcceptance['kind'][]) {
    const offered: string[] = [];
    const denials: AgentAccountDenialRecord[] = [];
    let call = 0;
    const next = (): AuditAcceptance => {
      const kind = answers[call] ?? 'accepted';
      call += 1;
      return { kind } as AuditAcceptance;
    };
    const accept = async ({ record }: { readonly record: AgentAccountAuditRecord }): Promise<AuditAcceptance> => {
      offered.push(record.outcome.kind);
      return next();
    };
    const acceptDenial = async ({ record }: { readonly record: AgentAccountDenialRecord }): Promise<AuditAcceptance> => {
      denials.push(record);
      return next();
    };
    return { repository: { accept, acceptDenial }, offered, denials };
  }

  it('given the outcome row cannot be accepted after the operation ran, should report the outcome as unrecorded rather than as a plain success', async () => {
    const { repository } = scriptedRepository(['accepted', 'unavailable']);
    const executor = createAuditedExecutor({ auditRepository: repository, hash: sha3 });
    const actual = await executor.execute({
      grant: makeGrant(),
      canonical: canonical(),
      now: AT,
      auditResourceKeys: [...AUDIT_RESOURCE_KEYS],
      act: async () => ({ kind: 'executed', upstreamStatus: 201 }),
    });
    const expected = { ok: true, outcome: { kind: 'executed', upstreamStatus: 201 }, outcomeRecorded: false };
    expect(actual).toEqual(expected);
  });

  it('given both rows accepted, should report the outcome as recorded', async () => {
    const { repository, offered } = scriptedRepository(['accepted', 'accepted']);
    const executor = createAuditedExecutor({ auditRepository: repository, hash: sha3 });
    const result = await executor.execute({
      grant: makeGrant(),
      canonical: canonical(),
      now: AT,
      auditResourceKeys: [...AUDIT_RESOURCE_KEYS],
      act: async () => ({ kind: 'executed', upstreamStatus: 201 }),
    });
    const actual = { result, offered };
    const expected = { result: { ok: true, outcome: { kind: 'executed', upstreamStatus: 201 }, outcomeRecorded: true }, offered: ['allowed', 'executed'] };
    expect(actual).toEqual(expected);
  });

  it('given a failure the operation knows happened before sending, should record the upstream_failed it returns — not unknown', async () => {
    const { repository, offered } = scriptedRepository(['accepted', 'accepted']);
    const executor = createAuditedExecutor({ auditRepository: repository, hash: sha3 });
    const result = await executor.execute({
      grant: makeGrant(),
      canonical: canonical(),
      now: AT,
      auditResourceKeys: [...AUDIT_RESOURCE_KEYS],
      // A connect/DNS/TLS failure is caught by the operation and RETURNED; only a throw means "may have been sent".
      act: async () => ({ kind: 'upstream_failed', upstreamStatus: null }),
    });
    const actual = { outcome: result.ok ? result.outcome : null, offered };
    const expected = { outcome: { kind: 'upstream_failed', upstreamStatus: null }, offered: ['allowed', 'upstream_failed'] };
    expect(actual).toEqual(expected);
  });

  it.each(['allowed', 'denied'] as const)('given an operation that returns the pre-execution outcome %s, should record unknown — only executed, upstream_failed or unknown can follow an effect', async (kind) => {
    const { repository, offered } = scriptedRepository(['accepted', 'accepted']);
    const executor = createAuditedExecutor({ auditRepository: repository, hash: sha3 });
    const misreported = (kind === 'allowed' ? { kind } : { kind, reason: 'bad_signature' }) as unknown as Extract<AuditOutcome, { kind: 'unknown' }>;
    const result = await executor.execute({
      grant: makeGrant(),
      canonical: canonical(),
      now: AT,
      auditResourceKeys: [...AUDIT_RESOURCE_KEYS],
      act: async () => misreported,
    });
    const actual = { outcome: result.ok ? result.outcome : null, offered };
    const expected = { outcome: { kind: 'unknown' }, offered: ['allowed', 'unknown'] };
    expect(actual).toEqual(expected);
  });

  it('given a denial, should record only the verified caller, a SHA3-256 digest of the presented claim, and the reason — no principal parsed from the grant', async () => {
    const { repository, denials } = scriptedRepository(['accepted']);
    const executor = createAuditedExecutor({ auditRepository: repository, hash: sha3 });
    const claim = new TextEncoder().encode(JSON.stringify(makeGrant({ human: { userId: 'user_victim' as UserId, sessionId: null } })));
    const result = await executor.recordDenial({
      caller: { channel: 'http-executor', presenterKeyId: 'pk_authenticated' as PresenterKeyId },
      claim,
      reason: 'bad_signature',
      now: AT,
    });
    const actual = { result, denials };
    const expected = {
      result: { ok: true },
      denials: [
        {
          caller: { channel: 'http-executor', presenterKeyId: 'pk_authenticated' },
          claimDigest: sha3(claim),
          reason: 'bad_signature',
          at: AT,
        },
      ],
    };
    expect(actual).toEqual(expected);
  });
});

