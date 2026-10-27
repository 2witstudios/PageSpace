/**
 * `consentersFitOwner` — the consenter set a record pins matches its owner
 * kind (ADR 0005 §2.6; G1c R2): `owner` for a user-owned account (the stored
 * owner is the only consenter), a NON-EMPTY `pinned` set for an
 * agent-page-owned one (an empty set could never consent to anything, so the
 * account could never widen or re-pin). Pure.
 */
import type { PlaneBindingsRecord } from './store-adapter';

export function consentersFitOwner({ record }: { readonly record: PlaneBindingsRecord }): boolean {
  if (record.bindings.ownerRef.kind === 'user') return record.consenters.kind === 'owner';
  return record.consenters.kind === 'pinned' && record.consenters.userIds.length > 0;
}
