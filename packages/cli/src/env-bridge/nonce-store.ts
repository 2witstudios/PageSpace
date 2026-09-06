/**
 * Replay protection on the daemon, plus the restart boundary (Codex C6).
 *
 * `verifyGrant` checks `has(nonce)` and then `add`s it in the same synchronous
 * call, with no `await` between them, and this daemon is ONE single-threaded
 * process — so `has` + `add` is atomic by construction. There is nothing to
 * lock. The dispatcher calls `evictExpired(now)` synchronously right before
 * each verification (still no `await` between it and `has`/`add`), so over a
 * long-running daemon the set never holds more than the grants issued inside
 * one TTL (≤ 60 s) — no timer, no unbounded growth.
 *
 * What an in-memory store cannot survive is a restart: a grant spent seconds
 * before `pagespace env connect` was restarted is unknown to the new process
 * and would verify again inside its TTL. `grantPredatesDaemon` closes that
 * window: a grant whose `iat` is earlier than the daemon's start minus the
 * clock-skew allowance is refused regardless of its nonce. A grant issued
 * while this process was alive was either seen by it (replay ⇒ `replayed`)
 * or was never delivered, and a grant issued before it existed cannot be told
 * apart from a replay — so it is denied. The skew allowance is the same
 * constant the gate uses for the future direction.
 */
import { GRANT_MAX_CLOCK_SKEW_MS, type NonceStore } from '@pagespace/lib/env-bridge/grant';

export interface DaemonNonceStore extends NonceStore {
  /** Forget nonces whose grants could no longer verify anyway. Called by the dispatcher before every verification. */
  evictExpired(now: number): void;
  /** Live entries — for tests and for a status line, never for a decision. */
  size(): number;
}

/** Wire reason (and audit verdict) for a grant refused at the restart boundary. */
export const PREDATES_DAEMON_REASON = 'predates_daemon';

/** Same semantics as the lib's reference store (`createMemoryNonceStore`), with a size for the bound to be observable. */
export function createDaemonNonceStore(): DaemonNonceStore {
  const seen = new Map<string, number>();
  return {
    has: (nonce) => seen.has(nonce),
    add: (nonce, exp) => {
      seen.set(nonce, exp);
    },
    evictExpired: (now) => {
      for (const [nonce, exp] of seen) {
        if (exp < now) seen.delete(nonce);
      }
    },
    size: () => seen.size,
  };
}

/** True when the grant was issued before this daemon process could have seen its nonce. */
export function grantPredatesDaemon(grantIat: number, daemonStartedAt: number): boolean {
  return grantIat < daemonStartedAt - GRANT_MAX_CLOCK_SKEW_MS;
}
