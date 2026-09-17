/**
 * `mapTenantProject` — one Infisical **project per tenant** (ADR 0005 §3.1,
 * D-17: per-tenant data key by construction). The project slug is derived
 * from `TenantId`, never chosen, so two calls for the same tenant always
 * name the same project and a tenant-A caller can never construct tenant-B's
 * slug by guessing. The hash primitive is injected (env-bridge discipline)
 * so this stays free of `node:crypto` and testable without real hashing.
 */
import type { TenantId } from '@pagespace/db/schema/agent-accounts';
import type { HashBytes } from '../grant';

export type TenantProjectRef = {
  readonly tenantId: TenantId;
  /** Infisical project slug — `/<projectSlug>/<accountId>/<kind>` is the secret path (ADR 0005 §2.2). */
  readonly projectSlug: string;
};

export type MapTenantProject = (input: { readonly tenantId: TenantId; readonly hash: HashBytes }) => TenantProjectRef;

export const mapTenantProject: MapTenantProject = ({ tenantId, hash }) => {
  const digest = hash(new TextEncoder().encode(tenantId))
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 32);
  return { tenantId, projectSlug: `pgsp-${digest}` };
};
