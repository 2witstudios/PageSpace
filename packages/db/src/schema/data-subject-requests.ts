import { pgTable, text, timestamp, integer, boolean, jsonb, index, pgEnum } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';

/**
 * Data Subject Requests (GDPR Art 12(3), Art 17).
 *
 * Evidences that a rights request (erasure, export, …) was received and
 * resolved within the statutory 30-day SLA. The row deliberately OUTLIVES the
 * data subject: `userId` is `onDelete: 'set null'` so the FK drops cleanly when
 * the user is erased, while `subjectEmail` is denormalized and retained as the
 * audit record of which request was honoured.
 */

export type DataSubjectRequestType =
  | 'erasure'
  | 'export'
  | 'access'
  | 'rectification'
  | 'restriction'
  | 'portability'
  | 'objection';

export type DataSubjectRequestStatus =
  | 'pending'
  | 'queued'
  | 'in_progress'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type DataSubjectRequesterType = 'self' | 'admin';

/** Per-step outcome recorded by the erasure runner for evidence + retry. */
export type DataSubjectRequestStepResult = {
  step: string;
  status: 'ok' | 'skipped' | 'failed';
  detail?: string;
  at: string;
};

export const dataSubjectRequestType = pgEnum('data_subject_request_type', [
  'erasure',
  'export',
  'access',
  'rectification',
  'restriction',
  'portability',
  'objection',
]);

export const dataSubjectRequestStatus = pgEnum('data_subject_request_status', [
  'pending',
  'queued',
  'in_progress',
  'blocked',
  'completed',
  'failed',
  'cancelled',
]);

export const dataSubjectRequesterType = pgEnum('data_subject_requester_type', ['self', 'admin']);

export const dataSubjectRequests = pgTable(
  'data_subject_requests',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),

    // Subject — FK drops on erasure, email retained as denormalized evidence.
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    subjectEmail: text('subject_email').notNull(),

    requestType: dataSubjectRequestType('request_type').notNull().default('erasure'),
    status: dataSubjectRequestStatus('status').notNull().default('pending'),

    // #908 — admin escalation/force-delete of multi-member drives.
    forceDelete: boolean('force_delete').notNull().default(false),

    // Who lodged the request (admin or the data subject themselves).
    requestedByUserId: text('requested_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    requestedByType: dataSubjectRequesterType('requested_by_type').notNull().default('self'),
    legalBasis: text('legal_basis'),

    // SLA clock — Art 12(3) starts at receipt; deadline is receipt + 30 days.
    receivedAt: timestamp('received_at', { mode: 'date' }).defaultNow().notNull(),
    slaDeadline: timestamp('sla_deadline', { mode: 'date' }).notNull(),
    startedAt: timestamp('started_at', { mode: 'date' }),
    completedAt: timestamp('completed_at', { mode: 'date' }),

    blockedReason: text('blocked_reason'),

    // Durable-queue linkage + retry bookkeeping.
    jobId: text('job_id'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    stepResults: jsonb('step_results').$type<DataSubjectRequestStepResult[]>(),

    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    statusIdx: index('data_subject_requests_status_idx').on(table.status),
    slaDeadlineIdx: index('data_subject_requests_sla_deadline_idx').on(table.slaDeadline),
    userIdx: index('data_subject_requests_user_id_idx').on(table.userId),
  })
);

export const dataSubjectRequestsRelations = relations(dataSubjectRequests, ({ one }) => ({
  user: one(users, {
    fields: [dataSubjectRequests.userId],
    references: [users.id],
  }),
}));

export type DataSubjectRequest = typeof dataSubjectRequests.$inferSelect;
export type NewDataSubjectRequest = typeof dataSubjectRequests.$inferInsert;
