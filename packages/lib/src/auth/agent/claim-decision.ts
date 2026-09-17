/**
 * Pure claim-ceremony decisions (ADR 0007 Decisions 3, 7, 8) in the shape of
 * `decideDevicePoll` / `decideDeviceApproval` (`auth/oauth/code-lifecycle.ts`).
 *
 * A claim record binds a HUMAN owner to an AGENT: the agent polls the claim
 * grant on the token endpoint, and a signed-in human approves or denies at
 * `/claim`. Unlike a device code, an approved claim mints for the AGENT
 * (the principal never changes — Decision 7), so the grant carries both ids.
 *
 * No I/O: the route fetches the claim row and the agent's current owner,
 * calls these, and persists what the decision implies.
 */

// ---------------------------------------------------------------------------
// Policy constants (creation sites use these; the decisions only compare)
// ---------------------------------------------------------------------------

/** A claim link is good for 15 minutes (threat model §4.3). */
export const CLAIM_TTL_SECONDS = 900;

/** RFC 8628 §3.2 default minimum poll interval, reused for the claim grant. */
export const CLAIM_POLL_INTERVAL_SECONDS = 5;

// ---------------------------------------------------------------------------
// Records and inputs
// ---------------------------------------------------------------------------

interface ClaimCommon {
  agentUserId: string;
  /** The agent's CURRENT owner from `agent_identities.ownerUserId` — null while unclaimed. */
  agentOwnerUserId: string | null;
  expiresAt: Date;
  /** Null on the very first poll — no throttle to apply yet. */
  lastPolledAt: Date | null;
  pollIntervalSeconds: number;
}

export type ClaimRecord =
  | ({ status: 'pending' } & ClaimCommon)
  | ({ status: 'approved'; ownerUserId: string } & ClaimCommon)
  | ({ status: 'denied' } & ClaimCommon)
  /** Already exchanged for the agent's credentials — dead for good. */
  | ({ status: 'redeemed' } & ClaimCommon);

export interface ClaimGrant {
  agentUserId: string;
  ownerUserId: string;
}

export interface Claimer {
  userId: string;
  accountType: 'human' | 'agent';
}

// ---------------------------------------------------------------------------
// Poll (the agent, on the token endpoint)
// ---------------------------------------------------------------------------

export type ClaimPollDecision =
  | { status: 'authorization_pending' }
  | { status: 'slow_down' }
  | { status: 'expired_token' }
  | { status: 'access_denied' }
  /** The claim was already exchanged; the route collapses this to invalid_grant. */
  | { status: 'already_redeemed' }
  | { status: 'ok'; grant: ClaimGrant };

/**
 * Precedence mirrors decideDevicePoll:
 *  1. already_redeemed — stays dead regardless of the clock.
 *  2. expired_token — absolute boundary, exactly-at-expiry fails closed.
 *  3. A settled record reports its outcome regardless of throttle; an
 *     approved record whose approving owner is no longer the current owner
 *     reports access_denied, never a stale grant.
 *  4. pending — slow_down only when polled strictly faster than the interval.
 */
export function decideClaimPoll(record: ClaimRecord, now: Date): ClaimPollDecision {
  if (record.status === 'redeemed') {
    return { status: 'already_redeemed' };
  }

  if (now.getTime() >= record.expiresAt.getTime()) {
    return { status: 'expired_token' };
  }

  if (record.status === 'denied') {
    return { status: 'access_denied' };
  }

  if (record.status === 'approved') {
    // The approving owner must still be the agent's CURRENT owner. If they
    // unlinked (or another owner replaced them) between approve and poll, the
    // historical grant is stale: report it as denied — the same wire shape a
    // human denial produces, so a poller learns nothing about ownership churn.
    if (record.agentOwnerUserId !== record.ownerUserId) {
      return { status: 'access_denied' };
    }
    return {
      status: 'ok',
      grant: { agentUserId: record.agentUserId, ownerUserId: record.ownerUserId },
    };
  }

  if (
    record.lastPolledAt !== null &&
    now.getTime() - record.lastPolledAt.getTime() < record.pollIntervalSeconds * 1000
  ) {
    return { status: 'slow_down' };
  }

  return { status: 'authorization_pending' };
}

// ---------------------------------------------------------------------------
// Approval (the human, at /claim)
// ---------------------------------------------------------------------------

export type ClaimApprovalAction = 'approve' | 'deny';

export type ClaimApprovalDecision =
  | { status: 'approved'; agentUserId: string; ownerUserId: string; approvedAt: Date }
  | { status: 'denied'; deniedAt: Date }
  /** The claimer is not a human account — an agent can never own an agent (threat model T7). */
  | { status: 'not_human' }
  /** The agent already has an owner (this record or another) — one owner, ever (T8). */
  | { status: 'already_claimed'; ownerUserId: string }
  | { status: 'already_settled'; existingStatus: 'approved' | 'denied' | 'redeemed' }
  | { status: 'expired' };

/**
 * Precedence:
 *  1. not_human — checked before anything else; who is asking matters more
 *     than what they are asking about. Mutation-checked.
 *  2. already_claimed — the agent-level fact beats the record-level fact:
 *     what the human needs to hear is "this agent already has an owner".
 *  3. already_settled — a terminal record stays terminal, even once expired.
 *  4. expired — a pending record fails closed exactly at its boundary.
 *  5. deny / approve — with timestamps for the route to persist.
 */
export function decideClaimApproval(
  record: ClaimRecord,
  action: ClaimApprovalAction,
  claimer: Claimer,
  now: Date,
): ClaimApprovalDecision {
  if (claimer.accountType !== 'human') {
    return { status: 'not_human' };
  }

  if (record.agentOwnerUserId !== null) {
    return { status: 'already_claimed', ownerUserId: record.agentOwnerUserId };
  }

  if (record.status !== 'pending') {
    return { status: 'already_settled', existingStatus: record.status };
  }

  if (now.getTime() >= record.expiresAt.getTime()) {
    return { status: 'expired' };
  }

  if (action === 'deny') {
    return { status: 'denied', deniedAt: now };
  }

  return {
    status: 'approved',
    agentUserId: record.agentUserId,
    ownerUserId: claimer.userId,
    approvedAt: now,
  };
}
