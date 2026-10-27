/**
 * `selectIdentity` — the machine identity an executor holds for a tenant
 * (ADR 0005 §3.3), pinned to **D-29 = B**: one Infisical machine identity
 * per tenant, every tier (self-hosted OSS is free per identity, so the
 * A/C cost forks `planStoreIdentity` still models do not apply here).
 *
 * `identityId` is a deterministic name, not a secret — the actual Universal
 * Auth client id/secret for that name is an `infisical-client.ts` I/O
 * lookup (env/provisioning store), never computed here. Pure and idempotent:
 * the same tenant always selects the same identity name. `channel` is the role
 * the caller holds (G1c R8/E3), carried so the adapter can enforce it at runtime;
 * per-role Infisical identities are a provisioning concern, not a name here.
 */
import type { TenantId } from '@pagespace/db/schema/agent-accounts';
import type { StoreChannel, StoreIdentity } from './store-adapter';
import { planStoreIdentity } from './plan-store-identity';

export type SelectIdentity = (input: { readonly tenantId: TenantId; readonly channel: StoreChannel }) => StoreIdentity;

export const selectIdentity: SelectIdentity = ({ tenantId, channel }) => {
  const plan = planStoreIdentity({ tenantId, tier: 'paid', model: 'B' });
  return {
    tenantId,
    identityId: `tenant-identity:${tenantId}`,
    channel,
    blastRadius: plan.blastRadius,
  };
};
