/**
 * Pure rules for delivering staged org audit events (Spec AUD-1). IO lives in org-audit.ts.
 */

/** The first retry waits this long; each later failure doubles it. */
export const ORG_AUDIT_RETRY_BASE_MS = 30_000;
/** No retry waits longer than this: a recovered audit chain catches up within the hour. */
export const ORG_AUDIT_RETRY_MAX_MS = 60 * 60_000;
/**
 * How long an event staged for a change that is not final yet (an invitation whose email has not gone out) is held
 * back from the drainer. The caller publishes it as soon as the change is final, or discards it with the change.
 */
export const ORG_AUDIT_PENDING_HOLD_MS = 15 * 60_000;
/** Rows one drainer pass delivers, so a long backlog never holds one request open. */
export const ORG_AUDIT_DRAIN_BATCH = 200;

/**
 * After this many refused appends (about a day at the capped backoff) an event is dead-lettered: kept in the outbox,
 * counted where admins see it and alerted, but no longer retried by the drainer.
 */
export const ORG_AUDIT_DEAD_LETTER_ATTEMPTS = 24;

export const isOrgAuditDeadLetter = (attempts: number): boolean => attempts >= ORG_AUDIT_DEAD_LETTER_ATTEMPTS;

/**
 * When a staged event whose append has now failed `attempts` times (1 after the first failure) is next tried.
 * Exponential and capped; an event leaves the outbox only by a successful append (or, refused too often, it is
 * dead-lettered and kept).
 */
export function nextOrgAuditAttemptAt(attempts: number, now: Date): Date {
  const exponent = Math.max(0, Math.floor(attempts) - 1);
  const delay = Math.min(ORG_AUDIT_RETRY_MAX_MS, ORG_AUDIT_RETRY_BASE_MS * 2 ** Math.min(exponent, 20));
  return new Date(now.getTime() + delay);
}

/**
 * The details an outbox row is appended to the chain with: the caller's details, then the dimensions no detail may
 * overwrite — the org, the drive, when the change happened (`occurredAt`, captured in the change's transaction; the
 * chain's own timestamp is the delivery time) and the outbox id (delivery is at least once, so a reader deduplicates
 * on it).
 */
export function orgAuditChainDetails(row: {
  id: string;
  orgId: string;
  driveId: string | null;
  createdAt: Date;
  details: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    ...row.details,
    orgId: row.orgId,
    ...(row.driveId ? { driveId: row.driveId } : {}),
    occurredAt: row.createdAt.toISOString(),
    outboxId: row.id,
  };
}
