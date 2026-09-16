/**
 * `decideWriteBindings` — whether a `put`/`rotate` may commit the bindings it carries (ADR 0005 §2.2;
 * G1a review H2). `rebind`, gated on an owner consent, is the ONE path that rewrites a ref's
 * `PlaneBindings`; a write onto an existing ref must carry exactly the stored bindings (compared as
 * canonical JSON, so key order does not matter). Anything else — a stale copy that would revert a
 * consented rebind, or a widening nobody consented to — is refused as `version_conflict`: the
 * caller's view of the bindings is out of date and it must read (or rebind) first.
 *
 * Pure. The first `put` (nothing stored) sets the bindings.
 */
import { canonicalJson } from '../canonical-json';
import type { PlaneBindings } from './store-adapter';

export type WriteBindingsDecision = { readonly ok: true } | { readonly ok: false; readonly reason: 'version_conflict' };

export type DecideWriteBindings = (input: { readonly stored: PlaneBindings | null; readonly written: PlaneBindings }) => WriteBindingsDecision;

export const decideWriteBindings: DecideWriteBindings = ({ stored, written }) =>
  stored === null || canonicalJson(stored) === canonicalJson(written) ? { ok: true } : { ok: false, reason: 'version_conflict' };
