/**
 * `digestWrite` — the identity of ONE Infisical write, value and comment
 * together (ADR 0005 §2.3; G1c E1): the injected hash (SHA3-256) over
 * `canonicalJson({ secretValue, secretComment })`. Recorded as the pending
 * write before a replacing write lands and compared at reconcile, so "this is
 * the write we attempted" is decided by bytes, never by a version number a
 * second writer could also produce. Pure.
 */
import { canonicalJson } from '../canonical-json';
import type { DigestWrite, WriteDigest } from './store-adapter';

export const digestWrite: DigestWrite = ({ secretValue, secretComment, hash }) =>
  hash(new TextEncoder().encode(canonicalJson({ secretValue, secretComment }))) as WriteDigest;
