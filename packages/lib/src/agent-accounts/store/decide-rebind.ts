/**
 * `decideRebind` — whether the plane may rewrite an account's `PlaneBindings` (ADR 0005 §2.2
 * `rebind`, §10.21; G1a review H2). Pure: the adapter reads the stored bindings under the
 * per-secret lock and acts only on `rebind`.
 *
 * Refusal order: nothing stored (`not_found`); then the consent — signature under the pinned
 * consent key, digest over EXACTLY `next`, freshness, and for a user-owned account a consenting
 * user equal to the owner in the STORED bindings (so a DB writer who reassigned the owner cannot
 * consent as the new one); then the immutable fields; then the CAS on `policyVersion`. The consent
 * is checked before anything about the stored row is revealed to the caller.
 *
 * An agent-page-owned account has no user owner in the plane's copy to compare against; the signed
 * consent (a step-up the authority only mints for someone who holds `grant` on the account) is the
 * whole gate there.
 */
import { secureCompare } from '../../auth/secure-compare';
import { canonicalJson } from '../canonical-json';
import { decodeBase64 } from '../decode-base64';
import type { DecideRebind, OwnerConsent } from './store-adapter';
import { digestBindings } from './digest-bindings';

const NOT_FOUND = { outcome: 'refuse', reason: 'not_found' } as const;
const CONSENT_INVALID = { outcome: 'refuse', reason: 'consent_invalid' } as const;
const IMMUTABLE_BINDING_CHANGED = { outcome: 'refuse', reason: 'immutable_binding_changed' } as const;
const VERSION_CONFLICT = { outcome: 'refuse', reason: 'version_conflict' } as const;
const REBIND = { outcome: 'rebind' } as const;

function consentMessage({ consentId, consentingUserId, stepUpChallengeId, bindingsDigest, issuedAt }: OwnerConsent): Uint8Array {
  return new TextEncoder().encode(canonicalJson({ consentId, consentingUserId, stepUpChallengeId, bindingsDigest, issuedAt }));
}

export const decideRebind: DecideRebind = ({ stored, expectedVersion, next, consent, consentPublicKey, now, maxAgeMs, verify, hash }) => {
  if (stored === null) return NOT_FOUND;

  const signature = decodeBase64(consent.signature);
  if (signature === null) return CONSENT_INVALID;
  let signed = false;
  try {
    signed = verify(consentMessage(consent), signature, consentPublicKey);
  } catch {
    signed = false;
  }
  if (!signed) return CONSENT_INVALID;
  if (!secureCompare(consent.bindingsDigest, digestBindings({ bindings: next, hash }))) return CONSENT_INVALID;
  if (consent.issuedAt > now || now - consent.issuedAt > maxAgeMs) return CONSENT_INVALID;
  if (stored.ownerRef.kind === 'user' && consent.consentingUserId !== stored.ownerRef.userId) return CONSENT_INVALID;

  if (next.tenantId !== stored.tenantId || next.kind !== stored.kind) return IMMUTABLE_BINDING_CHANGED;

  if (stored.policyVersion !== expectedVersion || next.policyVersion <= expectedVersion) return VERSION_CONFLICT;

  return REBIND;
};
