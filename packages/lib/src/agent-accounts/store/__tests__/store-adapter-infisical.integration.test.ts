/**
 * ADR 0005 §7, §10.7-9 — the adapter against a REAL local Infisical OSS
 * instance + its own metadata Postgres (`store/infisical-dev/`), never a
 * mock of either. Synthetic credentials only (task brief).
 *
 * Skips itself — visibly, as a reported "skipped", never a crash — when the
 * local instance is not reachable (the same `describe.skipIf(!reachable)`
 * pattern as `observability/__tests__/analytics-gdpr.integration.test.ts`
 * and `error-resolutions.integration.test.ts`). Run
 * `docker compose -f store/infisical-dev/docker-compose.yml up -d`,
 * bootstrap an admin (see `README-infisical-dev.md`), and export
 * `INFISICAL_DEV_ADMIN_TOKEN` to exercise it for real. CI's Unit Tests job
 * brings the stack up and runs this file explicitly in its own named step
 * (`.github/workflows/ci.yml`), which fails if the suite reports skipped —
 * the general `test:integration` step above it may legitimately skip this
 * file (e.g. a local run with no Infisical), but CI as a whole may not.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { get } from 'node:http';
import type { AccountId, PolicyVersion, TenantId } from '@pagespace/db/schema/agent-accounts';
import type { CanonicalOrigin } from '../../canonical-request';
import type {
  AgentAccountGrant,
  ApprovalId,
  BindingDigest,
  ConversationId,
  GrantId,
  GrantIssuer,
  HashBytes,
  Nonce,
  OperationRef,
  PresenterChannel,
  PresenterKeyId,
  RequestDigest,
  RunId,
  SessionId,
  UserId,
} from '../../grant';
import type { PlaneBindings, VerifiedGrant } from '../store-adapter';
import { digestBindings } from '../digest-bindings';
import { createInfisicalClient } from '../infisical-client';
import { createPlaneMetadataRepository } from '../plane-metadata-repository';
import { createInfisicalStoreAdapter } from '../store-adapter-infisical';

const INFISICAL_URL = process.env.INFISICAL_DEV_URL ?? 'http://localhost:8080';
const INFISICAL_ADMIN_TOKEN = process.env.INFISICAL_DEV_ADMIN_TOKEN;
const METADATA_URL = process.env.PLANE_METADATA_DEV_URL ?? 'postgres://plane_metadata:plane_metadata@127.0.0.1:55433/plane_metadata';

const hash: HashBytes = (bytes) => createHash('sha3-256').update(bytes).digest('hex');
const NOW = Date.now();
const TENANT_A = `user:itest-${NOW}-a` as TenantId;
const TENANT_B = `user:itest-${NOW}-b` as TenantId;

// node:http, not fetch — matches the repo's other optional-external-service
// integration suites (analytics-gdpr, error-resolutions) so the probe never
// depends on whatever a test-setup file does to the global fetch. A missing
// admin token means the instance cannot be used even if it answers, so both
// fold into one "usable right now" boolean.
const infisicalReachable = INFISICAL_ADMIN_TOKEN
  ? await new Promise<boolean>((resolve) => {
      const req = get(`${INFISICAL_URL}/api/status`, { timeout: 2000 }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(false));
    })
  : false;

let pool: Pool;
let projectAId: string;
let projectBId: string;
let identityA: { readonly clientId: string; readonly clientSecret: string; readonly identityId: string };
let identityBWrongTenant: { readonly clientId: string; readonly clientSecret: string; readonly identityId: string };
let orgId: string;

async function api<T>(path: string, init: RequestInit & { readonly token?: string } = {}): Promise<T> {
  const response = await fetch(`${INFISICAL_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...init.headers },
  });
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

async function provisionTenantProject(name: string): Promise<{ readonly projectId: string; readonly identity: { readonly clientId: string; readonly clientSecret: string; readonly identityId: string } }> {
  const project = await api<{ project: { id: string } }>('/api/v2/workspace', {
    method: 'POST',
    token: INFISICAL_ADMIN_TOKEN,
    body: JSON.stringify({ projectName: name, organizationSlug: undefined, organizationId: orgId }),
  }).catch(() =>
    api<{ project: { id: string } }>('/api/v2/workspace', {
      method: 'POST',
      token: INFISICAL_ADMIN_TOKEN,
      body: JSON.stringify({ projectName: name, organizationId: orgId }),
    }),
  );
  const identity = await api<{ identity: { id: string } }>('/api/v1/identities', {
    method: 'POST',
    token: INFISICAL_ADMIN_TOKEN,
    body: JSON.stringify({ name: `${name}-identity`, organizationId: orgId }),
  });
  await api('/api/v1/auth/universal-auth/identities/' + identity.identity.id, {
    method: 'POST',
    token: INFISICAL_ADMIN_TOKEN,
    body: JSON.stringify({ clientSecretTrustedIps: [{ ipAddress: '0.0.0.0/0' }], accessTokenTrustedIps: [{ ipAddress: '0.0.0.0/0' }], accessTokenTTL: 7200, accessTokenMaxTTL: 86400, accessTokenNumUsesLimit: 0 }),
  });
  await api(`/api/v2/workspace/${project.project.id}/identity-memberships/${identity.identity.id}`, {
    method: 'POST',
    token: INFISICAL_ADMIN_TOKEN,
    body: JSON.stringify({ roles: [{ role: 'admin' }] }),
  });
  const clientSecretResult = await api<{ clientSecret: string }>(`/api/v1/auth/universal-auth/identities/${identity.identity.id}/client-secrets`, {
    method: 'POST',
    token: INFISICAL_ADMIN_TOKEN,
    body: JSON.stringify({}),
  });
  const ua = await api<{ identityUniversalAuth: { clientId: string } }>(`/api/v1/auth/universal-auth/identities/${identity.identity.id}`, { token: INFISICAL_ADMIN_TOKEN });

  return {
    projectId: project.project.id,
    identity: { clientId: ua.identityUniversalAuth.clientId, clientSecret: clientSecretResult.clientSecret, identityId: `itest:${identity.identity.id}` },
  };
}

// Only runs at all when `describe.skipIf(!infisicalReachable)` below let the block through —
// a failure here is a REAL failure (the instance answered its health check but provisioning
// still broke), never a reason to fall back to skipping (`requireDb`'s rule: missing service
// is a visible skip, decided once, up front; a service that answered and then failed is not).
beforeAll(async () => {
  orgId = process.env.INFISICAL_DEV_ORG_ID ?? '';
  if (!orgId) {
    const orgs = await api<{ organizations: { id: string }[] }>('/api/v1/organization', { token: INFISICAL_ADMIN_TOKEN });
    orgId = orgs.organizations[0]?.id ?? '';
  }
  const a = await provisionTenantProject(`itest-a-${NOW}`);
  const b = await provisionTenantProject(`itest-b-${NOW}`);
  projectAId = a.projectId;
  projectBId = b.projectId;
  identityA = a.identity;
  identityBWrongTenant = b.identity;

  pool = new Pool({ connectionString: METADATA_URL });
  await pool.query('SELECT 1');
});

afterAll(async () => {
  if (pool) await pool.end();
});

function makeAdapter() {
  const infisical = createInfisicalClient({ baseUrl: INFISICAL_URL, environment: 'dev' });
  const metadata = createPlaneMetadataRepository({ pool: pool as never });
  const projects: Record<string, string> = { [TENANT_A]: projectAId, [TENANT_B]: projectBId };
  const identities: Record<string, { clientId: string; clientSecret: string }> = {
    [identityA?.identityId]: identityA,
    [identityBWrongTenant?.identityId]: identityBWrongTenant,
  };
  return createInfisicalStoreAdapter({
    infisical,
    metadata,
    advisoryLockPool: metadata.advisoryLockPool,
    resolveProject: async (tenantId) => (projects[tenantId] ? { projectId: projects[tenantId] } : null),
    resolveCredentials: async ({ identityId }) => identities[identityId] ?? null,
    hash,
    now: () => Date.now(),
  });
}

const OPERATION: OperationRef = { class: 'read', name: 'github.repos.get' };

function makeGrant(overrides: Partial<AgentAccountGrant> = {}): VerifiedGrant {
  const aud: PresenterChannel = overrides.aud ?? 'http-executor';
  const grant: AgentAccountGrant = {
    grantId: 'grant_itest' as GrantId,
    iss: 'pagespace-account-authority' as GrantIssuer,
    aud,
    tenantId: TENANT_A,
    human: { userId: 'u1' as UserId, sessionId: 'session_1' as SessionId },
    delegationId: null,
    agentPageId: null,
    conversationId: 'conv_1' as ConversationId,
    runId: 'run_1' as RunId,
    sandbox: null,
    callerCeiling: { allowedDriveIds: [], originatingMcpTokenId: null },
    accountId: 'acct_itest_1' as AccountId,
    accountKind: 'api_key',
    credentialVersion: 1 as never,
    policyVersion: 1 as PolicyVersion,
    bindingDigest: '' as BindingDigest,
    operation: OPERATION,
    requestDigest: 'req_digest_itest' as RequestDigest,
    sessionHttp: false,
    approvalId: 'approval_1' as ApprovalId,
    iat: NOW - 1_000,
    nbf: NOW - 1_000,
    exp: NOW + 600_000,
    nonce: 'nonce_itest' as Nonce,
    presenter: { keyId: 'pk_1' as PresenterKeyId, channel: aud },
    ...overrides,
  };
  return grant as VerifiedGrant;
}

describe.skipIf(!infisicalReachable)('createInfisicalStoreAdapter — integration against real Infisical + plane metadata', () => {
  it('given put then describe, should return version and bindings and never the material', async () => {
    const adapter = makeAdapter();
    const accountId = `acct-put-describe-${NOW}` as AccountId;
    const ref = { tenantId: TENANT_A, accountId, kind: 'api_key' as const };
    const bindings: PlaneBindings = { tenantId: TENANT_A, ownerRef: { kind: 'user', userId: 'u1' }, allowedOrigins: ['https://example.com' as CanonicalOrigin], policyVersion: 1 as PolicyVersion, kind: 'api_key' };
    const identity = { tenantId: TENANT_A, identityId: identityA.identityId, blastRadius: 'tenant' as const };

    const putResult = await adapter.put({
      ref,
      material: { kind: 'api_key', material: { value: 'sk-synthetic', placement: { in: 'header', name: 'Authorization' } } },
      expectedVersion: null,
      bindings,
      identity,
    });
    expect(putResult).toEqual({ ok: true, version: 1 });

    const described = await adapter.describe({ ref, identity });
    expect(described.ok).toBe(true);
    if (described.ok) {
      expect(described.version).toBe(1);
      expect(described.bindings).toEqual(bindings);
      expect((described as unknown as { material?: unknown }).material).toBeUndefined();
    }
  });

  it('given resolve with a wrong-tenant identity, should return not_found', async () => {
    const adapter = makeAdapter();
    const accountId = `acct-wrong-tenant-${NOW}` as AccountId;
    const ref = { tenantId: TENANT_A, accountId, kind: 'api_key' as const };
    const bindings: PlaneBindings = { tenantId: TENANT_A, ownerRef: { kind: 'user', userId: 'u1' }, allowedOrigins: ['https://example.com' as CanonicalOrigin], policyVersion: 1 as PolicyVersion, kind: 'api_key' };
    const identityForTenantA = { tenantId: TENANT_A, identityId: identityA.identityId, blastRadius: 'tenant' as const };

    await adapter.put({ ref, material: { kind: 'api_key', material: { value: 'sk-synthetic', placement: { in: 'header', name: 'Authorization' } } }, expectedVersion: null, bindings, identity: identityForTenantA });

    const grant = makeGrant({ accountId, bindingDigest: digestBindings({ bindings, hash }) });
    const wrongTenantIdentity = { tenantId: TENANT_B, identityId: identityBWrongTenant.identityId, blastRadius: 'tenant' as const };

    const result = await adapter.resolve({ ref: { ...ref, kind: 'api_key' }, version: 1 as never, grant, identity: wrongTenantIdentity });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('given resolve after revoke, should return revoked', async () => {
    const adapter = makeAdapter();
    const accountId = `acct-revoke-${NOW}` as AccountId;
    const ref = { tenantId: TENANT_A, accountId, kind: 'api_key' as const };
    const bindings: PlaneBindings = { tenantId: TENANT_A, ownerRef: { kind: 'user', userId: 'u1' }, allowedOrigins: ['https://example.com' as CanonicalOrigin], policyVersion: 1 as PolicyVersion, kind: 'api_key' };
    const identity = { tenantId: TENANT_A, identityId: identityA.identityId, blastRadius: 'tenant' as const };

    await adapter.put({ ref, material: { kind: 'api_key', material: { value: 'sk-synthetic', placement: { in: 'header', name: 'Authorization' } } }, expectedVersion: null, bindings, identity });
    await adapter.revoke({ ref, reason: 'owner_revoked', identity });

    const grant = makeGrant({ accountId, bindingDigest: digestBindings({ bindings, hash }) });
    const result = await adapter.resolve({ ref, version: 1 as never, grant, identity });
    expect(result).toEqual({ ok: false, reason: 'revoked' });
  });

  // Codex review PR #2646 (P1, store-adapter-infisical.ts:225): revoke never compared
  // ref.tenantId against identity.tenantId (unlike resolve/describe/writeSecret), so a
  // tenant-B identity could deny a tenant-A account outright.
  it('given revoke with a wrong-tenant identity, should return not_found and leave the account unrevoked', async () => {
    const adapter = makeAdapter();
    const accountId = `acct-revoke-cross-tenant-${NOW}` as AccountId;
    const ref = { tenantId: TENANT_A, accountId, kind: 'api_key' as const };
    const bindings: PlaneBindings = { tenantId: TENANT_A, ownerRef: { kind: 'user', userId: 'u1' }, allowedOrigins: ['https://example.com' as CanonicalOrigin], policyVersion: 1 as PolicyVersion, kind: 'api_key' };
    const identityForTenantA = { tenantId: TENANT_A, identityId: identityA.identityId, blastRadius: 'tenant' as const };
    const wrongTenantIdentity = { tenantId: TENANT_B, identityId: identityBWrongTenant.identityId, blastRadius: 'tenant' as const };

    await adapter.put({ ref, material: { kind: 'api_key', material: { value: 'sk-synthetic', placement: { in: 'header', name: 'Authorization' } } }, expectedVersion: null, bindings, identity: identityForTenantA });

    const revokeResult = await adapter.revoke({ ref, reason: 'admin', identity: wrongTenantIdentity });
    expect(revokeResult).toEqual({ ok: false, reason: 'not_found' });

    const described = await adapter.describe({ ref, identity: identityForTenantA });
    expect(described.ok).toBe(true);
    if (described.ok) expect(described.revokedAt).toBeNull();
  });

  it('given delete then describe, should return not_found', async () => {
    const adapter = makeAdapter();
    const accountId = `acct-delete-${NOW}` as AccountId;
    const ref = { tenantId: TENANT_A, accountId, kind: 'api_key' as const };
    const bindings: PlaneBindings = { tenantId: TENANT_A, ownerRef: { kind: 'user', userId: 'u1' }, allowedOrigins: ['https://example.com' as CanonicalOrigin], policyVersion: 1 as PolicyVersion, kind: 'api_key' };
    const identity = { tenantId: TENANT_A, identityId: identityA.identityId, blastRadius: 'tenant' as const };

    await adapter.put({ ref, material: { kind: 'api_key', material: { value: 'sk-synthetic', placement: { in: 'header', name: 'Authorization' } } }, expectedVersion: null, bindings, identity });
    const deleteResult = await adapter.delete({ ref, identity, upstream: 'unsupported' });
    expect(deleteResult).toEqual({ ok: true, removed: true, upstream: 'unsupported' });

    const described = await adapter.describe({ ref, identity });
    expect(described).toEqual({ ok: false, reason: 'not_found' });
  });

  it('given delete whose upstream revocation is unsupported, should return removed true and upstream unsupported', async () => {
    const adapter = makeAdapter();
    const accountId = `acct-upstream-${NOW}` as AccountId;
    const ref = { tenantId: TENANT_A, accountId, kind: 'api_key' as const };
    const bindings: PlaneBindings = { tenantId: TENANT_A, ownerRef: { kind: 'user', userId: 'u1' }, allowedOrigins: ['https://example.com' as CanonicalOrigin], policyVersion: 1 as PolicyVersion, kind: 'api_key' };
    const identity = { tenantId: TENANT_A, identityId: identityA.identityId, blastRadius: 'tenant' as const };

    await adapter.put({ ref, material: { kind: 'api_key', material: { value: 'sk-synthetic', placement: { in: 'header', name: 'Authorization' } } }, expectedVersion: null, bindings, identity });
    const result = await adapter.delete({ ref, identity, upstream: 'unsupported' });
    expect(result).toEqual({ ok: true, removed: true, upstream: 'unsupported' });
  });

  it('given two concurrent rotate calls with the same expectedVersion, should commit exactly one and return version_conflict for the other', async () => {
    const adapter = makeAdapter();
    const accountId = `acct-concurrent-${NOW}` as AccountId;
    const ref = { tenantId: TENANT_A, accountId, kind: 'api_key' as const };
    const bindings: PlaneBindings = { tenantId: TENANT_A, ownerRef: { kind: 'user', userId: 'u1' }, allowedOrigins: ['https://example.com' as CanonicalOrigin], policyVersion: 1 as PolicyVersion, kind: 'api_key' };
    const identity = { tenantId: TENANT_A, identityId: identityA.identityId, blastRadius: 'tenant' as const };
    const refreshIdentity = { ...identity, channel: 'refresh-worker' as const };

    await adapter.put({ ref, material: { kind: 'api_key', material: { value: 'sk-v1', placement: { in: 'header', name: 'Authorization' } } }, expectedVersion: null, bindings, identity });

    const [a, b] = await Promise.all([
      adapter.rotate({ ref, expectedVersion: 1 as never, next: { kind: 'api_key', material: { value: 'sk-v2a', placement: { in: 'header', name: 'Authorization' } } }, bindings, identity: refreshIdentity }),
      adapter.rotate({ ref, expectedVersion: 1 as never, next: { kind: 'api_key', material: { value: 'sk-v2b', placement: { in: 'header', name: 'Authorization' } } }, bindings, identity: refreshIdentity }),
    ]);

    const outcomes = [a, b].map((r) => (r.ok ? 'commit' : r.reason));
    expect(outcomes.filter((o) => o === 'commit')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'version_conflict')).toHaveLength(1);
  });

  // Codex review PR #2646 (P1): the adapter wrote { kind, material } where `material` was the
  // WHOLE discriminated SecretMaterial ({ kind, material: perKindPayload }), so resolve returned
  // a double-nested object instead of the per-kind payload callers expect.
  it('given put of api_key material then resolve, should return the exact per-kind payload, not the discriminated-union wrapper', async () => {
    const adapter = makeAdapter();
    const accountId = `acct-payload-shape-${NOW}` as AccountId;
    const ref = { tenantId: TENANT_A, accountId, kind: 'api_key' as const };
    const bindings: PlaneBindings = { tenantId: TENANT_A, ownerRef: { kind: 'user', userId: 'u1' }, allowedOrigins: ['https://example.com' as CanonicalOrigin], policyVersion: 1 as PolicyVersion, kind: 'api_key' };
    const identity = { tenantId: TENANT_A, identityId: identityA.identityId, blastRadius: 'tenant' as const };
    const perKindPayload = { value: 'sk-shape-check', placement: { in: 'header' as const, name: 'Authorization' } };

    await adapter.put({ ref, material: { kind: 'api_key', material: perKindPayload }, expectedVersion: null, bindings, identity });

    const grant = makeGrant({ accountId, accountKind: 'api_key', credentialVersion: 1 as never, bindingDigest: digestBindings({ bindings, hash }) });
    const result = await adapter.resolve({ ref, version: 1 as never, grant, identity });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.material).toEqual(perKindPayload);
  });

  // Same review finding: because of the double-nesting, `stripRefreshToken` inspected the WRAPPER
  // object (which never has a top-level `refreshToken`) instead of the real oauth2 payload, so the
  // real refresh token was never actually stripped for http-executor/relay-runner resolves.
  it('given resolve of an oauth2 ref by http-executor, should never include refreshToken in the returned material', async () => {
    const adapter = makeAdapter();
    const accountId = `acct-oauth2-strip-${NOW}` as AccountId;
    const ref = { tenantId: TENANT_A, accountId, kind: 'oauth2' as const };
    const bindings: PlaneBindings = { tenantId: TENANT_A, ownerRef: { kind: 'user', userId: 'u1' }, allowedOrigins: ['https://example.com' as CanonicalOrigin], policyVersion: 1 as PolicyVersion, kind: 'oauth2' };
    const identity = { tenantId: TENANT_A, identityId: identityA.identityId, blastRadius: 'tenant' as const };
    const oauth2Payload = {
      accessToken: 'access-synthetic',
      accessExpiresAt: NOW + 3_600_000,
      refreshToken: 'refresh-synthetic-SHOULD-NEVER-LEAK',
      scopes: ['repo'],
      issuer: 'https://issuer.example',
      tokenEndpoint: 'https://issuer.example/token',
    };

    await adapter.put({ ref, material: { kind: 'oauth2', material: oauth2Payload }, expectedVersion: null, bindings, identity });

    const grant = makeGrant({ aud: 'http-executor', accountId, accountKind: 'oauth2', credentialVersion: 1 as never, bindingDigest: digestBindings({ bindings, hash }) });
    const result = await adapter.resolve({ ref, version: 1 as never, grant, identity });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.material).not.toHaveProperty('refreshToken');
      expect(JSON.stringify(result.material)).not.toContain('refresh-synthetic-SHOULD-NEVER-LEAK');
    }
  });

  // Codex review PR #2646 (P1, store-adapter-infisical.ts:112): writeSecret never checked
  // revokedAt before writing, and metadata.commit unconditionally reset revoked_at to NULL — so a
  // rotate (or put) issued after revoke silently reactivated a supposedly broker-denied credential.
  it('given rotate after revoke, should refuse and resolve should still report revoked', async () => {
    const adapter = makeAdapter();
    const accountId = `acct-revoke-then-rotate-${NOW}` as AccountId;
    const ref = { tenantId: TENANT_A, accountId, kind: 'api_key' as const };
    const bindings: PlaneBindings = { tenantId: TENANT_A, ownerRef: { kind: 'user', userId: 'u1' }, allowedOrigins: ['https://example.com' as CanonicalOrigin], policyVersion: 1 as PolicyVersion, kind: 'api_key' };
    const identity = { tenantId: TENANT_A, identityId: identityA.identityId, blastRadius: 'tenant' as const };
    const refreshIdentity = { ...identity, channel: 'refresh-worker' as const };

    await adapter.put({ ref, material: { kind: 'api_key', material: { value: 'sk-v1', placement: { in: 'header', name: 'Authorization' } } }, expectedVersion: null, bindings, identity });
    await adapter.revoke({ ref, reason: 'owner_revoked', identity });

    const rotateResult = await adapter.rotate({
      ref,
      expectedVersion: 1 as never,
      next: { kind: 'api_key', material: { value: 'sk-v2-should-not-land', placement: { in: 'header', name: 'Authorization' } } },
      bindings,
      identity: refreshIdentity,
    });
    expect(rotateResult.ok).toBe(false);

    const described = await adapter.describe({ ref, identity });
    expect(described.ok).toBe(true);
    if (described.ok) expect(described.revokedAt).not.toBeNull();

    const grant = makeGrant({ accountId, bindingDigest: digestBindings({ bindings, hash }) });
    const resolveResult = await adapter.resolve({ ref, version: 1 as never, grant, identity });
    expect(resolveResult).toEqual({ ok: false, reason: 'revoked' });
  });

  // Codex review PR #2646 (P2, store-adapter-infisical.ts:103): PutInput does not type-correlate
  // ref.kind with the SecretMaterial discriminant, so a caller could submit e.g. password material
  // under an api_key ref; the adapter ignored material.kind and wrote the mismatched payload.
  it('given put with material.kind different from ref.kind, should return kind_mismatch and write nothing', async () => {
    const adapter = makeAdapter();
    const accountId = `acct-kind-mismatch-${NOW}` as AccountId;
    const ref = { tenantId: TENANT_A, accountId, kind: 'api_key' as const };
    const bindings: PlaneBindings = { tenantId: TENANT_A, ownerRef: { kind: 'user', userId: 'u1' }, allowedOrigins: ['https://example.com' as CanonicalOrigin], policyVersion: 1 as PolicyVersion, kind: 'api_key' };
    const identity = { tenantId: TENANT_A, identityId: identityA.identityId, blastRadius: 'tenant' as const };

    const putResult = await adapter.put({
      ref,
      material: { kind: 'password', material: { username: 'attacker', password: 'sneaky', totpSecret: null } },
      expectedVersion: null,
      bindings,
      identity,
    });
    expect(putResult).toEqual({ ok: false, reason: 'kind_mismatch' });

    const described = await adapter.describe({ ref, identity });
    expect(described).toEqual({ ok: false, reason: 'not_found' });
  });

  // Codex review PR #2646 (P1, store-adapter-infisical.ts:188): resolveCore never compared the
  // fetched Infisical record's version against the metadata read that authorized it, so a write
  // landing between the two reads hands a grant material from a version it never named — labeled
  // with the STALE metadata version. Simulated here as an out-of-band Infisical write (standing
  // in for a rotation slipping in between resolveCore's metadata.read and infisical.getSecret).
  it('given the Infisical secret changed after the authorizing metadata read (a race), should refuse rather than serve mismatched material', async () => {
    const adapter = makeAdapter();
    const accountId = `acct-race-${NOW}` as AccountId;
    const ref = { tenantId: TENANT_A, accountId, kind: 'api_key' as const };
    const bindings: PlaneBindings = { tenantId: TENANT_A, ownerRef: { kind: 'user', userId: 'u1' }, allowedOrigins: ['https://example.com' as CanonicalOrigin], policyVersion: 1 as PolicyVersion, kind: 'api_key' };
    const identity = { tenantId: TENANT_A, identityId: identityA.identityId, blastRadius: 'tenant' as const };

    await adapter.put({ ref, material: { kind: 'api_key', material: { value: 'sk-v1', placement: { in: 'header', name: 'Authorization' } } }, expectedVersion: null, bindings, identity });

    // Out-of-band write: bumps the Infisical secret to v2 WITHOUT touching the plane metadata row,
    // standing in for a rotation that committed to Infisical between resolveCore's metadata read
    // and its Infisical fetch. Metadata still says currentVersion 1.
    const rawInfisical = createInfisicalClient({ baseUrl: INFISICAL_URL, environment: 'dev' });
    await rawInfisical.updateSecret({
      projectId: projectAId,
      credentials: identityA,
      secretKey: `${accountId}__api_key`,
      secretValue: JSON.stringify({ kind: 'api_key', material: { value: 'sk-v2-raced-in', placement: { in: 'header', name: 'Authorization' } } }),
      secretComment: JSON.stringify(bindings),
    });

    const grant = makeGrant({ accountId, credentialVersion: 1 as never, bindingDigest: digestBindings({ bindings, hash }) });
    const result = await adapter.resolve({ ref, version: 1 as never, grant, identity });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toBe('ok');
    expect(JSON.stringify(result)).not.toContain('sk-v2-raced-in');
  });

  // Codex review PR #2646 (P1, store-adapter-infisical.ts:210): decideResolve correctly allows a
  // grant naming `previousVersion` inside the grace window, but resolveCore always fetched and
  // returned CURRENT material/version — an honest caller naming the old version was rejected by
  // the downstream version_mismatch check (result.version came back as the NEW version), while a
  // caller pairing an old grant with the NEW input.version got the rotated secret.
  it('given a grant naming the version just rotated away, inside rotationGraceMs, should resolve to the OLD material at the OLD version — never the new one', async () => {
    const adapter = makeAdapter();
    const accountId = `acct-grace-content-${NOW}` as AccountId;
    const ref = { tenantId: TENANT_A, accountId, kind: 'api_key' as const };
    const bindings: PlaneBindings = { tenantId: TENANT_A, ownerRef: { kind: 'user', userId: 'u1' }, allowedOrigins: ['https://example.com' as CanonicalOrigin], policyVersion: 1 as PolicyVersion, kind: 'api_key' };
    const identity = { tenantId: TENANT_A, identityId: identityA.identityId, blastRadius: 'tenant' as const };
    const refreshIdentity = { ...identity, channel: 'refresh-worker' as const };

    await adapter.put({ ref, material: { kind: 'api_key', material: { value: 'sk-old-value', placement: { in: 'header', name: 'Authorization' } } }, expectedVersion: null, bindings, identity });
    const rotateResult = await adapter.rotate({
      ref,
      expectedVersion: 1 as never,
      next: { kind: 'api_key', material: { value: 'sk-new-value', placement: { in: 'header', name: 'Authorization' } } },
      bindings,
      identity: refreshIdentity,
    });
    expect(rotateResult).toEqual({ ok: true, version: 2 });

    // Honest caller: a grant naming version 1, presented with version 1 (what it actually holds).
    const oldGrant = makeGrant({ accountId, credentialVersion: 1 as never, bindingDigest: digestBindings({ bindings, hash }) });
    const oldResolve = await adapter.resolve({ ref, version: 1 as never, grant: oldGrant, identity });
    expect(oldResolve.ok).toBe(true);
    if (oldResolve.ok) {
      expect(oldResolve.version).toBe(1);
      expect(oldResolve.material).toEqual({ value: 'sk-old-value', placement: { in: 'header', name: 'Authorization' } });
    }

    // Attacker shape: the SAME old grant (names version 1), but the presented version bumped to
    // the new one — must not be satisfied with the rotated secret.
    const mismatchedResolve = await adapter.resolve({ ref, version: 2 as never, grant: oldGrant, identity });
    expect(mismatchedResolve.ok).toBe(false);

    // The new version is still resolvable on its own honest terms.
    const newGrant = makeGrant({ accountId, credentialVersion: 2 as never, bindingDigest: digestBindings({ bindings, hash }) });
    const newResolve = await adapter.resolve({ ref, version: 2 as never, grant: newGrant, identity });
    expect(newResolve.ok).toBe(true);
    if (newResolve.ok) {
      expect(newResolve.version).toBe(2);
      expect(newResolve.material).toEqual({ value: 'sk-new-value', placement: { in: 'header', name: 'Authorization' } });
    }
  });

  // Defense-in-depth for the same race as above, one step removed: two rotations back-to-back
  // (v1->v2, v2->v3) overwrite the grace companion to represent v2; a resolveCore call whose
  // metadata read is stale (still sees previousVersion=1) must not be served v2's content
  // mislabeled as v1. Simulated as an out-of-band overwrite of the companion secret.
  it('given the grace companion secret represents a different version than the authorizing metadata read expected, should refuse', async () => {
    const adapter = makeAdapter();
    const accountId = `acct-grace-stale-${NOW}` as AccountId;
    const ref = { tenantId: TENANT_A, accountId, kind: 'api_key' as const };
    const bindings: PlaneBindings = { tenantId: TENANT_A, ownerRef: { kind: 'user', userId: 'u1' }, allowedOrigins: ['https://example.com' as CanonicalOrigin], policyVersion: 1 as PolicyVersion, kind: 'api_key' };
    const identity = { tenantId: TENANT_A, identityId: identityA.identityId, blastRadius: 'tenant' as const };
    const refreshIdentity = { ...identity, channel: 'refresh-worker' as const };

    await adapter.put({ ref, material: { kind: 'api_key', material: { value: 'sk-v1', placement: { in: 'header', name: 'Authorization' } } }, expectedVersion: null, bindings, identity });
    await adapter.rotate({ ref, expectedVersion: 1 as never, next: { kind: 'api_key', material: { value: 'sk-v2', placement: { in: 'header', name: 'Authorization' } } }, bindings, identity: refreshIdentity });

    // Out-of-band: overwrite the grace companion to claim it represents v2 (what a second, racing
    // rotation would leave behind), without touching the plane metadata row (still says
    // currentVersion 2 / previousVersion 1 from the single rotate above).
    const rawInfisical = createInfisicalClient({ baseUrl: INFISICAL_URL, environment: 'dev' });
    await rawInfisical.updateSecret({
      projectId: projectAId,
      credentials: identityA,
      secretKey: `${accountId}__api_key__previous`,
      secretValue: JSON.stringify({ kind: 'api_key', material: { value: 'sk-v2-impersonating-v1', placement: { in: 'header', name: 'Authorization' } } }),
      secretComment: JSON.stringify({ __version: 2 }),
    });

    const grant = makeGrant({ accountId, credentialVersion: 1 as never, bindingDigest: digestBindings({ bindings, hash }) });
    const result = await adapter.resolve({ ref, version: 1 as never, grant, identity });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('sk-v2-impersonating-v1');
  });
});
