/**
 * `decideResolve` — every refusal in ADR 0005 §8 F1–F5, F10 as data. The
 * adapter looks the secret up (`stored`) and hands the facts here; this
 * function decides, the adapter only acts. Composed from the narrower pure
 * decisions so each rule has one owner: `decideResolveCaller` (the
 * channel/kind gate, F1/F2/F2a) and `decidePlaneBinding` (the signed-digest
 * compare, F4) are not re-derived here.
 *
 * Deny order matches §8: not_found / revoked facts are checked first (no
 * point comparing a version or a binding against a row that is not there or
 * is dead), then the caller gate, then version, then bindings.
 */
import type { DecideResolve, ResolveDecision } from './store-adapter';
import { decideResolveCaller } from './decide-resolve-caller';
import { decidePlaneBinding } from './decide-plane-binding';

const NOT_FOUND: ResolveDecision = { ok: false, reason: 'not_found' };
const REVOKED: ResolveDecision = { ok: false, reason: 'revoked' };
const KIND_NOT_RESOLVABLE: ResolveDecision = { ok: false, reason: 'kind_not_resolvable' };
const VERSION_MISMATCH: ResolveDecision = { ok: false, reason: 'version_mismatch' };
const BINDING_MISMATCH: ResolveDecision = { ok: false, reason: 'binding_mismatch' };
const OK: ResolveDecision = { ok: true };

export const decideResolve: DecideResolve = ({ grant, ref, stored, now, rotationGraceMs, hash }) => {
  if (stored === null) return NOT_FOUND;
  if (stored.revokedAt !== null) return REVOKED;

  // `PlaneBindings` and its digest carry no `accountId` (the digest covers owner/origins/policy,
  // not which account this is), so two accounts in the same tenant with identical bindings/kind/
  // version would otherwise pass the bindings check for each other's ref. The grant's own
  // `accountId` — already a required field, signed by the authority — must name the SAME account
  // as `ref` (Codex review PR #2646 P1). Reported as `not_found`, consistent with the other
  // identity-mismatch case (F5: a tenant-scoped identity resolving a ref in a different tenant).
  if (grant.accountId !== ref.accountId) return NOT_FOUND;

  const caller = decideResolveCaller({ aud: grant.aud, kind: ref.kind, sessionHttp: grant.sessionHttp });
  if (!caller.ok) return KIND_NOT_RESOLVABLE;

  // The previous version is for a grant IN FLIGHT across the rotation only: issued before
  // `rotatedAt`, presented strictly inside the window (G1a review M7; the same rule as ADR 0004 F5a).
  const versionOk =
    grant.credentialVersion === stored.currentVersion ||
    (stored.previousVersion !== null &&
      grant.credentialVersion === stored.previousVersion &&
      stored.rotatedAt !== null &&
      grant.iat < stored.rotatedAt &&
      now < stored.rotatedAt + rotationGraceMs);
  if (!versionOk) return VERSION_MISMATCH;

  const binding = decidePlaneBinding({ storedBindings: stored.bindings, grantBindingDigest: grant.bindingDigest, hash });
  if (!binding.ok) return BINDING_MISMATCH;

  return OK;
};
