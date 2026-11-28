/**
 * `mintOwnerConsent` — the authority's signed statement that a consenter the
 * plane pinned passed step-up for EXACTLY this ref, these bindings and this
 * consenter set (ADR 0005 §2.6; `OwnerConsent`). The plane verifies it under
 * the consent PUBLIC key, checks every field against the rebind it rides on,
 * and consumes `consentId` once (`decideRebind`). Signed under the consent
 * key, never the grant key: a grant signer cannot widen a scope.
 *
 * The signed message is the canonical JSON of every field but the signature —
 * the same bytes `decideRebind` rebuilds. Pure: the signer, hash and ids are
 * inputs.
 */
import type { ConsentId, HashBytes, UserId } from './grant';
import type { OwnerConsent, PlaneBindings, PlaneConsenters, SecretRef } from './store/store-adapter';
import { canonicalJson } from './canonical-json';
import { digestBindings } from './store/digest-bindings';

export function mintOwnerConsent({
  consentId,
  consentingUserId,
  stepUpChallengeId,
  ref,
  bindings,
  consenters,
  issuedAt,
  sign,
  hash,
}: {
  readonly consentId: ConsentId;
  readonly consentingUserId: UserId;
  readonly stepUpChallengeId: string;
  readonly ref: SecretRef;
  readonly bindings: PlaneBindings;
  readonly consenters: PlaneConsenters;
  readonly issuedAt: number;
  readonly sign: (message: Uint8Array) => Uint8Array;
  /** SHA3-256 — the bindings digest the plane recomputes. */
  readonly hash: HashBytes;
}): OwnerConsent {
  const bindingsDigest = digestBindings({ bindings, hash });
  const message = new TextEncoder().encode(canonicalJson({ consentId, consentingUserId, stepUpChallengeId, ref, bindingsDigest, consenters, issuedAt }));
  return { consentId, consentingUserId, stepUpChallengeId, ref, bindingsDigest, consenters, issuedAt, signature: Buffer.from(sign(message)).toString('base64') };
}
