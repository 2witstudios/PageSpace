/**
 * ADR 0004 F13 + §5 — audit acceptance PRECEDES execution, against the REAL
 * hash-chained security audit on :5433.
 *
 * Written RED at G1b before `audit-repository.ts` and `audit-gate-executor.ts`
 * existed. The rule this pins is not "we log the operation": it is that a
 * privileged operation does not happen at all until its `allowed` row is
 * durably in the chain, and that an audit outage refuses rather than
 * silently enabling unaudited credential use.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import { db } from '@pagespace/db/db';
import { sql, eq } from '@pagespace/db/operators';
import { securityAuditLog } from '@pagespace/db/schema/security-audit';
import { requireDb } from '@pagespace/db/test/require-db';
import { factories } from '@pagespace/db/test/factories';
import { createSecurityAuditRepository } from '../../audit/security-audit-repository';
import { createAgentAccountAuditRepository } from '../audit-repository';
import { createAuditedExecutor } from '../audit-gate-executor';
import { buildAuditRecord } from '../build-audit-record';
import { canonicalizeRequest } from '../canonicalize-request';
import { digestRequest } from '../digest-request';
import { GRANT_ISSUER } from '../grant-constants';
import type { CanonicalRequest } from '../canonical-request';
import type {
  AgentAccountGrant,
  AgentPageId,
  ApprovalId,
  BindingDigest,
  ConversationId,
  GrantId,
  HashBytes,
  Nonce,
  PresenterKeyId,
  RunId,
  UserId,
} from '../grant';
import type { AccountId, CredentialVersion, PolicyVersion, TenantId } from '@pagespace/db/schema/agent-accounts';

const hash: HashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha3: HashBytes = (bytes) => createHash('sha3-256').update(bytes).digest('hex');
const DECLARED_RESOURCE_KEYS = ['repo'];
const SECRET = 'ghp_canary_itest_7c1d9a';
const BODY = `{"title":"ship","token":"${SECRET}"}`;
const PREFIX = 'itest-audit-';
let dbAvailable = false;
let seq = 0;
const AT = Date.now();
/** security_audit_log.user_id is a real FK, so the principal must be a real row. */
let userId = 'user_1' as UserId;

function canonical(): CanonicalRequest {
  const result = canonicalizeRequest({
    channel: 'http-executor',
    method: 'POST',
    url: 'https://api.github.com/repos/octo/hello/issues',
    headers: { accept: 'application/json' },
    body: new TextEncoder().encode(BODY),
    resources: { repo: 'octo/hello' },
    operation: { class: 'write', name: 'github.issues.create' },
    declaredHeaders: [],
  });
  if (!result.ok) throw new Error(result.reason);
  return result.canonical;
}

function makeGrant(): AgentAccountGrant {
  seq += 1;
  return {
    grantId: `${PREFIX}${AT}-${seq}` as GrantId,
    iss: GRANT_ISSUER,
    aud: 'http-executor',
    tenantId: 'user:user_1' as TenantId,
    human: { userId, sessionId: null },
    delegationId: null,
    agentPageId: 'page_1' as AgentPageId,
    conversationId: 'conv_1' as ConversationId,
    runId: 'run_1' as RunId,
    sandbox: null,
    callerCeiling: { allowedDriveIds: [], originatingMcpTokenId: null },
    accountId: 'acct_1' as AccountId,
    accountKind: 'api_key',
    credentialVersion: 1 as CredentialVersion,
    policyVersion: 1 as PolicyVersion,
    bindingDigest: 'bd' as BindingDigest,
    operation: { class: 'write', name: 'github.issues.create' },
    requestDigest: digestRequest({ canonical: canonical(), hash }),
    sessionHttp: false,
    approvalId: 'approval_1' as ApprovalId,
    iat: AT - 1_000,
    nbf: AT - 1_000,
    exp: AT + 60_000,
    nonce: `${PREFIX}n-${seq}` as Nonce,
    presenter: { keyId: 'pk_1' as PresenterKeyId, channel: 'http-executor' },
  };
}

/** An append path whose every write fails, standing in for an audit outage. */
const unavailableAppendPath = {
  appendEvent: async () => {
    throw new Error('audit store unreachable');
  },
};

async function rowsFor(grantId: string) {
  return db
    .select({ eventType: securityAuditLog.eventType, details: securityAuditLog.details, resourceId: securityAuditLog.resourceId, previousHash: securityAuditLog.previousHash, eventHash: securityAuditLog.eventHash })
    .from(securityAuditLog)
    .where(eq(securityAuditLog.resourceId, grantId))
    .orderBy(securityAuditLog.chainSeq);
}

async function clearRows() {
  await db.delete(securityAuditLog).where(sql`${securityAuditLog.resourceId} LIKE ${`${PREFIX}%`}`);
}

beforeAll(async () => {
  try {
    await db.execute(sql`SELECT 1`);
    dbAvailable = true;
    userId = (await factories.createUser()).id as UserId;
  } catch (error) {
    requireDb('audit-repository.integration.test.ts', error);
    dbAvailable = false;
  }
});

beforeEach(async () => {
  if (dbAvailable) await clearRows();
});

afterAll(async () => {
  if (dbAvailable) await clearRows();
});

describe('agent-account audit repository (ADR 0004 §5)', () => {
  it('given an allowed record, should accept it durably into the hash chain, keyed by the grantId', async () => {
    if (!dbAvailable) return;
    const repository = createAgentAccountAuditRepository({ appendPath: createSecurityAuditRepository({ db }) });
    const grant = makeGrant();
    const acceptance = await repository.accept({ record: buildAuditRecord({ grant, canonical: canonical(), outcome: { kind: 'allowed' }, at: AT, hash: sha3, declaredResourceKeys: DECLARED_RESOURCE_KEYS }) });
    const rows = await rowsFor(grant.grantId);
    expect({ acceptance, count: rows.length, eventType: rows[0]?.eventType, chained: typeof rows[0]?.eventHash === 'string' && rows[0]!.eventHash.length === 64 }).toEqual({
      acceptance: { kind: 'accepted' },
      count: 1,
      eventType: 'credential.grant.allowed',
      chained: true,
    });
  });

  it('given a record whose request carried a body and a credential, should store neither in the row', async () => {
    if (!dbAvailable) return;
    const repository = createAgentAccountAuditRepository({ appendPath: createSecurityAuditRepository({ db }) });
    const grant = makeGrant();
    await repository.accept({ record: buildAuditRecord({ grant, canonical: canonical(), outcome: { kind: 'allowed' }, at: AT, hash: sha3, declaredResourceKeys: DECLARED_RESOURCE_KEYS }) });
    const [row] = await rowsFor(grant.grantId);
    const serialized = JSON.stringify(row);
    expect({ hasSecret: serialized.includes(SECRET), hasBody: serialized.includes(BODY) }).toEqual({ hasSecret: false, hasBody: false });
  });

  it('given the audit store unavailable, should report unavailable rather than throwing', async () => {
    if (!dbAvailable) return;
    const repository = createAgentAccountAuditRepository({ appendPath: unavailableAppendPath });
    const grant = makeGrant();
    const actual = await repository.accept({ record: buildAuditRecord({ grant, canonical: canonical(), outcome: { kind: 'allowed' }, at: AT, hash: sha3, declaredResourceKeys: DECLARED_RESOURCE_KEYS }) });
    expect(actual).toEqual({ kind: 'unavailable' });
  });
});

describe('audit acceptance before execute (ADR 0004 F13)', () => {
  it('given a durable allowed record, should act, then write the outcome row keyed by the same grantId', async () => {
    if (!dbAvailable) return;
    const executor = createAuditedExecutor({ auditRepository: createAgentAccountAuditRepository({ appendPath: createSecurityAuditRepository({ db }) }), hash: sha3 });
    const grant = makeGrant();
    const acted: string[] = [];
    const result = await executor.execute({
      grant,
      canonical: canonical(),
      now: AT,
      declaredResourceKeys: DECLARED_RESOURCE_KEYS,
      act: async () => {
        acted.push(grant.grantId);
        return { kind: 'executed', upstreamStatus: 201 } as const;
      },
    });
    const rows = await rowsFor(grant.grantId);
    expect({ result, acted, types: rows.map((row) => row.eventType), linked: rows.length === 2 && rows[1]!.previousHash === rows[0]!.eventHash }).toEqual({
      result: { ok: true, outcome: { kind: 'executed', upstreamStatus: 201 }, outcomeRecorded: true },
      acted: [grant.grantId],
      types: ['credential.grant.allowed', 'credential.operation.executed'],
      linked: true,
    });
  });

  it('given an unavailable audit store, should refuse the operation with audit_unavailable and NOT act', async () => {
    if (!dbAvailable) return;
    const executor = createAuditedExecutor({ auditRepository: createAgentAccountAuditRepository({ appendPath: unavailableAppendPath }), hash: sha3 });
    const grant = makeGrant();
    const acted: string[] = [];
    const result = await executor.execute({
      grant,
      canonical: canonical(),
      now: AT,
      declaredResourceKeys: DECLARED_RESOURCE_KEYS,
      act: async () => {
        acted.push(grant.grantId);
        return { kind: 'executed', upstreamStatus: 201 } as const;
      },
    });
    const rows = await rowsFor(grant.grantId);
    expect({ result, acted, rows: rows.length }).toEqual({ result: { ok: false, reason: 'audit_unavailable' }, acted: [], rows: 0 });
  });

  it('given the operation throws after a durable allowed row, should record outcome unknown (a write may have landed) and report it', async () => {
    if (!dbAvailable) return;
    const executor = createAuditedExecutor({ auditRepository: createAgentAccountAuditRepository({ appendPath: createSecurityAuditRepository({ db }) }), hash: sha3 });
    const grant = makeGrant();
    const result = await executor.execute({
      grant,
      canonical: canonical(),
      now: AT,
      declaredResourceKeys: DECLARED_RESOURCE_KEYS,
      act: async () => {
        throw new Error('socket hang up');
      },
    });
    const rows = await rowsFor(grant.grantId);
    expect({ result, types: rows.map((row) => row.eventType) }).toEqual({
      result: { ok: true, outcome: { kind: 'unknown' }, outcomeRecorded: true },
      types: ['credential.grant.allowed', 'credential.operation.unknown'],
    });
  });

  it('given a denied verdict, should write the denied row and never call the operation', async () => {
    if (!dbAvailable) return;
    const executor = createAuditedExecutor({ auditRepository: createAgentAccountAuditRepository({ appendPath: createSecurityAuditRepository({ db }) }), hash: sha3 });
    const grant = makeGrant();
    const acted: string[] = [];
    const result = await executor.recordDenial({ grant, canonical: canonical(), reason: 'approval_mismatch', now: AT, declaredResourceKeys: DECLARED_RESOURCE_KEYS });
    const rows = await rowsFor(grant.grantId);
    expect({ result, acted, types: rows.map((row) => row.eventType), reason: (rows[0]?.details as { outcome?: { reason?: string } } | null)?.outcome?.reason }).toEqual({
      result: { ok: true },
      acted: [],
      types: ['credential.grant.denied'],
      reason: 'approval_mismatch',
    });
  });
});
