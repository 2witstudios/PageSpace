/**
 * `createInfisicalTenantProvisioner` — one Infisical project and one machine
 * identity PER TENANT (D-29 = B; ADR 0005 §3), created on the tenant's first
 * use, and short-lived Universal Auth client secrets minted for that identity
 * per operation (ADR 0005 §3.3 rider i). I/O only.
 *
 * What is stored: the tenant → (project, identity, client id) mapping, in the
 * plane's own metadata store (`agent_account_plane_tenants`). What is NOT
 * stored anywhere: a tenant identity's client secret. `credentialsFor` mints
 * one with a short TTL and caches it in this process's memory for half that
 * TTL, so a leaked executor credential reads one tenant for minutes.
 *
 * The provisioner's own credential (an org-level identity able to create
 * projects and identities) is the plane's root, like Infisical's own root key:
 * it is a process secret of the plane, never in the main DB or the web
 * process. It can mint a credential for any tenant — that is the stated
 * residual of any provisioning authority, not a reading identity.
 *
 * First-use creation is serialized per tenant with an advisory lock on the
 * plane metadata DB, so two concurrent first puts create one project.
 */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { TenantId } from '@pagespace/db/schema/agent-accounts';
import { withAdvisoryLock, type AdvisoryLockPool } from '@pagespace/db/advisory-lock';
import type { FetchImpl, InfisicalCredentials } from './infisical-client';

export type TenantProvisioner = {
  /** The tenant's project and identity, creating both on first use. null when Infisical or the metadata store cannot answer. */
  readonly ensureTenant: (tenantId: TenantId) => Promise<{ readonly projectId: string; readonly identityId: string } | null>;
  /** The project of an already-provisioned tenant; null when none (never creates). */
  readonly projectOf: (tenantId: TenantId) => Promise<{ readonly projectId: string } | null>;
  /** The project and identity of an already-provisioned tenant; null when none (never creates). */
  readonly identityOf: (tenantId: TenantId) => Promise<{ readonly projectId: string; readonly identityId: string } | null>;
  /** Short-lived Universal Auth credentials for the tenant's identity; null when the tenant is not provisioned or minting failed. */
  readonly credentialsFor: (input: { readonly tenantId: TenantId; readonly identityId: string }) => Promise<InfisicalCredentials | null>;
};

export type ProvisionerAuth = { readonly kind: 'token'; readonly token: string } | { readonly kind: 'universal_auth'; readonly clientId: string; readonly clientSecret: string };

type TenantRow = { project_id: string; identity_id: string; client_id: string };

const CLIENT_SECRET_TTL_SECONDS = 600;
const ACCESS_TOKEN_TTL_SECONDS = 600;
/** Creation makes six Infisical calls; ~10s of waiting covers it without turning a slow creator into a refusal. */
const LOCK_RETRY_ATTEMPTS = 400;
const LOCK_RETRY_DELAY_MS = 25;

export function createInfisicalTenantProvisioner({
  baseUrl,
  organizationId,
  auth,
  pool,
  advisoryLockPool,
  fetchImpl = fetch,
  now = () => Date.now(),
}: {
  readonly baseUrl: string;
  readonly organizationId: string;
  readonly auth: ProvisionerAuth;
  readonly pool: Pick<Pool, 'query'>;
  readonly advisoryLockPool: AdvisoryLockPool;
  readonly fetchImpl?: FetchImpl;
  readonly now?: () => number;
}): TenantProvisioner {
  const minted = new Map<string, { readonly credentials: InfisicalCredentials; readonly freshUntil: number }>();

  async function provisionerToken(): Promise<string> {
    if (auth.kind === 'token') return auth.token;
    const response = await fetchImpl(`${baseUrl}/api/v1/auth/universal-auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: auth.clientId, clientSecret: auth.clientSecret }),
    });
    if (!response.ok) throw new Error(`provisioner login -> ${response.status}`);
    return ((await response.json()) as { accessToken: string }).accessToken;
  }

  async function api<T>(path: string, init: { readonly method?: string; readonly body?: unknown } = {}): Promise<T> {
    const token = await provisionerToken();
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (!response.ok) throw new Error(`${path} -> ${response.status}`);
    return (await response.json()) as T;
  }

  async function read(tenantId: TenantId): Promise<TenantRow | null> {
    const result = await pool.query('SELECT project_id, identity_id, client_id FROM agent_account_plane_tenants WHERE tenant_id = $1', [tenantId]);
    return (result.rows[0] as TenantRow | undefined) ?? null;
  }

  /** Deterministic, non-identifying names: the tenant id never appears in Infisical. */
  const nameFor = (tenantId: TenantId) => `ps-${createHash('sha256').update(tenantId).digest('hex').slice(0, 20)}`;

  async function create(tenantId: TenantId): Promise<TenantRow> {
    const name = nameFor(tenantId);
    const project = await api<{ project: { id: string } }>('/api/v2/workspace', { method: 'POST', body: { projectName: name, organizationId } });
    const identity = await api<{ identity: { id: string } }>('/api/v1/identities', { method: 'POST', body: { name, organizationId } });
    await api(`/api/v1/auth/universal-auth/identities/${identity.identity.id}`, {
      method: 'POST',
      body: {
        clientSecretTrustedIps: [{ ipAddress: '0.0.0.0/0' }],
        accessTokenTrustedIps: [{ ipAddress: '0.0.0.0/0' }],
        accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
        accessTokenMaxTTL: ACCESS_TOKEN_TTL_SECONDS,
        accessTokenNumUsesLimit: 0,
      },
    });
    // `member`, never `admin`: the tenant identity reads and writes secrets in its ONE project.
    await api(`/api/v2/workspace/${project.project.id}/identity-memberships/${identity.identity.id}`, { method: 'POST', body: { roles: [{ role: 'member' }] } });
    const ua = await api<{ identityUniversalAuth: { clientId: string } }>(`/api/v1/auth/universal-auth/identities/${identity.identity.id}`);
    const row: TenantRow = { project_id: project.project.id, identity_id: identity.identity.id, client_id: ua.identityUniversalAuth.clientId };
    await pool.query(
      'INSERT INTO agent_account_plane_tenants (tenant_id, project_id, identity_id, client_id) VALUES ($1, $2, $3, $4) ON CONFLICT (tenant_id) DO NOTHING',
      [tenantId, row.project_id, row.identity_id, row.client_id],
    );
    return row;
  }

  return {
    async ensureTenant(tenantId) {
      try {
        const existing = await read(tenantId);
        if (existing !== null) return { projectId: existing.project_id, identityId: existing.identity_id };
        // `withAdvisoryLock` is a TRY lock: a concurrent first use waits for the creator, then reads its row.
        const attempt = () => withAdvisoryLock(advisoryLockPool, `agent-accounts:tenant:${tenantId}`, async () => (await read(tenantId)) ?? create(tenantId));
        let locked = await attempt();
        for (let tries = 0; locked.outcome === 'lock_busy' && tries < LOCK_RETRY_ATTEMPTS; tries += 1) {
          await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
          locked = await attempt();
        }
        if (locked.outcome !== 'acquired') return null;
        return { projectId: locked.result.project_id, identityId: locked.result.identity_id };
      } catch {
        return null;
      }
    },

    async projectOf(tenantId) {
      try {
        const row = await read(tenantId);
        return row === null ? null : { projectId: row.project_id };
      } catch {
        return null;
      }
    },

    async identityOf(tenantId) {
      try {
        const row = await read(tenantId);
        return row === null ? null : { projectId: row.project_id, identityId: row.identity_id };
      } catch {
        return null;
      }
    },

    async credentialsFor({ tenantId, identityId }) {
      try {
        const row = await read(tenantId);
        // The identity must be THIS tenant's: a wrong-tenant identity id is never minted for.
        if (row === null || row.identity_id !== identityId) return null;
        const cached = minted.get(identityId);
        if (cached !== undefined && cached.freshUntil > now()) return cached.credentials;
        const secret = await api<{ clientSecret: string }>(`/api/v1/auth/universal-auth/identities/${identityId}/client-secrets`, {
          method: 'POST',
          body: { description: 'pagespace-plane-operation', ttl: CLIENT_SECRET_TTL_SECONDS, numUsesLimit: 0 },
        });
        const credentials = { clientId: row.client_id, clientSecret: secret.clientSecret };
        minted.set(identityId, { credentials, freshUntil: now() + (CLIENT_SECRET_TTL_SECONDS * 1000) / 2 });
        return credentials;
      } catch {
        return null;
      }
    },
  };
}
