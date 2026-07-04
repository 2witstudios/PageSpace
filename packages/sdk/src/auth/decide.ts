/**
 * Pure decision core for OAuthTokenProvider (ADR 0003 §3.2, §6; Phase 2 task 4).
 *
 * No I/O. Clock and skew window are always passed in by the caller so every
 * boundary is exhaustively testable with plain inputs.
 */
import {
  isNetworkError,
  isRateLimitError,
  isServerError,
  isTimeoutError,
} from '../errors.js';

export type TokenAction = 'use-cached' | 'refresh' | 'unauthenticated';

export type OAuthTokenState =
  | { status: 'authenticated'; accessExpiresAt: number; refreshExpiresAt: number }
  | { status: 'unauthenticated'; accessExpiresAt: number };

/**
 * Decides what an OAuthTokenProvider should do for the next getAccessToken()
 * call. Refreshes proactively once fewer than `skewMs` remain before expiry
 * — never waits for the server to return a 401. Once `refreshExpiresAt`
 * itself has passed, goes straight to 'unauthenticated' rather than
 * attempting a refresh call that the server will reject anyway.
 */
export function decideTokenAction(
  state: OAuthTokenState,
  nowMs: number,
  skewMs: number,
): TokenAction {
  if (state.status === 'unauthenticated') {
    return 'unauthenticated';
  }
  if (nowMs + skewMs < state.accessExpiresAt) {
    return 'use-cached';
  }
  return nowMs < state.refreshExpiresAt ? 'refresh' : 'unauthenticated';
}

export type RefreshFailureClassification = 'retryable' | 'terminal';

/**
 * Classifies a refresh-flight failure per ADR 0003 §6 classifyRefreshFailure:
 * network errors, timeouts, 429, and 5xx are transient — retry per policy.
 * Everything else (400 invalid_grant/invalid_request, 401 invalid_client,
 * 403, or any error shape this SDK doesn't recognize) is treated as a
 * definitive rejection: fail closed to 'terminal' rather than retry-loop on
 * something that will never succeed.
 */
export function classifyRefreshFailure(error: unknown): RefreshFailureClassification {
  if (
    isNetworkError(error) ||
    isTimeoutError(error) ||
    isRateLimitError(error) ||
    isServerError(error)
  ) {
    return 'retryable';
  }
  return 'terminal';
}
