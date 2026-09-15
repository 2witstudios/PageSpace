/**
 * ADR 0005 §7, §10.7-9 — the adapter against a REAL local Infisical OSS
 * instance + its own metadata Postgres (`store/infisical-dev/`), never a
 * mock of either. Synthetic credentials only (task brief).
 *
 * FAILS LOUDLY when the local instance is unreachable (`requireDb`-style);
 * opt out locally with `ALLOW_SKIP_DB_TESTS=1`. CI provisions the compose
 * stack and never sets it (see `README-infisical-dev.md`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createHash } from 'node:crypto';
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
const ALLOW_SKIP = process.env.ALLOW_SKIP_DB_TESTS === '1';

const hash: HashBytes = (bytes) => createHash('sha3-256').update(bytes).digest('hex');
const NOW = Date.now();
const TENANT_A = `user:itest-${NOW}-a` as TenantId;
const TENANT_B = `user:itest-${NOW}-b` as TenantId;

let available = false;
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

beforeAll(async () => {
  if (!INFISICAL_ADMIN_TOKEN) {
    if (ALLOW_SKIP) return;
    throw new Error(
      'store-adapter-infisical.integration.test.ts: INFISICAL_DEV_ADMIN_TOKEN is not set. Bring up store/infisical-dev/ (docker compose up -d) and bootstrap an admin (see README-infisical-dev.md), or set ALLOW_SKIP_DB_TESTS=1 to skip locally.',
    );
  }
  try {
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

    available = true;
  } catch (error) {
    if (ALLOW_SKIP) {
      available = false;
      return;
    }
    throw error;
  }
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

describe.skipIf(!INFISICAL_ADMIN_TOKEN && ALLOW_SKIP)('createInfisicalStoreAdapter — integration against real Infisical + plane metadata', () => {
  it('given put then describe, should return version and bindings and never the material', async () => {
    if (!available) return;
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
    if (!available) return;
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
    if (!available) return;
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
    if (!available) return;
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
    if (!available) return;
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
    if (!available) return;
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
    if (!available) return;
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
    if (!available) return;
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
    if (!available) return;
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
    if (!available) return;
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
    if (!available) return;
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
});
