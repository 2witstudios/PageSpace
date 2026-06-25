/**
 * Data Subject Request repository — clean seam for DSR persistence.
 *
 * Thin mapping layer only: SLA math lives in `compliance/dsr/sla`, transition
 * rules in `compliance/dsr/status-machine`. Tests mock this repository, not the
 * ORM chains.
 */

import { db } from '@pagespace/db/db';
import { eq, inArray, desc, sql } from '@pagespace/db/operators';
import {
  dataSubjectRequests,
  type DataSubjectRequest,
  type DataSubjectRequestStatus,
  type DataSubjectRequestStepResult,
  type DataSubjectRequestType,
  type DataSubjectRequesterType,
} from '@pagespace/db/schema/data-subject-requests';
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
    const [row] = await db
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
  },

  findById: async (id: string): Promise<DataSubjectRequest | null> => {
    const row = await db.query.dataSubjectRequests.findFirst({
      where: eq(dataSubjectRequests.id, id),
    });
    return row ?? null;
  },

  /** An in-flight (non-terminal) erasure request for a user, if any. */
  findActiveErasureForUser: async (userId: string): Promise<DataSubjectRequest | null> => {
    const row = await db.query.dataSubjectRequests.findFirst({
      where: (t, { and, eq: eqOp, inArray: inArrayOp }) =>
        and(
          eqOp(t.userId, userId),
          eqOp(t.requestType, 'erasure'),
          inArrayOp(t.status, ['pending', 'queued', 'in_progress', 'blocked'])
        ),
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
