/**
 * `auditResourceKeysFor` — which resource keys of a canonical request may
 * enter the tamper-evident, non-erasable audit chain (ADR 0004 §5; G1c R6).
 *
 * Exactly the matched entry's `auditResourceSlots`, each under the restriction
 * key `canonical.resources` carries it as. Nothing else: after M8 every path
 * slot was a "declared" resource, so `/v1/tokens/{token}` wrote the token into
 * a chain that cannot be erased. A generic request (no entry) audits no
 * resource value. Pure.
 */
import type { OperationRegistryEntry } from './canonical-request';

export function auditResourceKeysFor({ entry }: { readonly entry: OperationRegistryEntry | null }): readonly string[] {
  if (entry === null) return [];
  return entry.auditResourceSlots.map((slot) => (Object.prototype.hasOwnProperty.call(entry.restrictionKeys, slot) ? entry.restrictionKeys[slot]! : slot));
}
