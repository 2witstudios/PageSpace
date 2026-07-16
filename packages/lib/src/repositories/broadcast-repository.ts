/**
 * Email broadcast repository — clean seam for broadcast persistence.
 *
 * Thin mapping layer only, mirroring `data-subject-request-repository.ts`: the send
 * decisions live in `services/broadcast/core`, the ledger writes in
 * `services/broadcast/record-adapter`. Tests mock this repository, not the ORM chains.
 */

import { db } from '@pagespace/db/db';
import { and, desc, eq, inArray, sql } from '@pagespace/db/operators';
import {
  broadcastTemplates,
  emailBroadcasts,
  type BroadcastAudienceDefinition,
  type BroadcastStepResult,
  type BroadcastTemplate,
  type EmailBroadcast,
  type EmailBroadcastContentMode,
  type EmailBroadcastEngine,
  type EmailBroadcastStatus,
} from '@pagespace/db/schema/email-broadcasts';
import type { NotificationTypeValue } from '@pagespace/db/schema/notifications';
import {
  claimRecipient,
  countRecipientsByStatus,
  loadAlreadySentEmails,
  loadAlreadySentUserIds,
  recordFailure,
  recordSent,
  recordSkip,
} from '../services/broadcast/record-adapter';

export interface CreateBroadcastInput {
  subject: string;
  engine?: EmailBroadcastEngine;
  contentMode?: EmailBroadcastContentMode;
  templateId?: string | null;
  bodyMarkdown?: string | null;
  notificationType?: NotificationTypeValue;
  audienceDefinition: BroadcastAudienceDefinition;
  /** Defaults TRUE. A live send is something you ask for, never something you get. */
  dryRun?: boolean;
  sendLimit?: number | null;
  delayMs?: number;
  createdByUserId?: string | null;
}

export interface UpdateBroadcastStatusPatch {
  startedAt?: Date;
  completedAt?: Date;
  blockedReason?: string | null;
  jobId?: string;
  lastError?: string | null;
}

export interface BroadcastCounts {
  totalTargeted?: number;
  sentCount?: number;
  skippedCount?: number;
  failedCount?: number;
}

export const broadcastRepository = {
  create: async (input: CreateBroadcastInput): Promise<EmailBroadcast> => {
    const [row] = await db
      .insert(emailBroadcasts)
      .values({
        subject: input.subject,
        engine: input.engine ?? 'transactional',
        contentMode: input.contentMode ?? 'compose',
        templateId: input.templateId ?? null,
        bodyMarkdown: input.bodyMarkdown ?? null,
        notificationType: input.notificationType ?? 'PRODUCT_UPDATE',
        audienceDefinition: input.audienceDefinition,
        dryRun: input.dryRun ?? true,
        sendLimit: input.sendLimit ?? null,
        delayMs: input.delayMs ?? 120,
        createdByUserId: input.createdByUserId ?? null,
        status: 'pending',
      })
      .returning();
    return row;
  },

  findById: async (id: string): Promise<EmailBroadcast | null> => {
    const row = await db.query.emailBroadcasts.findFirst({
      where: eq(emailBroadcasts.id, id),
    });
    return row ?? null;
  },

  updateStatus: async (
    id: string,
    status: EmailBroadcastStatus,
    patch: UpdateBroadcastStatusPatch = {},
  ): Promise<void> => {
    await db
      .update(emailBroadcasts)
      .set({ status, updatedAt: new Date(), ...patch })
      .where(eq(emailBroadcasts.id, id));
  },

  /**
   * Transition a freshly-created broadcast to `queued` and record the jobId — but ONLY
   * if it is still `draft`/`pending`. This guards the race where the durable worker has
   * already advanced the row to `in_progress`/`completed` by the time the enqueuer writes
   * back; without the guard we would regress a terminal state to `queued` and the admin
   * UI would poll a finished send forever. Returns rows updated (0 = the worker moved on).
   */
  markQueued: async (id: string, jobId: string): Promise<number> => {
    const rows = await db
      .update(emailBroadcasts)
      .set({ status: 'queued', jobId, blockedReason: null, updatedAt: new Date() })
      .where(and(eq(emailBroadcasts.id, id), inArray(emailBroadcasts.status, ['draft', 'pending'])))
      .returning({ id: emailBroadcasts.id });
    return rows.length;
  },

  /** Mark a broadcast failed (e.g. enqueue threw) so it is no longer "active". */
  markFailed: async (id: string, error: string): Promise<void> => {
    await db
      .update(emailBroadcasts)
      .set({ status: 'failed', lastError: error, updatedAt: new Date() })
      .where(eq(emailBroadcasts.id, id));
  },

  incrementAttempts: async (id: string): Promise<void> => {
    await db
      .update(emailBroadcasts)
      .set({ attempts: sql`${emailBroadcasts.attempts} + 1`, updatedAt: new Date() })
      .where(eq(emailBroadcasts.id, id));
  },

  /** Append a step result to the progress trail (immutable accumulation). */
  appendStepResult: async (id: string, result: BroadcastStepResult): Promise<void> => {
    await db
      .update(emailBroadcasts)
      .set({
        stepResults: sql`coalesce(${emailBroadcasts.stepResults}, '[]'::jsonb) || ${JSON.stringify([result])}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(emailBroadcasts.id, id));
  },

  /**
   * Overwrite the progress counters. The worker recomputes these from the ledger rather
   * than incrementing, so a retry that re-walks part of the audience reports the truth
   * instead of double-counting what it already sent.
   */
  updateCounts: async (id: string, counts: BroadcastCounts): Promise<void> => {
    await db
      .update(emailBroadcasts)
      .set({ ...counts, updatedAt: new Date() })
      .where(eq(emailBroadcasts.id, id));
  },

  listByStatus: async (statuses: EmailBroadcastStatus[]): Promise<EmailBroadcast[]> => {
    return db
      .select()
      .from(emailBroadcasts)
      .where(inArray(emailBroadcasts.status, statuses))
      .orderBy(desc(emailBroadcasts.createdAt));
  },

  /** Most-recent-first listing for the admin broadcasts page. */
  listRecent: async (limit = 100): Promise<EmailBroadcast[]> => {
    return db
      .select()
      .from(emailBroadcasts)
      .orderBy(desc(emailBroadcasts.createdAt))
      .limit(limit);
  },

  // --- Recipient ledger (delegated to the record adapter, which owns the
  //     ON CONFLICT idempotency rules) ---

  loadAlreadySentUserIds,
  loadAlreadySentEmails,
  /** Take ownership of a recipient before mailing them — call this BEFORE the provider. */
  claimRecipient,
  recordSent,
  recordSkip,
  recordFailure,
  countRecipientsByStatus,

  // --- Templates ---

  listTemplates: async (activeOnly = true): Promise<BroadcastTemplate[]> => {
    const rows = db.select().from(broadcastTemplates);
    return activeOnly
      ? rows.where(eq(broadcastTemplates.isActive, true)).orderBy(desc(broadcastTemplates.createdAt))
      : rows.orderBy(desc(broadcastTemplates.createdAt));
  },

  findTemplateById: async (id: string): Promise<BroadcastTemplate | null> => {
    const row = await db.query.broadcastTemplates.findFirst({
      where: eq(broadcastTemplates.id, id),
    });
    return row ?? null;
  },

  createTemplate: async (input: {
    name: string;
    subject: string;
    bodyMarkdown: string;
    isActive?: boolean;
    createdByUserId?: string | null;
  }): Promise<BroadcastTemplate> => {
    const [row] = await db
      .insert(broadcastTemplates)
      .values({
        name: input.name,
        subject: input.subject,
        bodyMarkdown: input.bodyMarkdown,
        isActive: input.isActive ?? true,
        createdByUserId: input.createdByUserId ?? null,
      })
      .returning();
    return row;
  },
};

export type BroadcastRepository = typeof broadcastRepository;