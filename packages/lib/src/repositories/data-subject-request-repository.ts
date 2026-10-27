/**
 * Data Subject Request repository — clean seam for DSR persistence.
 *
 * Thin mapping layer only: SLA math lives in `compliance/dsr/sla`, transition
 * rules in `compliance/dsr/status-machine`. Tests mock this repository, not the
 * ORM chains.
 */

import { db } from '@pagespace/db/db';
import { and, eq, inArray, desc, sql } from '@pagespace/db/operators';
import {
  dataSubjectRequests,
  type DataSubjectRequest,
  type DataSubjectRequestStatus,
  type DataSubjectRequestStepResult,
  type DataSubjectRequestType,
  type DataSubjectRequesterType,
} from '@pagespace/db/schema/data-subject-requests';
import { activeErasureForUser, lockOwnershipSubject } from '../organizations/owner-candidate';
import { accountRepository } from './account-repository';
import { computeSlaDeadline } from '../compliance/dsr/sla';

export interface CreateDsrInput {
  userId: string;
  subjectEmail: string;
  requestType?: DataSubjectRequestType;
  forceDelete?: boolean;
  requestedByUserId?: string | null;
  requestedByType?: DataSubjectRequesterType;
  legalBasis?: string | null;
  /** Receipt instant; the SLA clock starts here. Injected for determinism. */
  receivedAt: Date;
}

export interface UpdateStatusPatch {
  startedAt?: Date;
  completedAt?: Date;
  blockedReason?: string | null;
  jobId?: string;
  lastError?: string | null;
}

export const dataSubjectRequestRepository = {
  create: async (input: CreateDsrInput): Promise<DataSubjectRequest> => {
    return db.transaction(async (tx) => {
      if ((input.requestType ?? 'erasure') === 'erasure') {
        await lockOwnershipSubject(tx, input.userId);
        await accountRepository.assertMayLodgeErasure(input.userId, tx);
      }
      const [row] = await tx
        .insert(dataSubjectRequests)
        .values({
          userId: input.userId,
          subjectEmail: input.subjectEmail,
          requestType: input.requestType ?? 'erasure',
          forceDelete: input.forceDelete ?? false,
          requestedByUserId: input.requestedByUserId ?? input.userId,
          requestedByType: input.requestedByType ?? 'self',
          legalBasis: input.legalBasis ?? null,
          receivedAt: input.receivedAt,
          slaDeadline: computeSlaDeadline(input.receivedAt),
          status: 'pending',
        })
        .returning();
      return row;
    });
  },

  /** Install durable retirement exclusion under the owner writers' user-row lock before any purge. */
  claimErasure: async (requestId: string, userId: string): Promise<boolean> => db.transaction(async (tx) => {
    await lockOwnershipSubject(tx, userId);
    const [request] = await tx.select({ status: dataSubjectRequests.status }).from(dataSubjectRequests)
      .where(and(eq(dataSubjectRequests.id, requestId), eq(dataSubjectRequests.userId, userId), eq(dataSubjectRequests.requestType, 'erasure'))).for('update');
    if (!request || request.status === 'completed' || request.status === 'cancelled') return false;
    await tx.update(dataSubjectRequests).set({ status: 'in_progress', startedAt: new Date(), updatedAt: new Date() }).where(eq(dataSubjectRequests.id, requestId));
    return true;
  }),

  findById: async (id: string): Promise<DataSubjectRequest | null> => {
    const row = await db.query.dataSubjectRequests.findFirst({
      where: eq(dataSubjectRequests.id, id),
    });
    return row ?? null;
  },

  /** An active erasure, including a started worker waiting for retry, if any. */
  findActiveErasureForUser: async (userId: string): Promise<DataSubjectRequest | null> => {
    const row = await db.query.dataSubjectRequests.findFirst({
      where: activeErasureForUser(userId),
    });
    return row ?? null;
  },

  updateStatus: async (
    id: string,
    status: DataSubjectRequestStatus,
    patch: UpdateStatusPatch = {}
  ): Promise<void> => {
    await db
      .update(dataSubjectRequests)
      .set({ status, updatedAt: new Date(), ...patch })
      .where(eq(dataSubjectRequests.id, id));
  },

  /**
   * Transition a freshly-lodged (or admin-reopened) request to `queued` and
   * record the jobId — but ONLY if it is still `pending`/`blocked`. This guards
   * against a race where the durable worker has already advanced the row to
   * `in_progress`/`completed` by the time the enqueuer writes back; without the
   * guard we would regress a terminal state to `queued`. Returns the number of
   * rows updated (0 means the worker already moved on).
   */
  markQueued: async (id: string, jobId: string): Promise<number> => {
    const rows = await db
      .update(dataSubjectRequests)
      .set({ status: 'queued', jobId, blockedReason: null, updatedAt: new Date() })
      .where(
        and(
          eq(dataSubjectRequests.id, id),
          inArray(dataSubjectRequests.status, ['pending', 'blocked'])
        )
      )
      .returning({ id: dataSubjectRequests.id });
    return rows.length;
  },

  /** Failed enqueue before starting is inactive; a started worker failure remains protected for retry. */
  markFailed: async (id: string, error: string): Promise<void> => {
    await db
      .update(dataSubjectRequests)
      .set({ status: 'failed', lastError: error, updatedAt: new Date() })
      .where(eq(dataSubjectRequests.id, id));
  },

  /** Admin escalation: grant force-delete and clear the block on a request. */
  setForceDelete: async (id: string): Promise<void> => {
    await db
      .update(dataSubjectRequests)
      .set({ forceDelete: true, blockedReason: null, updatedAt: new Date() })
      .where(eq(dataSubjectRequests.id, id));
  },

  /** Append a step result to the evidence trail (immutable accumulation). */
  appendStepResult: async (
    id: string,
    result: DataSubjectRequestStepResult
  ): Promise<void> => {
    await db
      .update(dataSubjectRequests)
      .set({
        stepResults: sql`coalesce(${dataSubjectRequests.stepResults}, '[]'::jsonb) || ${JSON.stringify([result])}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(dataSubjectRequests.id, id));
  },

  incrementAttempts: async (id: string): Promise<void> => {
    await db
      .update(dataSubjectRequests)
      .set({ attempts: sql`${dataSubjectRequests.attempts} + 1`, updatedAt: new Date() })
      .where(eq(dataSubjectRequests.id, id));
  },

  listByStatus: async (statuses: DataSubjectRequestStatus[]): Promise<DataSubjectRequest[]> => {
    return db
      .select()
      .from(dataSubjectRequests)
      .where(inArray(dataSubjectRequests.status, statuses))
      .orderBy(desc(dataSubjectRequests.slaDeadline));
  },

  /** Most-recent-first listing for the admin SLA dashboard. */
  listRecent: async (limit = 200): Promise<DataSubjectRequest[]> => {
    return db
      .select()
      .from(dataSubjectRequests)
      .orderBy(desc(dataSubjectRequests.receivedAt))
      .limit(limit);
  },
};

export type DataSubjectRequestRepository = typeof dataSubjectRequestRepository;
