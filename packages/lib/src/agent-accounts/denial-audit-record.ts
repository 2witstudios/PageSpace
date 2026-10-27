/**
 * The denial audit row — what the chain may say about a grant it REFUSED.
 *
 * A refused grant is, by definition, not trusted: at `bad_signature` it is
 * attacker-authored text, and at every later step its claims are exactly
 * what failed to hold. The chain it lands in is tamper-evident and cannot be
 * erased, so a row built from the grant's `human`, `agentPageId` or
 * `grantId` would let anyone who can reach an executor write permanent
 * history naming an arbitrary person or agent (ASI03). A denial therefore
 * carries only:
 *   - `caller`: what the executor AUTHENTICATED itself — its own channel and
 *     the presenter key the transport verified — never a field of the grant;
 *   - `claimDigest`: SHA3-256 of the presented bytes, so the exact claim stays
 *     provable against a copy held elsewhere without being stored here;
 *   - `reason` and `at`.
 *
 * Kept beside, not inside, the frozen `AgentAccountAuditRecord`, whose
 * principals are only sound once the grant has verified.
 */
import type { ExecutorChannel, GrantDenyReason, PresenterKeyId } from './grant';

/** The caller identity the executor authenticated, independent of anything the grant claims. */
export type VerifiedCaller = {
  readonly channel: ExecutorChannel;
  readonly presenterKeyId: PresenterKeyId;
};

export type AgentAccountDenialRecord = {
  readonly caller: VerifiedCaller;
  /** SHA3-256 hex of the claim bytes exactly as presented. */
  readonly claimDigest: string;
  readonly reason: GrantDenyReason;
  /** ms since epoch, injected. */
  readonly at: number;
};
