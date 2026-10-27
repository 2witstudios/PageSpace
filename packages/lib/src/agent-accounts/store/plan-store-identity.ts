/**
 * `planStoreIdentity` — the D-29 identity-cost decision as data (ADR 0005 §3.3, §9).
 *
 * Three billing models the founder could have picked (A/B/C); D-29 answered
 * **B** (one identity per tenant, all tiers — free on self-host, D-21
 * revised), so `selectIdentity` pins `model: 'B'` for every real call. This
 * function stays parameterized so the Λ4 threat-model sentence and a future
 * re-decision are one branch, not a rewrite (ADR 0005 §3.3: "the adapter,
 * SecretRef, TenantId and the CAS do not [change]").
 */
import type { TenantId } from '@pagespace/db/schema/agent-accounts';

export type StoreIdentityKind = 'dedicated' | 'pooled' | 'single';
export type BlastRadius = 'tenant' | 'tier' | 'all';
export type IdentityTier = 'free' | 'paid';
export type IdentityModel = 'A' | 'B' | 'C';

export type PlanStoreIdentity = (input: {
  readonly tenantId: TenantId;
  readonly tier: IdentityTier;
  readonly model: IdentityModel;
}) => { readonly identity: StoreIdentityKind; readonly projectRoleScope: TenantId; readonly blastRadius: BlastRadius };

export const planStoreIdentity: PlanStoreIdentity = ({ tenantId, tier, model }) => {
  if (model === 'A') {
    return tier === 'paid'
      ? { identity: 'dedicated', projectRoleScope: tenantId, blastRadius: 'tenant' }
      : { identity: 'pooled', projectRoleScope: tenantId, blastRadius: 'tier' };
  }
  if (model === 'B') {
    return { identity: 'dedicated', projectRoleScope: tenantId, blastRadius: 'tenant' };
  }
  return { identity: 'single', projectRoleScope: tenantId, blastRadius: 'all' };
};
