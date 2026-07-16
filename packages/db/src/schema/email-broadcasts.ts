import { pgTable, text, timestamp, integer, boolean, jsonb, index, uniqueIndex, pgEnum } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { notificationType } from './notifications';

/**
 * Admin-console email broadcasts.
 *
 * Replaces the laptop-and-a-JSONL-file broadcast (scripts/send-sdk-launch-notifications.ts)
 * with a durable job: the admin authors a row, a processor worker sends against it, and
 * both progress and per-recipient outcomes survive a restart. Models
 * `data-subject-requests.ts` — the same durable-job shape (status enum, jobId, attempts,
 * lastError, stepResults) the erasure pipeline already proves in production.
 *
 * `broadcast_recipients` is the idempotency backbone: UNIQUE(broadcastId, userId) is what
 * makes "did we already mail this person?" a database fact rather than a file on someone's
 * machine, so a retry after a crash resumes instead of double-sending.
 */

export type EmailBroadcastEngine = 'transactional' | 'resend_broadcast';

export type EmailBroadcastContentMode = 'compose' | 'template';

export type EmailBroadcastStatus =
  | 'draft'
  | 'pending'
  | 'queued'
  | 'in_progress'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type BroadcastRecipientStatus = 'pending' | 'sent' | 'skipped' | 'failed';

/** Per-batch/step outcome recorded by the worker, for live progress + evidence. */
export type BroadcastStepResult = {
  step: string;
  status: 'ok' | 'skipped' | 'failed';
  detail?: string;
  at: string;
};

/**
 * The OPERATOR-EDITABLE part of the targeting.
 *
 * Standard exclusions (opted-out, GDPR rights-restricted, suppressed, unverified,
 * suspended) are deliberately NOT representable here: they are applied in code by
 * `audience.ts` on every resolve, so no stored definition — and no admin with a JSON
 * editor — can turn them off.
 */
export type BroadcastAudienceDefinition = {
  /**
   * Mail addresses that were never confirmed. Defaults to false: an unverified address
   * was never proven to belong to the account holder, so a blast to it may be mail to a
   * stranger (or to a spam trap that damages the sending domain).
   */
  includeUnverified?: boolean;
  /** `users.subscriptionTier` values to include. Absent/empty = every tier. */
  planTiers?: string[];
  /** ISO-8601 instants bounding `users.createdAt` (inclusive). */
  signupAfter?: string;
  signupBefore?: string;
  /** Hand-picked recipients. When present, the audience is exactly these users (still
   *  subject to every standard exclusion and the other filters). */
  userIds?: string[];
};

export const emailBroadcastEngine = pgEnum('email_broadcast_engine', [
  'transactional',
  'resend_broadcast',
]);

export const emailBroadcastContentMode = pgEnum('email_broadcast_content_mode', [
  'compose',
  'template',
]);

export const emailBroadcastStatus = pgEnum('email_broadcast_status', [
  'draft',
  'pending',
  'queued',
  'in_progress',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);

export const broadcastRecipientStatus = pgEnum('broadcast_recipient_status', [
  'pending',
  'sent',
  'skipped',
  'failed',
]);

/** Reusable saved content for a broadcast. */
export const broadcastTemplates = pgTable(
  'broadcast_templates',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    name: text('name').notNull(),
    subject: text('subject').notNull(),
    bodyMarkdown: text('body_markdown').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    activeIdx: index('broadcast_templates_active_idx').on(table.isActive),
  })
);

export const emailBroadcasts = pgTable(
  'email_broadcasts',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),

    subject: text('subject').notNull(),
    engine: emailBroadcastEngine('engine').notNull().default('transactional'),
    contentMode: emailBroadcastContentMode('content_mode').notNull().default('compose'),
    /** Set when contentMode is 'template'. `set null` so deleting a template cannot
     *  delete the evidence of a send that already happened. */
    templateId: text('template_id').references(() => broadcastTemplates.id, { onDelete: 'set null' }),
    /** Set when contentMode is 'compose'. */
    bodyMarkdown: text('body_markdown'),

    /** The opt-out channel this broadcast belongs to — recipients unsubscribe from THIS. */
    notificationType: notificationType('notification_type').notNull().default('PRODUCT_UPDATE'),

    audienceDefinition: jsonb('audience_definition').$type<BroadcastAudienceDefinition>().notNull().default({}),

    status: emailBroadcastStatus('status').notNull().default('draft'),

    /** Dry-run is the DEFAULT. The blast radius is "every user we have", so the safe
     *  mode is the one you get by accident. */
    dryRun: boolean('dry_run').notNull().default(true),
    /** Canary cap. Counts ATTEMPTS, not successes — a provider outage must not let a
     *  5-person canary quietly walk the whole audience. */
    sendLimit: integer('send_limit'),
    delayMs: integer('delay_ms').notNull().default(120),

    totalTargeted: integer('total_targeted').notNull().default(0),
    sentCount: integer('sent_count').notNull().default(0),
    skippedCount: integer('skipped_count').notNull().default(0),
    failedCount: integer('failed_count').notNull().default(0),

    stepResults: jsonb('step_results').$type<BroadcastStepResult[]>(),

    // Durable-queue linkage + retry bookkeeping (mirrors data_subject_requests).
    jobId: text('job_id'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    blockedReason: text('blocked_reason'),

    createdByUserId: text('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),

    startedAt: timestamp('started_at', { mode: 'date' }),
    completedAt: timestamp('completed_at', { mode: 'date' }),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    statusIdx: index('email_broadcasts_status_idx').on(table.status),
    createdAtIdx: index('email_broadcasts_created_at_idx').on(table.createdAt),
    createdByIdx: index('email_broadcasts_created_by_idx').on(table.createdByUserId),
  })
);

/**
 * The DB replacement for the JSONL ledger: one row per person per broadcast.
 *
 * `userId` CASCADES, matching `email_notification_log` (the sibling send record) rather
 * than `data_subject_requests`. The distinction matters: a DSR row outlives its subject
 * because the row IS the evidence that a rights request was honoured, and `subjectEmail`
 * is retained deliberately for that. Marketing send history makes no such claim — and
 * `recipientEmail` here is PLAINTEXT (the address we mailed), so keeping it past an
 * erasure would leave a readable copy of the address behind forever, unreachable by any
 * erasure step, defeating the field encryption `audience.ts` preserves everywhere else.
 * Erasing the user erases the record that we mailed them, which is the point.
 *
 * `userId` is also `notNull` for a second reason: Postgres treats NULLs as distinct, so a
 * nullable column would silently punch a hole in the UNIQUE(broadcastId, userId) that the
 * whole idempotency story rests on.
 */
export const broadcastRecipients = pgTable(
  'broadcast_recipients',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    broadcastId: text('broadcast_id')
      .notNull()
      .references(() => emailBroadcasts.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    recipientEmail: text('recipient_email').notNull(),

    status: broadcastRecipientStatus('status').notNull().default('pending'),
    skipReason: text('skip_reason'),
    errorMessage: text('error_message'),
    attempts: integer('attempts').notNull().default(0),
    sentAt: timestamp('sent_at', { mode: 'date' }),

    /**
     * When a worker last took this recipient to mail them — the claim LEASE.
     *
     * The unique constraint alone cannot stop a double-send: it only coalesces the
     * ledger AFTER both workers have already handed mail to the provider. So a worker
     * claims a recipient (an atomic upsert that only succeeds if nobody else holds a
     * fresh lease) BEFORE calling the provider, and the losing worker skips.
     *
     * A lease rather than a permanent flag because a worker that crashes mid-send would
     * otherwise strand its claimed recipients as `pending` forever, and nobody would
     * ever mail them. Once the lease expires a retry may reclaim the row.
     */
    claimedAt: timestamp('claimed_at', { mode: 'date' }),

    /**
     * WHICH claim currently holds this row — a fresh opaque id per successful claim.
     *
     * `claimed_at` says a lease exists; this says whose it is. A later write needs the
     * difference: a worker whose send outlived its lease (there is no timeout on the
     * provider call) must not be able to report a failure that revokes the claim of the
     * worker which legitimately took over, and hand the recipient to a third.
     *
     * Deliberately not `claimed_at` itself. That comparison cannot be made to work:
     * Postgres stores microseconds, a JS Date holds milliseconds, so a stamp read back
     * through the driver never equals the stored value and the fence silently matches
     * nothing — which fails OPEN, in the one place that must fail closed.
     */
    claimedBy: text('claimed_by'),

    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
  },
  (table) => ({
    // The idempotency backbone: the ON CONFLICT target that makes a re-send impossible
    // rather than merely unlikely.
    broadcastUserUnique: uniqueIndex('broadcast_recipients_broadcast_user_unique').on(
      table.broadcastId,
      table.userId
    ),
    // Progress counts + the resume set are both `WHERE broadcastId = ? AND status = ?`.
    broadcastStatusIdx: index('broadcast_recipients_broadcast_status_idx').on(
      table.broadcastId,
      table.status
    ),
  })
);

export const emailBroadcastsRelations = relations(emailBroadcasts, ({ one, many }) => ({
  createdBy: one(users, {
    fields: [emailBroadcasts.createdByUserId],
    references: [users.id],
  }),
  template: one(broadcastTemplates, {
    fields: [emailBroadcasts.templateId],
    references: [broadcastTemplates.id],
  }),
  recipients: many(broadcastRecipients),
}));

export const broadcastRecipientsRelations = relations(broadcastRecipients, ({ one }) => ({
  broadcast: one(emailBroadcasts, {
    fields: [broadcastRecipients.broadcastId],
    references: [emailBroadcasts.id],
  }),
  user: one(users, {
    fields: [broadcastRecipients.userId],
    references: [users.id],
  }),
}));

export const broadcastTemplatesRelations = relations(broadcastTemplates, ({ one, many }) => ({
  createdBy: one(users, {
    fields: [broadcastTemplates.createdByUserId],
    references: [users.id],
  }),
  broadcasts: many(emailBroadcasts),
}));

export type EmailBroadcast = typeof emailBroadcasts.$inferSelect;
export type NewEmailBroadcast = typeof emailBroadcasts.$inferInsert;
export type BroadcastRecipient = typeof broadcastRecipients.$inferSelect;
export type NewBroadcastRecipient = typeof broadcastRecipients.$inferInsert;
export type BroadcastTemplate = typeof broadcastTemplates.$inferSelect;
export type NewBroadcastTemplate = typeof broadcastTemplates.$inferInsert;
