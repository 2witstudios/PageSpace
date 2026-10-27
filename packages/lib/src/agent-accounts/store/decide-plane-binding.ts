/**
 * `decidePlaneBinding` — the plane's independent check that a grant's signed
 * `bindingDigest` still matches what is stored beside the material (ADR 0005
 * §2.4, F4; threat-model A9). No main-DB fact is consulted: a main-DB writer
 * who reassigns `ownerRef` or widens `allowedOrigins` either signs a grant
 * whose digest disagrees with the plane's copy (`binding_mismatch`) or never
 * gets a grant at all.
 *
 * The compare goes through `secureCompare` (SHA3-256 both sides, constant
 * time) per the repo's timing-safe-compare rule — never a raw `===` on the
 * digest.
 */
import { secureCompare } from '../../auth/secure-compare';
import type { BindingDigest, HashBytes } from '../grant';
import type { PlaneBindings } from './store-adapter';
import { digestBindings } from './digest-bindings';

export type PlaneBindingDecision = { readonly ok: true } | { readonly ok: false; readonly reason: 'binding_mismatch' };

export type DecidePlaneBinding = (input: {
  readonly storedBindings: PlaneBindings;
  readonly grantBindingDigest: BindingDigest;
  readonly hash: HashBytes;
}) => PlaneBindingDecision;

export const decidePlaneBinding: DecidePlaneBinding = ({ storedBindings, grantBindingDigest, hash }) => {
  const stored = digestBindings({ bindings: storedBindings, hash });
  return secureCompare(stored, grantBindingDigest) ? { ok: true } : { ok: false, reason: 'binding_mismatch' };
};
