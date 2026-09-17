/**
 * `isRecordSelfConsistent` — a bindings record's scope hashes to its own
 * `policyDigest` and its allowed origins are the bindings' allowed origins
 * (ADR 0005 §2.6; G1c R4, R13). A record that fails this claims one scope
 * while binding another — never written, never compared for narrowing. The
 * injected hash must be SHA3-256; the digest compare is timing-safe. Pure.
 */
import { secureCompare } from '../../auth/secure-compare';
import { canonicalJson } from '../canonical-json';
import type { HashBytes } from '../grant';
import type { PlaneBindingsRecord } from './store-adapter';
import { digestPlaneScope } from './digest-plane-scope';
import { isPlaneScopeWellFormed } from './is-plane-scope-well-formed';

export function isRecordSelfConsistent({ record, hash }: { readonly record: PlaneBindingsRecord; readonly hash: HashBytes }): boolean {
  // Values first: a scope whose limits or trigger are not their declared types is never a record the plane keeps (G1c review).
  if (!isPlaneScopeWellFormed({ scope: record.scope })) return false;
  if (!secureCompare(digestPlaneScope({ scope: record.scope, hash }), record.bindings.policyDigest)) return false;
  return canonicalJson([...record.scope.allowedOrigins].sort()) === canonicalJson([...record.bindings.allowedOrigins].sort());
}
