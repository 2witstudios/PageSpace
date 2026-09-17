/**
 * `decideWriteRecord` — whether a `put`/`rotate` may commit the bindings
 * record it carries (ADR 0005 §2.2, §8 F25; G1a review H2; G1c R2, R4).
 *
 * `rebind`, gated on consent or narrowing, is the ONE path that rewrites a
 * ref's bindings record. So: the record must be self-consistent (its scope
 * hashes to its policyDigest — `version_conflict` otherwise), its consenters
 * must fit the owner kind (`consenters_invalid`), and on an existing ref it
 * must equal the stored record exactly — bindings AND the pinned consenter set
 * (`version_conflict`): a stale copy would revert a consented rebind, and a
 * different set would re-pin who may consent with nobody's consent. The first
 * put (nothing stored) pins what it carries. Pure.
 */
import { canonicalJson } from '../canonical-json';
import type { HashBytes } from '../grant';
import type { PlaneBindingsRecord } from './store-adapter';
import { canonicalConsenters } from './canonical-consenters';
import { consentersFitOwner } from './consenters-fit-owner';
import { isRecordSelfConsistent } from './is-record-self-consistent';

export type WriteRecordDecision = { readonly ok: true } | { readonly ok: false; readonly reason: 'version_conflict' | 'consenters_invalid' };

export function decideWriteRecord({
  stored,
  written,
  hash,
}: {
  readonly stored: PlaneBindingsRecord | null;
  readonly written: PlaneBindingsRecord;
  readonly hash: HashBytes;
}): WriteRecordDecision {
  if (!isRecordSelfConsistent({ record: written, hash })) return { ok: false, reason: 'version_conflict' };
  if (!consentersFitOwner({ record: written })) return { ok: false, reason: 'consenters_invalid' };
  if (stored === null) return { ok: true };
  if (canonicalJson(stored.bindings) !== canonicalJson(written.bindings)) return { ok: false, reason: 'version_conflict' };
  if (canonicalConsenters({ consenters: stored.consenters }) !== canonicalConsenters({ consenters: written.consenters })) return { ok: false, reason: 'version_conflict' };
  return { ok: true };
}
