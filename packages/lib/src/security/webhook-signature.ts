import { createHmac } from 'crypto';
import { secureCompare } from '../auth/secure-compare';

/**
 * Shared, pure webhook signature helper — the ONE place inbound intake
 * verification and (future) outbound delivery signing agree on crypto.
 *
 * Pure by contract: no db, no fetch, no env, no clock — the current time
 * arrives as `nowMs` (enforced by the purity test alongside this module).
 */

/** Default replay window for timestamped schemes: 5 minutes, matching the intake route. */
export const DEFAULT_REPLAY_WINDOW_MS = 5 * 60 * 1000;

export type VerifyInput = {
  secret: string;
  /** Signature header value as delivered, or null if the header was absent. */
  signature: string | null;
  /**
   * Timestamp header value as delivered (seconds since epoch), or null if
   * absent. Schemes that verify a timestamp MUST recompute over this exact
   * string — the sender signed these bytes, not a normalized number.
   */
  timestamp: string | null;
  rawBody: string;
  /** Current time in ms — injected so the module stays clock-free. */
  nowMs: number;
  /** Max allowed |nowMs - timestamp| for replay protection. */
  replayWindowMs: number;
};

/**
 * The pluggability seam: one adapter per signature scheme. A provider adapter
 * (e.g. GitHub `X-Hub-Signature-256`) slots in as just another object
 * implementing this interface — intake code never changes shape. Schemes
 * without a timestamp simply ignore the timestamp/replay fields.
 */
export interface SignatureScheme {
  /** Stable identifier for registry keying (e.g. 'v0'). */
  name: string;
  sign(secret: string, timestampSeconds: number, rawBody: string): string;
  verify(input: VerifyInput): boolean;
}

/**
 * PageSpace's native scheme (Slack-style): HMAC-SHA256 over
 * `v0:{timestamp}:{rawBody}`, rendered as `v0=<hex>`, with a replay-window
 * check on the timestamp. Comparison goes through `secureCompare` — never raw
 * `crypto.timingSafeEqual` on unhashed input (see auth/secure-compare.ts).
 */
export const v0Scheme: SignatureScheme = {
  name: 'v0',

  sign(secret, timestampSeconds, rawBody) {
    const message = `v0:${timestampSeconds}:${rawBody}`;
    return 'v0=' + createHmac('sha256', secret).update(message).digest('hex');
  },

  verify({ secret, signature, timestamp, rawBody, nowMs, replayWindowMs }) {
    if (!signature || !timestamp) return false;

    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(nowMs - ts * 1000) > replayWindowMs) return false;

    const message = `v0:${timestamp}:${rawBody}`;
    const expected = 'v0=' + createHmac('sha256', secret).update(message).digest('hex');
    return secureCompare(signature, expected);
  },
};
