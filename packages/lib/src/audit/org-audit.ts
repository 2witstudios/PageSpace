/**
 * Org audit events (Spec AUD-1, AUD-2): written through the existing security audit chain. There is no new
 * audit table; an org event is an ordinary chain row whose `details.orgId` is the org dimension.
 *
 * Durable by construction. The chain may live in another database (the Admin PG), so a change cannot append to it
 * inside its own transaction. Instead the change STAGES its event in `org_audit_outbox` inside that transaction
 * (stageOrgAuditEvent): the event exists exactly when the change committed. After commit the caller PUBLISHES what it
 * staged (publishOrgAuditEvents), which appends each event to the chain and deletes its row. Anything a publish could
 * not deliver (the chain refused, the process died) stays queued, and drainOrgAuditOutbox (the cron route) retries it
 * with a capped backoff until it lands. No path drops an event; no path appends one directly.
 *
 * Details carry ids and counts, never content or names.
 */
import type { SecurityEventType } from '@pagespace/db/schema/security-audit';
import { db } from '@pagespace/db/db';
import { and, asc, eq, inArray, isNull, lte, sql } from '@pagespace/db/operators';
import { orgAuditOutbox } from '@pagespace/db/schema/organizations';
import { users } from '@pagespace/db/schema/auth';
import { loggers } from '../logging/logger-config';
import { securityAudit } from './security-audit';
import { isOrgAuditDeadLetter, nextOrgAuditAttemptAt, orgAuditChainDetails, ORG_AUDIT_DRAIN_BATCH, ORG_AUDIT_PENDING_HOLD_MS } from './org-audit-outbox-core';
import { notifyOrgAuditDeadLetter } from './security-audit-alerting';

/**
 * Every org event, plus `authz.access.granted`: the ORG-4 record of org Owner/Admin power opening a drive, which the
 * permissions layer writes under the org dimension (catalogued as private_drive_access).
 */
export type OrgAuditEventType = Extract<SecurityEventType, `org.${string}`> | 'authz.access.granted';

export interface OrgAuditEvent {
  orgId: string;
  eventType: OrgAuditEventType;
  /** The person who acted; omitted for system actions. */
  actorId?: string;
  resourceType: string;
  resourceId: string;
  /** Set when the event concerns one drive, so the log filters by drive. */
  driveId?: string;
  details?: Record<string, unknown>;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** The change's own transaction; `db` only for an event that is the whole change (nothing else is written). */
export type OrgAuditExecutor = typeof db | Tx;

/** A staged event's handle: what the caller publishes after its transaction commits. */
export interface StagedOrgAuditEvent {
  id: string;
}

/**
 * Stage org events inside the change's transaction. If the transaction rolls back, so do they; if it commits, they
 * are delivered (now by publishOrgAuditEvents, or later by the drainer).
 */
export async function stageOrgAuditEvents(
  executor: OrgAuditExecutor,
  events: readonly OrgAuditEvent[],
  options: StageOptions = {},
): Promise<StagedOrgAuditEvent[]> {
  if (events.length === 0) return [];
  const hold = options.hold
    ? { nextAttemptAt: new Date(Date.now() + ORG_AUDIT_PENDING_HOLD_MS), discardIfUnreleased: options.hold === 'discard_if_unreleased' }
    : {};
  return executor
    .insert(orgAuditOutbox)
    .values(
      events.map((e) => ({
        orgId: e.orgId,
        eventType: e.eventType,
        actorId: e.actorId ?? null,
        resourceType: e.resourceType,
        resourceId: e.resourceId,
        driveId: e.driveId ?? null,
        details: e.details ?? {},
        ...hold,
      })),
    )
    .returning({ id: orgAuditOutbox.id });
}

export async function stageOrgAuditEvent(executor: OrgAuditExecutor, event: OrgAuditEvent, options: StageOptions = {}): Promise<StagedOrgAuditEvent> {
  const [staged] = await stageOrgAuditEvents(executor, [event], options);
  return staged;
}

export interface StageOptions {
  /**
   * The change commits now but is final only after a later step. The drainer leaves the event alone for
   * ORG_AUDIT_PENDING_HOLD_MS; the caller publishes it once final, or discards it with an undo. If the caller never
   * does (the process stopped), the hold ends:
   *   - `deliver_if_unreleased`: the committed change stands unless undone (an invitation whose email may or may not
   *     have gone out still exists), so the event is delivered;
   *   - `discard_if_unreleased`: the change is real only once a later step commits (a guest approval whose admission
   *     may never have run), so the event is discarded, never delivered.
   */
  hold?: 'deliver_if_unreleased' | 'discard_if_unreleased';
}

/** Withdraw staged events whose change was undone (in the undo's own transaction). */
/**
 * The change a `discard_if_unreleased` hold waited for has COMMITTED (a guest approval's admission): from now on the
 * event is an ordinary one, delivered (and retried, and dead-lettered) like any other, never discarded. Release it as
 * soon as the change commits, before publishing, so a failed publish leaves it for the drainer to deliver.
 *
 * The one window left: a process that dies between the change's commit and this release loses that approval's event
 * (its hold ends unreleased and is discarded). The alternative, delivering unreleased holds, would record approvals
 * whose admission never ran; the discard is logged with the event's ids so the record survives in the security log.
 */
export async function releaseStagedOrgAuditEvents(executor: OrgAuditExecutor, staged: readonly StagedOrgAuditEvent[]): Promise<void> {
  if (staged.length === 0) return;
  await executor.update(orgAuditOutbox).set({ discardIfUnreleased: false }).where(inArray(orgAuditOutbox.id, staged.map((s) => s.id)));
}

export async function discardStagedOrgAuditEvents(executor: OrgAuditExecutor, staged: readonly StagedOrgAuditEvent[]): Promise<void> {
  if (staged.length === 0) return;
  await executor.delete(orgAuditOutbox).where(inArray(orgAuditOutbox.id, staged.map((s) => s.id)));
}

type OutboxRow = typeof orgAuditOutbox.$inferSelect;

/** The chain append: one row, with the org (and drive) dimensions written last so details can never overwrite them. */
async function appendToChain(row: OutboxRow): Promise<void> {
  const entry = {
    eventType: row.eventType,
    userId: row.actorId ?? undefined,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    details: orgAuditChainDetails(row),
  };
  loggers.security.info(`[Audit] ${entry.eventType}`, { ...entry });
  await securityAudit.logEvent(entry);
}

type Delivery = 'delivered' | 'retrying' | 'skipped' | 'discarded' | 'dead_lettered';

/**
 * Deliver one staged event: lock its row (SKIP LOCKED, so a publish and the drainer never deliver it twice at once),
 * append it to the chain, delete the row. A refused append keeps the row, counts the attempt and schedules the next.
 * At least once: a crash between the append and the delete re-appends the same event on the next drain.
 */
async function deliverOne(id: string, now: Date, releasedHold: 'drainer' | null): Promise<Delivery> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(orgAuditOutbox).where(eq(orgAuditOutbox.id, id)).for('update', { skipLocked: true }).limit(1);
    if (!row) return 'skipped';
    if (releasedHold === null && row.discardIfUnreleased) {
      // The caller released it (its change is final): from now on it is an ordinary event, retried until delivered.
      await tx.update(orgAuditOutbox).set({ discardIfUnreleased: false }).where(eq(orgAuditOutbox.id, id));
    } else if (releasedHold !== null && row.discardIfUnreleased) {
      // The hold ended without the caller releasing it: the change it described never became final.
      await tx.delete(orgAuditOutbox).where(eq(orgAuditOutbox.id, id));
      // Either the change never committed (the intended case), or the process died between its commit and the release
      // (the accepted trade-off, see releaseStagedOrgAuditEvents): the ids are logged so the record is not silent.
      loggers.security.warn('[Audit] a held org event was not released (its change did not commit, or the process stopped before releasing it) and is discarded', {
        outboxId: id, eventType: row.eventType, orgId: row.orgId, resourceType: row.resourceType, resourceId: row.resourceId,
        actorId: row.actorId, driveId: row.driveId, details: row.details, occurredAt: row.createdAt.toISOString(),
      });
      return 'discarded';
    }
    // An actor whose account was deleted while the event waited is written as no one: the chain's user reference is
    // SET NULL on erasure, so this is exactly what a delivered row would hold by now (and the append cannot fail on it).
    const actorGone = row.actorId !== null && (await tx.select({ id: users.id }).from(users).where(eq(users.id, row.actorId)).limit(1)).length === 0;
    try {
      await appendToChain(actorGone ? { ...row, actorId: null } : row);
    } catch (error) {
      const attempts = row.attempts + 1;
      const message = error instanceof Error ? error.message : String(error);
      const dead = isOrgAuditDeadLetter(attempts);
      await tx
        .update(orgAuditOutbox)
        .set({ attempts, lastError: message.slice(0, 500), nextAttemptAt: nextOrgAuditAttemptAt(attempts, now), ...(dead ? { deadLetteredAt: now } : {}) })
        .where(eq(orgAuditOutbox.id, id));
      if (dead) {
        loggers.security.error('[Audit] org event dead-lettered: the audit chain refused it on every attempt; it is kept, not delivered', {
          outboxId: id, eventType: row.eventType, orgId: row.orgId, attempts, error: message,
        });
        await notifyOrgAuditDeadLetter({ outboxId: id, eventType: row.eventType, orgId: row.orgId, attempts, lastError: message });
        return 'dead_lettered';
      }
      loggers.security.warn('[Audit] org event append failed; it stays queued and will be retried', {
        outboxId: id,
        eventType: row.eventType,
        orgId: row.orgId,
        attempts,
        error: message,
      });
      return 'retrying';
    }
    await tx.delete(orgAuditOutbox).where(eq(orgAuditOutbox.id, id));
    return 'delivered';
  });
}

/**
 * After the change committed: deliver what it staged, in order. Never throws (the change has happened); an event it
 * cannot deliver stays queued for the drainer, so nothing is lost either way.
 */
export async function publishOrgAuditEvents(staged: readonly StagedOrgAuditEvent[] | StagedOrgAuditEvent | null | undefined): Promise<void> {
  const list = staged == null ? [] : Array.isArray(staged) ? staged : [staged as StagedOrgAuditEvent];
  const now = new Date();
  for (const { id } of list) {
    try {
      await deliverOne(id, now, null);
    } catch (error) {
      loggers.security.warn('[Audit] org event publish failed; it stays in the outbox for the drainer (a still-held event is delivered only once released)', {
        outboxId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * An org event that is the whole change (nothing else is written): stage it on its own and publish it.
 * A change that writes anything stages in its own transaction instead.
 */
export async function recordOrgAuditEvent(event: OrgAuditEvent): Promise<void> {
  await publishOrgAuditEvents(await stageOrgAuditEvent(db, event));
}

/** Stages events in the running transaction (see transactionWithOrgAudit). */
export type StageOrgAudit = (...events: OrgAuditEvent[]) => Promise<void>;

/**
 * A change in its own transaction, with its audit: whatever `run` stages through `audit` commits with the change and
 * is published once it has committed. A retried transaction starts its staging afresh.
 */
export async function transactionWithOrgAudit<T>(run: (tx: Tx, audit: StageOrgAudit) => Promise<T>): Promise<T> {
  const staged: StagedOrgAuditEvent[] = [];
  const result = await db.transaction(async (tx) => {
    staged.length = 0;
    return run(tx, async (...events) => {
      staged.push(...(await stageOrgAuditEvents(tx, events)));
    });
  });
  await publishOrgAuditEvents(staged);
  return result;
}

export interface OrgAuditDrainResult {
  delivered: number;
  retrying: number;
  /** Held events whose change never became final, dropped this pass. */
  discarded: number;
  /** Events this pass gave up retrying (kept, alerted). */
  deadLettered: number;
}

/**
 * The retrying drainer (cron): deliver every staged event that is due, oldest first, up to `limit` per pass.
 * Rows another drainer or a publish holds are skipped, never waited on.
 */
export async function drainOrgAuditOutbox(options: { now?: Date; limit?: number } = {}): Promise<OrgAuditDrainResult> {
  const now = options.now ?? new Date();
  const due = await db
    .select({ id: orgAuditOutbox.id })
    .from(orgAuditOutbox)
    .where(and(lte(orgAuditOutbox.nextAttemptAt, now), isNull(orgAuditOutbox.deadLetteredAt)))
    .orderBy(asc(orgAuditOutbox.seq))
    .limit(options.limit ?? ORG_AUDIT_DRAIN_BATCH);
  const result: OrgAuditDrainResult = { delivered: 0, retrying: 0, discarded: 0, deadLettered: 0 };
  const counter = { delivered: 'delivered', retrying: 'retrying', discarded: 'discarded', dead_lettered: 'deadLettered' } as const;
  for (const { id } of due) {
    const outcome = await deliverOne(id, now, 'drainer');
    if (outcome !== 'skipped') result[counter[outcome]] += 1;
  }
  return result;
}

export interface OrgAuditBacklog {
  /** Staged events not yet in the chain (held, due or backing off). */
  queued: number;
  /** Events the chain refused on every attempt: kept, no longer retried, need an operator. */
  deadLettered: number;
}

/** The outbox as an admin sees it (the admin monitoring page). */
export async function getOrgAuditBacklog(): Promise<OrgAuditBacklog> {
  const [row] = await db
    .select({
      queued: sql<number>`count(*) filter (where ${orgAuditOutbox.deadLetteredAt} is null)::int`,
      deadLettered: sql<number>`count(*) filter (where ${orgAuditOutbox.deadLetteredAt} is not null)::int`,
    })
    .from(orgAuditOutbox);
  return { queued: Number(row?.queued ?? 0), deadLettered: Number(row?.deadLettered ?? 0) };
}

