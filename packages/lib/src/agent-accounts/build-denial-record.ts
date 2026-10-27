/**
 * `buildDenialRecord` — the denial row, rebuilt field by field from the
 * verified caller and a digest of the claim (`denial-audit-record.ts`). The
 * claim itself is only ever hashed: no field of an unverified grant can reach
 * the row, whatever object a caller hands in.
 *
 * Pure: the clock and the hash are parameters.
 */
import type { AgentAccountDenialRecord, VerifiedCaller } from './denial-audit-record';
import type { GrantDenyReason, HashBytes } from './grant';

export function buildDenialRecord({
  caller,
  claim,
  reason,
  at,
  hash,
}: {
  readonly caller: VerifiedCaller;
  /** The grant and signature bytes exactly as presented. Hashed, never read. */
  readonly claim: Uint8Array;
  readonly reason: GrantDenyReason;
  readonly at: number;
  readonly hash: HashBytes;
}): AgentAccountDenialRecord {
  return {
    caller: { channel: caller.channel, presenterKeyId: caller.presenterKeyId },
    claimDigest: hash(claim),
    reason,
    at,
  };
}
