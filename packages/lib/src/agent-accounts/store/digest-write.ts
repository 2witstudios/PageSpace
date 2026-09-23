/**
 * `digestWrite` — the identity of ONE Infisical write, value and comment
 * together (ADR 0005 §2.3; G1c E1): an HMAC under the plane-held
 * `WriteDigestKey` over `canonicalJson({ secretValue, secretComment })`.
 * Recorded as the pending write before a replacing write lands and compared at
 * reconcile, so "this is the write we attempted" is decided by bytes, never by
 * a version number a second writer could also produce.
 *
 * Keyed on purpose (G2 ruling 4): the digest sits in the plane metadata row
 * while a write is ambiguous, and an unkeyed hash of material lets any reader
 * of that row test candidate values offline. Without the plane key there is
 * nothing to test a guess against. Pure: the MAC is injected.
 */
import { canonicalJson } from '../canonical-json';
import type { DigestWrite, WriteDigest } from './store-adapter';

export const digestWrite: DigestWrite = ({ secretValue, secretComment, key, hmac }) =>
  hmac(key, new TextEncoder().encode(canonicalJson({ secretValue, secretComment }))) as WriteDigest;
