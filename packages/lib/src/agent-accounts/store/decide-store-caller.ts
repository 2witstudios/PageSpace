/**
 * `decideStoreCaller` — whether a store identity may perform an operation
 * that requires one role (ADR 0005 §2.1, F18; G1c E3). `rebind`, `revoke`
 * and `describe` require `manage`.
 *
 * The first adapter checked only the tenant; "manage" existed in the input
 * TYPE alone, so any identity assembled at runtime — an executor's, the
 * ingress handler's — could revoke or describe any ref in its tenant. The
 * tenant is compared first and reported as `not_found`, as every other
 * cross-tenant refusal is, so a foreign identity learns nothing about roles;
 * then the channel must be exactly the required one. Pure.
 */
import type { DecideStoreCaller } from './store-adapter';

export const decideStoreCaller: DecideStoreCaller = ({ identity, ref, required }) => {
  if (identity.tenantId !== ref.tenantId) return { ok: false, reason: 'not_found' };
  if (identity.channel !== required) return { ok: false, reason: 'identity_refused' };
  return { ok: true };
};
