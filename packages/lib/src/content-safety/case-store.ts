/**
 * Content cases — the database edge for takedowns: open a case, record its
 * steps, write the block, and read cases back for the admin console.
 *
 * `steps` and `snapshot` are only ever appended to or merged in SQL, never
 * read-modified-written, so two runs of the same case cannot lose each other's
 * entries.
 */

import { db } from '@pagespace/db/db';
import { and, desc, eq, gte, inArray, lte, or, sql } from '@pagespace/db/operators';
import {
  contentBlocks,
  contentCases,
  type ContentBlockCategory,
  type ContentCase,
  type ContentCaseSnapshot,
  type ContentCaseStatus,
  type ContentCaseTargetType,
} from '@pagespace/db/schema/content-safety';
import { collectContentReferences } from './references';
import type { TakedownCaseStore } from './takedown';

type TakedownOptions = NonNullable<ContentCaseSnapshot['takedown']>;

export function createTakedownCaseStore(): TakedownCaseStore {
  return {
    async load(caseId) {
      const [row] = await db.select().from(contentCases).where(eq(contentCases.id, caseId)).limit(1);
      return row ?? null;
    },
    async appendStep(caseId, step) {
      await db
        .update(contentCases)
        .set({ steps: sql`coalesce(${contentCases.steps}, '[]'::jsonb) || ${JSON.stringify([step])}::jsonb` })
        .where(eq(contentCases.id, caseId));
    },
    async setStatus(caseId, status) {
      await db.update(contentCases).set({ status }).where(eq(contentCases.id, caseId));
    },
    async mergeSnapshot(caseId, patch) {
      await db
        .update(contentCases)
        .set({ snapshot: sql`coalesce(${contentCases.snapshot}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` })
        .where(eq(contentCases.id, caseId));
    },
    async upsertBlock(block) {
      // The first block of a hash keeps its provenance; a second takedown of the
      // same hash changes nothing here, the hash is already refused everywhere.
      await db.insert(contentBlocks).values(block).onConflictDoNothing({ target: contentBlocks.contentHash });
    },
    collectReferences: collectContentReferences,
  };
}

export interface OpenTakedownCaseInput {
  targetType: ContentCaseTargetType;
  targetId: string;
  contentHash?: string | null;
  category: ContentBlockCategory;
  reason: string;
  takedown: TakedownOptions;
  snapshot?: Partial<ContentCaseSnapshot>;
}

export interface OpenedCase {
  case: ContentCase;
  /** False when an unfinished case for the same target and action was reused. */
  created: boolean;
}

/**
 * Open the case for a takedown, or return the one already open for the same
 * target and action so a repeated request continues it instead of starting a
 * second sequence. A reused case takes on options the new request adds
 * (`suspendUploader`, `skipPreservation`); it never drops ones it already had.
 */
export async function openTakedownCase(input: OpenTakedownCaseInput): Promise<OpenedCase> {
  const [existing] = await db
    .select()
    .from(contentCases)
    .where(
      and(
        eq(contentCases.targetType, input.targetType),
        eq(contentCases.targetId, input.targetId),
        inArray(contentCases.status, ['open', 'awaiting_evidence']),
        sql`${contentCases.snapshot} -> 'takedown' ->> 'kind' = ${input.takedown.kind}`,
      ),
    )
    .orderBy(desc(contentCases.createdAt))
    .limit(1);

  if (existing) {
    const previous = existing.snapshot?.takedown;
    const merged: TakedownOptions = {
      ...previous,
      ...input.takedown,
      skipPreservation: previous?.skipPreservation === true || input.takedown.skipPreservation === true,
      skipPreservationReason: input.takedown.skipPreservationReason ?? previous?.skipPreservationReason,
      suspendUploader: previous?.suspendUploader === true || input.takedown.suspendUploader === true,
    };
    const [updated] = await db
      .update(contentCases)
      .set({ snapshot: sql`coalesce(${contentCases.snapshot}, '{}'::jsonb) || ${JSON.stringify({ takedown: merged })}::jsonb` })
      .where(eq(contentCases.id, existing.id))
      .returning();
    return { case: updated, created: false };
  }

  const [created] = await db
    .insert(contentCases)
    .values({
      targetType: input.targetType,
      targetId: input.targetId,
      contentHash: input.contentHash ?? null,
      category: input.category,
      reason: input.reason,
      status: 'open',
      snapshot: { ...input.snapshot, takedown: input.takedown },
      steps: [],
    })
    .returning();
  return { case: created, created: true };
}

export interface ListCasesOptions {
  status?: ContentCaseStatus;
  limit?: number;
  offset?: number;
}

export async function listContentCases(options: ListCasesOptions = {}): Promise<ContentCase[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  return db
    .select()
    .from(contentCases)
    .where(options.status ? eq(contentCases.status, options.status) : undefined)
    .orderBy(desc(contentCases.createdAt))
    .limit(limit)
    .offset(Math.max(options.offset ?? 0, 0));
}

export async function getContentCase(caseId: string): Promise<ContentCase | null> {
  const [row] = await db.select().from(contentCases).where(eq(contentCases.id, caseId)).limit(1);
  return row ?? null;
}

/** Every case about a target: by its own ID, or by the content hash it resolves to. */
export async function listCasesForTarget(input: {
  targetType: ContentCaseTargetType;
  targetId: string;
  contentHash?: string | null;
}): Promise<ContentCase[]> {
  const byTarget = and(eq(contentCases.targetType, input.targetType), eq(contentCases.targetId, input.targetId));
  return db
    .select()
    .from(contentCases)
    .where(input.contentHash ? or(byTarget, eq(contentCases.contentHash, input.contentHash)) : byTarget)
    .orderBy(desc(contentCases.createdAt))
    .limit(100);
}

/**
 * Finished global takedowns whose storage has not been passed over again since
 * `actionedBefore`. Used by the re-sweep cron: a presigned PUT issued before a
 * block outlives it, so each case gets one more pass once that window closed.
 */
export async function listCasesDueForResweep(input: { actionedBefore: Date; actionedAfter: Date; limit?: number }): Promise<ContentCase[]> {
  return db
    .select()
    .from(contentCases)
    .where(
      and(
        eq(contentCases.status, 'actioned'),
        sql`${contentCases.snapshot} -> 'takedown' ->> 'kind' = 'global'`,
        lte(contentCases.updatedAt, input.actionedBefore),
        gte(contentCases.updatedAt, input.actionedAfter),
        sql`NOT (coalesce(${contentCases.steps}, '[]'::jsonb) @> '[{"step":"resweep"}]'::jsonb)`,
      ),
    )
    .orderBy(contentCases.updatedAt)
    .limit(input.limit ?? 25);
}
