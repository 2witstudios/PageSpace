/**
 * `decideRebind` — whether the plane may rewrite an account's bindings row
 * (ADR 0005 §2.2 `rebind`, §2.6; G1a review H2; G1c R2, E2, R13). Pure: the
 * adapter reads the stored record under the per-secret lock, consumes the
 * named consent single-use, and writes only on `rebind`.
 *
 * Refusal order:
 *   1. nothing stored — `not_found`; a revoked ref — `revoked` (its consent is never spent);
 *   2. a stored scope that does not hash to the stored `policyDigest` — the
 *      plane's own record is inconsistent, so fail closed (`store_unavailable`);
 *   3. a next scope that does not hash to the next `policyDigest`, or whose
 *      origins disagree with the bindings' — a narrow scope claimed over wide
 *      bindings must never pass as a narrowing (`version_conflict`);
 *   4. tenant, kind or owner KIND changed, or an owner that no longer derives
 *      the stored tenant (`immutable_binding_changed`, R2) — a user owner
 *      rewritten to another user changes the tenant it derives;
 *   5. the CAS on `policyVersion` (`version_conflict`);
 *   6. consenters that do not fit the owner kind — `owner` for a user owner, a
 *      non-empty `pinned` set for an agent page (`consent_invalid`);
 *   7. consent. An equal-or-narrower scope with the owner and consenters
 *      unchanged needs none (R13). Otherwise a missing consent is
 *      `consent_required`. A consent that is present is ALWAYS verified, never
 *      ignored: signature under the pinned consent key, this exact `ref` (E2),
 *      exactly the next bindings digest and consenters, freshness, and a
 *      consenting user who is a consenter in the STORED record — the stored
 *      user owner, or a member of the stored pinned set (R2). A main-DB role
 *      never mints consent authority: a drive ADMIN the plane did not pin is
 *      refused.
 *
 * A `rebind` names the consent the adapter must consume through the replay
 * store before writing (`consumeConsentId`), or null when none was presented.
 */
import { secureCompare } from '../../auth/secure-compare';
import { canonicalJson } from '../canonical-json';
import { decodeBase64 } from '../decode-base64';
import type { UserId } from '../grant';
import type { DecideRebind, OwnerConsent, PlaneBindingsRecord } from './store-adapter';
import { canonicalConsenters } from './canonical-consenters';
import { consentersFitOwner } from './consenters-fit-owner';
import { deriveTenantId } from './derive-tenant-id';
import { digestBindings } from './digest-bindings';
import { isRecordSelfConsistent } from './is-record-self-consistent';
import { isScopeNarrowing } from './is-scope-narrowing';

const NOT_FOUND = { outcome: 'refuse', reason: 'not_found' } as const;
const REVOKED = { outcome: 'refuse', reason: 'revoked' } as const;
const STORE_UNAVAILABLE = { outcome: 'refuse', reason: 'store_unavailable' } as const;
const CONSENT_REQUIRED = { outcome: 'refuse', reason: 'consent_required' } as const;
const CONSENT_INVALID = { outcome: 'refuse', reason: 'consent_invalid' } as const;
const IMMUTABLE_BINDING_CHANGED = { outcome: 'refuse', reason: 'immutable_binding_changed' } as const;
const VERSION_CONFLICT = { outcome: 'refuse', reason: 'version_conflict' } as const;

function consentMessage({ consentId, consentingUserId, stepUpChallengeId, ref, bindingsDigest, consenters, issuedAt }: OwnerConsent): Uint8Array {
  return new TextEncoder().encode(canonicalJson({ consentId, consentingUserId, stepUpChallengeId, ref, bindingsDigest, consenters, issuedAt }));
}

function isStoredConsenter(stored: PlaneBindingsRecord, consentingUserId: UserId): boolean {
  const { ownerRef } = stored.bindings;
  if (ownerRef.kind === 'user') return stored.consenters.kind === 'owner' && consentingUserId === ownerRef.userId;
  return stored.consenters.kind === 'pinned' && stored.consenters.userIds.includes(consentingUserId);
}

export const decideRebind: DecideRebind = ({ ref, stored, storedRevoked, expectedVersion, next, consent, consentPublicKey, now, maxAgeMs, verify, hash }) => {
  if (stored === null) return NOT_FOUND;
  // A revoked account's bindings are never rewritten, and nothing about the consent is looked at (G1c review).
  if (storedRevoked) return REVOKED;
  if (!isRecordSelfConsistent({ record: stored, hash })) return STORE_UNAVAILABLE;
  if (!isRecordSelfConsistent({ record: next, hash })) return VERSION_CONFLICT;

  const was = stored.bindings;
  const will = next.bindings;
  if (will.tenantId !== was.tenantId || will.kind !== was.kind) return IMMUTABLE_BINDING_CHANGED;
  if (will.ownerRef.kind !== was.ownerRef.kind || deriveTenantId({ owner: will.ownerRef }) !== was.tenantId) return IMMUTABLE_BINDING_CHANGED;

  if (was.policyVersion !== expectedVersion || will.policyVersion <= expectedVersion) return VERSION_CONFLICT;
  if (!consentersFitOwner({ record: next })) return CONSENT_INVALID;

  const consentNeeded =
    !isScopeNarrowing({ stored: stored.scope, next: next.scope }) ||
    canonicalJson(will.ownerRef) !== canonicalJson(was.ownerRef) ||
    canonicalConsenters({ consenters: next.consenters }) !== canonicalConsenters({ consenters: stored.consenters });
  if (consent === null) return consentNeeded ? CONSENT_REQUIRED : { outcome: 'rebind', consumeConsentId: null };

  const signature = decodeBase64(consent.signature);
  if (signature === null) return CONSENT_INVALID;
  let signed = false;
  try {
    signed = verify(consentMessage(consent), signature, consentPublicKey);
  } catch {
    signed = false;
  }
  if (!signed) return CONSENT_INVALID;
  if (canonicalJson(consent.ref) !== canonicalJson(ref)) return CONSENT_INVALID;
  if (!secureCompare(consent.bindingsDigest, digestBindings({ bindings: will, hash }))) return CONSENT_INVALID;
  if (canonicalConsenters({ consenters: consent.consenters }) !== canonicalConsenters({ consenters: next.consenters })) return CONSENT_INVALID;
  if (consent.issuedAt > now || now - consent.issuedAt > maxAgeMs) return CONSENT_INVALID;
  if (!isStoredConsenter(stored, consent.consentingUserId)) return CONSENT_INVALID;

  return { outcome: 'rebind', consumeConsentId: consent.consentId };
};
