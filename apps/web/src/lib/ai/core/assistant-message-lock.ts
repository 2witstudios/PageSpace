import { getAdvisoryLockPool } from '@pagespace/db/db';
import { withAdvisoryLock, type AdvisoryLockPool } from '@pagespace/db/advisory-lock';

/**
 * Serializes every writer of ONE assistant row's tool parts — approval apply /
 * dismiss / outcome record and ask_user apply / dismiss.
 *
 * Each writer is an unlocked fetch → patch → persist of the WHOLE parts array
 * (the message repository's save has no per-part write). Unserialized, two
 * writers on the same row interleave and the later persist restores the
 * earlier one's snapshot: an executed approval's result disappears from model
 * context, or a part is left `approval-requested` while its decision row is
 * already claimed (every answer then 409s). Holding this lock across the
 * fetch, the decision claims and the persist makes each writer see the
 * previous one's result.
 *
 * Session-level try-lock on the dedicated advisory-lock pool (never the app
 * pool, so a waiter cannot starve the holder of a connection), retried with
 * backoff: the critical sections are a handful of round trips, so contention
 * clears quickly. Past `maxWaitMs` the writer is refused with
 * {@link AssistantMessageBusyError} rather than run unserialized.
 */
export class AssistantMessageBusyError extends Error {
  constructor(messageId: string) {
    super(`Assistant message ${messageId} is busy — another write to its tool parts did not finish in time.`);
    this.name = 'AssistantMessageBusyError';
  }
}

export interface AssistantMessageLockDeps {
  pool?: AdvisoryLockPool;
  maxWaitMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_WAIT_MS = 15_000;
const MAX_BACKOFF_MS = 250;

export async function withAssistantMessageLock<T>(
  messageId: string,
  fn: () => Promise<T>,
  deps: AssistantMessageLockDeps = {},
): Promise<T> {
  const pool = deps.pool ?? getAdvisoryLockPool();
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (deps.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
  const lockKey = `assistant-message-parts:${messageId}`;

  for (let attempt = 0; ; attempt += 1) {
    const locked = await withAdvisoryLock(pool, lockKey, fn);
    if (locked.outcome === 'acquired') return locked.result;
    if (locked.outcome === 'connection_error') throw locked.error;
    if (now() >= deadline) throw new AssistantMessageBusyError(messageId);
    await sleep(Math.min(10 * 2 ** attempt, MAX_BACKOFF_MS));
  }
}
