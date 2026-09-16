/**
 * `digestPlaneScope` — the `policyDigest` inside `PlaneBindings` (ADR 0005 §2.4; G1a review H1):
 * `hash(canonicalJson(scope))` with `boundAgentPageIds`, `allowedOrigins` and `auxiliaryOrigins` sorted, so the
 * authority (reading the main DB) and the plane (holding its own copy) derive the same bytes
 * whatever order either side read the rows in. `policyVersion` is a counter a main-DB writer can
 * leave untouched while widening the policy; this digest is not. The scope includes
 * `sessionHttpEnabled`, `auxiliaryOrigins` and `providerSlug` (G1c R1/R7).
 *
 * Pure. Sorts copies — never the caller's arrays. The injected `hash` must be SHA3-256.
 */
import { canonicalJson } from '../canonical-json';
import type { DigestPlaneScope, PolicyDigest } from './store-adapter';

export const digestPlaneScope: DigestPlaneScope = ({ scope, hash }) => {
  const canonical = {
    ...scope,
    boundAgentPageIds: [...scope.boundAgentPageIds].sort(),
    allowedOrigins: [...scope.allowedOrigins].sort(),
    auxiliaryOrigins: [...scope.auxiliaryOrigins].sort(),
  };
  return hash(new TextEncoder().encode(canonicalJson(canonical))) as PolicyDigest;
};
