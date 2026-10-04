/**
 * The lock a terminal's billing-window claims run under (review #2760 re-review P2-1).
 *
 * Two typists on different connections can claim the same session's window within one gate
 * round-trip of each other. Unserialized, both claims read the same window, both settle it and
 * both place a hold — one hold is then referenced by nothing (leaked until its TTL, reserving
 * that person's seat room), the window is settled twice, and a loser can report success while
 * its input is billed to the winner. Every claim therefore runs read-window → settle → hold →
 * write-window under ONE lock per session, so the second claim sees the first's window and
 * either becomes the next segment or is refused.
 *
 * Production takes a Postgres advisory lock keyed on the session key (cross-process: a second
 * realtime instance serializes too). Without one injected (unit tests, a deployment with no
 * database), an in-process per-session chain gives the same ordering inside this process.
 */
import { getAdvisoryLockPool } from '@pagespace/db/db';
import { withBlockingAdvisoryLock } from '@pagespace/db/advisory-lock';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { errorLogFields } from '@pagespace/lib/logging/error-cause';

export type WindowClaimLockResult<T> = { acquired: true; result: T } | { acquired: false };
export type WindowClaimLock = <T>(sessionKey: string, fn: () => Promise<T>) => Promise<WindowClaimLockResult<T>>;

/** A claim is a gate read plus a settle: seconds at worst. Past this the claim is refused, not queued forever. */
export const WINDOW_CLAIM_LOCK_TIMEOUT_MS = 10_000;

export const windowClaimLockKey = (sessionKey: string): string => `terminal-window-claim:${sessionKey}`;

/** The cross-process lock: a Postgres session advisory lock, waited for up to the timeout. */
export const pgWindowClaimLock: WindowClaimLock = async (sessionKey, fn) => {
  const locked = await withBlockingAdvisoryLock(getAdvisoryLockPool(), windowClaimLockKey(sessionKey), fn, {
    timeoutMs: WINDOW_CLAIM_LOCK_TIMEOUT_MS,
  });
  if (locked.outcome === 'acquired') return { acquired: true, result: locked.result };
  if (locked.outcome === 'connection_error') {
    loggers.realtime.warn('Terminal window-claim lock could not be taken — the claim is refused, not run unlocked', {
      sessionKey,
      ...errorLogFields(locked.error),
    });
  }
  return { acquired: false };
};

const chains = new Map<string, Promise<unknown>>();

/** In-process only: claims on one session run one after another, in arrival order. */
export const inProcessWindowClaimLock: WindowClaimLock = async (sessionKey, fn) => {
  const prior = chains.get(sessionKey) ?? Promise.resolve();
  const run = prior.catch(() => undefined).then(fn);
  chains.set(sessionKey, run);
  try {
    return { acquired: true, result: await run };
  } finally {
    if (chains.get(sessionKey) === run) chains.delete(sessionKey);
  }
};
