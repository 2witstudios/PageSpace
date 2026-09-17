/**
 * `decideReplay` — the replay ledger's facts as a `NonceState` (ADR 0004 §2.4).
 *
 * The verifier never performs the lookup; the repository does, and hands
 * the result here. Three states, no fourth: a nonce with no row is `fresh`;
 * a nonce with a row is `consumed`, however old the row — a ledger entry is
 * never un-spent by time (an expired grant fails F10 before F12 anyway, and
 * sweeping is the ledger's housekeeping, not a decision); and a lookup that
 * FAILED is `unknown`, which the verifier turns into
 * `replay_store_unavailable` — never "assume fresh" (§8.11).
 *
 * Pure: the clock is a parameter and is deliberately unused by the rule —
 * it is here so the signature never has to change when a future rule needs
 * it, and so the caller cannot forget to pass one.
 */
import type { GrantId, NonceState } from './grant';

export type RecordedNonce = {
  readonly grantId: GrantId | string;
  /** ms since epoch. */
  readonly expiresAt: number;
  /** ms since epoch. */
  readonly consumedAt: number;
};

/** What the repository found: the row, no row, or a lookup that did not complete. */
export type NonceLookup = { readonly ok: true; readonly recorded: RecordedNonce | null } | { readonly ok: false };

export type DecideReplay = (input: { readonly lookup: NonceLookup; readonly now: number }) => NonceState;

export const decideReplay: DecideReplay = ({ lookup }) => {
  if (!lookup.ok) return 'unknown';
  return lookup.recorded === null ? 'fresh' : 'consumed';
};
