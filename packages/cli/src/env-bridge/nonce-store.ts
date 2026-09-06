/**
 * Replay protection on the daemon, plus the restart boundary (Codex C6).
 *
 * The nonce store is the pure core's reference in-memory store: `verifyGrant`
 * checks `has(nonce)` and then `add`s it in the same synchronous call, with no
 * `await` between them, and this daemon is ONE single-threaded process — so
 * `has` + `add` is atomic by construction. There is nothing to lock.
 *
 * What an in-memory store cannot survive is a restart: a grant spent seconds
 * before `pagespace env connect` was restarted is unknown to the new process
 * and would verify again inside its TTL (≤ 60 s). `grantPredatesDaemon`
 * closes that window: a grant whose `iat` is earlier than the daemon's start
 * minus the clock-skew allowance is refused regardless of its nonce. A grant
 * issued while this process was alive was either seen by it (replay ⇒
 * `replayed`) or was never delivered, and a grant issued before it existed
 * cannot be told apart from a replay — so it is denied. The skew allowance is
 * the same constant the gate uses for the future direction, so the two
 * clocks are judged by one rule.
 */
import { createMemoryNonceStore, GRANT_MAX_CLOCK_SKEW_MS, type NonceStore } from '@pagespace/lib/env-bridge/grant';

export interface DaemonNonceStore extends NonceStore {
  /** Forget nonces whose grants could no longer verify anyway; call periodically so the set stays bounded. */
  evictExpired(now: number): void;
}

/** Wire reason (and audit verdict) for a grant refused at the restart boundary. */
export const PREDATES_DAEMON_REASON = 'predates_daemon';

export function createDaemonNonceStore(): DaemonNonceStore {
  return createMemoryNonceStore();
}

/** True when the grant was issued before this daemon process could have seen its nonce. */
export function grantPredatesDaemon(grantIat: number, daemonStartedAt: number): boolean {
  return grantIat < daemonStartedAt - GRANT_MAX_CLOCK_SKEW_MS;
}
