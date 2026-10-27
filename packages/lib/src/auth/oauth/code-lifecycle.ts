/**
 * Pure authorization-code and device-code lifecycle decisions for the OAuth 2.1
 * provider (Phase 1).
 *
 * No I/O: every function takes the fetched record, the request facts, and an
 * injected `now`, and returns a decision. The endpoint route (Phase 1 tasks
 * 7/9) fetches the record, calls these, and persists whatever the decision
 * implies (revoke, mark consumed, transition status) — this module never
 * reaches into the database or the clock itself.
 *
 * Following the `token-lifecycle-policy.ts` precedent: exhaustive discriminated
 * unions instead of booleans-with-meanings, fail-closed at every boundary.
 */

import { verifyPkceChallenge } from './pkce';

// ---------------------------------------------------------------------------
// Policy constants — named, not buried as literals in the branches below.
// Downstream creation sites (the /authorize, /token, and device-authorization
// routes) use these when minting new code records; the decide functions here
// only ever compare against Dates/numbers already stored on the record.
// ---------------------------------------------------------------------------

/** OAuth 2.1 requires authorization codes to be short-lived. */
export const AUTHORIZATION_CODE_TTL_SECONDS = 60;

/** RFC 8628 §3.2 example default device-code lifetime. */
export const DEVICE_CODE_TTL_SECONDS = 1800;

/** RFC 8628 §3.2 default minimum poll interval. */
export const DEVICE_CODE_POLL_INTERVAL_SECONDS = 5;

// ---------------------------------------------------------------------------
// Authorization-code exchange (decideCodeExchange)
// ---------------------------------------------------------------------------

export interface AuthorizationCodeRecord {
  clientId: string;
  userId: string;
  scopes: string[];
  redirectUri: string;
  /** S256 PKCE challenge captured at /authorize time. */
  codeChallenge: string;
  expiresAt: Date;
  /** Set once the code has been exchanged; null while still live. */
  consumedAt: Date | null;
}

export interface CodeExchangeInput {
  redirectUri: string;
  codeVerifier: string;
}

export interface CodeExchangeGrant {
  clientId: string;
  userId: string;
  scopes: string[];
}

export type CodeExchangeDecision =
  | { status: 'ok'; grant: CodeExchangeGrant }
  | { status: 'expired' }
  | { status: 'already_consumed'; revokeIssuedTokens: true }
  | { status: 'redirect_mismatch' }
  | { status: 'pkce_failed' };

/**
 * Decide the outcome of exchanging an authorization code.
 *
 * Precedence (each a distinct security posture, most severe first):
 *  1. already_consumed — a replay of a used code is OAuth 2.1's theft signal;
 *     it wins over every other check, including a since-expired window.
 *  2. expired — an absolute time boundary; exactly-at-expiry fails closed.
 *  3. redirect_mismatch — exact-match only (no substring/prefix matching).
 *  4. pkce_failed — the last defense once the client is otherwise legitimate.
 */
export function decideCodeExchange(
  record: AuthorizationCodeRecord,
  input: CodeExchangeInput,
  now: Date,
): CodeExchangeDecision {
  if (record.consumedAt !== null) {
    return { status: 'already_consumed', revokeIssuedTokens: true };
  }

  if (now.getTime() >= record.expiresAt.getTime()) {
    return { status: 'expired' };
  }

  if (input.redirectUri !== record.redirectUri) {
    return { status: 'redirect_mismatch' };
  }

  if (!verifyPkceChallenge(input.codeVerifier, record.codeChallenge, 'S256')) {
    return { status: 'pkce_failed' };
  }

  return {
    status: 'ok',
    grant: { clientId: record.clientId, userId: record.userId, scopes: record.scopes },
  };
}

// ---------------------------------------------------------------------------
// Device-authorization grant (RFC 8628 §3.5): poll + approval state machines
// ---------------------------------------------------------------------------

interface DeviceCodeCommon {
  clientId: string;
  scopes: string[];
  expiresAt: Date;
  /** Null on the very first poll — no throttle to apply yet. */
  lastPolledAt: Date | null;
  pollIntervalSeconds: number;
}

export type DeviceCodeRecord =
  | ({ status: 'pending' } & DeviceCodeCommon)
  | ({ status: 'approved'; approvedUserId: string } & DeviceCodeCommon)
  | ({ status: 'denied' } & DeviceCodeCommon)
  /** Already exchanged for credentials — RFC 8628 §3.5 requires it be invalidated. */
  | ({ status: 'redeemed' } & DeviceCodeCommon);

export interface DeviceGrant {
  clientId: string;
  userId: string;
  scopes: string[];
}

export type DevicePollDecision =
  | { status: 'authorization_pending' }
  | { status: 'slow_down' }
  | { status: 'expired_token' }
  | { status: 'access_denied' }
  /** The device_code was already exchanged; the route collapses this to invalid_grant. */
  | { status: 'already_redeemed' }
  | { status: 'ok'; grant: DeviceGrant };

/**
 * Decide the response to a device-code poll (RFC 8628 §3.5).
 *
 * Precedence:
 *  1. already_redeemed — a code that has been exchanged is dead for good, and
 *     stays dead regardless of the clock; reported before expiry so the answer
 *     doesn't change to `expired_token` once the TTL passes. RFC 8628 §3.5.
 *     Without this, an approved code keeps issuing credentials on every poll
 *     until it expires — harmless-looking for a login grant, but a mint-shaped
 *     grant (`keys create --device`) would mint a fresh key each time.
 *  2. expired_token — absolute boundary, checked before anything else
 *     remaining, including an already-approved-but-unexchanged code.
 *  3. A settled record (approved/denied) reports its outcome immediately —
 *     the poll-interval throttle only governs *continued waiting*, not
 *     delivery of an already-decided result.
 *  4. pending — throttle repeated polling faster than pollIntervalSeconds;
 *     exactly-at-interval is allowed (only strictly-less-than throttles).
 */
export function decideDevicePoll(record: DeviceCodeRecord, now: Date): DevicePollDecision {
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
    return {
      status: 'ok',
      grant: {
        clientId: record.clientId,
        userId: record.approvedUserId,
        scopes: record.scopes,
      },
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

export type DeviceApprovalAction = 'approve' | 'deny';

export type DeviceApprovalDecision =
  | { status: 'approved'; grant: DeviceGrant }
  | { status: 'denied' }
  | { status: 'already_settled'; existingStatus: 'approved' | 'denied' | 'redeemed' }
  | { status: 'expired' };

/**
 * Decide the outcome of a user's approve/deny action at the /activate screen.
 *
 * A settled record (already approved, denied, or redeemed) always rejects
 * further decisions — that check runs before expiry, since a terminal outcome
 * stays terminal regardless of whether the code has since expired. A
 * still-pending record fails closed exactly at (and after) its expiry
 * boundary.
 */
export function decideDeviceApproval(
  record: DeviceCodeRecord,
  action: DeviceApprovalAction,
  userId: string,
  now: Date,
): DeviceApprovalDecision {
  if (record.status !== 'pending') {
    return { status: 'already_settled', existingStatus: record.status };
  }

  if (now.getTime() >= record.expiresAt.getTime()) {
    return { status: 'expired' };
  }

  if (action === 'deny') {
    return { status: 'denied' };
  }

  return {
    status: 'approved',
    grant: { clientId: record.clientId, userId, scopes: record.scopes },
  };
}
